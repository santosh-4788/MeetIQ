using System.Text.Json;
using System.Threading.Channels;
using Microsoft.Playwright;
using OneInsure.Connect.Domain.Recording;

namespace OneInsure.Connect.Recorder;

public sealed record RecordingJob(string JobId, string Room, string Title, MeetingRecordingKind Kind, bool ConsentGranted, TimeSpan MaxDuration);

public enum AttemptOutcome { RoomEnded, StopRequested, MaxDuration, Disconnected, Stalled, BrowserCrashed, StartFailed }

/// <summary>
/// Supervises one recording job. Each browser session writes its own WebM segment; after a crash,
/// stall or unexpected disconnect a new session (segment) is started while the room still exists.
/// </summary>
public sealed class RecordingSession(RecorderOptions options, RecordingJob job, EventLog log, LiveKitClient liveKit, string jobDir)
{
    private const string Origin = "http://127.0.0.1:7999"; // never listened on: served via request interception
    private readonly Channel<string> _commands = Channel.CreateUnbounded<string>();
    private readonly List<SegmentWriter> _segments = [];
    private readonly DateTimeOffset _jobStartedUtc = DateTimeOffset.UtcNow;
    private int _restarts;
    private string _lastOutcome = "";
    private JsonElement? _lastStatus;

    public IReadOnlyList<SegmentWriter> Segments => _segments;
    public int Restarts => _restarts;

    public void PostCommand(string command) => _commands.Writer.TryWrite(command);

    public async Task<AttemptOutcome> RunAsync(CancellationToken ct)
    {
        using var playwright = await Playwright.CreateAsync();
        var outcome = AttemptOutcome.StartFailed;
        for (var attempt = 0; ; attempt++)
        {
            var segment = new SegmentWriter(Path.Combine(jobDir, $"segment-{attempt:00}.webm"));
            _segments.Add(segment);
            try
            {
                outcome = await RunAttemptAsync(playwright, segment, attempt, ct);
            }
            catch (Exception e) when (e is PlaywrightException or TimeoutException or InvalidOperationException)
            {
                log.Write("attempt_error", new { attempt, error = e.Message });
                outcome = AttemptOutcome.StartFailed;
            }
            finally
            {
                segment.Dispose();
            }
            _lastOutcome = outcome.ToString();
            log.Write("attempt_finished", new { attempt, outcome = outcome.ToString(), segment.Bytes, segment.Chunks, segment.SequenceGaps });
            WriteStatus("attempt_finished");

            if (outcome is AttemptOutcome.RoomEnded or AttemptOutcome.StopRequested or AttemptOutcome.MaxDuration || ct.IsCancellationRequested)
                return outcome;
            if (_restarts >= options.Health.MaxRestarts)
            {
                log.Write("restart_limit_reached", new { _restarts });
                return outcome;
            }
            if (!await RoomStillActiveAsync(ct))
            {
                log.Write("room_gone", new { job.Room });
                return AttemptOutcome.RoomEnded;
            }
            _restarts++;
            var delay = TimeSpan.FromSeconds(Math.Min(2 * _restarts, 10));
            log.Write("restarting", new { restart = _restarts, delaySeconds = delay.TotalSeconds });
            await Task.Delay(delay, ct);
        }
    }

