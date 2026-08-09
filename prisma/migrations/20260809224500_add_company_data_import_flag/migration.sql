-- Add company-level Data Import access flag.
-- Default is disabled. Platform User can enable it temporarily during onboarding.
ALTER TABLE "Company"
ADD COLUMN "dataImportEnabled" BOOLEAN NOT NULL DEFAULT false;
