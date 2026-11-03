namespace OneInsure.Connect.Recorder;

/// <summary>
/// Writes one WebM segment (one browser session) to the local spool. Every chunk is flushed to disk
/// immediately, so a browser or host crash loses at most the in-flight timeslice.
/// </summary>
public sealed class SegmentWriter : IDisposable
{
    private readonly FileStream _stream;
    private int _expectedSeq;

    public SegmentWriter(string path)
    {
        FilePath = path;
        _stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read, 1 << 16, FileOptions.WriteThrough);
        StartedUtc = DateTimeOffset.UtcNow;
    }

    public string FilePath { get; }
    public DateTimeOffset StartedUtc { get; }
    public DateTimeOffset? LastChunkUtc { get; private set; }
    public DateTimeOffset? FirstChunkUtc { get; private set; }
    public long Bytes { get; private set; }
    public int Chunks { get; private set; }
    public int SequenceGaps { get; private set; }
    /// <summary>When MediaRecorder started / stopped in the page (reported via events).</summary>
    public DateTimeOffset? RecordingStartedUtc { get; private set; }
    public DateTimeOffset? RecordingStoppedUtc { get; private set; }

    public void MarkRecordingStarted() => RecordingStartedUtc ??= DateTimeOffset.UtcNow;
    public void MarkRecordingStopped() => RecordingStoppedUtc ??= DateTimeOffset.UtcNow;

    public void Append(int seq, string base64)
    {
        if (seq != _expectedSeq) SequenceGaps++;
        _expectedSeq = seq + 1;
        var bytes = Convert.FromBase64String(base64);
        _stream.Write(bytes);
        _stream.Flush(flushToDisk: true);
        Bytes += bytes.Length;
        Chunks++;
        FirstChunkUtc ??= DateTimeOffset.UtcNow;
        LastChunkUtc = DateTimeOffset.UtcNow;
    }

    /// <summary>
    /// Wall-clock time this segment's MediaRecorder was running. If the browser died before reporting
    /// a stop, the last persisted chunk is the end of the usable media.
    /// </summary>
    public TimeSpan CoveredDuration(TimeSpan timeslice)
    {
        if (LastChunkUtc is null) return TimeSpan.Zero;
        var start = RecordingStartedUtc ?? FirstChunkUtc!.Value - timeslice;
        var end = RecordingStoppedUtc ?? LastChunkUtc.Value;
        return end - start;
    }

    public void Dispose() => _stream.Dispose();
}
