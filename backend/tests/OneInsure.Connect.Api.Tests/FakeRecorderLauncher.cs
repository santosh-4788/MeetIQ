using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;
using OneInsure.Connect.Api.Recording;

namespace OneInsure.Connect.Api.Tests;

/// <summary>
/// Stand-in for the R2 recorder process. Records every launch; tests decide when a run "starts recording" and how it ends by writing
/// the same result.json (and MP4) the real recorder writes. MP4s are produced by real FFmpeg so the API's verification is real.
/// </summary>
public sealed class FakeRecorderLauncher : IRecorderLauncher
{
    public ConcurrentQueue<FakeRun> Runs { get; } = new();
    /// <summary>What a "finalize" launch does (default: exits without changing anything).</summary>
    public Action<FakeRun>? OnFinalize { get; set; }

    public IRecorderRun Start(RecorderLaunch launch)
    {
        var run = new FakeRun(launch);
        Directory.CreateDirectory(launch.JobDir);
        Runs.Enqueue(run);
        if (launch.Mode == "finalize")
        {
            OnFinalize?.Invoke(run);
            run.Exit();
        }
        return run;
    }

    public IRecorderRun? Adopt(int processId, string jobDir) => null;

    public FakeRun? For(Guid recording, int part = 1, string mode = "record") =>
        Runs.LastOrDefault(r => r.Launch.JobKey == $"{recording:N}-{part}" && r.Launch.Mode == mode);

    static readonly SemaphoreSlim Gate = new(1, 1);
    static string? goodMp4;

    /// <summary>A real, valid 1280x720 H.264/AAC faststart MP4 of 4 seconds (generated once).</summary>
    public static async Task<string> GoodMp4Async()
    {
        await Gate.WaitAsync();
        try
        {
            if (goodMp4 is not null && File.Exists(goodMp4)) return goodMp4;
            var f = Path.Combine(Path.GetTempPath(), $"oic-rec-sample-{Guid.NewGuid():N}.mp4");
            var psi = new ProcessStartInfo(Path.Combine(ApiFixture.FfmpegDir, "ffmpeg.exe"))
            {
                RedirectStandardError = true, RedirectStandardOutput = true, UseShellExecute = false, CreateNoWindow = true,
            };
            foreach (var a in new[] { "-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=25",
                         "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "4", "-c:v", "libx264", "-preset", "ultrafast",
                         "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-movflags", "+faststart", f })
                psi.ArgumentList.Add(a);
            using var p = Process.Start(psi)!;
            var err = await p.StandardError.ReadToEndAsync();
            await p.WaitForExitAsync();
            if (p.ExitCode != 0) throw new InvalidOperationException("ffmpeg could not create the sample MP4: " + err);
            return goodMp4 = f;
        }
        finally
        {
            Gate.Release();
        }
    }
}

public sealed class FakeRun(RecorderLaunch launch) : IRecorderRun
{
    public RecorderLaunch Launch => launch;
    public int? ProcessId => 4242;
    public bool HasExited { get; private set; }
    public bool Started { get; set; }
    public bool StopRequested { get; private set; }
    public bool Killed { get; private set; }

    public void RequestStop() => StopRequested = true;
    public void Kill() { Killed = true; HasExited = true; }
    public void Exit() => HasExited = true;
    public void Dispose() { }

    void Result(object o) => File.WriteAllText(Path.Combine(launch.JobDir, "result.json"), JsonSerializer.Serialize(o));

    /// <summary>The recorder finished and its own verification passed: result.json + the MP4 in its output folder.</summary>
    public async Task CompleteAsync(double expectedSeconds = 4, bool corrupt = false)
    {
        var dir = Path.Combine(launch.JobDir, "out");
        Directory.CreateDirectory(dir);
        var file = Path.Combine(dir, $"{launch.JobKey}.mp4");
        File.Copy(await FakeRecorderLauncher.GoodMp4Async(), file, overwrite: true);
        if (corrupt)
        {
            // Overwrite the middle of the media data: the container still parses, the full decode does not.
            await using var fs = new FileStream(file, FileMode.Open, FileAccess.Write);
            var junk = new byte[fs.Length / 3];
            new Random(7).NextBytes(junk);
            fs.Position = fs.Length / 3;
            await fs.WriteAsync(junk);
        }
        File.WriteAllBytes(Path.Combine(launch.JobDir, "segment-00.webm"), [1, 2, 3]);
        Result(new
        {
            status = "COMPLETED", outcome = "StopRequested", Restarts = 0, file,
            segments = new[] { new { file = "segment-00.webm", covered = expectedSeconds } },
            verification = new { Passed = true, Failures = Array.Empty<string>(), ExpectedSeconds = expectedSeconds },
        });
        Exit();
    }

    public void Fail(string failure)
    {
        Result(new { status = "FAILED", reason = "VERIFICATION", verification = new { Passed = false, Failures = new[] { failure }, ExpectedSeconds = 4.0 } });
        Exit();
    }

    public void Refuse(string code)
    {
        Result(new { status = "REFUSED", Code = code, Message = "Refused by the recorder's policy gate." });
        Exit();
    }

    /// <summary>The recorder process died without a result.</summary>
    public void Crash() => Exit();
}
