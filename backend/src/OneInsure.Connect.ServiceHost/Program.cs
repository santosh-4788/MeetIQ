// OneInsure Connect — Windows service host for a console program (production: the LiveKit video server).
// livekit-server.exe is not a Windows service itself; this small supervisor is: it starts the program, writes its output
// to a daily log file, restarts it after a crash (back-off up to one minute) and stops it with the service.
// Built-in .NET hosting only: no third-party service wrapper.
//
// Settings: appsettings.json next to the exe (written by the installer) or the command line:
//   { "Supervisor": { "ServiceName": "...", "Executable": "<path>", "Arguments": "<args>", "LogDirectory": "<dir>" } }
//
// The child inherits this process's environment (for LiveKit: LIVEKIT_KEYS, set on the service, never in a file).
using System.Diagnostics;

// Services start in System32: read appsettings.json from the program folder.
var builder = Host.CreateApplicationBuilder(new HostApplicationBuilderSettings { Args = args, ContentRootPath = AppContext.BaseDirectory });
builder.Services.AddWindowsService(o => o.ServiceName = builder.Configuration["Supervisor:ServiceName"] ?? "OneInsureConnectVideo");
builder.Services.AddHostedService<Supervisor>();
await builder.Build().RunAsync();

sealed class Supervisor(IConfiguration config, ILogger<Supervisor> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        var exe = config["Supervisor:Executable"] ?? throw new InvalidOperationException("Supervisor:Executable is not configured.");
        exe = Path.GetFullPath(exe, AppContext.BaseDirectory);
        var arguments = config["Supervisor:Arguments"] ?? "";
        var logDir = Path.GetFullPath(config["Supervisor:LogDirectory"] ?? "logs", AppContext.BaseDirectory);
        Directory.CreateDirectory(logDir);
        var delay = TimeSpan.FromSeconds(2);

        // A copy left running by a host that crashed would hold the ports: stop it first.
        foreach (var p in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(exe)))
            try { if (string.Equals(p.MainModule?.FileName, exe, StringComparison.OrdinalIgnoreCase)) p.Kill(entireProcessTree: true); } catch { /* access denied / already gone */ }

        while (!stop.IsCancellationRequested)
        {
            var started = DateTime.UtcNow;
            using var child = new Process
            {
                StartInfo = new ProcessStartInfo(exe, arguments)
                {
                    WorkingDirectory = Path.GetDirectoryName(exe)!, UseShellExecute = false, CreateNoWindow = true,
                    RedirectStandardOutput = true, RedirectStandardError = true,
                },
                EnableRaisingEvents = true,
            };
            var gate = new object();
            void Write(string? line)
            {
                if (line is null) return;
                lock (gate) File.AppendAllText(Path.Combine(logDir, $"{Path.GetFileNameWithoutExtension(exe)}-{DateTime.Now:yyyyMMdd}.log"), line + Environment.NewLine);
            }
            child.OutputDataReceived += (_, e) => Write(e.Data);
            child.ErrorDataReceived += (_, e) => Write(e.Data);
            try
            {
                child.Start();
                child.BeginOutputReadLine();
                child.BeginErrorReadLine();
                log.LogInformation("Started {Exe} (pid {Pid})", exe, child.Id);
                await child.WaitForExitAsync(stop);
                log.LogWarning("{Exe} exited with code {Code}", exe, child.ExitCode);
            }
            catch (OperationCanceledException)
            {
                try { child.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
                log.LogInformation("Stopped {Exe}", exe);
                return;
            }
            catch (Exception e)
            {
                log.LogError(e, "Could not run {Exe}", exe);
            }
            // Ran a while → it was a crash, restart quickly; failing repeatedly at start → back off up to a minute.
            delay = DateTime.UtcNow - started > TimeSpan.FromMinutes(2) ? TimeSpan.FromSeconds(2) : TimeSpan.FromSeconds(Math.Min(60, delay.TotalSeconds * 2));
            try { await Task.Delay(delay, stop); } catch (OperationCanceledException) { return; }
        }
    }
}
