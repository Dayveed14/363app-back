import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { boot } from "./helpers.js";

let t, member;
before(async () => {
  t = await boot();
  await t.wipe();
  member = await t.mkUser("member", { available: 10000 });
});
after(async () => t.close());

test("unsafe request without the security header is blocked (403 csrf_header)", async () => {
  const r = await t.call(member, "POST", "/api/deposits/initialize", { amount: 500 }, { csrf: false });
  assert.equal(r.s, 403);
  assert.equal(r.j.code, "csrf_header");
});

test("unsafe request from an untrusted Origin is blocked even with the header", async () => {
  const r = await t.call(member, "POST", "/api/deposits/initialize", { amount: 500 }, { headers: { origin: "https://evil.example" } });
  // Blocked by CORS first (error body differs), with the CSRF origin check as a second layer.
  assert.equal(r.s, 403);
});

test("unsafe request from an allowed Origin with the header goes through", async () => {
  const r = await t.call(member, "POST", "/api/deposits/initialize", { amount: 500 }, { headers: { origin: "http://localhost:5173" } });
  assert.equal(r.s, 201);
});

test("no Origin (non-browser client) still needs the header", async () => {
  const ok = await t.call(member, "POST", "/api/deposits/initialize", { amount: 500 });
  assert.equal(ok.s, 201);
  const blocked = await t.call(member, "POST", "/api/deposits/initialize", { amount: 500 }, { csrf: false });
  assert.equal(blocked.s, 403);
});

test("wrong header value is rejected", async () => {
  const r = await t.call(member, "POST", "/api/deposits/initialize", { amount: 500 }, { csrf: false, headers: { "x-requested-with": "XMLHttpRequest" } });
  assert.equal(r.s, 403);
});

test("safe methods are not affected", async () => {
  const r = await t.call(member, "GET", "/api/deposits/me", undefined, { csrf: false });
  assert.equal(r.s, 200);
});

test("PUT/PATCH/DELETE are covered too", async () => {
  for (const m of ["PUT", "PATCH", "DELETE"]) {
    const r = await t.call(member, m, "/api/deposits/1", undefined, { csrf: false });
    assert.equal(r.s, 403, m);
  }
});

test("login (pre-auth) is also protected against cross-site posts", async () => {
  const r = await t.call(null, "POST", "/api/auth/login", { email: "a@b.c", password: "x" }, { csrf: false, headers: { origin: "https://evil.example" } });
  assert.equal(r.s, 403);
});

test("the Paystack webhook is exempt from CSRF (it authenticates by HMAC signature)", async () => {
  const r = await t.webhook({ event: "charge.success", data: { reference: "nope" } });
  assert.equal(r.s, 200);
});

test("the CSRF middleware itself rejects a disallowed Origin (defence in depth)", async () => {
  const { csrfProtection } = await import("../src/middleware/csrf.middleware.js");
  let status, body;
  const res = { status(s) { status = s; return this; }, json(b) { body = b; return this; } };
  const req = { method: "POST", path: "/api/x", get: (h) => ({ origin: "https://evil.example", "x-requested-with": "363app" })[h.toLowerCase()] };
  csrfProtection(req, res, () => assert.fail("should not pass"));
  assert.equal(status, 403);
  assert.equal(body.code, "csrf_origin");
});

test("CORS rejects an unknown origin outright", async () => {
  const res = await fetch(t.base + "/api/deposits/me", { headers: { origin: "https://evil.example" } });
  assert.equal(res.status, 403);
});

test("CORS preflight for the security header is approved for our origins only", async () => {
  const ok = await fetch(t.base + "/api/deposits/initialize", {
    method: "OPTIONS",
    headers: { origin: "http://localhost:5173", "access-control-request-method": "POST", "access-control-request-headers": "content-type,x-requested-with" },
  });
  assert.ok(ok.status === 204 || ok.status === 200);
  assert.match(ok.headers.get("access-control-allow-headers") || "", /x-requested-with/i);
  assert.equal(ok.headers.get("access-control-allow-credentials"), "true");
  const bad = await fetch(t.base + "/api/deposits/initialize", {
    method: "OPTIONS",
    headers: { origin: "https://evil.example", "access-control-request-method": "POST", "access-control-request-headers": "x-requested-with" },
  });
  assert.equal(bad.status, 403);
});
