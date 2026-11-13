-- V023: external API platform (12 Nov 2026, business owner: "API Key").
--   Each external portal is an integration with its own API keys (only a SHA-256 hash is stored; the key is shown once),
--   scopes, rate limit, webhook subscription, request log and idempotency records. Meetings and recordings created through
--   an integration carry its IntegrationId; every external query filters on it, so one portal can never see another's data.
--   No existing table is reused: app.WebhookEvents is the INBOUND LiveKit log; nothing outbound or key-based existed.
--   Rollback: drop the FK columns mtg.Meetings.IntegrationId/ExternalReference and rec.MeetingRecordings.IntegrationId (and their
--   indexes/FKs), then DROP TABLE app.WebhookDeliveries, app.WebhookSubscriptions, app.ApiIdempotency, app.ApiRequestLog,
--   app.ApiKeys, app.ApiIntegrationScopes, app.ApiIntegrations; DELETE the integrations.manage permission rows.

CREATE TABLE app.ApiIntegrations (
    IntegrationId          BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_ApiIntegrations PRIMARY KEY,
    PublicId               UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_ApiIntegrations_PublicId DEFAULT (NEWSEQUENTIALID()),
    IntegrationCode        VARCHAR(40)    NOT NULL,
    Name                   NVARCHAR(100)  NOT NULL,
    PortalName             NVARCHAR(200)  NOT NULL,
    Description            NVARCHAR(1000) NULL,
    IsActive               BIT            NOT NULL CONSTRAINT DF_ApiIntegrations_IsActive DEFAULT (1),
    RateLimitPerMinute     INT            NOT NULL CONSTRAINT DF_ApiIntegrations_Rate DEFAULT (60),
    -- Meetings created without an explicit host e-mail are hosted by this employee (optional).
    DefaultHostEmployeeId  BIGINT         NULL CONSTRAINT FK_ApiIntegrations_DefaultHost REFERENCES org.Employees (EmployeeId),
    LastUsedUtc            DATETIME2(3)   NULL,
    CreatedUtc             DATETIME2(3)   NOT NULL CONSTRAINT DF_ApiIntegrations_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    CreatedByUserId        BIGINT         NULL,
    ModifiedUtc            DATETIME2(3)   NULL,
    ModifiedByUserId       BIGINT         NULL,
    DeactivatedUtc         DATETIME2(3)   NULL,
    CONSTRAINT UQ_ApiIntegrations_PublicId UNIQUE (PublicId),
    CONSTRAINT UQ_ApiIntegrations_Code UNIQUE (IntegrationCode),
    CONSTRAINT UQ_ApiIntegrations_Name UNIQUE (Name),
    CONSTRAINT CK_ApiIntegrations_Rate CHECK (RateLimitPerMinute BETWEEN 1 AND 6000),
    CONSTRAINT CK_ApiIntegrations_Code CHECK (IntegrationCode LIKE 'INT-%')
);

CREATE TABLE app.ApiIntegrationScopes (
    IntegrationId  BIGINT       NOT NULL CONSTRAINT FK_ApiIntegrationScopes_Integration REFERENCES app.ApiIntegrations (IntegrationId),
    Scope          VARCHAR(40)  NOT NULL,
    GrantedUtc     DATETIME2(3) NOT NULL CONSTRAINT DF_ApiIntegrationScopes_GrantedUtc DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT PK_ApiIntegrationScopes PRIMARY KEY (IntegrationId, Scope),
    CONSTRAINT CK_ApiIntegrationScopes_Scope CHECK (Scope IN ('meeting.create', 'meeting.read', 'meeting.schedule', 'meeting.cancel',
        'recording.read', 'recording.download', 'meeting.json.read', 'webhook.manage'))
);

