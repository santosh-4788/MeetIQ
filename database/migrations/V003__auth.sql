-- V003: identity and access (auth). No credentials are seeded; the first SuperAdmin is created through /setup.
-- Secrets are never stored in plain text: passwords as hashes, tokens/session ids as SHA-256, MFA secrets encrypted.

CREATE TABLE auth.Users (
    UserId              BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Users PRIMARY KEY,
    PublicId            UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_Users_PublicId DEFAULT (NEWSEQUENTIALID()),
    EmployeeId          BIGINT         NULL CONSTRAINT FK_Users_Employee REFERENCES org.Employees (EmployeeId),
    Email               NVARCHAR(254)  NOT NULL CONSTRAINT UQ_Users_Email UNIQUE,
    EmployeeCode        VARCHAR(30)    NULL,
    PasswordHash        VARCHAR(400)   NULL,
    PasswordChangedUtc  DATETIME2(3)   NULL,
    SecurityStamp       UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_Users_SecurityStamp DEFAULT (NEWID()),
    MustChangePassword  BIT            NOT NULL CONSTRAINT DF_Users_MustChangePassword DEFAULT (0),
    FailedLoginCount    INT            NOT NULL CONSTRAINT DF_Users_FailedLoginCount DEFAULT (0),
    LockoutEndUtc       DATETIME2(3)   NULL,
    IsLocked            BIT            NOT NULL CONSTRAINT DF_Users_IsLocked DEFAULT (0),
    MfaEnabled          BIT            NOT NULL CONSTRAINT DF_Users_MfaEnabled DEFAULT (0),
    TimeZoneId          VARCHAR(64)    NOT NULL CONSTRAINT DF_Users_TimeZoneId DEFAULT ('Asia/Kolkata'),
    LastLoginUtc        DATETIME2(3)   NULL,
    IsActive            BIT            NOT NULL CONSTRAINT DF_Users_IsActive DEFAULT (1),
    DeactivatedUtc      DATETIME2(3)   NULL,
    CreatedUtc          DATETIME2(3)   NOT NULL CONSTRAINT DF_Users_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    CreatedByUserId     BIGINT         NULL,
    ModifiedUtc         DATETIME2(3)   NULL,
    ModifiedByUserId    BIGINT         NULL,
    RowVersion          ROWVERSION     NOT NULL,
    CONSTRAINT UQ_Users_PublicId UNIQUE (PublicId),
    CONSTRAINT CK_Users_FailedLoginCount CHECK (FailedLoginCount >= 0)
);
CREATE UNIQUE INDEX UX_Users_EmployeeId ON auth.Users (EmployeeId) WHERE EmployeeId IS NOT NULL;
CREATE UNIQUE INDEX UX_Users_EmployeeCode ON auth.Users (EmployeeCode) WHERE EmployeeCode IS NOT NULL;

CREATE TABLE auth.Roles (
    RoleId              INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Roles PRIMARY KEY,
    Code                VARCHAR(50)    NOT NULL CONSTRAINT UQ_Roles_Code UNIQUE,
    Name                NVARCHAR(100)  NOT NULL,
    Description         NVARCHAR(400)  NULL,
    IsSystem            BIT            NOT NULL CONSTRAINT DF_Roles_IsSystem DEFAULT (0),
    CreatedUtc          DATETIME2(3)   NOT NULL CONSTRAINT DF_Roles_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    CreatedByUserId     BIGINT         NULL,
    ModifiedUtc         DATETIME2(3)   NULL,
    ModifiedByUserId    BIGINT         NULL,
    RowVersion          ROWVERSION     NOT NULL
);

CREATE TABLE auth.Permissions (
    PermissionId        INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Permissions PRIMARY KEY,
    Code                VARCHAR(100)   NOT NULL CONSTRAINT UQ_Permissions_Code UNIQUE,
    Module              VARCHAR(50)    NOT NULL,
    Description         NVARCHAR(400)  NULL
);

CREATE TABLE auth.RolePermissions (
    RoleId              INT            NOT NULL CONSTRAINT FK_RolePermissions_Role REFERENCES auth.Roles (RoleId),
    PermissionId        INT            NOT NULL CONSTRAINT FK_RolePermissions_Permission REFERENCES auth.Permissions (PermissionId),
    GrantedUtc          DATETIME2(3)   NOT NULL CONSTRAINT DF_RolePermissions_GrantedUtc DEFAULT (SYSUTCDATETIME()),
    GrantedByUserId     BIGINT         NULL,
    CONSTRAINT PK_RolePermissions PRIMARY KEY (RoleId, PermissionId)
);

CREATE TABLE auth.UserRoles (
    UserId              BIGINT         NOT NULL CONSTRAINT FK_UserRoles_User REFERENCES auth.Users (UserId),
    RoleId              INT            NOT NULL CONSTRAINT FK_UserRoles_Role REFERENCES auth.Roles (RoleId),
    AssignedUtc         DATETIME2(3)   NOT NULL CONSTRAINT DF_UserRoles_AssignedUtc DEFAULT (SYSUTCDATETIME()),
    AssignedByUserId    BIGINT         NULL,
    CONSTRAINT PK_UserRoles PRIMARY KEY (UserId, RoleId)
);
CREATE INDEX IX_UserRoles_Role ON auth.UserRoles (RoleId);

