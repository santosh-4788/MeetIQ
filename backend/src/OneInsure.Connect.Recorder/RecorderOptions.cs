using OneInsure.Connect.Domain.Recording;

namespace OneInsure.Connect.Recorder;

public sealed class RecorderOptions
{
    public DeploymentEnvironment Environment { get; set; } = DeploymentEnvironment.Development;
    public LiveKitOptions LiveKit { get; set; } = new();
    public BrowserOptions Browser { get; set; } = new();
    public LayoutOptions Layout { get; set; } = new();
    public StorageOptions Storage { get; set; } = new();
    public FfmpegOptions Ffmpeg { get; set; } = new();
    public HealthOptions Health { get; set; } = new();
}

public sealed class LiveKitOptions
{
    /// <summary>ws:// or wss:// URL of the LiveKit server (separate component).</summary>
    public string Url { get; set; } = "ws://127.0.0.1:7880";
    /// <summary>Supplied via environment (LIVEKIT_API_KEY / LIVEKIT_API_SECRET), never appsettings.</summary>
    public string ApiKey { get; set; } = "";
    public string ApiSecret { get; set; } = "";
    public int TokenTtlMinutes { get; set; } = 10;
}

public sealed class BrowserOptions
{
    /// <summary>"msedge", "chrome", or empty for Playwright's bundled Chromium.</summary>
    public string Channel { get; set; } = "msedge";
    public string? ExecutablePath { get; set; }
    public bool Headless { get; set; } = true;
}

public sealed class LayoutOptions
{
    public string DistPath { get; set; } = @"..\..\..\recording\layout\dist";
    public int Width { get; set; } = 1280;
    public int Height { get; set; } = 720;
    public int Fps { get; set; } = 25;
    public int VideoBitsPerSecond { get; set; } = 2_500_000;
    public int AudioBitsPerSecond { get; set; } = 128_000;
    public int TimesliceMs { get; set; } = 2000;
    /// <summary>"vp8" (transcode to H.264) or "h264" (remux when possible).</summary>
    public string VideoCodec { get; set; } = "vp8";
    /// <summary>"generator" (VideoFrame per draw) or "capture" (canvas.captureStream).</summary>
    public string CaptureMode { get; set; } = "generator";
    public string TimeZone { get; set; } = "Asia/Kolkata";
}

public sealed class StorageOptions
{
    public string SpoolRoot { get; set; } = @"..\..\..\recording\spool";
    public string OutputRoot { get; set; } = @"..\..\..\recording\output";
    /// <summary>Keep WebM spool after a verified MP4 (PoC analysis only; false in production).</summary>
    public bool KeepSpoolAfterSuccess { get; set; }
}

public sealed class FfmpegOptions
{
    public string FfmpegPath { get; set; } = "ffmpeg";
    public string FfprobePath { get; set; } = "ffprobe";
    public string X264Preset { get; set; } = "veryfast";
    public int Crf { get; set; } = 23;
    public int AudioBitrateKbps { get; set; } = 128;
    /// <summary>Lower priority so post-processing never starves live recordings.</summary>
    public bool BelowNormalPriority { get; set; } = true;
}

public sealed class HealthOptions
{
    public int PollSeconds { get; set; } = 2;
    /// <summary>No new chunk for this long = stalled recorder → restart a new segment.</summary>
    public int StallSeconds { get; set; } = 12;
    public int MaxRestarts { get; set; } = 5;
    /// <summary>How long a vanished room may stay absent (e.g. SFU restart) before the recording is finalised.</summary>
    public int RoomGoneGraceSeconds { get; set; } = 30;
    public int MaxDurationMinutes { get; set; } = 240;
    /// <summary>Allowed difference between MP4 duration and recorded wall time.</summary>
    public double DurationTolerancePercent { get; set; } = 3;
    public double DurationToleranceMinSeconds { get; set; } = 5;
}
