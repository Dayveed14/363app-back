// Test runner: `npm test`.
//
// Safety first: these tests DELETE data. They refuse to run unless the
// database name ends in `_test`, so they can never wipe a real database
// (including your TiDB Cloud one) even if .env points at it by mistake.
//
// Setup (one time):
//   mysql -u root -p -e "CREATE DATABASE coop363_test"
//   DB_NAME=coop363_test npm test        (or put DB_NAME=... in .env.test)
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import mysql from "mysql2/promise";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Optional .env.test overrides everything; real env vars win over .env.
if (fs.existsSync(path.join(root, ".env.test"))) {
  dotenv.config({ path: path.join(root, ".env.test"), override: true });
} else {
  dotenv.config({ path: path.join(root, ".env") });
}

const dbName = process.env.DB_NAME || "";
if (!/_test$/.test(dbName)) {
  console.error(
    `\nRefusing to run: DB_NAME is "${dbName}". Tests wipe tables, so the database name must end in "_test".\n` +
      `Create one (CREATE DATABASE coop363_test) and run:  DB_NAME=coop363_test npm test\n`
  );
  process.exit(1);
}
if (process.env.DB_SSL === "true" && !process.env.ALLOW_REMOTE_TEST_DB) {
  console.error("Refusing to run tests against an SSL (remote) database. Set ALLOW_REMOTE_TEST_DB=1 if that is really a disposable test database.");
  process.exit(1);
}

// Never let tests touch live services: everything external is mocked in
// tests/helpers.js, and the secrets below are dummies.
Object.assign(process.env, {
  NODE_ENV: "test",
  JWT_ACCESS_SECRET: "test-access",
  JWT_REFRESH_SECRET: "test-refresh",
  JWT_PENDING_2FA_SECRET: "test-2fa",
  JWT_PENDING_WITHDRAWAL_SECRET: "test-wd",
  OTP_HASH_PEPPER: "test-pepper",
  RESEND_API_KEY: "re_test",
  PAYSTACK_SECRET_KEY: "sk_test_dummy",
  PAYSTACK_PUBLIC_KEY: "pk_test_dummy",
  CLOUDINARY_CLOUD_NAME: "test",
  CLOUDINARY_API_KEY: "test",
  CLOUDINARY_API_SECRET: "test",
  CLIENT_ORIGIN: "http://localhost:5173",
  DB_HOST: process.env.DB_HOST || "127.0.0.1",
  DB_USER: process.env.DB_USER || "root",
  DB_PASSWORD: process.env.DB_PASSWORD || "",
});

// Fresh schema every run.
const conn = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: dbName,
  multipleStatements: true,
});
await conn.query("SET FOREIGN_KEY_CHECKS = 0");
const [tables] = await conn.query("SHOW TABLES");
for (const row of tables) await conn.query(`DROP TABLE IF EXISTS \`${Object.values(row)[0]}\``);
await conn.query("SET FOREIGN_KEY_CHECKS = 1");
await conn.end();

const migrate = spawnSync(process.execPath, [path.join(root, "src/db/migrate.js")], { stdio: "inherit", env: process.env });
if (migrate.status !== 0) process.exit(migrate.status || 1);

// The repo's migrations don't yet add the disbursed_* columns (they were
// added by hand in production). Add them here, the same way, if missing.
const fix = await mysql.createConnection({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: dbName,
});
const [cols] = await fix.query("SHOW COLUMNS FROM finance_facility_applications");
const have = new Set(cols.map((c) => c.Field));
if (!have.has("disbursed_at")) await fix.query("ALTER TABLE finance_facility_applications ADD COLUMN disbursed_at DATETIME NULL");
if (!have.has("disbursed_by")) await fix.query("ALTER TABLE finance_facility_applications ADD COLUMN disbursed_by BIGINT UNSIGNED NULL");
if (!have.has("disbursement_reference")) await fix.query("ALTER TABLE finance_facility_applications ADD COLUMN disbursement_reference VARCHAR(100) NULL");
await fix.end();

const files = fs.readdirSync(path.join(root, "tests")).filter((f) => f.endsWith(".test.js")).map((f) => path.join("tests", f));
const result = spawnSync(process.execPath, ["--test", "--test-reporter=spec", "--test-concurrency=1", ...files], { stdio: "inherit", cwd: root, env: process.env });
process.exit(result.status ?? 1);