    private async Task<AttemptOutcome> RunAttemptAsync(IPlaywright playwright, SegmentWriter segment, int attempt, CancellationToken ct)
    {
        // The unique profile path also lets monitoring tools attribute browser processes to this job.
        var profileDir = Path.Combine(jobDir, $"oic-rec-{job.JobId}-{attempt}");
        var outcome = new TaskCompletionSource<AttemptOutcome>(TaskCreationOptions.RunContinuationsAsynchronously);
        var stopped = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var started = false;

        var launch = new BrowserTypeLaunchPersistentContextOptions
        {
            Headless = options.Browser.Headless,
            ViewportSize = new ViewportSize { Width = options.Layout.Width, Height = options.Layout.Height },
            Args =
            [
                "--autoplay-policy=no-user-gesture-required",
                "--disable-background-timer-throttling",
                "--disable-renderer-backgrounding",
                "--disable-backgrounding-occluded-windows",
                "--disable-features=CalculateNativeWinOcclusion",
                "--force-device-scale-factor=1",
                "--no-first-run",
            ],
        };
        if (!string.IsNullOrWhiteSpace(options.Browser.ExecutablePath)) launch.ExecutablePath = options.Browser.ExecutablePath;
        else if (!string.IsNullOrWhiteSpace(options.Browser.Channel)) launch.Channel = options.Browser.Channel;

        var context = await playwright.Chromium.LaunchPersistentContextAsync(profileDir, launch);
        try
        {
            context.Close += (_, _) => outcome.TrySetResult(AttemptOutcome.BrowserCrashed);
            // Chromium Local Network Access treats the intercepted origin as public; LiveKit lives on a
            // loopback/private address, so the recorder origin (and only it) is granted access explicitly.
            await context.GrantPermissionsAsync(["local-network-access"], new BrowserContextGrantPermissionsOptions { Origin = Origin });
            await context.RouteAsync($"{Origin}/**", ServeLayoutAsync);
            await context.ExposeFunctionAsync<int, string, bool>("oicChunk", (seq, b64) =>
            {
                segment.Append(seq, b64);
                return true;
            });
            await context.ExposeFunctionAsync<string, bool>("oicEvent", json =>
            {
                log.WriteRaw(json);
                var type = ReadType(json);
                if (type == "room_ended") outcome.TrySetResult(AttemptOutcome.RoomEnded);
                else if (type == "disconnected") outcome.TrySetResult(AttemptOutcome.Disconnected);
                else if (type == "recording_started") segment.MarkRecordingStarted();
                else if (type == "recording_stopped")
                {
                    segment.MarkRecordingStopped();
                    stopped.TrySetResult();
                }
                return true;
            });
            var cfg = new
            {
                url = options.LiveKit.Url,
                token = liveKit.CreateRecorderToken(job.Room, $"oic-recorder-{job.JobId}"),
                meetingTitle = job.Title,
                timeZone = options.Layout.TimeZone,
                width = options.Layout.Width,
                height = options.Layout.Height,
                fps = options.Layout.Fps,
                videoBitsPerSecond = options.Layout.VideoBitsPerSecond,
                audioBitsPerSecond = options.Layout.AudioBitsPerSecond,
                timesliceMs = options.Layout.TimesliceMs,
                videoCodec = options.Layout.VideoCodec,
                captureMode = options.Layout.CaptureMode,
            };
            await context.AddInitScriptAsync($"window.__OIC_REC__ = {JsonSerializer.Serialize(cfg)};");

            var page = context.Pages.Count > 0 ? context.Pages[0] : await context.NewPageAsync();
            page.Crash += (_, _) => outcome.TrySetResult(AttemptOutcome.BrowserCrashed);
            page.Console += (_, m) => { if (m.Type == "error") log.Write("page_console_error", new { text = m.Text }); };
            await page.GotoAsync($"{Origin}/index.html", new PageGotoOptions { Timeout = 30_000 });
            var start = await page.EvaluateAsync<JsonElement>("() => window.oicControl.start()");
            started = true;
            log.Write("attempt_started", new { attempt, mime = start.GetProperty("mimeType").GetString() });

            var poll = TimeSpan.FromSeconds(options.Health.PollSeconds);
            var deadline = _jobStartedUtc + job.MaxDuration;
            while (!outcome.Task.IsCompleted)
            {
                var cmdTask = _commands.Reader.WaitToReadAsync(ct).AsTask();
                await Task.WhenAny(outcome.Task, Task.Delay(poll, ct), cmdTask);
                if (outcome.Task.IsCompleted) break;

                while (_commands.Reader.TryRead(out var cmd))
                {
                    if (cmd == "stop") outcome.TrySetResult(AttemptOutcome.StopRequested);
                    else if (cmd.StartsWith("simulate ", StringComparison.Ordinal))
                    {
                        var scenario = cmd["simulate ".Length..].Trim();
                        log.Write("simulate", new { scenario });
                        try { await page.EvaluateAsync("s => window.oicControl.simulate(s)", scenario); }
                        catch (PlaywrightException e) { log.Write("simulate_failed", new { scenario, error = e.Message }); }
                    }
                }
                if (outcome.Task.IsCompleted) break;
                if (DateTimeOffset.UtcNow >= deadline) { outcome.TrySetResult(AttemptOutcome.MaxDuration); break; }
                if (File.Exists(Path.Combine(jobDir, "STOP"))) { outcome.TrySetResult(AttemptOutcome.StopRequested); break; }

                try
                {
                    _lastStatus = await page.EvaluateAsync<JsonElement>("() => window.oicControl.status()").WaitAsync(TimeSpan.FromSeconds(5), ct);
                }
                catch (Exception e) when (e is PlaywrightException or TimeoutException)
                {
                    log.Write("status_failed", new { error = e.Message });
                }
                WriteStatus("recording");
                var last = segment.LastChunkUtc ?? segment.StartedUtc;
                if (DateTimeOffset.UtcNow - last > TimeSpan.FromSeconds(options.Health.StallSeconds))
                {
                    log.Write("stall_detected", new { lastChunkUtc = segment.LastChunkUtc });
                    outcome.TrySetResult(AttemptOutcome.Stalled);
                }
            }

            var result = await outcome.Task;
            if (result is AttemptOutcome.StopRequested or AttemptOutcome.MaxDuration or AttemptOutcome.Stalled)
            {
                try { await page.EvaluateAsync("() => window.oicControl.stop()").WaitAsync(TimeSpan.FromSeconds(20), ct); }
                catch (Exception e) when (e is PlaywrightException or TimeoutException) { log.Write("graceful_stop_failed", new { error = e.Message }); }
            }
            else if (result is AttemptOutcome.RoomEnded or AttemptOutcome.Disconnected)
            {
                // The page stops MediaRecorder itself on disconnect; wait for the final chunk.
                await Task.WhenAny(stopped.Task, Task.Delay(TimeSpan.FromSeconds(15), ct));
            }
            return result;
        }
        catch (PlaywrightException) when (started && outcome.Task.IsCompleted)
        {
            return await outcome.Task; // browser died while we were talking to it
        }
        finally
        {
            try { await context.CloseAsync(); } catch (PlaywrightException) { }
            TryDelete(profileDir);
        }
    }

