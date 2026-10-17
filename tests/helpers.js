// Shared test harness: boots the real Express app on an ephemeral port
// against the _test database, with Paystack and Resend replaced by an
// in-memory fake (global fetch is intercepted), so no test ever reaches a
// real external service.
import http from "node:http";
import crypto from "node:crypto";
import mysql from "mysql2/promise";

const realFetch = globalThis.fetch;

export const ps = {
  txs: new Map(),
  n: 0,
  verifyFailures: 0, // next N verify calls return a 500 (provider outage)
  initFailures: 0,
  reset() {
    this.txs.clear();
    this.verifyFailures = 0;
    this.initFailures = 0;
  },
  /** Mark a checkout as paid/failed/etc. on the fake provider. */
  setStatus(ref, status) {
    this.txs.get(ref).status = status;
  },
};
export const emails = [];

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status });

  if (u.includes("api.paystack.co/transaction/initialize")) {
    if (ps.initFailures > 0) {
      ps.initFailures--;
      return json({ status: false, message: "provider down" }, 500);
    }
    const b = JSON.parse(opts.body);
    const ref = b.reference || "psref_" + ++ps.n;
    ps.txs.set(ref, {
      id: 9000 + ++ps.n,
      reference: ref,
      status: "abandoned",
      amount: b.amount,
      currency: b.currency || "NGN",
      metadata: b.metadata,
      gateway_response: "test",
    });
    return json({ status: true, data: { reference: ref, authorization_url: "https://pay.test/" + ref, access_code: "ac" } });
  }
  if (u.includes("api.paystack.co/transaction/verify/")) {
    if (ps.verifyFailures > 0) {
      ps.verifyFailures--;
      return json({ status: false, message: "provider down" }, 500);
    }
    const ref = decodeURIComponent(u.split("/verify/")[1]);
    const tx = ps.txs.get(ref);
    if (!tx) return json({ status: false, message: "Transaction reference not found" }, 404);
    return json({ status: true, data: tx });
  }
  if (u.includes("api.resend.com")) {
    const b = JSON.parse(opts.body);
    emails.push({ to: b.to, subject: b.subject, html: b.html, text: b.text });
    return json({ id: "email_" + emails.length });
  }
  return realFetch(url, opts);
};

let booted;
export async function boot() {
  if (booted) return booted;
  const { app } = await import("../src/app.js");
  const { signAccessToken } = await import("../src/services/token.service.js");
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const db = await mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    namedPlaceholders: true,
    connectionLimit: 20,
  });

  const quiet = process.env.TEST_VERBOSE ? null : () => {};
  if (quiet) {
    console.log = quiet; // morgan/mailer chatter
    console.error = quiet;
  }

  let counter = 0;
  async function mkUser(role = "member", { available = 0, book = 0 } = {}) {
    const n = ++counter + Math.floor(Math.random() * 1e6) * 100;
    const [r] = await db.query(
      `INSERT INTO users (member_id, full_name, email, phone, password_hash, status, role, book_balance, available_balance, email_verified_at)
       VALUES (:m, :name, :email, :phone, 'x', 'active', :role, :book, :available, NOW())`,
      { m: "363-" + n, name: "Test " + role + " " + n, email: `u${n}@test.local`, phone: String(n).padStart(11, "0").slice(-11), role, book, available }
    );
    const user = { id: r.insertId, member_id: "363-" + n, status: "active", role, email: `u${n}@test.local` };
    user.cookie = "access_token=" + signAccessToken(user);
    return user;
  }

  async function approveKyc(userId, { bank = "Test Bank", account = "0123456789" } = {}) {
    await db.query(
      `INSERT INTO kyc_submissions (user_id, account_number, bank_name, house_address, id_document_public_id, proof_of_address_public_id, status)
       VALUES (:userId, :account, :bank, '1 Test Street', 'x/id', 'x/addr', 'approved')`,
      { userId, account, bank }
    );
  }

  async function call(user, method, path, body, { headers = {}, csrf = true } = {}) {
    const h = { "content-type": "application/json", ...headers };
    if (user) h.cookie = user.cookie;
    if (csrf) h["x-requested-with"] = "363app";
    const res = await realFetch(base + path, { method, headers: h, body: body === undefined || method === "GET" || method === "HEAD" ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let j = null;
    try { j = JSON.parse(text); } catch { j = text; }
    return { s: res.status, j, setCookie: res.headers.get("set-cookie") || "" };
  }

  async function balances(userId) {
    const [[u]] = await db.query("SELECT book_balance b, available_balance a FROM users WHERE id=?", [userId]);
    return { book: Number(u.b), available: Number(u.a) };
  }

  /** Raw paystack webhook call with a correct (or supplied) signature. */
  async function webhook(payload, { signature } = {}) {
    const raw = JSON.stringify(payload);
    const sig = signature ?? crypto.createHmac("sha512", process.env.PAYSTACK_SECRET_KEY).update(raw).digest("hex");
    const res = await realFetch(base + "/api/webhooks/paystack", {
      method: "POST",
      headers: { "content-type": "application/json", "x-paystack-signature": sig },
      body: raw,
    });
    return { s: res.status, j: await res.json().catch(() => null) };
  }

  async function wipe() {
    await db.query("SET FOREIGN_KEY_CHECKS = 0");
    for (const t of ["finance_facility_repayments", "finance_facility_repayment_schedules", "finance_facility_documents", "finance_facility_applications", "withdrawals", "deposits", "kyc_submissions", "otps", "refresh_tokens", "users"]) {
      await db.query(`DELETE FROM ${t}`);
    }
    await db.query("SET FOREIGN_KEY_CHECKS = 1");
    emails.length = 0;
    ps.reset();
  }

  async function close() {
    await new Promise((r) => server.close(r));
    await db.end();
    const { pool } = await import("../src/config/db.js");
    await pool.end();
  }

  booted = { app, base, db, mkUser, approveKyc, call, balances, webhook, wipe, close, ps, emails };
  return booted;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
