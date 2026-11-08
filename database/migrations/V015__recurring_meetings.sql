-- V015: recurring meetings.
-- A recurring booking is generated as independent mtg.Meetings rows (one per occurrence), linked by
-- mtg.MeetingSeries. Every existing per-meeting mechanism keeps working unchanged on each occurrence -
-- conflict detection, recording policy, participants, invitations, reminders, cancellation, reports,
-- host transfer, the join flow: none of it needs to know a meeting belongs to a series. "Recurring" only
-- adds a way to create many real meetings at once (bounded: at most 52 occurrences, within one year) and to
-- cancel the rest of a series together.

CREATE TABLE mtg.MeetingSeries (
    SeriesId            BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_MeetingSeries PRIMARY KEY,
    PublicId            UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_MeetingSeries_PublicId DEFAULT (NEWSEQUENTIALID()),
    Pattern             VARCHAR(10)   NOT NULL,
    IntervalCount       INT           NOT NULL CONSTRAINT DF_MeetingSeries_Interval DEFAULT (1),
    ByWeekdaysMask      TINYINT       NULL, -- WEEKLY only: bitmask Mon=1, Tue=2, Wed=4, Thu=8, Fri=16, Sat=32, Sun=64
    EndType             VARCHAR(10)   NOT NULL,
    EndCount            INT           NULL,
    EndUntilUtc         DATETIME2(3)  NULL,
    TimeZoneId          VARCHAR(64)   NOT NULL,
    CreatedByEmployeeId BIGINT        NOT NULL CONSTRAINT FK_MeetingSeries_CreatedBy REFERENCES org.Employees (EmployeeId),
    CreatedUtc          DATETIME2(3)  NOT NULL CONSTRAINT DF_MeetingSeries_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT UQ_MeetingSeries_PublicId UNIQUE (PublicId),
    CONSTRAINT CK_MeetingSeries_Pattern CHECK (Pattern IN ('DAILY', 'WEEKLY', 'MONTHLY')),
    CONSTRAINT CK_MeetingSeries_Interval CHECK (IntervalCount BETWEEN 1 AND 30),
    CONSTRAINT CK_MeetingSeries_Weekdays CHECK (Pattern <> 'WEEKLY' OR (ByWeekdaysMask IS NOT NULL AND ByWeekdaysMask BETWEEN 1 AND 127)),
    CONSTRAINT CK_MeetingSeries_EndType CHECK (EndType IN ('COUNT', 'UNTIL')),
    CONSTRAINT CK_MeetingSeries_End CHECK (
        (EndType = 'COUNT' AND EndCount IS NOT NULL AND EndCount BETWEEN 2 AND 52 AND EndUntilUtc IS NULL)
        OR (EndType = 'UNTIL' AND EndUntilUtc IS NOT NULL AND EndCount IS NULL)
    )
);
GO

ALTER TABLE mtg.Meetings ADD
    SeriesId  BIGINT NULL CONSTRAINT FK_Meetings_Series REFERENCES mtg.MeetingSeries (SeriesId),
    SeriesSeq INT    NULL;
GO
ALTER TABLE mtg.Meetings ADD CONSTRAINT CK_Meetings_SeriesSeq CHECK (
    (SeriesId IS NULL AND SeriesSeq IS NULL) OR (SeriesId IS NOT NULL AND SeriesSeq IS NOT NULL AND SeriesSeq >= 1)
);
GO
CREATE INDEX IX_Meetings_Series ON mtg.Meetings (SeriesId, SeriesSeq) WHERE SeriesId IS NOT NULL;
GO