    /// <summary>
    /// After an SFU restart a single-node LiveKit forgets the room until participants rejoin, so a missing
    /// room is only treated as "meeting ended" after a grace period. (In the full system the meeting status
    /// in SQL Server is authoritative; this check is the PoC stand-in.)
    /// </summary>
    private async Task<bool> RoomStillActiveAsync(CancellationToken ct)
    {
        var until = DateTimeOffset.UtcNow.AddSeconds(options.Health.RoomGoneGraceSeconds);
        while (true)
        {
            try
            {
                if (await liveKit.RoomExistsAsync(job.Room, ct)) return true;
            }
            catch (HttpRequestException e)
            {
                log.Write("room_check_failed", new { error = e.Message });
            }
            if (DateTimeOffset.UtcNow >= until) return false;
            await Task.Delay(TimeSpan.FromSeconds(3), ct);
        }
    }

    private async Task ServeLayoutAsync(IRoute route)
    {
        var rel = new Uri(route.Request.Url).AbsolutePath.TrimStart('/');
        var root = Path.GetFullPath(options.Layout.DistPath);
        var file = Path.GetFullPath(Path.Combine(root, rel));
        if (!file.StartsWith(root, StringComparison.OrdinalIgnoreCase) || !File.Exists(file))
        {
            await route.FulfillAsync(new RouteFulfillOptions { Status = 404 });
            return;
        }
        var type = Path.GetExtension(file) switch { ".html" => "text/html", ".js" => "text/javascript", ".css" => "text/css", _ => "application/octet-stream" };
        await route.FulfillAsync(new RouteFulfillOptions { Status = 200, ContentType = type, BodyBytes = await File.ReadAllBytesAsync(file) });
    }

    private void WriteStatus(string state)
    {
        var status = new
        {
            state,
            job.JobId,
            job.Room,
            restarts = _restarts,
            lastOutcome = _lastOutcome,
            segments = _segments.Select(s => new { file = Path.GetFileName(s.FilePath), s.Bytes, s.Chunks, s.SequenceGaps, s.LastChunkUtc }),
            page = _lastStatus,
            updatedUtc = DateTimeOffset.UtcNow,
        };
        try { File.WriteAllText(Path.Combine(jobDir, "status.json"), JsonSerializer.Serialize(status, new JsonSerializerOptions { WriteIndented = true })); }
        catch (IOException) { /* best effort */ }
    }

    private static string? ReadType(string json)
    {
        try
        {
            using var d = JsonDocument.Parse(json);
            return d.RootElement.TryGetProperty("type", out var t) ? t.GetString() : null;
        }
        catch (JsonException) { return null; }
    }

    private static void TryDelete(string dir)
    {
        for (var i = 0; i < 5; i++)
        {
            try
            {
                if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
                return;
            }
            catch (IOException) { Thread.Sleep(500); }
            catch (UnauthorizedAccessException) { Thread.Sleep(500); }
        }
    }
}
