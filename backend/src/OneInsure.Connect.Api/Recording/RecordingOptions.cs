using System.Collections.Concurrent;
using System.Diagnostics;
using Microsoft.Extensions.Options;
using OneInsure.Connect.Api.Meetings;
using OneInsure.Connect.Domain.Recording;

namespace OneInsure.Connect.Api.Recording;

/// <summary>
/// Recording:* settings. Relative paths are resolved against the API's content root. The library (StorageRoot) must be
/// outside the web root: files are only ever served through short-lived signed URLs by the API, never as static files.
/// </summary>
public sealed class RecordingOptions
{
    /// <summary>Development / Test / Pilot / Production. Pilot and Production refuse recording under an unconfirmed policy.</summary>
    public string Environment { get; set; } = "Production";
    /// <summary>Verified recordings (opaque relative keys yyyy/MM/&lt;random&gt;.mp4). Empty = recording unavailable.</summary>
    public string StorageRoot { get; set; } = "";
    /// <summary>Recorder working folder (WebM segments, logs, unverified MP4s). Never served.</summary>
    public string SpoolRoot { get; set; } = "";
    /// <summary>The R2 recorder (proof of concept) executable, a separate process from the API and the media server.</summary>
    public string RecorderExePath { get; set; } = "";
    public string FfmpegPath { get; set; } = "ffmpeg";
    public string FfprobePath { get; set; } = "ffprobe";
    /// <summary>Microsoft Edge used headless by the recorder. Empty = the installed Edge (channel "msedge").</summary>
    public string? EdgePath { get; set; }
    /// <summary>Composite layout page (recording/layout/dist). Empty = the recorder's own default.</summary>
    public string? LayoutDistPath { get; set; }
    /// <summary>LiveKit URL the recorder connects to. Empty = LiveKit:PublicUrl.</summary>
    public string? LiveKitUrl { get; set; }

    public bool WorkerEnabled { get; set; } = true;
    public int PollSeconds { get; set; } = 3;
    public int LeaseSeconds { get; set; } = 60;
    /// <summary>How long the recorder may take to report that it is recording.</summary>
    public int StartTimeoutSeconds { get; set; } = 120;
    /// <summary>After a stop request the recorder gets this long to finalise before it is terminated.</summary>
    public int StopTimeoutSeconds { get; set; } = 300;
    public int MaxDurationMinutes { get; set; } = 240;
    /// <summary>Recorder process launches per recording (the first plus restarts after the recorder process died).</summary>
    public int MaxLaunches { get; set; } = 3;
    public bool KeepSpoolAfterSuccess { get; set; }

    public bool RetentionEnabled { get; set; } = true;
    public int RetentionPollMinutes { get; set; } = 60;

    public int Width { get; set; } = 1280;
    public int Height { get; set; } = 720;
    public double DurationTolerancePercent { get; set; } = 3;
    public double DurationToleranceMinSeconds { get; set; } = 5;

    public DeploymentEnvironment DeploymentEnvironment =>
        Enum.TryParse<DeploymentEnvironment>(Environment, true, out var e) ? e : DeploymentEnvironment.Production;

    public bool IsRestrictedEnvironment => DeploymentEnvironment is DeploymentEnvironment.Pilot or DeploymentEnvironment.Production;
}

/// <summary>Absolute paths derived from <see cref="RecordingOptions"/>.</summary>
public sealed class RecordingPaths(IOptions<RecordingOptions> options, IHostEnvironment host)
{
    RecordingOptions O => options.Value;

    string? Abs(string? p) => string.IsNullOrWhiteSpace(p) ? null : Path.GetFullPath(Path.IsPathRooted(p) ? p : Path.Combine(host.ContentRootPath, p));

    public string? StorageRoot => Abs(O.StorageRoot);
    public string? SpoolRoot => Abs(O.SpoolRoot);
    public string? RecorderExe => Abs(O.RecorderExePath);
    public string? LayoutDist => Abs(O.LayoutDistPath);
    /// <summary>Where the recorder writes its own (recorder-verified) MP4s; the API moves them into the library.</summary>
    public string? RecorderOutputRoot => SpoolRoot is null ? null : Path.Combine(SpoolRoot, "_output");
    public string Ffmpeg => ResolveExe(O.FfmpegPath) ?? O.FfmpegPath;
    public string Ffprobe => ResolveExe(O.FfprobePath) ?? O.FfprobePath;