CREATE TABLE app.ApiKeys (
    KeyId            BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_ApiKeys PRIMARY KEY,
    PublicId         UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_ApiKeys_PublicId DEFAULT (NEWSEQUENTIALID()),
    IntegrationId    BIGINT         NOT NULL CONSTRAINT FK_ApiKeys_Integration REFERENCES app.ApiIntegrations (IntegrationId),
    -- Non-secret lookup part shown in the admin list ("oic_live_ab12cd34ef56…"); the secret is never stored, only SHA-256(full key).
    KeyPrefix        VARCHAR(40)    NOT NULL,
    SecretHash       VARBINARY(32)  NOT NULL,
    CreatedUtc       DATETIME2(3)   NOT NULL CONSTRAINT DF_ApiKeys_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    CreatedByUserId  BIGINT         NULL,
    RevokedUtc       DATETIME2(3)   NULL,
    RevokedByUserId  BIGINT         NULL,
    RevokedReason    NVARCHAR(200)  NULL,
    LastUsedUtc      DATETIME2(3)   NULL,
    LastUsedIp       VARCHAR(45)    NULL,
    CONSTRAINT UQ_ApiKeys_PublicId UNIQUE (PublicId),
    CONSTRAINT UQ_ApiKeys_Prefix UNIQUE (KeyPrefix)
);
CREATE INDEX IX_ApiKeys_Integration ON app.ApiKeys (IntegrationId) INCLUDE (RevokedUtc);

CREATE TABLE app.ApiRequestLog (
    LogId          BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_ApiRequestLog PRIMARY KEY,
    Utc            DATETIME2(3)   NOT NULL CONSTRAINT DF_ApiRequestLog_Utc DEFAULT (SYSUTCDATETIME()),
    IntegrationId  BIGINT         NULL,
    KeyId          BIGINT         NULL,
    Method         VARCHAR(10)    NOT NULL,
    Path           NVARCHAR(400)  NOT NULL,
    StatusCode     INT            NOT NULL,
    DurationMs     INT            NOT NULL,
    Ip             VARCHAR(45)    NULL,
    ErrorCode      VARCHAR(60)    NULL
);
CREATE INDEX IX_ApiRequestLog_Integration ON app.ApiRequestLog (IntegrationId, Utc DESC);

CREATE TABLE app.ApiIdempotency (
    IntegrationId   BIGINT         NOT NULL CONSTRAINT FK_ApiIdempotency_Integration REFERENCES app.ApiIntegrations (IntegrationId),
    IdempotencyKey  VARCHAR(100)   NOT NULL,
    RequestHash     VARBINARY(32)  NOT NULL,
    StatusCode      INT            NOT NULL, -- 0 = request in progress
    ResponseJson    NVARCHAR(MAX)  NULL,
    CreatedUtc      DATETIME2(3)   NOT NULL CONSTRAINT DF_ApiIdempotency_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT PK_ApiIdempotency PRIMARY KEY (IntegrationId, IdempotencyKey)
);

CREATE TABLE app.WebhookSubscriptions (
    SubscriptionId    BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_WebhookSubscriptions PRIMARY KEY,
    IntegrationId     BIGINT         NOT NULL CONSTRAINT FK_WebhookSubscriptions_Integration REFERENCES app.ApiIntegrations (IntegrationId),
    Url               NVARCHAR(500)  NOT NULL,
    -- Signing secret, encrypted with ASP.NET Data Protection (it must be readable to sign deliveries; never returned after creation).
    SecretProtected   NVARCHAR(1000) NOT NULL,
    Events            VARCHAR(600)   NOT NULL, -- comma-separated event types
    IsActive          BIT            NOT NULL CONSTRAINT DF_WebhookSubscriptions_IsActive DEFAULT (1),
    CreatedUtc        DATETIME2(3)   NOT NULL CONSTRAINT DF_WebhookSubscriptions_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    ModifiedUtc       DATETIME2(3)   NULL,
    CONSTRAINT UQ_WebhookSubscriptions_Integration UNIQUE (IntegrationId),
    CONSTRAINT CK_WebhookSubscriptions_Https CHECK (Url LIKE 'https://%' OR Url LIKE 'http://localhost%' OR Url LIKE 'http://127.0.0.1%')
);

