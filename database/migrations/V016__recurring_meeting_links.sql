-- V016: one shareable link for a whole recurring series, instead of a different one per occurrence.
-- mtg.MeetingLinks gets an optional SeriesId; exactly one of MeetingId/SeriesId is set per row. A series-scoped
-- link resolves, at the moment it is opened, to whichever occurrence is relevant right then (the one currently
-- live, else the earliest upcoming one that has not ended yet) - the same link keeps working for every future
-- occurrence, the way a recurring Zoom/Teams link does. A plain per-meeting link (MeetingId set, the existing
-- behaviour for one-off and instant meetings) is completely unaffected.

ALTER TABLE mtg.MeetingLinks ADD SeriesId BIGINT NULL CONSTRAINT FK_MeetingLinks_Series REFERENCES mtg.MeetingSeries (SeriesId);
GO
ALTER TABLE mtg.MeetingLinks ALTER COLUMN MeetingId BIGINT NULL;
GO
ALTER TABLE mtg.MeetingLinks ADD CONSTRAINT CK_MeetingLinks_OneTarget CHECK (
    (MeetingId IS NOT NULL AND SeriesId IS NULL) OR (MeetingId IS NULL AND SeriesId IS NOT NULL)
);
GO

DROP INDEX UX_MeetingLinks_Active ON mtg.MeetingLinks;
GO
CREATE UNIQUE INDEX UX_MeetingLinks_Active_Meeting ON mtg.MeetingLinks (MeetingId) WHERE RevokedUtc IS NULL AND MeetingId IS NOT NULL;
CREATE UNIQUE INDEX UX_MeetingLinks_Active_Series ON mtg.MeetingLinks (SeriesId) WHERE RevokedUtc IS NULL AND SeriesId IS NOT NULL;
GO
