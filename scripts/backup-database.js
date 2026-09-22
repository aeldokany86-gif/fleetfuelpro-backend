require("dotenv/config");

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// For backup/maintenance jobs, prefer DIRECT_URL (port 5432) over
// the transaction pooler DATABASE_URL (port 6543).
if (process.env.DIRECT_URL) {
  process.env.DATABASE_URL = process.env.DIRECT_URL;
}

const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

/*
  Fleet Fuel PRO - local application-data backup

  Purpose:
  - Create a local JSON backup of EVERY Prisma model in the current schema.
  - No database records are changed.
  - No external program such as pg_dump is required.
  - Uses the same DATABASE_URL that the backend already uses.

  Run from the backend project root:
      node scripts/backup-before-cleanup.js

  Output:
      local-backups/fleetfuelpro-backup-YYYY-MM-DDTHH-mm-ss-sssZ/

  IMPORTANT:
  This is an application-data backup, not a byte-for-byte PostgreSQL dump.
  Keep schema.prisma + migrations/source code together with this backup.
*/

const MODEL_DELEGATES = [
  ["Company", "company"],
  ["ImportBatch", "importBatch"],
  ["ImportRow", "importRow"],
  ["Project", "project"],
  ["Role", "role"],
  ["Permission", "permission"],
  ["RolePermission", "rolePermission"],
  ["User", "user"],
  ["Notification", "notification"],
  ["MobilePushToken", "mobilePushToken"],
  ["Employee", "employee"],
  ["EmployeeProjectAssignment", "employeeProjectAssignment"],
  ["EmployeeTransferRequest", "employeeTransferRequest"],
  ["EmployeeTransferApproval", "employeeTransferApproval"],
  ["EmployeeProjectRemovalRequest", "employeeProjectRemovalRequest"],
  ["Asset", "asset"],
  ["AssetOdometerReset", "assetOdometerReset"],
  ["AssetTransferRequest", "assetTransferRequest"],
  ["AssetTransferApproval", "assetTransferApproval"],
  ["AssetActionRequest", "assetActionRequest"],
  ["AssetAssignmentHistory", "assetAssignmentHistory"],
  ["Station", "station"],
  ["StationCounterReset", "stationCounterReset"],
  ["StationStockMovement", "stationStockMovement"],
  ["Operation", "operation"],
  ["OperationPhotoDraft", "operationPhotoDraft"],
  ["OperationApproval", "operationApproval"],
  ["OperationCorrection", "operationCorrection"],
  ["ProjectFuelPriceHistory", "projectFuelPriceHistory"],
  ["StationTransferRequest", "stationTransferRequest"],
  ["StationTransferApproval", "stationTransferApproval"],
  ["StationActionRequest", "stationActionRequest"],
  ["StationAssignmentHistory", "stationAssignmentHistory"],
  ["RefreshToken", "refreshToken"],
];

function timestampForFolder() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function jsonReplacer(_key, value) {
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value)) {
    return {
      __type: "Buffer",
      base64: value.toString("base64"),
    };
  }
  return value;
}

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function ensureDelegate(delegateName) {
  const delegate = prisma[delegateName];

  if (!delegate || typeof delegate.findMany !== "function") {
    throw new Error(
      `Prisma delegate "${delegateName}" is unavailable. ` +
        `Run "npx prisma generate" and make sure schema.prisma matches this backup script.`,
    );
  }

  return delegate;
}

async function readAllRows(delegateName) {
  const delegate = ensureDelegate(delegateName);

  /*
    findMany() with no include exports the raw scalar columns for the model.
    Foreign-key IDs are therefore preserved exactly as stored in the DB.
  */
  return delegate.findMany();
}