CREATE TABLE app.WebhookDeliveries (
    DeliveryId       BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_WebhookDeliveries PRIMARY KEY,
    EventId          UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_WebhookDeliveries_EventId DEFAULT (NEWID()),
    IntegrationId    BIGINT         NOT NULL CONSTRAINT FK_WebhookDeliveries_Integration REFERENCES app.ApiIntegrations (IntegrationId),
    SubscriptionId   BIGINT         NOT NULL CONSTRAINT FK_WebhookDeliveries_Subscription REFERENCES app.WebhookSubscriptions (SubscriptionId),
    EventType        VARCHAR(50)    NOT NULL,
    MeetingId        BIGINT         NULL,
    -- What the event is about (e.g. "m:123", "a:456" attendance row, "r:789" recording): with EventType it makes enqueuing
    -- idempotent - the same state change can never be delivered twice (UX_WebhookDeliveries_Source).
    SourceRef        VARCHAR(80)    NOT NULL,
    PayloadJson      NVARCHAR(MAX)  NOT NULL,
    CreatedUtc       DATETIME2(3)   NOT NULL CONSTRAINT DF_WebhookDeliveries_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    [Status]         VARCHAR(12)    NOT NULL CONSTRAINT DF_WebhookDeliveries_Status DEFAULT ('PENDING'),
    Attempts         INT            NOT NULL CONSTRAINT DF_WebhookDeliveries_Attempts DEFAULT (0),
    NextAttemptUtc   DATETIME2(3)   NOT NULL CONSTRAINT DF_WebhookDeliveries_Next DEFAULT (SYSUTCDATETIME()),
    LeaseUntilUtc    DATETIME2(3)   NULL,
    LastAttemptUtc   DATETIME2(3)   NULL,
    LastStatusCode   INT            NULL,
    LastError        NVARCHAR(1000) NULL,
    DeliveredUtc     DATETIME2(3)   NULL,
    CONSTRAINT UQ_WebhookDeliveries_EventId UNIQUE (EventId),
    CONSTRAINT CK_WebhookDeliveries_Status CHECK ([Status] IN ('PENDING', 'DELIVERED', 'FAILED')),
    CONSTRAINT CK_WebhookDeliveries_Json CHECK (ISJSON(PayloadJson) = 1)
);
CREATE UNIQUE INDEX UX_WebhookDeliveries_Source ON app.WebhookDeliveries (IntegrationId, EventType, SourceRef);
CREATE INDEX IX_WebhookDeliveries_Due ON app.WebhookDeliveries (NextAttemptUtc) WHERE [Status] = 'PENDING';
CREATE INDEX IX_WebhookDeliveries_Integration ON app.WebhookDeliveries (IntegrationId, CreatedUtc DESC);
GO

ALTER TABLE mtg.Meetings ADD IntegrationId BIGINT NULL CONSTRAINT FK_Meetings_Integration REFERENCES app.ApiIntegrations (IntegrationId),
    ExternalReference NVARCHAR(100) NULL;
ALTER TABLE rec.MeetingRecordings ADD IntegrationId BIGINT NULL CONSTRAINT FK_MeetingRecordings_Integration REFERENCES app.ApiIntegrations (IntegrationId);
GO
CREATE INDEX IX_Meetings_Integration ON mtg.Meetings (IntegrationId, CreatedUtc DESC) INCLUDE (ExternalReference) WHERE IntegrationId IS NOT NULL;
GO

-- Actions taken through the external API are audited as ActorType 'INTEGRATION' (ActorUserId = the mapped host's login).
ALTER TABLE app.AuditLog DROP CONSTRAINT CK_AuditLog_ActorType;
ALTER TABLE app.AuditLog ADD CONSTRAINT CK_AuditLog_ActorType CHECK (ActorType IN ('USER', 'CUSTOMER', 'SYSTEM', 'INTEGRATION'));
GO

INSERT auth.Permissions (Code, Module, Description) VALUES
 ('integrations.manage', 'System', N'Manage external API integrations: create portals, issue/rotate/revoke API keys, scopes, webhooks and view API logs');
GO
INSERT auth.RolePermissions (RoleId, PermissionId)
SELECT r.RoleId, p.PermissionId
FROM auth.Roles r CROSS JOIN auth.Permissions p
WHERE r.Code IN ('Admin', 'SuperAdmin') AND p.Code = 'integrations.manage'
  AND NOT EXISTS (SELECT 1 FROM auth.RolePermissions rp WHERE rp.RoleId = r.RoleId AND rp.PermissionId = p.PermissionId);
GO

INSERT app.AuditLog ([Utc], ActorType, [Action], EntityType, EntityId, Summary, NewValuesJson)
VALUES (SYSUTCDATETIME(), 'SYSTEM', 'SCHEMA_CHANGED', 'Schema', 'V023',
    N'Migration V023: external API integrations (keys, scopes, request log, idempotency, webhooks); integrations.manage for Admin and SuperAdmin',
    N'{"tables":["app.ApiIntegrations","app.ApiIntegrationScopes","app.ApiKeys","app.ApiRequestLog","app.ApiIdempotency","app.WebhookSubscriptions","app.WebhookDeliveries"]}');
