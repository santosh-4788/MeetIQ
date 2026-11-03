-- V002: organisation masters (org). Independent of Prarambh; ExternalRef is reserved for a future mapping.
-- Audit "*ByUserId" columns carry no FK on purpose: auth.Users is created later and references org.Employees.

CREATE TABLE org.Departments (
    DepartmentId        BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Departments PRIMARY KEY,
    Code                VARCHAR(30)    NOT NULL CONSTRAINT UQ_Departments_Code UNIQUE,
    Name                NVARCHAR(150)  NOT NULL,
    HeadEmployeeId      BIGINT         NULL,
    ParentDepartmentId  BIGINT         NULL CONSTRAINT FK_Departments_Parent REFERENCES org.Departments (DepartmentId),
    IsActive            BIT            NOT NULL CONSTRAINT DF_Departments_IsActive DEFAULT (1),
    DeactivatedUtc      DATETIME2(3)   NULL,
    CreatedUtc          DATETIME2(3)   NOT NULL CONSTRAINT DF_Departments_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    CreatedByUserId     BIGINT         NULL,
    ModifiedUtc         DATETIME2(3)   NULL,
    ModifiedByUserId    BIGINT         NULL,
    RowVersion          ROWVERSION     NOT NULL,
    CONSTRAINT CK_Departments_NotOwnParent CHECK (ParentDepartmentId IS NULL OR ParentDepartmentId <> DepartmentId)
);

CREATE TABLE org.Designations (
    DesignationId       BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Designations PRIMARY KEY,
    Code                VARCHAR(30)    NOT NULL CONSTRAINT UQ_Designations_Code UNIQUE,
    Name                NVARCHAR(150)  NOT NULL,
    [Level]             INT            NULL,
    IsActive            BIT            NOT NULL CONSTRAINT DF_Designations_IsActive DEFAULT (1),
    DeactivatedUtc      DATETIME2(3)   NULL,
    CreatedUtc          DATETIME2(3)   NOT NULL CONSTRAINT DF_Designations_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    CreatedByUserId     BIGINT         NULL,
    ModifiedUtc         DATETIME2(3)   NULL,
    ModifiedByUserId    BIGINT         NULL,
    RowVersion          ROWVERSION     NOT NULL
);

CREATE TABLE org.Branches (
    BranchId            BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Branches PRIMARY KEY,
    Code                VARCHAR(30)    NOT NULL CONSTRAINT UQ_Branches_Code UNIQUE,
    Name                NVARCHAR(150)  NOT NULL,
    City                NVARCHAR(100)  NULL,
    [State]             NVARCHAR(100)  NULL,
    TimeZoneId          VARCHAR(64)    NOT NULL CONSTRAINT DF_Branches_TimeZoneId DEFAULT ('Asia/Kolkata'),
    Address             NVARCHAR(500)  NULL,
    IsActive            BIT            NOT NULL CONSTRAINT DF_Branches_IsActive DEFAULT (1),
    DeactivatedUtc      DATETIME2(3)   NULL,
    CreatedUtc          DATETIME2(3)   NOT NULL CONSTRAINT DF_Branches_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    CreatedByUserId     BIGINT         NULL,
    ModifiedUtc         DATETIME2(3)   NULL,
    ModifiedByUserId    BIGINT         NULL,
    RowVersion          ROWVERSION     NOT NULL
);

