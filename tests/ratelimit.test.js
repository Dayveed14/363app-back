import { test, before, after } from "node:test";
import assert from "node:assert/strict";

process.env.TEST_RATE_LIMITS = "1";
const { boot } = await import("./helpers.js");

let t, member;
before(async () => {
  t = await boot();
  await t.wipe();
  member = await t.mkUser("member", { available: 1000 });
  await t.approveKyc(member.id);
});
after(async () => { delete process.env.TEST_RATE_LIMITS; await t.close(); });

test("login attempts are rate limited (credential-stuffing guard)", async () => {
  let blocked = 0;
  for (let i = 0; i < 25; i++) {
    const r = await t.call(null, "POST", "/api/auth/login", { email: "nobody@test.local", password: "wrong-password" });
    if (r.s === 429) blocked++;
  }
  assert.ok(blocked >= 1, "expected at least one 429 after repeated login attempts");
});

test("withdrawal OTP requests are rate limited", async () => {
  let blocked = 0;
  for (let i = 0; i < 12; i++) {
    const r = await t.call(member, "POST", "/api/withdrawals/initiate", { amount: 100 });
    if (r.s === 429) blocked++;
  }
  assert.ok(blocked >= 1, "expected at least one 429");
});
