-- V004: customer participants (crm). Customers have no login. PII is minimised and never used in recording paths.

CREATE TABLE crm.Customers (
    CustomerId          BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Customers PRIMARY KEY,
    PublicId            UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_Customers_PublicId DEFAULT (NEWSEQUENTIALID()),
    CustomerRef         VARCHAR(50)    NOT NULL CONSTRAINT UQ_Customers_CustomerRef UNIQUE,
    FullName            NVARCHAR(200)  NOT NULL,
    Email               NVARCHAR(254)  NULL,
    Mobile              VARCHAR(20)    NULL,
    PolicyNumber        VARCHAR(50)    NULL,
    ReferenceNumber     VARCHAR(50)    NULL,
    AssignedEmployeeId  BIGINT         NULL CONSTRAINT FK_Customers_AssignedEmployee REFERENCES org.Employees (EmployeeId),
    Notes               NVARCHAR(1000) NULL,
    IsActive            BIT            NOT NULL CONSTRAINT DF_Customers_IsActive DEFAULT (1),
    DeactivatedUtc      DATETIME2(3)   NULL,
    CreatedUtc          DATETIME2(3)   NOT NULL CONSTRAINT DF_Customers_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    CreatedByUserId     BIGINT         NULL,
    ModifiedUtc         DATETIME2(3)   NULL,
    ModifiedByUserId    BIGINT         NULL,
    RowVersion          ROWVERSION     NOT NULL,
    CONSTRAINT UQ_Customers_PublicId UNIQUE (PublicId),
    -- An invitation must be deliverable somewhere.
    CONSTRAINT CK_Customers_Contact CHECK (Email IS NOT NULL OR Mobile IS NOT NULL)
);
CREATE INDEX IX_Customers_AssignedEmployee ON crm.Customers (AssignedEmployeeId) WHERE AssignedEmployeeId IS NOT NULL;
CREATE INDEX IX_Customers_PolicyNumber ON crm.Customers (PolicyNumber) WHERE PolicyNumber IS NOT NULL;
GO