CREATE TABLE org.Employees (
    EmployeeId          BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Employees PRIMARY KEY,
    PublicId            UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_Employees_PublicId DEFAULT (NEWSEQUENTIALID()),
    EmployeeCode        VARCHAR(30)    NOT NULL CONSTRAINT UQ_Employees_EmployeeCode UNIQUE,
    FirstName           NVARCHAR(100)  NOT NULL,
    LastName            NVARCHAR(100)  NULL,
    DisplayName         NVARCHAR(200)  NOT NULL,
    OfficialEmail       NVARCHAR(254)  NOT NULL CONSTRAINT UQ_Employees_OfficialEmail UNIQUE,
    Mobile              VARCHAR(20)    NULL,
    DepartmentId        BIGINT         NOT NULL CONSTRAINT FK_Employees_Department REFERENCES org.Departments (DepartmentId),
    DesignationId       BIGINT         NOT NULL CONSTRAINT FK_Employees_Designation REFERENCES org.Designations (DesignationId),
    BranchId            BIGINT         NULL CONSTRAINT FK_Employees_Branch REFERENCES org.Branches (BranchId),
    ReportingManagerId  BIGINT         NULL CONSTRAINT FK_Employees_ReportingManager REFERENCES org.Employees (EmployeeId),
    DateOfJoining       DATE           NULL,
    PhotoPath           NVARCHAR(400)  NULL,
    ExternalRef         NVARCHAR(100)  NULL,
    IsActive            BIT            NOT NULL CONSTRAINT DF_Employees_IsActive DEFAULT (1),
    DeactivatedUtc      DATETIME2(3)   NULL,
    CreatedUtc          DATETIME2(3)   NOT NULL CONSTRAINT DF_Employees_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    CreatedByUserId     BIGINT         NULL,
    ModifiedUtc         DATETIME2(3)   NULL,
    ModifiedByUserId    BIGINT         NULL,
    RowVersion          ROWVERSION     NOT NULL,
    CONSTRAINT UQ_Employees_PublicId UNIQUE (PublicId),
    CONSTRAINT CK_Employees_NotOwnManager CHECK (ReportingManagerId IS NULL OR ReportingManagerId <> EmployeeId)
);
CREATE INDEX IX_Employees_Department ON org.Employees (DepartmentId) INCLUDE (DisplayName, IsActive);
CREATE INDEX IX_Employees_ReportingManager ON org.Employees (ReportingManagerId) WHERE ReportingManagerId IS NOT NULL;

ALTER TABLE org.Departments ADD CONSTRAINT FK_Departments_HeadEmployee
    FOREIGN KEY (HeadEmployeeId) REFERENCES org.Employees (EmployeeId);

CREATE TABLE org.Teams (
    TeamId              BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Teams PRIMARY KEY,
    Code                VARCHAR(30)    NOT NULL CONSTRAINT UQ_Teams_Code UNIQUE,
    Name                NVARCHAR(150)  NOT NULL,
    DepartmentId        BIGINT         NOT NULL CONSTRAINT FK_Teams_Department REFERENCES org.Departments (DepartmentId),
    TeamLeaderEmployeeId BIGINT        NULL CONSTRAINT FK_Teams_TeamLeader REFERENCES org.Employees (EmployeeId),
    IsActive            BIT            NOT NULL CONSTRAINT DF_Teams_IsActive DEFAULT (1),
    DeactivatedUtc      DATETIME2(3)   NULL,
    CreatedUtc          DATETIME2(3)   NOT NULL CONSTRAINT DF_Teams_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    CreatedByUserId     BIGINT         NULL,
    ModifiedUtc         DATETIME2(3)   NULL,
    ModifiedByUserId    BIGINT         NULL,
    RowVersion          ROWVERSION     NOT NULL
);

CREATE TABLE org.TeamMembers (
    TeamId              BIGINT         NOT NULL CONSTRAINT FK_TeamMembers_Team REFERENCES org.Teams (TeamId),
    EmployeeId          BIGINT         NOT NULL CONSTRAINT FK_TeamMembers_Employee REFERENCES org.Employees (EmployeeId),
    FromUtc             DATETIME2(3)   NOT NULL CONSTRAINT DF_TeamMembers_FromUtc DEFAULT (SYSUTCDATETIME()),
    ToUtc               DATETIME2(3)   NULL,
    CONSTRAINT PK_TeamMembers PRIMARY KEY (TeamId, EmployeeId),
    CONSTRAINT CK_TeamMembers_Period CHECK (ToUtc IS NULL OR ToUtc > FromUtc)
);
CREATE INDEX IX_TeamMembers_Employee ON org.TeamMembers (EmployeeId);
GO
