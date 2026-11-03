using System.Diagnostics;

namespace OneInsure.Connect.Api.Recording;

/// <summary>One recorder process to start: "record" (joins the room) or "finalize" (re-builds the MP4 from a job's spool).</summary>
public sealed record RecorderLaunch(string Mode, string JobKey, string JobDir, string? Room, string? Title, string? Kind, bool ConsentGranted, int MaxMinutes,
    IReadOnlyDictionary<string, string> Environment);

/// <summary>A running (or finished) recorder process.</summary>
public interface IRecorderRun : IDisposable
{
    int? ProcessId { get; }
    bool HasExited { get; }
    /// <summary>The recorder reported that it is in the room and recording ("attempt_started").</summary>
    bool Started { get; }
    /// <summary>Graceful stop: the recorder stops MediaRecorder, finalises and verifies the MP4, then exits.</summary>
    void RequestStop();
    void Kill();
}

/// <summary>Starts the R2 recorder. Tests replace it with a fake; production starts OneInsure.Connect.Recorder.exe.</summary>
public interface IRecorderLauncher
{
    IRecorderRun Start(RecorderLaunch launch);
    /// <summary>Re-attaches to a recorder that is still running after the API restarted (null if that process is gone).</summary>
    IRecorderRun? Adopt(int processId, string jobDir);
}

/// <summary>
/// Starts OneInsure.Connect.Recorder.exe as a separate process (never inside the API process): a browser crash or FFmpeg failure
/// cannot take the API down, and the API can be restarted while a recording continues (the worker re-attaches by process id).
/// Secrets reach the recorder only through its process environment, never its command line.
/// </summary>
public sealed class ProcessRecorderLauncher(RecordingPaths paths, ILogger<ProcessRecorderLauncher> log) : IRecorderLauncher
{
    public IRecorderRun Start(RecorderLaunch l)
    {
        var exe = paths.RecorderExe ?? throw new InvalidOperationException("Recording:RecorderExePath is not configured.");
        if (!File.Exists(exe)) throw new InvalidOperationException($"Recorder executable not found: {exe}");
        var psi = new ProcessStartInfo(exe)
        {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            WorkingDirectory = Path.GetDirectoryName(exe)!,
        };
        psi.ArgumentList.Add(l.Mode);
        if (l.Mode == "record")
        {
            foreach (var (k, v) in new[] { ("--room", l.Room!), ("--title", l.Title ?? l.Room!), ("--kind", l.Kind ?? "internal"),
                         ("--consent", l.ConsentGranted ? "granted" : "missing"), ("--job-id", l.JobKey), ("--max-minutes", l.MaxMinutes.ToString(System.Globalization.CultureInfo.InvariantCulture)) })
            {
                psi.ArgumentList.Add(k);
                psi.ArgumentList.Add(v);
            }
        }
        else
        {
            psi.ArgumentList.Add("--job-id");
            psi.ArgumentList.Add(l.JobKey);
        }
        foreach (var (k, v) in l.Environment) psi.Environment[k] = v;
        // The recorder is a framework-dependent app: point it at the runtime this API runs on when that is a private install.
        if (!psi.Environment.ContainsKey("DOTNET_ROOT") && System.Environment.ProcessPath is { } host && Path.GetFileNameWithoutExtension(host).Equals("dotnet", StringComparison.OrdinalIgnoreCase))
            psi.Environment["DOTNET_ROOT"] = Path.GetDirectoryName(host)!;
        var p = Process.Start(psi) ?? throw new InvalidOperationException("The recorder process could not be started.");
        log.LogInformation("Recorder {Mode} started for job {Job} (pid {Pid})", l.Mode, l.JobKey, p.Id);
        return new ProcessRun(p, l.JobDir, log);
    }

    public IRecorderRun? Adopt(int processId, string jobDir)
    {
        try
        {
            var p = Process.GetProcessById(processId);
            if (!p.ProcessName.StartsWith("OneInsure.Connect.Recorder", StringComparison.OrdinalIgnoreCase) || p.HasExited)
            {
                p.Dispose();
                return null;
            }
            return new AdoptedRun(p, jobDir);
        }
        catch (ArgumentException) { return null; } // no such process
        catch (InvalidOperationException) { return null; }
    }

    static void StopFile(string jobDir)
    {
        try
        {
            Directory.CreateDirectory(jobDir);
            File.WriteAllText(Path.Combine(jobDir, "STOP"), DateTime.UtcNow.ToString("O"));
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    sealed class ProcessRun : IRecorderRun
    {
        readonly Process p;
        readonly string jobDir;
        volatile bool started;

        public ProcessRun(Process p, string jobDir, ILogger log)
        {
            this.p = p;
            this.jobDir = jobDir;
            p.OutputDataReceived += (_, e) =>
            {
                if (e.Data is { } line && line.Contains("\"attempt_started\"", StringComparison.Ordinal)) started = true;
            };
            p.ErrorDataReceived += (_, e) => { if (!string.IsNullOrWhiteSpace(e.Data)) log.LogWarning("Recorder {Pid}: {Line}", p.Id, e.Data); };
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
        }

        public int? ProcessId => p.Id;
        public bool HasExited => p.HasExited;
        public bool Started => started;

        public void RequestStop()
        {
            StopFile(jobDir); // polled by the recorder every few seconds
            try { p.StandardInput.WriteLine("stop"); p.StandardInput.Flush(); }
            catch (Exception e) when (e is IOException or InvalidOperationException or ObjectDisposedException) { }
        }

        public void Kill()
        {
            try { p.Kill(entireProcessTree: true); } catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception) { }
        }

        public void Dispose() => p.Dispose();
    }

    sealed class AdoptedRun(Process p, string jobDir) : IRecorderRun
    {
        public int? ProcessId => p.Id;
        public bool HasExited
        {
            get
            {
                try { return p.HasExited; } catch (InvalidOperationException) { return true; }
            }
        }
        public bool Started => true;
        public void RequestStop() => StopFile(jobDir);
        public void Kill()
        {
            try { p.Kill(entireProcessTree: true); } catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception) { }
        }
        public void Dispose() => p.Dispose();
    }
}
