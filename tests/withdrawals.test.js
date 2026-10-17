import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { boot, emails } from "./helpers.js";

let t, admin, admin2, member, wmodel;
before(async () => {
  t = await boot();
  wmodel = await import("../src/models/withdrawal.model.js");
});
after(async () => t.close());
beforeEach(async () => {
  await t.wipe();
  admin = await t.mkUser("admin");
  admin2 = await t.mkUser("admin");
  member = await t.mkUser("member", { available: 100000 });
  await t.approveKyc(member.id);
});

const lastCode = () => {
  const m = emails.at(-1)?.text?.match(/Your code is: (\d{6})/);
  return m && m[1];
};
const cookieValue = (setCookie, name) => setCookie.match(new RegExp(name + "=([^;]+)"))?.[1];

/** Full member flow: initiate (OTP by email) -> confirm. Returns the confirm response. */
async function requestWithdrawal(user, amount) {
  const init = await t.call(user, "POST", "/api/withdrawals/initiate", { amount });
  if (init.s !== 201) return { init };
  const pending = cookieValue(init.setCookie, "pending_withdrawal_token");
  const code = lastCode();
  const confirm = await t.call({ cookie: `${user.cookie}; pending_withdrawal_token=${pending}` }, "POST", "/api/withdrawals/confirm", { code });
  return { init, confirm, pending, code };
}

test("happy path: OTP-confirmed withdrawal holds funds immediately", async () => {
  const { confirm } = await requestWithdrawal(member, 30000);
  assert.equal(confirm.s, 201);
  assert.deepEqual(await t.balances(member.id), { book: 0, available: 70000 });
});

test("cannot withdraw more than the available balance (checked at initiate)", async () => {
  const { init } = await requestWithdrawal(member, 100001);
  assert.equal(init.s, 422);
  assert.deepEqual(await t.balances(member.id), { book: 0, available: 100000 });
});

test("withdrawal needs an approved KYC", async () => {
  const noKyc = await t.mkUser("member", { available: 5000 });
  const { init } = await requestWithdrawal(noKyc, 1000);
  assert.equal(init.s, 403);
});

test("the OTP cannot be replayed: two simultaneous confirms with the same code create one withdrawal", async () => {
  const init = await t.call(member, "POST", "/api/withdrawals/initiate", { amount: 40000 });
  const pending = cookieValue(init.setCookie, "pending_withdrawal_token");
  const code = lastCode();
  const who = { cookie: `${member.cookie}; pending_withdrawal_token=${pending}` };
  const results = await Promise.all(Array.from({ length: 8 }, () => t.call(who, "POST", "/api/withdrawals/confirm", { code })));
  assert.equal(results.filter((r) => r.s === 201).length, 1);
  assert.deepEqual(await t.balances(member.id), { book: 0, available: 60000 });
  const [rows] = await t.db.query("SELECT COUNT(*) c FROM withdrawals WHERE user_id=?", [member.id]);
  assert.equal(Number(rows[0].c), 1);
});

test("a wrong code fails and an old token+code cannot be reused later", async () => {
  const init = await t.call(member, "POST", "/api/withdrawals/initiate", { amount: 1000 });
  const pending = cookieValue(init.setCookie, "pending_withdrawal_token");
  const who = { cookie: `${member.cookie}; pending_withdrawal_token=${pending}` };
  const wrong = await t.call(who, "POST", "/api/withdrawals/confirm", { code: "000000" === lastCode() ? "111111" : "000000" });
  assert.equal(wrong.s, 400);
  const code = lastCode();
  assert.equal((await t.call(who, "POST", "/api/withdrawals/confirm", { code })).s, 201);
  assert.equal((await t.call(who, "POST", "/api/withdrawals/confirm", { code })).s, 400);
  assert.deepEqual(await t.balances(member.id), { book: 0, available: 99000 });
});

test("the amount is fixed by the signed token: a body amount is ignored", async () => {
  const init = await t.call(member, "POST", "/api/withdrawals/initiate", { amount: 1000 });
  const pending = cookieValue(init.setCookie, "pending_withdrawal_token");
  const r = await t.call({ cookie: `${member.cookie}; pending_withdrawal_token=${pending}` }, "POST", "/api/withdrawals/confirm", { code: lastCode(), amount: 99999 });
  assert.equal(r.s, 201);
  assert.equal(r.j.withdrawal.amount, 1000);
});

// ---------- concurrency: funds can never be overspent ----------

test("20 concurrent holds of 30% of the balance: exactly 3 succeed, balance never negative", async () => {
  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      wmodel.createWithHold({ userId: member.id, amount: 30000, bankName: "B", accountNumber: "0123456789", accountName: "N" })
    )
  );
  assert.equal(results.filter(Boolean).length, 3);
  const b = await t.balances(member.id);
  assert.equal(b.available, 10000);
  const [[w]] = await t.db.query("SELECT COUNT(*) c, SUM(amount) s FROM withdrawals WHERE user_id=?", [member.id]);
  assert.equal(Number(w.c), 3);
  assert.equal(Number(w.s), 90000);
});

