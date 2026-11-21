-- Rollback for V033 (task collaboration). Run ONLY if V033 must be removed: it deletes the copies of tasks that were ASSIGNED to
-- other people, checklists, task history and comments, proof-file records (the stored files stay on disk), note shares, note colours,
-- the task e-mail preference and the TASK_* / NOTE_SHARED notifications. Each person's own (unassigned) tasks and notes stay.
-- Tasks in IN_REVIEW go back to IN_PROGRESS. Take a database backup first. Switching TASK_COLLAB off is the normal,
-- data-preserving way to stop the feature.
SET XACT_ABORT ON;
BEGIN TRANSACTION;

DELETE FROM mtg.MeetingNotifications WHERE [Type] IN ('TASK_ASSIGNED', 'TASK_UPDATE', 'TASK_REVIEW', 'TASK_COMMENT', 'TASK_DUE', 'NOTE_SHARED');
ALTER TABLE mtg.MeetingNotifications DROP CONSTRAINT CK_MeetingNotifications_Type;
ALTER TABLE mtg.MeetingNotifications ADD CONSTRAINT CK_MeetingNotifications_Type CHECK ([Type] IN
    ('INVITATION', 'REMINDER', 'RESCHEDULED', 'CANCELLED', 'STARTING_SOON', 'RECORDING_AVAILABLE', 'RECORDING_FAILED', 'ADMIT_REQUEST', 'RESPONSE', 'MISSED_CALL',
     'TASK_REMINDER', 'NOTE_REMINDER', 'CHAT_MENTION', 'GROUP_ADDED'));

DELETE FROM app.FeatureSettings WHERE FeatureKey = 'TASK_COLLAB';

DROP TABLE IF EXISTS chat.TRN_ChatTaskChecklist;
DROP TABLE IF EXISTS chat.TRN_ChatTaskActivity;
DROP TABLE IF EXISTS chat.TRN_ChatTaskFile;
DROP TABLE IF EXISTS chat.TRN_ChatNoteShare;

-- Assigned copies: their reminders, links from notes and repeats first, then the rows.
UPDATE chat.TRN_ChatNote SET TaskId = NULL WHERE TaskId IN (SELECT TaskId FROM chat.TRN_ChatTask WHERE AssignedByUserId IS NOT NULL);
DELETE FROM chat.TRN_ChatReminder WHERE TaskId IN (SELECT TaskId FROM chat.TRN_ChatTask WHERE AssignedByUserId IS NOT NULL);
UPDATE chat.TRN_ChatTask SET RepeatedFromTaskId = NULL WHERE RepeatedFromTaskId IN (SELECT TaskId FROM chat.TRN_ChatTask WHERE AssignedByUserId IS NOT NULL);
DELETE FROM chat.TRN_ChatTask WHERE AssignedByUserId IS NOT NULL;
UPDATE chat.TRN_ChatTask SET [Status] = 'IN_PROGRESS' WHERE [Status] = 'IN_REVIEW';

ALTER TABLE chat.TRN_ChatTask DROP CONSTRAINT CK_TRN_ChatTask_Status;
ALTER TABLE chat.TRN_ChatTask ADD CONSTRAINT CK_TRN_ChatTask_Status CHECK ([Status] IN ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'POSTPONED', 'CANCELLED'));
IF OBJECT_ID(N'chat.CK_TRN_ChatTask_Assigned', N'C') IS NOT NULL ALTER TABLE chat.TRN_ChatTask DROP CONSTRAINT CK_TRN_ChatTask_Assigned;
IF OBJECT_ID(N'chat.CK_TRN_ChatTask_AssignState', N'C') IS NOT NULL ALTER TABLE chat.TRN_ChatTask DROP CONSTRAINT CK_TRN_ChatTask_AssignState;
IF OBJECT_ID(N'chat.FK_TRN_ChatTask_AssignedBy', N'F') IS NOT NULL ALTER TABLE chat.TRN_ChatTask DROP CONSTRAINT FK_TRN_ChatTask_AssignedBy;
IF OBJECT_ID(N'chat.DF_TRN_ChatTask_RequiresReview', N'D') IS NOT NULL ALTER TABLE chat.TRN_ChatTask DROP CONSTRAINT DF_TRN_ChatTask_RequiresReview;
DROP INDEX IF EXISTS IX_TRN_ChatTask_AssignedBy ON chat.TRN_ChatTask;
DROP INDEX IF EXISTS IX_TRN_ChatTask_AssignmentKey ON chat.TRN_ChatTask;
ALTER TABLE chat.TRN_ChatTask DROP COLUMN AssignedByUserId, AssignmentKey, AssignState, RequiresReview, RequestedDueUtc, RequestReason,
    SubmittedUtc, ReviewedUtc, FocusUtc, DueSoonSentUtc, OverdueSentUtc;

IF OBJECT_ID(N'chat.CK_TRN_ChatNote_Color', N'C') IS NOT NULL ALTER TABLE chat.TRN_ChatNote DROP CONSTRAINT CK_TRN_ChatNote_Color;
IF COL_LENGTH(N'chat.TRN_ChatNote', N'Color') IS NOT NULL ALTER TABLE chat.TRN_ChatNote DROP COLUMN Color;
IF OBJECT_ID(N'chat.DF_MST_ChatUserPreference_TaskEmails', N'D') IS NOT NULL ALTER TABLE chat.MST_ChatUserPreference DROP CONSTRAINT DF_MST_ChatUserPreference_TaskEmails;
IF COL_LENGTH(N'chat.MST_ChatUserPreference', N'TaskEmails') IS NOT NULL ALTER TABLE chat.MST_ChatUserPreference DROP COLUMN TaskEmails;

DELETE FROM dbo.SchemaMigrations WHERE ScriptName = 'V033__task_collaboration.sql';

COMMIT TRANSACTION;