    public string? EdgeExe
    {
        get
        {
            if (!string.IsNullOrWhiteSpace(O.EdgePath)) return Abs(O.EdgePath);
            foreach (var p in new[] { @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe", @"C:\Program Files\Microsoft\Edge\Application\msedge.exe" })
                if (File.Exists(p)) return p;
            return null;
        }
    }

    /// <summary>Full path of a library file. Throws if the key would escape the root.</summary>
    public static string Resolve(string root, string key)
    {
        var full = Path.GetFullPath(Path.Combine(root, key.Replace('/', Path.DirectorySeparatorChar)));
        var r = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!full.StartsWith(r, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Storage key escapes the storage root.");
        return full;
    }

    /// <summary>An absolute path, or the first match on PATH for a bare executable name.</summary>
    public static string? ResolveExe(string? exe)
    {
        if (string.IsNullOrWhiteSpace(exe)) return null;
        if (Path.IsPathRooted(exe)) return File.Exists(exe) ? exe : null;
        var names = Path.HasExtension(exe) ? [exe] : new[] { exe + ".exe", exe };
        foreach (var dir in (System.Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
            foreach (var n in names)
            {
                try
                {
                    var f = Path.Combine(dir.Trim(), n);
                    if (File.Exists(f)) return f;
                }
                catch (ArgumentException) { }
            }
        return null;
    }
}

public sealed record HealthItem(string Name, bool Ok, string Detail);

/// <summary>Is the recorder usable on this server? (executable, FFmpeg/FFprobe, Edge, layout, storage folders, LiveKit keys).</summary>
public sealed class RecorderHealth(RecordingPaths paths, IOptions<RecordingOptions> options, IOptions<LiveKitOptions> liveKit)
{
    readonly ConcurrentDictionary<string, (DateTime At, IReadOnlyList<HealthItem> Items)> cache = new();

    /// <summary>Cheap checks (file existence), cached for 30 s: used before every recording start.</summary>
    public IReadOnlyList<HealthItem> Quick()
    {
        if (cache.TryGetValue("quick", out var c) && DateTime.UtcNow - c.At < TimeSpan.FromSeconds(30)) return c.Items;
        var items = Collect(runTools: false);
        cache["quick"] = (DateTime.UtcNow, items);
        return items;
    }

    /// <summary>Full check for administrators: also runs "ffmpeg -version" and "ffprobe -version".</summary>
    public IReadOnlyList<HealthItem> Full() => Collect(runTools: true);

    public static string? Problem(IReadOnlyList<HealthItem> items) =>
        items.FirstOrDefault(i => !i.Ok) is { } bad ? $"{bad.Name}: {bad.Detail}" : null;

    IReadOnlyList<HealthItem> Collect(bool runTools)
    {
        var o = options.Value;
        var list = new List<HealthItem>
        {
            Dir("Library storage (Recording:StorageRoot)", paths.StorageRoot),
            Dir("Recorder spool (Recording:SpoolRoot)", paths.SpoolRoot),
            FileItem("R2 recorder executable (Recording:RecorderExePath)", paths.RecorderExe),
            Tool("FFmpeg (Recording:FfmpegPath)", paths.Ffmpeg, runTools),
            Tool("FFprobe (Recording:FfprobePath)", paths.Ffprobe, runTools),
            FileItem("Microsoft Edge (Recording:EdgePath)", paths.EdgeExe),
            new("LiveKit credentials", liveKit.Value.IsConfigured, liveKit.Value.IsConfigured ? "Configured" : "LiveKit:ApiKey/ApiSecret/PublicUrl missing"),
        };
        if (paths.LayoutDist is { } layout)
            list.Add(new("Recording layout (Recording:LayoutDistPath)", File.Exists(Path.Combine(layout, "index.html")), layout));
        list.Add(new("Recorder worker", o.WorkerEnabled, o.WorkerEnabled ? "Enabled" : "Recording:WorkerEnabled is false"));
        return list;
    }

    static HealthItem Dir(string name, string? path)
    {
        if (path is null) return new(name, false, "Not configured");
        try
        {
            Directory.CreateDirectory(path);
            var probe = Path.Combine(path, $".probe-{Guid.NewGuid():N}");
            File.WriteAllText(probe, "ok");
            File.Delete(probe);
            return new(name, true, path);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or NotSupportedException or ArgumentException)
        {
            return new(name, false, $"{path}: not writable ({e.Message})");
        }
    }

    static HealthItem FileItem(string name, string? path) =>
        path is null ? new(name, false, "Not configured / not found") : new(name, File.Exists(path), File.Exists(path) ? path : $"{path}: not found");

    static HealthItem Tool(string name, string path, bool run)
    {
        var resolved = RecordingPaths.ResolveExe(path);
        if (resolved is null) return new(name, false, $"{path}: not found");
        if (!run) return new(name, true, resolved);
        try
        {
            using var p = Process.Start(new ProcessStartInfo(resolved, "-version") { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true });
            if (p is null) return new(name, false, $"{resolved}: could not start");
            var first = p.StandardOutput.ReadLine() ?? "";
            p.StandardError.ReadToEnd();
            if (!p.WaitForExit(10_000)) { p.Kill(); return new(name, false, $"{resolved}: no answer"); }
            return new(name, p.ExitCode == 0, p.ExitCode == 0 ? $"{resolved} ({first.Split(" Copyright")[0]})" : $"{resolved}: exit {p.ExitCode}");
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            return new(name, false, $"{resolved}: {e.Message}");
        }
    }
}
