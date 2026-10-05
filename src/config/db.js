import fs from "node:fs";
import mysql from "mysql2/promise";
import { env } from "./env.js";

function buildSslOption() {
  if (!env.db.ssl) return undefined;
  return {
    minVersion: "TLSv1.2",
    rejectUnauthorized: true,
    ca: env.db.sslCaPath ? fs.readFileSync(env.db.sslCaPath) : undefined,
  };
}

export const pool = mysql.createPool({
  host: env.db.host,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  database: env.db.database,
  connectionLimit: env.db.connectionLimit,
  dateStrings: false,
  namedPlaceholders: true,
  ssl: buildSslOption(),
});

export async function pingDb() {
  const conn = await pool.getConnection();
  try {
    await conn.query("SELECT 1");
  } finally {
    conn.release();
  }
}
