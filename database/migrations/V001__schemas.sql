-- V001: schemas for OneInsureVideoMeetingDB.
-- Deviation from DATABASE_DESIGN.md v1: the platform schema is `app`, not `sys`.
-- SQL Server reserves `sys` for system objects; CREATE TABLE sys.* fails even for sysadmin (Msg 2760).
CREATE SCHEMA auth AUTHORIZATION dbo;
GO
CREATE SCHEMA org AUTHORIZATION dbo;
GO
CREATE SCHEMA crm AUTHORIZATION dbo;
GO
CREATE SCHEMA mtg AUTHORIZATION dbo;
GO
CREATE SCHEMA rec AUTHORIZATION dbo;
GO
CREATE SCHEMA app AUTHORIZATION dbo;
GO
