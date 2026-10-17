import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { boot, emails } from "./helpers.js";

let t, admin, admin2, member;
before(async () => { t = await boot(); });
after(async () => t.close());
beforeEach(async () => {
  await t.wipe();
  admin = await t.mkUser("admin");
  admin2 = await t.mkUser("admin");
  member = await t.mkUser("member");
});

async function startDeposit(user, amount) {
  const r = await t.call(user, "POST", "/api/deposits/initialize", { amount });
  assert.equal(r.s, 201, JSON.stringify(r.j));
  return r.j.reference;
}
const verify = (user, ref) => t.call(user, "GET", `/api/deposits/verify/${ref}`);
const depositRow = async (ref) => (await t.db.query("SELECT * FROM deposits WHERE reference=?", [ref]))[0][0];

// ---------------- verification: duplicates & retries ----------------

test("15 simultaneous verifications credit the deposit exactly once", async () => {
  const ref = await startDeposit(member, 5000);
  t.ps.setStatus(ref, "success");
  const results = await Promise.all(Array.from({ length: 15 }, () => verify(member, ref)));
  assert.ok(results.every((r) => r.s === 200));
  assert.deepEqual(await t.balances(member.id), { book: 5000, available: 0 });
  assert.equal((await depositRow(ref)).status, "pending_confirmation");
  const adminMails = emails.filter((e) => /deposit/i.test(e.subject));
  assert.equal(adminMails.length, 2, "each admin is notified once, not once per request"); // 2 admins
});

test("callback + webhook + reconciliation racing each other still credit once", async () => {
  const ref = await startDeposit(member, 7000);
  t.ps.setStatus(ref, "success");
  await t.db.query("UPDATE deposits SET created_at = NOW() - INTERVAL 1 HOUR WHERE reference=?", [ref]);
  await Promise.all([
    verify(member, ref),
    t.webhook({ event: "charge.success", data: { reference: ref } }),
    t.call(admin, "POST", "/api/admin/deposits/reconcile", {}),
    verify(admin, ref),
    t.webhook({ event: "charge.success", data: { reference: ref } }),
  ]);
  assert.deepEqual(await t.balances(member.id), { book: 7000, available: 0 });
});

test("verifying again after it has been credited never credits again", async () => {
  const ref = await startDeposit(member, 2500);
  t.ps.setStatus(ref, "success");
  await verify(member, ref);
  await verify(member, ref);
  await t.webhook({ event: "charge.success", data: { reference: ref } });
  assert.deepEqual(await t.balances(member.id), { book: 2500, available: 0 });
});

test("provider outage during verify: nothing changes, retry succeeds", async () => {
  const ref = await startDeposit(member, 3000);
  t.ps.setStatus(ref, "success");
  t.ps.verifyFailures = 1;
  const first = await verify(member, ref);
  assert.equal(first.s, 502);
  assert.equal((await depositRow(ref)).status, "initialized");
  assert.deepEqual(await t.balances(member.id), { book: 0, available: 0 });
  const retry = await verify(member, ref);
  assert.equal(retry.s, 200);
  assert.deepEqual(await t.balances(member.id), { book: 3000, available: 0 });
});

test("abandoned/pending checkouts are not marked failed and can still complete later", async () => {
  const ref = await startDeposit(member, 1500);
  for (const s of ["abandoned", "pending", "ongoing"]) {
    t.ps.setStatus(ref, s);
    await verify(member, ref);
    assert.equal((await depositRow(ref)).status, "initialized", s);
  }
  t.ps.setStatus(ref, "success");
  await verify(member, ref);
  assert.deepEqual(await t.balances(member.id), { book: 1500, available: 0 });
});

test("failed/reversed are final and never credit", async () => {
  for (const s of ["failed", "reversed"]) {
    const ref = await startDeposit(member, 1000);
    t.ps.setStatus(ref, s);
    await verify(member, ref);
    assert.equal((await depositRow(ref)).status, "failed");
    t.ps.setStatus(ref, "success"); // a later "success" for a closed deposit must not credit
    await verify(member, ref);
    await t.webhook({ event: "charge.success", data: { reference: ref } });
  }
  assert.deepEqual(await t.balances(member.id), { book: 0, available: 0 });
});

test("amount or currency mismatch is not credited and is closed as failed", async () => {
  const ref = await startDeposit(member, 5000);
  t.ps.txs.get(ref).amount = 100; // paid ₦1 instead of ₦5000
  t.ps.setStatus(ref, "success");
  await verify(member, ref);
  assert.equal((await depositRow(ref)).status, "failed");

  const ref2 = await startDeposit(member, 5000);
  t.ps.txs.get(ref2).currency = "USD";
  t.ps.setStatus(ref2, "success");
  await verify(member, ref2);
  assert.equal((await depositRow(ref2)).status, "failed");
  assert.deepEqual(await t.balances(member.id), { book: 0, available: 0 });
});

