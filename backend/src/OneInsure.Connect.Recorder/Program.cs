// OneInsure Connect — R2 recorder (PROOF OF CONCEPT, not production-ready).
// Usage:
//   OneInsure.Connect.Recorder record --room <name> --title <text> --kind internal|customer
//                                     --consent granted|missing [--job-id <id>] [--max-minutes <n>]
//   OneInsure.Connect.Recorder finalize --job-id <id>
//       Re-builds and re-verifies the MP4 from a job's spooled WebM segments (safe retry of failed post-processing;
//       nothing joins a room). Used by the API's recorder worker when an administrator retries a failed recording.
// Exit codes: 0 completed+verified, 2 failed (recording or verification), 3 refused by policy, 4 configuration error.
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using OneInsure.Connect.Domain.Recording;
using OneInsure.Connect.Recorder;

if (args.Length == 0 || args[0] is not ("record" or "finalize"))
{
    Console.Error.WriteLine("usage: record --room <name> --title <text> --kind internal|customer --consent granted|missing [--job-id <id>] [--max-minutes <n>]");
    Console.Error.WriteLine("       finalize --job-id <id>");
    return 4;
}

var argMap = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
for (var i = 1; i + 1 < args.Length; i += 2) argMap[args[i].TrimStart('-')] = args[i + 1];

var env = Environment.GetEnvironmentVariable("OIC_ENVIRONMENT") ?? "Development";
var config = new ConfigurationBuilder()
    .SetBasePath(AppContext.BaseDirectory)
    .AddJsonFile("appsettings.json", optional: false)
    .AddJsonFile($"appsettings.{env}.json", optional: true)
    .AddEnvironmentVariables("OIC_")
    .Build();

var options = config.GetSection("Recorder").Get<RecorderOptions>() ?? new RecorderOptions();
options.LiveKit.ApiKey = Environment.GetEnvironmentVariable("LIVEKIT_API_KEY") ?? options.LiveKit.ApiKey;
options.LiveKit.ApiSecret = Environment.GetEnvironmentVariable("LIVEKIT_API_SECRET") ?? options.LiveKit.ApiSecret;
options.LiveKit.Url = Environment.GetEnvironmentVariable("LIVEKIT_URL") ?? options.LiveKit.Url;
var policy = config.GetSection("RecordingPolicy").Get<RecordingPolicy>() ?? new RecordingPolicy();

static string Abs(string p) => Path.IsPathRooted(p) ? p : Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, p));
options.Layout.DistPath = Abs(options.Layout.DistPath);
options.Storage.SpoolRoot = Abs(options.Storage.SpoolRoot);
options.Storage.OutputRoot = Abs(options.Storage.OutputRoot);

if (args[0] == "finalize")
    return await FinalizeCommand.RunAsync(options, argMap.GetValueOrDefault("job-id"));

if (!argMap.TryGetValue("room", out var room) || string.IsNullOrWhiteSpace(room))
{
    Console.Error.WriteLine("--room is required");
    return 4;
}
var jobId = argMap.GetValueOrDefault("job-id") ?? Guid.NewGuid().ToString("N");
var kind = argMap.GetValueOrDefault("kind")?.ToLowerInvariant() == "customer" ? MeetingRecordingKind.Customer : MeetingRecordingKind.Internal;
var consent = argMap.GetValueOrDefault("consent")?.ToLowerInvariant() == "granted";
var maxMinutes = int.TryParse(argMap.GetValueOrDefault("max-minutes"), out var mm) ? mm : options.Health.MaxDurationMinutes;
var job = new RecordingJob(jobId, room, argMap.GetValueOrDefault("title") ?? room, kind, consent, TimeSpan.FromMinutes(maxMinutes));

var jobDir = Path.Combine(options.Storage.SpoolRoot, jobId);
Directory.CreateDirectory(jobDir);
using var log = new EventLog(Path.Combine(jobDir, "events.log"));
log.Write("job_received", new { job.JobId, job.Room, kind = kind.ToString(), consent, environment = options.Environment.ToString(), policyApproval = policy.ApprovalStatus.ToString(), policyHasPlaceholders = policy.HasPlaceholders });

