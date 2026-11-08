using System.Globalization;
using System.Text;
using OneInsure.Connect.Domain.Recording;

namespace OneInsure.Connect.Recorder;

/// <summary>
/// Builds the final MP4 from WebM segments with FFmpeg and verifies it before it may be marked COMPLETED.
/// The verification itself lives in <see cref="MediaVerifier"/> (Domain), shared with the API, which verifies the file again
/// after moving it into the recording library.
/// </summary>
public sealed class Finalizer(RecorderOptions options, EventLog log)
{
    private FfmpegOptions Ff => options.Ffmpeg;
    private MediaVerifier Verifier => new(Ff.FfmpegPath, Ff.FfprobePath, Ff.BelowNormalPriority);

    /// <summary>width/height: the canvas size the recorder actually used for this job (landscape 1280x720 for group
    /// calls, or a portrait canvas for a 1:1 call where a camera was portrait - see RecordingSession.ActualWidth/Height).
    /// Falls back to the configured default landscape size when a job never reported its own (e.g. it failed before
    /// any frame was drawn).</summary>
    public async Task<FfmpegRun> BuildMp4Async(IReadOnlyList<string> segments, string outputPath, bool remux, int width, int height, CancellationToken ct)
    {
        var args = new List<string> { "-hide_banner", "-nostdin", "-y", "-loglevel", "warning" };
        foreach (var s in segments) args.AddRange(["-fflags", "+genpts", "-i", s]);

        if (remux && segments.Count == 1)
        {
            args.AddRange(["-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy"]);
        }
        else
        {
            var l = options.Layout;
            var fc = new StringBuilder();
            for (var i = 0; i < segments.Count; i++)
            {
                fc.Append(CultureInfo.InvariantCulture, $"[{i}:v:0]fps={l.Fps},scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v{i}];");
                fc.Append(CultureInfo.InvariantCulture, $"[{i}:a:0]aresample=48000:async=1:first_pts=0[a{i}];");
            }
            for (var i = 0; i < segments.Count; i++) fc.Append(CultureInfo.InvariantCulture, $"[v{i}][a{i}]");
            fc.Append(CultureInfo.InvariantCulture, $"concat=n={segments.Count}:v=1:a=1[v][a]");
            args.AddRange(["-filter_complex", fc.ToString(), "-map", "[v]", "-map", "[a]",
                "-c:v", "libx264", "-preset", Ff.X264Preset, "-crf", Ff.Crf.ToString(CultureInfo.InvariantCulture),
                "-profile:v", "high", "-level:v", "4.1", "-pix_fmt", "yuv420p", "-g", (l.Fps * 2).ToString(CultureInfo.InvariantCulture)]);
        }
        args.AddRange(["-c:a", "aac", "-b:a", $"{Ff.AudioBitrateKbps}k", "-ar", "48000", "-movflags", "+faststart", outputPath]);

        log.Write("ffmpeg_start", new { segments = segments.Count, remux, outputPath, width, height });
        var run = await Verifier.RunAsync(Ff.FfmpegPath, args, ct);
        log.Write("ffmpeg_done", new { run.ExitCode, run.CpuSeconds, run.WallSeconds, stderr = run.StdErrTail });
        return run;
    }

    public Task<VerificationResult> VerifyAsync(string path, double expectedSeconds, int width, int height, CancellationToken ct) =>
        Verifier.VerifyAsync(path, new MediaExpectations(width, height, expectedSeconds,
            options.Health.DurationTolerancePercent, options.Health.DurationToleranceMinSeconds), ct);
}