test("overpayment on the provider side (amount higher than expected) is not credited either", async () => {
  const ref = await startDeposit(member, 1000);
  t.ps.txs.get(ref).amount = 10_000_000;
  t.ps.setStatus(ref, "success");
  await verify(member, ref);
  assert.equal((await depositRow(ref)).status, "failed");
  assert.deepEqual(await t.balances(member.id), { book: 0, available: 0 });
});

// ---------------- partial failure / rollback ----------------

test("a database failure while crediting rolls the claim back; the deposit is recoverable", async () => {
  const ref = await startDeposit(member, 6000);
  t.ps.setStatus(ref, "success");
  await t.db.query("ALTER TABLE users ADD CONSTRAINT chk_test_book CHECK (book_balance < 5000)");
  try {
    const r = await verify(member, ref);
    assert.equal(r.s, 500);
    assert.equal((await depositRow(ref)).status, "initialized", "claim must roll back with the failed balance update");
    assert.deepEqual(await t.balances(member.id), { book: 0, available: 0 });
  } finally {
    await t.db.query("ALTER TABLE users DROP CONSTRAINT chk_test_book");
  }
  const retry = await verify(member, ref);
  assert.equal(retry.s, 200);
  assert.deepEqual(await t.balances(member.id), { book: 6000, available: 0 });
});

test("provider failure when starting checkout closes the row instead of leaving an orphan", async () => {
  t.ps.initFailures = 1;
  const r = await t.call(member, "POST", "/api/deposits/initialize", { amount: 1000 });
  assert.equal(r.s, 502);
  const [rows] = await t.db.query("SELECT status FROM deposits WHERE user_id=?", [member.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "failed");
});

// ---------------- database-level duplicate guard ----------------

test("one Paystack transaction can never be credited to two deposits (DB unique index)", async () => {
  const a = await startDeposit(member, 2000);
  const b = await startDeposit(member, 2000);
  t.ps.setStatus(a, "success");
  t.ps.setStatus(b, "success");
  t.ps.txs.get(b).id = t.ps.txs.get(a).id; // same provider transaction presented for a second deposit
  await verify(member, a);
  await verify(member, b);
  assert.deepEqual(await t.balances(member.id), { book: 2000, available: 0 });
  assert.equal((await depositRow(b)).status, "failed");
});

test("the unique index exists at the database level", async () => {
  const [rows] = await t.db.query("SHOW INDEX FROM deposits WHERE Key_name='uq_deposits_paystack_ref_id'");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].Non_unique, 0);
  await assert.rejects(async () => {
    await t.db.query("INSERT INTO deposits (user_id, reference, amount, status, paystack_ref_id) VALUES (?, 'x1', 100, 'initialized', 'dup')", [member.id]);
    await t.db.query("INSERT INTO deposits (user_id, reference, amount, status, paystack_ref_id) VALUES (?, 'x2', 100, 'initialized', 'dup')", [member.id]);
  }, /Duplicate/);
});

// ---------------- admin confirm / decline ----------------

async function pendingDeposit(amount) {
  const ref = await startDeposit(member, amount);
  t.ps.setStatus(ref, "success");
  await verify(member, ref);
  return (await depositRow(ref)).id;
}

test("12 simultaneous confirmations move the money exactly once", async () => {
  const id = await pendingDeposit(4000);
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => t.call(i % 2 ? admin : admin2, "POST", `/api/admin/deposits/${id}/confirm`)));
  assert.equal(results.filter((r) => r.s === 200).length, 1);
  assert.equal(results.filter((r) => r.s === 409).length, 11);
  assert.deepEqual(await t.balances(member.id), { book: 0, available: 4000 });
});

test("confirm racing decline: exactly one wins and balances stay consistent", async () => {
  for (let i = 0; i < 5; i++) {
    await t.db.query("UPDATE users SET book_balance=0, available_balance=0 WHERE id=?", [member.id]);
    const id = await pendingDeposit(1000);
    const [c, d] = await Promise.all([
      t.call(admin, "POST", `/api/admin/deposits/${id}/confirm`),
      t.call(admin2, "POST", `/api/admin/deposits/${id}/decline`, { reason: "no funds" }),
    ]);
    assert.equal([c.s, d.s].filter((s) => s === 200).length, 1);
    const b = await t.balances(member.id);
    assert.ok(
      (c.s === 200 && b.available === 1000 && b.book === 0) || (d.s === 200 && b.available === 0 && b.book === 0),
      JSON.stringify({ c: c.s, d: d.s, b })
    );
  }
});

test("decline reverses the pending credit", async () => {
  const id = await pendingDeposit(900);
  assert.deepEqual(await t.balances(member.id), { book: 900, available: 0 });
  await t.call(admin, "POST", `/api/admin/deposits/${id}/decline`, { reason: "not received" });
  assert.deepEqual(await t.balances(member.id), { book: 0, available: 0 });
  const again = await t.call(admin2, "POST", `/api/admin/deposits/${id}/confirm`);
  assert.equal(again.s, 409);
});