test("concurrent holds that exactly use the whole balance leave zero, never below", async () => {
  const results = await Promise.all(
    Array.from({ length: 10 }, () => wmodel.createWithHold({ userId: member.id, amount: 10000, bankName: "B", accountNumber: "0123456789", accountName: "N" }))
  );
  assert.equal(results.filter(Boolean).length, 10);
  assert.equal((await t.balances(member.id)).available, 0);
  const extra = await wmodel.createWithHold({ userId: member.id, amount: 0.01, bankName: "B", accountNumber: "0123456789", accountName: "N" });
  assert.equal(extra, null);
});

test("full API: parallel OTP-confirmed withdrawals from one account can't exceed the balance", async () => {
  // Three separate members' flows can't interleave on one account, so drive confirm directly with valid tokens.
  const { signPendingWithdrawalToken } = await import("../src/services/token.service.js");
  const otp = await import("../src/services/otp.service.js");
  const attempts = [];
  for (let i = 0; i < 4; i++) {
    const token = signPendingWithdrawalToken({ id: member.id }, { amount: 40000, bankName: "B", accountNumber: "0123456789", accountName: "N" });
    attempts.push(token);
  }
  // Only one live OTP exists per purpose at a time, so the service layer is what bounds this; hammer the model-level hold too.
  const code = await otp.issueOtp({ userId: member.id, purpose: otp.OTP_PURPOSE.WITHDRAWAL });
  const results = await Promise.all(attempts.map((tok) =>
    t.call({ cookie: `${member.cookie}; pending_withdrawal_token=${tok}` }, "POST", "/api/withdrawals/confirm", { code })));
  assert.equal(results.filter((r) => r.s === 201).length, 1, "one OTP authorises one withdrawal");
  assert.ok((await t.balances(member.id)).available >= 0);
});

// ---------- partial failure rolls back ----------

test("if recording the withdrawal fails, the hold is rolled back", async () => {
  await assert.rejects(
    wmodel.createWithHold({ userId: member.id, amount: 5000, bankName: "x".repeat(500), accountNumber: "0123456789", accountName: "N" })
  );
  assert.equal((await t.balances(member.id)).available, 100000);
  const [[w]] = await t.db.query("SELECT COUNT(*) c FROM withdrawals WHERE user_id=?", [member.id]);
  assert.equal(Number(w.c), 0);
});

// ---------- admin actions ----------

async function pendingWithdrawal(amount) {
  const { confirm } = await requestWithdrawal(member, amount);
  assert.equal(confirm.s, 201);
  return confirm.j.withdrawal.id;
}

test("decline refunds exactly once, even with many simultaneous declines", async () => {
  const id = await pendingWithdrawal(25000);
  assert.equal((await t.balances(member.id)).available, 75000);
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => t.call(i % 2 ? admin : admin2, "POST", `/api/admin/withdrawals/${id}/decline`, { reason: "no" })));
  assert.equal(results.filter((r) => r.s === 200).length, 1);
  assert.equal((await t.balances(member.id)).available, 100000);
});

test("approve racing decline: one wins; refund happens only if declined", async () => {
  for (let i = 0; i < 5; i++) {
    await t.db.query("UPDATE users SET available_balance=100000 WHERE id=?", [member.id]);
    const id = await pendingWithdrawal(10000);
    const [a, d] = await Promise.all([
      t.call(admin, "POST", `/api/admin/withdrawals/${id}/approve`),
      t.call(admin2, "POST", `/api/admin/withdrawals/${id}/decline`, { reason: "x" }),
    ]);
    assert.equal([a.s, d.s].filter((s) => s === 200).length, 1, JSON.stringify([a.s, d.s]));
    const avail = (await t.balances(member.id)).available;
    assert.equal(avail, d.s === 200 ? 100000 : 90000);
  }
});

test("status machine: pending -> approved -> processed only, no skipping and no moving back", async () => {
  const id = await pendingWithdrawal(1000);
  assert.equal((await t.call(admin, "POST", `/api/admin/withdrawals/${id}/process`)).s, 409, "cannot process before approval");
  assert.equal((await t.call(admin, "POST", `/api/admin/withdrawals/${id}/approve`)).s, 200);
  assert.equal((await t.call(admin2, "POST", `/api/admin/withdrawals/${id}/decline`, { reason: "late" })).s, 409, "cannot decline once approved");
  assert.equal((await t.call(admin2, "POST", `/api/admin/withdrawals/${id}/process`)).s, 200);
  assert.equal((await t.call(admin2, "POST", `/api/admin/withdrawals/${id}/process`)).s, 409);
  assert.equal((await t.balances(member.id)).available, 99000, "processing never touches the balance again");
});

test("money conservation: available + held == starting balance across a mixed batch", async () => {
  const ids = [];
  for (const a of [1000, 2000, 3000, 4000]) ids.push(await pendingWithdrawal(a));
  await t.call(admin, "POST", `/api/admin/withdrawals/${ids[0]}/approve`);
  await t.call(admin, "POST", `/api/admin/withdrawals/${ids[1]}/decline`, { reason: "x" });
  await t.call(admin, "POST", `/api/admin/withdrawals/${ids[2]}/approve`);
  await t.call(admin2, "POST", `/api/admin/withdrawals/${ids[2]}/process`);
  const [[s]] = await t.db.query(`SELECT COALESCE(SUM(amount),0) s FROM withdrawals WHERE user_id=? AND status IN ('pending','approved','processed')`, [member.id]);
  assert.equal((await t.balances(member.id)).available + Number(s.s), 100000);
});
