using System.Text.Json;

namespace OneInsure.Connect.Recorder;

/// <summary>Append-only JSON-lines event log per recording job (also echoed to the console).</summary>
public sealed class EventLog(string path) : IDisposable
{
    private readonly StreamWriter _writer = new(new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.Read)) { AutoFlush = true };
    private readonly Lock _gate = new();

    public void Write(string type, object? data = null)
    {
        var line = JsonSerializer.Serialize(new { atUtc = DateTimeOffset.UtcNow, source = "host", type, data });
        lock (_gate)
        {
            _writer.WriteLine(line);
            Console.WriteLine(line);
        }
    }

    /// <summary>Events raised by the layout page arrive pre-serialised.</summary>
    public void WriteRaw(string json)
    {
        string line;
        try
        {
            using var doc = JsonDocument.Parse(json);
            line = JsonSerializer.Serialize(new { source = "page", evt = doc.RootElement });
        }
        catch (JsonException)
        {
            line = JsonSerializer.Serialize(new { source = "page", invalid = json });
        }
        lock (_gate)
        {
            _writer.WriteLine(line);
            Console.WriteLine(line);
        }
    }

    public void Dispose() => _writer.Dispose();
}