// 1. Policy gate (consent + legal approval) — before anything joins the room.
var decision = RecordingPolicyGate.Evaluate(policy, options.Environment, kind, consent);
if (!decision.Allowed)
{
    log.Write("refused_by_policy", decision);
    WriteResult(new { status = "REFUSED", decision.Code, decision.Message });
    return 3;
}
if (!Directory.Exists(options.Layout.DistPath))
{
    log.Write("config_error", new { message = $"Layout not built: {options.Layout.DistPath}" });
    return 4;
}

using var cts = new CancellationTokenSource();
var liveKit = new LiveKitClient(options.LiveKit);
var session = new RecordingSession(options, job, log, liveKit, jobDir);
Console.CancelKeyPress += (_, e) => { e.Cancel = true; session.PostCommand("stop"); };

// stdin commands (used by the PoC harness): stop | simulate <scenario>
_ = Task.Run(async () =>
{
    string? line;
    while ((line = await Console.In.ReadLineAsync()) is not null) session.PostCommand(line.Trim());
});

// 2. Record
var outcome = await session.RunAsync(cts.Token);
var segments = session.Segments.Where(s => s.Bytes > 0).ToList();
var timeslice = TimeSpan.FromMilliseconds(options.Layout.TimesliceMs);
var expectedSeconds = segments.Sum(s => s.CoveredDuration(timeslice).TotalSeconds);
log.Write("recording_finished", new { outcome = outcome.ToString(), session.Restarts, segments = segments.Count, expectedSeconds });

if (segments.Count == 0)
{
    WriteResult(new { status = "FAILED", reason = "NO_MEDIA", outcome = outcome.ToString(), session.Restarts });
    return 2;
}

// 3. Build MP4 → 4. verify → only then COMPLETED
var finalizer = new Finalizer(options, log);
var now = DateTime.UtcNow;
var outDir = Path.Combine(options.Storage.OutputRoot, now.ToString("yyyy"), now.ToString("MM"), now.ToString("dd"));
Directory.CreateDirectory(outDir);
var partial = Path.Combine(outDir, $"{jobId}.mp4.partial");
var final = Path.Combine(outDir, $"{jobId}.mp4");
var remux = options.Layout.VideoCodec == "h264";
var ff = await finalizer.BuildMp4Async(segments.Select(s => s.FilePath).ToList(), partial + ".mp4", remux, CancellationToken.None);
File.Move(partial + ".mp4", partial, overwrite: true);
var verification = ff.ExitCode == 0
    ? await finalizer.VerifyAsync(partial, expectedSeconds, CancellationToken.None)
    : new VerificationResult(false, [$"FFmpeg exited with {ff.ExitCode}: {ff.StdErrTail}"], 0, expectedSeconds, 0, "", "", "", 0, 0, 0, false, 0);

var recordingOk = outcome is AttemptOutcome.RoomEnded or AttemptOutcome.StopRequested or AttemptOutcome.MaxDuration;
var completed = verification.Passed && recordingOk;
if (completed) File.Move(partial, final, overwrite: false);
log.Write(completed ? "recording_completed" : "recording_failed", verification);

WriteResult(new
{
    status = completed ? "COMPLETED" : "FAILED",
    outcome = outcome.ToString(),
    session.Restarts,
    file = completed ? final : partial,
    segments = segments.Select(s => new { file = Path.GetFileName(s.FilePath), s.Bytes, s.Chunks, s.SequenceGaps, covered = s.CoveredDuration(timeslice).TotalSeconds }),
    ffmpeg = ff,
    verification,
});

if (completed && !options.Storage.KeepSpoolAfterSuccess)
    foreach (var s in segments) File.Delete(s.FilePath);
return completed ? 0 : 2;

void WriteResult(object result) =>
    File.WriteAllText(Path.Combine(jobDir, "result.json"), JsonSerializer.Serialize(result, new JsonSerializerOptions { WriteIndented = true }));
