using System.Globalization;
using System.Text.Json;
using OneInsure.Connect.Domain.Recording;

namespace OneInsure.Connect.Recorder;

/// <summary>
/// "finalize --job-id &lt;id&gt;": rebuilds the MP4 from the WebM segments a recording job left in the spool and verifies it again.
/// Used to retry post-processing safely (e.g. FFmpeg was missing or the disk was full): nothing joins a room. The recorded
/// wall time per segment comes from the job's result.json; without it (the recorder process itself died) the media duration of
/// each segment is used, which still enforces codecs, a full decode and faststart.
/// </summary>
public static class FinalizeCommand
{
    public static async Task<int> RunAsync(RecorderOptions options, string? jobId)
    {
        if (string.IsNullOrWhiteSpace(jobId) || jobId.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || jobId.Contains(".."))
        {
            Console.Error.WriteLine("--job-id is required");
            return 4;
        }
        var jobDir = Path.Combine(options.Storage.SpoolRoot, jobId);
        if (!Directory.Exists(jobDir))
        {
            Console.Error.WriteLine($"Spool folder not found: {jobDir}");
            return 4;
        }
        using var log = new EventLog(Path.Combine(jobDir, "events.log"));
        log.Write("finalize_requested", new { jobId });

        var resultPath = Path.Combine(jobDir, "result.json");
        var segments = new List<(string File, double Covered)>();
        var expectedSource = "recorded-wall-time";
        if (File.Exists(resultPath))
        {
            File.Copy(resultPath, Path.Combine(jobDir, $"result-{DateTime.UtcNow:yyyyMMddHHmmss}.json"), overwrite: true); // keep the original outcome
            try
            {
                using var doc = JsonDocument.Parse(await File.ReadAllTextAsync(resultPath));
                if (doc.RootElement.TryGetProperty("segments", out var segs))
                    foreach (var s in segs.EnumerateArray())
                    {
                        var file = Path.Combine(jobDir, s.GetProperty("file").GetString() ?? "");
                        if (File.Exists(file) && new FileInfo(file).Length > 0) segments.Add((file, s.GetProperty("covered").GetDouble()));
                    }
            }
            catch (Exception e) when (e is JsonException or KeyNotFoundException or InvalidOperationException)
            {
                log.Write("finalize_result_unreadable", new { error = e.Message });
            }
        }
        var verifier = new MediaVerifier(options.Ffmpeg.FfmpegPath, options.Ffmpeg.FfprobePath, options.Ffmpeg.BelowNormalPriority);
        if (segments.Count == 0)
        {
            expectedSource = "media-duration";
            foreach (var file in Directory.GetFiles(jobDir, "segment-*.webm").Order(StringComparer.Ordinal))
            {
                if (new FileInfo(file).Length == 0) continue;
                segments.Add((file, await MediaSecondsAsync(options, file)));
            }
        }
        if (segments.Count == 0)
        {
            Write(jobDir, new { status = "FAILED", reason = "NO_MEDIA", mode = "finalize" });
            return 2;
        }

        var finalizer = new Finalizer(options, log);
        var now = DateTime.UtcNow;
        var outDir = Path.Combine(options.Storage.OutputRoot, now.ToString("yyyy", CultureInfo.InvariantCulture), now.ToString("MM", CultureInfo.InvariantCulture), now.ToString("dd", CultureInfo.InvariantCulture));
        Directory.CreateDirectory(outDir);
        var partial = Path.Combine(outDir, $"{jobId}.mp4.partial");
        var final = Path.Combine(outDir, $"{jobId}.mp4");
        var expected = segments.Sum(s => s.Covered);
        var ff = await finalizer.BuildMp4Async(segments.Select(s => s.File).ToList(), partial + ".mp4", remux: false, CancellationToken.None);
        VerificationResult verification;
        if (ff.ExitCode == 0)
        {
            File.Move(partial + ".mp4", partial, overwrite: true);
            verification = await finalizer.VerifyAsync(partial, expected, CancellationToken.None);
        }
        else verification = new VerificationResult(false, [$"FFmpeg exited with {ff.ExitCode}: {ff.StdErrTail}"], 0, expected, 0, "", "", "", 0, 0, 0, false, 0);

        if (verification.Passed) File.Move(partial, final, overwrite: true);
        log.Write(verification.Passed ? "finalize_completed" : "finalize_failed", verification);
        Write(jobDir, new
        {
            status = verification.Passed ? "COMPLETED" : "FAILED",
            mode = "finalize",
            outcome = "Finalized",
            expectedSource,
            file = verification.Passed ? final : partial,
            segments = segments.Select(s => new { file = Path.GetFileName(s.File), covered = s.Covered }),
            ffmpeg = ff,
            verification,
        });
        return verification.Passed ? 0 : 2;
    }

    static async Task<double> MediaSecondsAsync(RecorderOptions options, string file)
    {
        var r = await MediaVerifier.RunProcessAsync(options.Ffmpeg.FfprobePath,
            ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time", "-of", "csv=p=0", file], false, CancellationToken.None, captureStdout: true);
        var pts = (r.StdOut ?? "").Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(x => double.TryParse(x, NumberStyles.Float, CultureInfo.InvariantCulture, out var v) ? v : double.NaN)
            .Where(v => !double.IsNaN(v)).ToList();
        return pts.Count < 2 ? 0 : pts.Max() - pts.Min();
    }

    static void Write(string jobDir, object result) =>
        File.WriteAllText(Path.Combine(jobDir, "result.json"), JsonSerializer.Serialize(result, new JsonSerializerOptions { WriteIndented = true }));
}
