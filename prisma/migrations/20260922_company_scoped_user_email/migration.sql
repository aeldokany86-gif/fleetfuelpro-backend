-- Fleet Fuel PRO
-- Change User email uniqueness from global to company-scoped.
-- This allows the same email address to exist in different customer companies,
-- while preventing duplicate email addresses inside the same company.
--
-- Platform users all belong to the PLATFORM company, so their email remains
-- unique within the platform tenant.

DROP INDEX IF EXISTS "User_email_key";

CREATE UNIQUE INDEX IF NOT EXISTS "User_companyId_email_key"
ON "User" ("companyId", "email");
