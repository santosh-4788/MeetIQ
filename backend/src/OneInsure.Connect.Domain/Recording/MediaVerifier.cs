using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace OneInsure.Connect.Domain.Recording;

public sealed record VerificationResult(
    bool Passed,
    IReadOnlyList<string> Failures,
    double DurationSeconds,
    double ExpectedSeconds,
    long SizeBytes,
    string Sha256,
    string VideoCodec,
    string AudioCodec,
    int Width,
    int Height,
    double Fps,
    bool FastStart,
    int DecodeErrors);

public sealed record FfmpegRun(int ExitCode, double CpuSeconds, double WallSeconds, string StdErrTail);

/// <summary>What a recording must look like to be accepted (resolution, recorded wall time and its tolerance).</summary>
public sealed record MediaExpectations(int Width, int Height, double ExpectedSeconds, double TolerancePercent, double ToleranceMinSeconds);

/// <summary>
/// Verification that every recording must pass before it may be marked COMPLETED: H.264 video + AAC audio at the expected
/// resolution, duration matching the recorded wall time, a full decode of every frame without errors, "faststart"
/// (moov before mdat, needed for progressive playback with range requests) and the SHA-256 of the exact bytes.
/// Shared by the R2 recorder (before it reports COMPLETED) and the API (again, after the file was moved into storage).
/// </summary>
public sealed class MediaVerifier(string ffmpegPath, string ffprobePath, bool lowPriority = true)
{
    public async Task<VerificationResult> VerifyAsync(string path, MediaExpectations e, CancellationToken ct)
    {
        var failures = new List<string>();
        if (!File.Exists(path)) return Fail("Output file does not exist.");
        var size = new FileInfo(path).Length;
        if (size == 0) return Fail("Output file is empty.");

        // 1. Container/stream inspection
        string vCodec = "", aCodec = "";
        int w = 0, h = 0;
        double fps = 0, duration = 0;
        ProcResult probe;
        try
        {
            probe = await RunProcessAsync(ffprobePath, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path], false, ct, captureStdout: true);
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            return Fail($"ffprobe could not be started: {ex.Message}");
        }
        try
        {
            using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(probe.StdOut) ? "{}" : probe.StdOut);
            foreach (var s in doc.RootElement.GetProperty("streams").EnumerateArray())
            {
                var type = s.GetProperty("codec_type").GetString();
                if (type == "video" && vCodec == "")
                {
                    vCodec = s.GetProperty("codec_name").GetString() ?? "";
                    w = s.GetProperty("width").GetInt32();
                    h = s.GetProperty("height").GetInt32();
                    fps = ParseRate(s.GetProperty("avg_frame_rate").GetString());
                }
                else if (type == "audio" && aCodec == "") aCodec = s.GetProperty("codec_name").GetString() ?? "";
            }
            duration = double.Parse(doc.RootElement.GetProperty("format").GetProperty("duration").GetString() ?? "0", CultureInfo.InvariantCulture);
        }
        catch (Exception ex) when (ex is JsonException or KeyNotFoundException or FormatException or InvalidOperationException)
        {
            failures.Add($"ffprobe could not read the container: {ex.Message}");
        }
        if (vCodec != "h264") failures.Add($"Video codec is '{vCodec}', expected h264.");
        if (aCodec != "aac") failures.Add($"Audio codec is '{aCodec}', expected aac.");
        if (w != e.Width || h != e.Height) failures.Add($"Resolution {w}x{h}, expected {e.Width}x{e.Height}.");

        // 2. Duration matches recorded wall time
        var tolerance = Math.Max(e.ToleranceMinSeconds, e.ExpectedSeconds * e.TolerancePercent / 100);
        if (duration <= 0) failures.Add("Duration is zero.");
        else if (Math.Abs(duration - e.ExpectedSeconds) > tolerance)
            failures.Add($"Duration {duration:F1}s differs from recorded wall time {e.ExpectedSeconds:F1}s by more than {tolerance:F1}s.");

        // 3. Full decode of every frame
        var decode = await RunAsync(ffmpegPath, ["-hide_banner", "-nostdin", "-v", "error", "-i", path, "-map", "0", "-f", "null", "-"], ct);
        var decodeErrors = decode.StdErrTail.Split('\n', StringSplitOptions.RemoveEmptyEntries).Length;
        if (decode.ExitCode != 0 || decodeErrors > 0) failures.Add($"Full decode reported {decodeErrors} error line(s), exit {decode.ExitCode}.");

        // 4. Progressive playback: moov atom before mdat
        var fastStart = MoovBeforeMdat(path);
        if (!fastStart) failures.Add("moov atom is not before mdat (not web-optimised).");

        // 5. Integrity hash
        var sha = await Sha256HexAsync(path, ct);

        return new VerificationResult(failures.Count == 0, failures, duration, e.ExpectedSeconds, size, sha, vCodec, aCodec, w, h, fps, fastStart, decodeErrors);

        VerificationResult Fail(string msg) => new(false, [msg], 0, e.ExpectedSeconds, 0, "", "", "", 0, 0, 0, false, 0);
    }

    /// <summary>Joins already-verified MP4 parts (same codecs and settings) without re-encoding, web-optimised.</summary>
    public async Task<FfmpegRun> ConcatAsync(IReadOnlyList<string> parts, string outputPath, CancellationToken ct)
    {
        var list = outputPath + ".txt";
        await File.WriteAllLinesAsync(list, parts.Select(p => $"file '{p.Replace("\\", "/").Replace("'", "'\\''")}'"), ct);
        try
        {
            return await RunAsync(ffmpegPath, ["-hide_banner", "-nostdin", "-y", "-loglevel", "warning", "-f", "concat", "-safe", "0", "-i", list,
                "-c", "copy", "-movflags", "+faststart", "-f", "mp4", outputPath], ct);
        }
        finally
        {
            File.Delete(list);
        }
    }

    public static async Task<string> Sha256HexAsync(string path, CancellationToken ct)
    {
        await using var fs = File.OpenRead(path);
        return Convert.ToHexStringLower(await SHA256.HashDataAsync(fs, ct));
    }

    static double ParseRate(string? r)
    {
        if (string.IsNullOrEmpty(r)) return 0;
        var parts = r.Split('/');
        return parts.Length == 2 && double.TryParse(parts[0], CultureInfo.InvariantCulture, out var n) && double.TryParse(parts[1], CultureInfo.InvariantCulture, out var d) && d != 0 ? n / d : 0;
    }

    public static bool MoovBeforeMdat(string path)
    {
        using var fs = File.OpenRead(path);
        Span<byte> hdr = stackalloc byte[16];
        long pos = 0;
        while (pos + 8 <= fs.Length)
        {
            fs.Position = pos;
            if (fs.Read(hdr[..8]) < 8) break;
            long size = (uint)(hdr[0] << 24 | hdr[1] << 16 | hdr[2] << 8 | hdr[3]);
            var type = Encoding.ASCII.GetString(hdr.Slice(4, 4));
            if (size == 1)
            {
                if (fs.Read(hdr.Slice(8, 8)) < 8) break;
                size = (long)(((ulong)hdr[8] << 56) | ((ulong)hdr[9] << 48) | ((ulong)hdr[10] << 40) | ((ulong)hdr[11] << 32) | ((ulong)hdr[12] << 24) | ((ulong)hdr[13] << 16) | ((ulong)hdr[14] << 8) | hdr[15]);
            }
            if (type == "moov") return true;
            if (type == "mdat") return false;
            if (size < 8) break;
            pos += size;
        }
        return false;
    }

    public sealed record ProcResult(int ExitCode, double CpuSeconds, double WallSeconds, string StdErrTail, string? StdOut);

    public static async Task<ProcResult> RunProcessAsync(string exe, IEnumerable<string> args, bool lowPriority, CancellationToken ct, bool captureStdout = false)
    {
        var psi = new ProcessStartInfo(exe) { RedirectStandardError = true, RedirectStandardOutput = true, UseShellExecute = false, CreateNoWindow = true };
        foreach (var a in args) psi.ArgumentList.Add(a);
        var sw = Stopwatch.StartNew();
        using var p = Process.Start(psi) ?? throw new InvalidOperationException($"Could not start {exe}");
        if (lowPriority)
        {
            try { p.PriorityClass = ProcessPriorityClass.BelowNormal; } catch (InvalidOperationException) { /* already exited */ }
        }
        var stdoutTask = p.StandardOutput.ReadToEndAsync(ct);
        var stderrTask = p.StandardError.ReadToEndAsync(ct);
        await p.WaitForExitAsync(ct);
        var stderr = await stderrTask;
        var stdout = await stdoutTask;
        double cpu = 0;
        try { cpu = p.TotalProcessorTime.TotalSeconds; } catch (InvalidOperationException) { }
        var tail = stderr.Length > 4000 ? stderr[^4000..] : stderr;
        return new ProcResult(p.ExitCode, cpu, sw.Elapsed.TotalSeconds, tail.Trim(), captureStdout ? stdout : null);
    }

    public async Task<FfmpegRun> RunAsync(string exe, IEnumerable<string> args, CancellationToken ct)
    {
        try
        {
            var r = await RunProcessAsync(exe, args, lowPriority, ct, captureStdout: false);
            return new FfmpegRun(r.ExitCode, r.CpuSeconds, r.WallSeconds, r.StdErrTail);
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            return new FfmpegRun(-1, 0, 0, $"{exe} could not be started: {ex.Message}");
        }
    }
}