-- SessionId is the non-secret handle shown in "active sessions"; the cookie value is only stored as TokenHash.
CREATE TABLE auth.UserSessions (
    SessionId           UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_UserSessions PRIMARY KEY NONCLUSTERED,
    TokenHash           BINARY(32)     NOT NULL CONSTRAINT UQ_UserSessions_TokenHash UNIQUE,
    UserId              BIGINT         NOT NULL CONSTRAINT FK_UserSessions_User REFERENCES auth.Users (UserId),
    CreatedUtc          DATETIME2(3)   NOT NULL CONSTRAINT DF_UserSessions_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    LastSeenUtc         DATETIME2(3)   NOT NULL CONSTRAINT DF_UserSessions_LastSeenUtc DEFAULT (SYSUTCDATETIME()),
    ExpiresUtc          DATETIME2(3)   NOT NULL,
    AbsoluteExpiryUtc   DATETIME2(3)   NOT NULL,
    IpAddress           VARCHAR(45)    NULL,
    UserAgent           NVARCHAR(512)  NULL,
    RevokedUtc          DATETIME2(3)   NULL,
    RevokedReason       VARCHAR(50)    NULL,
    CONSTRAINT CK_UserSessions_Expiry CHECK (ExpiresUtc <= AbsoluteExpiryUtc)
);
CREATE CLUSTERED INDEX CIX_UserSessions_User ON auth.UserSessions (UserId, CreatedUtc);

CREATE TABLE auth.UserMfaMethods (
    MfaMethodId         BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_UserMfaMethods PRIMARY KEY,
    UserId              BIGINT         NOT NULL CONSTRAINT FK_UserMfaMethods_User REFERENCES auth.Users (UserId),
    [Type]              VARCHAR(30)    NOT NULL CONSTRAINT CK_UserMfaMethods_Type CHECK ([Type] IN ('TOTP', 'EMAIL_OTP')),
    SecretEncrypted     VARBINARY(512) NULL,
    IsPrimary           BIT            NOT NULL CONSTRAINT DF_UserMfaMethods_IsPrimary DEFAULT (0),
    VerifiedUtc         DATETIME2(3)   NULL,
    RecoveryCodesHash   NVARCHAR(MAX)  NULL,
    CreatedUtc          DATETIME2(3)   NOT NULL CONSTRAINT DF_UserMfaMethods_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    RowVersion          ROWVERSION     NOT NULL,
    CONSTRAINT CK_UserMfaMethods_TotpSecret CHECK ([Type] <> 'TOTP' OR SecretEncrypted IS NOT NULL)
);
CREATE UNIQUE INDEX UX_UserMfaMethods_Type ON auth.UserMfaMethods (UserId, [Type]);
CREATE UNIQUE INDEX UX_UserMfaMethods_Primary ON auth.UserMfaMethods (UserId) WHERE IsPrimary = 1;

CREATE TABLE auth.PasswordResetTokens (
    TokenId             BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_PasswordResetTokens PRIMARY KEY,
    UserId              BIGINT         NOT NULL CONSTRAINT FK_PasswordResetTokens_User REFERENCES auth.Users (UserId),
    TokenHash           BINARY(32)     NOT NULL CONSTRAINT UQ_PasswordResetTokens_TokenHash UNIQUE,
    CreatedUtc          DATETIME2(3)   NOT NULL CONSTRAINT DF_PasswordResetTokens_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    ExpiresUtc          DATETIME2(3)   NOT NULL,
    UsedUtc             DATETIME2(3)   NULL,
    RequestIp           VARCHAR(45)    NULL,
    CONSTRAINT CK_PasswordResetTokens_Expiry CHECK (ExpiresUtc > CreatedUtc)
);
CREATE INDEX IX_PasswordResetTokens_User ON auth.PasswordResetTokens (UserId, CreatedUtc);

CREATE TABLE auth.LoginAttempts (
    AttemptId           BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_LoginAttempts PRIMARY KEY,
    LoginName           NVARCHAR(254)  NOT NULL,
    UserId              BIGINT         NULL CONSTRAINT FK_LoginAttempts_User REFERENCES auth.Users (UserId),
    Succeeded           BIT            NOT NULL,
    FailureReason       VARCHAR(30)    NULL,
    IpAddress           VARCHAR(45)    NULL,
    UserAgent           NVARCHAR(512)  NULL,
    AttemptUtc          DATETIME2(3)   NOT NULL CONSTRAINT DF_LoginAttempts_AttemptUtc DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT CK_LoginAttempts_Reason CHECK (Succeeded = 1 OR FailureReason IS NOT NULL)
);
CREATE INDEX IX_LoginAttempts_LoginName ON auth.LoginAttempts (LoginName, AttemptUtc);
CREATE INDEX IX_LoginAttempts_Ip ON auth.LoginAttempts (IpAddress, AttemptUtc);
GO