async function main() {
  console.log("\n============================================================");
  console.log(" Fleet Fuel PRO - Local Backup Before Production Cleanup");
  console.log("============================================================");
  console.log("Mode: READ ONLY — no database data will be changed.\n");

  if (!process.env.DATABASE_URL) {
    throw new Error(
      "Neither DIRECT_URL nor DATABASE_URL was found. Run this script from the backend project root where .env is available.",
    );
  }

  console.log(
    `Database connection: ${process.env.DIRECT_URL ? "DIRECT_URL (preferred for backup)" : "DATABASE_URL"}`,
  );

  const rootDir = process.cwd();
  const backupsRoot = path.join(rootDir, "local-backups");
  const finalDirName = `fleetfuelpro-backup-${timestampForFolder()}`;
  const finalDir = path.join(backupsRoot, finalDirName);
  const tempDir = `${finalDir}.incomplete`;

  fs.mkdirSync(backupsRoot, { recursive: true });

  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  fs.mkdirSync(tempDir, { recursive: true });

  const manifest = {
    backupType: "Fleet Fuel PRO Prisma application-data backup",
    formatVersion: 1,
    createdAt: new Date().toISOString(),
    databaseProvider: "postgresql",
    outputFolder: finalDirName,
    status: "IN_PROGRESS",
    modelCount: MODEL_DELEGATES.length,
    totalRows: 0,
    models: {},
    notes: [
      "Read-only logical application-data backup.",
      "Each model is exported to its own JSON file.",
      "Foreign-key scalar IDs are preserved.",
      "Keep this folder together with the matching schema.prisma and migration history.",
      "This is not a byte-for-byte PostgreSQL/pg_dump backup.",
    ],
  };

  const writeManifest = () => {
    const manifestText = JSON.stringify(manifest, jsonReplacer, 2) + "\n";
    fs.writeFileSync(
      path.join(tempDir, "manifest.json"),
      manifestText,
      "utf8",
    );
  };

  writeManifest();

  for (const [modelName, delegateName] of MODEL_DELEGATES) {
    process.stdout.write(`Backing up ${modelName} ... `);

    const rows = await readAllRows(delegateName);
    const jsonText = JSON.stringify(rows, jsonReplacer, 2) + "\n";
    const fileName = `${modelName}.json`;

    fs.writeFileSync(path.join(tempDir, fileName), jsonText, "utf8");

    const fileHash = sha256(jsonText);

    manifest.models[modelName] = {
      delegate: delegateName,
      file: fileName,
      rows: rows.length,
      bytes: Buffer.byteLength(jsonText, "utf8"),
      sha256: fileHash,
    };

    manifest.totalRows += rows.length;
    writeManifest();

    console.log(`${rows.length} row(s)`);
  }

  /*
    Copy schema.prisma if it exists in the standard Prisma location.
    This does not expose DATABASE_URL; schema.prisma only contains env() references.
  */
  const schemaCandidates = [
    path.join(rootDir, "prisma", "schema.prisma"),
    path.join(rootDir, "schema.prisma"),
  ];

  const schemaPath = schemaCandidates.find((candidate) => fs.existsSync(candidate));

  if (schemaPath) {
    fs.copyFileSync(schemaPath, path.join(tempDir, "schema.prisma"));
    manifest.schemaIncluded = true;
    manifest.schemaSource = path.relative(rootDir, schemaPath);
  } else {
    manifest.schemaIncluded = false;
    manifest.schemaSource = null;
    manifest.notes.push(
      "schema.prisma was not found in ./prisma/schema.prisma or ./schema.prisma; copy it into this backup folder manually.",
    );
  }

  manifest.status = "COMPLETE";
  manifest.completedAt = new Date().toISOString();

  writeManifest();

  // Validate every exported file before marking the backup directory complete.
  console.log("\nValidating exported files...");

  for (const [modelName] of MODEL_DELEGATES) {
    const metadata = manifest.models[modelName];
    const filePath = path.join(tempDir, metadata.file);

    if (!fs.existsSync(filePath)) {
      throw new Error(`Validation failed: ${metadata.file} is missing.`);
    }

    const fileText = fs.readFileSync(filePath, "utf8");
    const actualHash = sha256(fileText);

    if (actualHash !== metadata.sha256) {
      throw new Error(
        `Validation failed: SHA-256 mismatch for ${metadata.file}.`,
      );
    }

    const parsed = JSON.parse(fileText);

    if (!Array.isArray(parsed) || parsed.length !== metadata.rows) {
      throw new Error(
        `Validation failed: row count mismatch for ${metadata.file}.`,
      );
    }
  }

  if (fs.existsSync(finalDir)) {
    throw new Error(`Backup target already exists: ${finalDir}`);
  }

  fs.renameSync(tempDir, finalDir);

  console.log("✅ All JSON files passed hash and row-count validation.");
  console.log("\n============================================================");
  console.log(" BACKUP COMPLETE");
  console.log("============================================================");
  console.log(`Folder: ${finalDir}`);
  console.log(`Models: ${manifest.modelCount}`);
  console.log(`Total rows: ${manifest.totalRows}`);
  console.log("\nImportant:");
  console.log("1) Do not delete this backup folder until go-live is stable.");
  console.log("2) Copy the folder to a second location if possible (USB/OneDrive/etc.).");
  console.log("3) Do not commit local-backups to Git.");
  console.log("4) Send me the final console output + manifest row counts before cleanup.");
  console.log("");
}

main()
  .catch((error) => {
    console.error("\n❌ Backup failed:", error);
    console.error(
      "No cleanup should be executed until a successful COMPLETE backup exists.",
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