test("balance invariant: book = pending deposits, available = confirmed deposits", async () => {
  const ids = [];
  for (const amt of [1000, 2000, 3000, 4000]) ids.push(await pendingDeposit(amt));
  await t.call(admin, "POST", `/api/admin/deposits/${ids[0]}/confirm`);
  await t.call(admin, "POST", `/api/admin/deposits/${ids[1]}/decline`, { reason: "x" });
  await t.call(admin, "POST", `/api/admin/deposits/${ids[2]}/confirm`);
  const [[sum]] = await t.db.query(
    `SELECT COALESCE(SUM(CASE WHEN status='pending_confirmation' THEN amount END),0) p,
            COALESCE(SUM(CASE WHEN status='confirmed' THEN amount END),0) c FROM deposits WHERE user_id=?`, [member.id]);
  const b = await t.balances(member.id);
  assert.equal(b.book, Number(sum.p));
  assert.equal(b.available, Number(sum.c));
});

// ---------------- webhook & reconciliation ----------------

test("webhook with a bad or missing signature is rejected and credits nothing", async () => {
  const ref = await startDeposit(member, 1000);
  t.ps.setStatus(ref, "success");
  const bad = await t.webhook({ event: "charge.success", data: { reference: ref } }, { signature: "deadbeef" });
  assert.equal(bad.s, 401);
  const res = await fetch(t.base + "/api/webhooks/paystack", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: "charge.success", data: { reference: ref } }) });
  assert.equal(res.status, 401);
  assert.deepEqual(await t.balances(member.id), { book: 0, available: 0 });
});

test("a valid webhook recovers a payment the member never came back for", async () => {
  const ref = await startDeposit(member, 8000);
  t.ps.setStatus(ref, "success");
  const r = await t.webhook({ event: "charge.success", data: { reference: ref, amount: 1 } }); // payload amount is ignored
  assert.equal(r.s, 200);
  assert.deepEqual(await t.balances(member.id), { book: 8000, available: 0 });
});

test("webhook: forged 'success' for a payment Paystack says is unpaid credits nothing", async () => {
  const ref = await startDeposit(member, 8000);
  t.ps.setStatus(ref, "abandoned");
  await t.webhook({ event: "charge.success", data: { reference: ref } });
  assert.deepEqual(await t.balances(member.id), { book: 0, available: 0 });
  assert.equal((await depositRow(ref)).status, "initialized");
});

test("webhook: provider outage returns 500 so Paystack retries; unknown reference returns 200", async () => {
  const ref = await startDeposit(member, 1000);
  t.ps.setStatus(ref, "success");
  t.ps.verifyFailures = 1;
  assert.equal((await t.webhook({ event: "charge.success", data: { reference: ref } })).s, 500);
  assert.equal((await t.webhook({ event: "charge.success", data: { reference: ref } })).s, 200);
  assert.equal((await t.webhook({ event: "charge.success", data: { reference: "363-DEP-unknown" } })).s, 200);
  assert.equal((await t.webhook({ event: "transfer.success", data: { reference: ref } })).s, 200);
  assert.deepEqual(await t.balances(member.id), { book: 1000, available: 0 });
});

test("reconcile sweep: credits stale paid deposits, closes failed ones, leaves fresh and unpaid alone", async () => {
  const paid = await startDeposit(member, 1000);
  const failed = await startDeposit(member, 1100);
  const unpaid = await startDeposit(member, 1200);
  const fresh = await startDeposit(member, 1300);
  t.ps.setStatus(paid, "success");
  t.ps.setStatus(failed, "failed");
  t.ps.setStatus(fresh, "success");
  await t.db.query("UPDATE deposits SET created_at = NOW() - INTERVAL 1 HOUR WHERE reference IN (?,?,?)", [paid, failed, unpaid]);
  const r = await t.call(admin, "POST", "/api/admin/deposits/reconcile", {});
  assert.equal(r.s, 200);
  assert.equal(r.j.summary.credited, 1);
  assert.equal(r.j.summary.failed, 1);
  assert.equal(r.j.summary.stillPending, 1);
  assert.equal((await depositRow(paid)).status, "pending_confirmation");
  assert.equal((await depositRow(failed)).status, "failed");
  assert.equal((await depositRow(unpaid)).status, "initialized");
  assert.equal((await depositRow(fresh)).status, "initialized");
  assert.deepEqual(await t.balances(member.id), { book: 1000, available: 0 });
  assert.equal((await t.call(member, "POST", "/api/admin/deposits/reconcile", {})).s, 403);
});

test("reconcile survives a provider outage mid-sweep and finishes on the next run", async () => {
  const a = await startDeposit(member, 1000);
  const b = await startDeposit(member, 2000);
  t.ps.setStatus(a, "success"); t.ps.setStatus(b, "success");
  await t.db.query("UPDATE deposits SET created_at = NOW() - INTERVAL 1 HOUR");
  t.ps.verifyFailures = 1;
  const first = await t.call(admin, "POST", "/api/admin/deposits/reconcile", {});
  assert.equal(first.j.summary.errors, 1);
  const second = await t.call(admin, "POST", "/api/admin/deposits/reconcile", {});
  assert.equal(second.j.summary.errors, 0);
  assert.deepEqual(await t.balances(member.id), { book: 3000, available: 0 });
});
