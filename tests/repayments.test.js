import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { boot, emails } from "./helpers.js";

let t, admin, admin2, member, other, fmodel;
before(async () => {
  t = await boot();
  fmodel = await import("../src/models/financeFacility.model.js");
});
after(async () => t.close());
beforeEach(async () => {
  await t.wipe();
  admin = await t.mkUser("admin");
  admin2 = await t.mkUser("admin");
  member = await t.mkUser("member");
  other = await t.mkUser("member");
});

const TERMS = { approvedAmount: 100000, interestRate: 0, termMonths: 4, repaymentFrequency: "monthly", installmentAmount: 25000 };
const A = "/api/admin/finance-facilities";
const R = "/api/finance-facility-repayments";

async function mkApp(userId, status = "under_review") {
  const [r] = await t.db.query(
    `INSERT INTO finance_facility_applications (user_id,amount_requested,purpose,purpose_description,expected_benefit,repayment_source,expected_monthly_income,expected_monthly_expenses,business_name,business_type,business_address,years_in_business,status)
     VALUES (:u,100000,'inventory','d','b','s',1,1,'B','T','A',1,:s)`, { u: userId, s: status });
  return r.insertId;
}
const status = async (id) => (await t.db.query("SELECT status FROM finance_facility_applications WHERE id=?", [id]))[0][0].status;
const schedule = async (id) => (await t.db.query("SELECT installment_number n, amount_due d, amount_paid p, status s, due_date FROM finance_facility_repayment_schedules WHERE facility_id=? ORDER BY installment_number", [id]))[0]
  .map((r) => ({ n: r.n, d: Number(r.d), p: Number(r.p), s: r.s, due: r.due_date }));

/** Walk a fresh application through approve -> accept -> disburse via the real API. */
async function disbursedFacility(terms = TERMS, owner = member) {
  const id = await mkApp(owner.id);
  assert.equal((await t.call(admin, "POST", `${A}/${id}/approve`, terms)).s, 200);
  assert.equal((await t.call(owner, "POST", `/api/finance-facilities/${id}/offer/accept`)).s, 200);
  const d = await t.call(admin, "POST", `${A}/${id}/disburse`, { disbursementReference: "TRF-1" });
  assert.equal(d.s, 200, JSON.stringify(d.j));
  return id;
}
async function payAndVerify(user, fac, amount, finalStatus = "success") {
  const i = await t.call(user, "POST", `${R}/${fac}/initialize`, { amount });
  if (i.s !== 201) return { i };
  t.ps.setStatus(i.j.data.reference, finalStatus);
  const v = await t.call(user, "POST", `${R}/verify`, { reference: i.j.data.reference });
  return { i, v, ref: i.j.data.reference, id: v.j?.data?.repaymentId };
}
const confirm = (id, who = admin) => t.call(who, "POST", `${R}/admin/${id}/confirm`);

// ===================== offer & disbursement =====================

test("lifecycle: approve -> accept -> disburse; disbursing early is a 409, not a 500", async () => {
  const id = await mkApp(member.id);
  await t.call(admin, "POST", `${A}/${id}/approve`, TERMS);
  const early = await t.call(admin, "POST", `${A}/${id}/disburse`, {});
  assert.equal(early.s, 409);
  assert.match(early.j.error, /not accepted/i);
  assert.equal((await t.call(other, "POST", `/api/finance-facilities/${id}/offer/accept`)).s, 404);
  assert.equal((await t.call(member, "POST", `/api/finance-facilities/${id}/offer/accept`)).s, 200);
  assert.equal((await t.call(member, "POST", `/api/finance-facilities/${id}/offer/accept`)).s, 409);
  assert.equal((await t.call(member, "POST", `/api/finance-facilities/${id}/offer/decline`)).s, 409);
  assert.equal((await t.call(member, "POST", `${A}/${id}/disburse`, {})).s, 403);
  assert.equal((await t.call(admin, "POST", `${A}/${id}/disburse`, {})).s, 200);
  assert.equal(await status(id), "disbursed");
  assert.equal((await t.call(admin2, "POST", `${A}/${id}/disburse`, {})).s, 409);
});

test("concurrent disbursements generate exactly one schedule", async () => {
  const id = await mkApp(member.id);
  await t.call(admin, "POST", `${A}/${id}/approve`, TERMS);
  await t.call(member, "POST", `/api/finance-facilities/${id}/offer/accept`);
  const rs = await Promise.all([admin, admin2, admin, admin2, admin].map((a) => t.call(a, "POST", `${A}/${id}/disburse`, {})));
  assert.equal(rs.filter((r) => r.s === 200).length, 1);
  const s = await schedule(id);
  assert.equal(s.length, 4);
  assert.equal(s.reduce((x, r) => x + r.d, 0), 100000);
});

test("accept racing decline: exactly one wins", async () => {
  const id = await mkApp(member.id);
  await t.call(admin, "POST", `${A}/${id}/approve`, TERMS);
  const [a, d] = await Promise.all([
    t.call(member, "POST", `/api/finance-facilities/${id}/offer/accept`),
    t.call(member, "POST", `/api/finance-facilities/${id}/offer/decline`),
  ]);
  assert.equal([a.s, d.s].filter((s) => s === 200).length, 1);
  assert.equal(await status(id), a.s === 200 ? "offer_accepted" : "offer_declined");
});

test("a declined offer can never be disbursed, and the member may apply again", async () => {
  const id = await mkApp(member.id);
  await t.call(admin, "POST", `${A}/${id}/approve`, TERMS);
  await t.call(member, "POST", `/api/finance-facilities/${id}/offer/decline`);
  assert.equal((await t.call(admin, "POST", `${A}/${id}/disburse`, {})).s, 409);
  assert.equal(await fmodel.findActiveByUser(member.id), null);
});

test("an open loan blocks a new application; a completed one does not", async () => {
  for (const s of ["submitted", "under_review", "additional_information_required", "approved", "offer_accepted", "disbursed"]) {
    await t.db.query("DELETE FROM finance_facility_applications WHERE user_id=?", [member.id]);
    await mkApp(member.id, s);
    assert.ok(await fmodel.findActiveByUser(member.id), `${s} should block`);
  }
  for (const s of ["declined", "offer_declined", "completed"]) {
    await t.db.query("DELETE FROM finance_facility_applications WHERE user_id=?", [member.id]);
    await mkApp(member.id, s);
    assert.equal(await fmodel.findActiveByUser(member.id), null, `${s} should not block`);
  }
});

test("repayment schedule: monthly, correct count, due dates ascending, regenerating does not duplicate", async () => {
  const id = await disbursedFacility();
  const s = await schedule(id);
  assert.equal(s.length, 4);
  const dates = s.map((r) => new Date(r.due).getTime());
  assert.deepEqual([...dates].sort((a, b) => a - b), dates);
  const again = await t.call(admin, "POST", `${R}/admin/facilities/${id}/generate-schedule`, {});
  assert.ok(again.s < 500);
  assert.equal((await schedule(id)).length, 4);
});

// ===================== repayment: verify -> admin confirm =====================

test("a verified payment waits for admin confirmation and changes nothing until then", async () => {
  const id = await disbursedFacility();
  const { v } = await payAndVerify(member, id, 25000);
  assert.equal(v.j.data.status, "pending_confirmation");
  assert.deepEqual((await schedule(id)).map((r) => r.p), [0, 0, 0, 0]);
  assert.equal((await t.call(member, "POST", `${R}/admin/${v.j.data.repaymentId}/confirm`)).s, 403);
  assert.equal((await confirm(v.j.data.repaymentId)).s, 200);
  assert.deepEqual((await schedule(id)).map((r) => r.p), [25000, 0, 0, 0]);
  assert.ok(emails.some((e) => /Repayment confirmed/.test(e.subject)));
});

test("allocation spills across installments in order and marks partial/paid correctly", async () => {
  const id = await disbursedFacility();
  const { id: r1 } = await payAndVerify(member, id, 40000);
  await confirm(r1);
  let s = await schedule(id);
  assert.deepEqual(s.map((r) => [r.p, r.s]), [[25000, "paid"], [15000, "partial"], [0, "pending"], [0, "pending"]]);
  const { id: r2 } = await payAndVerify(member, id, 10000);
  await confirm(r2);
  s = await schedule(id);
  assert.deepEqual(s.map((r) => [r.p, r.s]), [[25000, "paid"], [25000, "paid"], [0, "pending"], [0, "pending"]]);
});

test("kobo-exact arithmetic: awkward amounts never drift", async () => {
  const id = await disbursedFacility({ ...TERMS, approvedAmount: 99999.99, termMonths: 3, installmentAmount: 33333.33 });
  const total = (await schedule(id)).reduce((x, r) => x + Math.round(r.d * 100), 0);
  const payments = [0.01, 33333.32, 0.1, 0.2, 33333.33, 0.07];
  let paid = 0;
  for (const p of payments) {
    const { id: rid, i } = await payAndVerify(member, id, p);
    assert.equal(i.s, 201, JSON.stringify(i.j));
    assert.equal((await confirm(rid)).s, 200);
    paid += Math.round(p * 100);
    const sumPaid = (await schedule(id)).reduce((x, r) => x + Math.round(r.p * 100), 0);
    assert.equal(sumPaid, paid);
  }
  assert.ok(paid < total);
});

test("invalid amounts are rejected before reaching the payment provider", async () => {
  const id = await disbursedFacility();
  for (const amount of [0, -5, "abc", null, 0.001, 25000.005]) {
    const r = await t.call(member, "POST", `${R}/${id}/initialize`, { amount });
    assert.equal(r.s, 400, `amount ${amount} -> ${r.s}`);
  }
  assert.equal(t.ps.txs.size, 0);
});

test("cannot pay more than the balance outstanding", async () => {
  const id = await disbursedFacility();
  const r = await t.call(member, "POST", `${R}/${id}/initialize`, { amount: 100000.01 });
  assert.ok(r.s === 400 || r.s === 409);
});

test("amount or metadata tampering at the provider is caught on verify", async () => {
  const id = await disbursedFacility();
  const i = await t.call(member, "POST", `${R}/${id}/initialize`, { amount: 25000 });
  const ref = i.j.data.reference;
  t.ps.txs.get(ref).amount = 100;
  t.ps.setStatus(ref, "success");
  const v = await t.call(member, "POST", `${R}/verify`, { reference: ref });
  assert.equal(v.s, 409);
  assert.equal((await t.db.query("SELECT status FROM finance_facility_repayments WHERE paystack_reference=?", [ref]))[0][0].status, "pending");

  const j = await t.call(member, "POST", `${R}/${id}/initialize`, { amount: 1000 });
  t.ps.txs.get(j.j.data.reference).metadata.facility_id = "99999";
  t.ps.setStatus(j.j.data.reference, "success");
  assert.equal((await t.call(member, "POST", `${R}/verify`, { reference: j.j.data.reference })).s, 409);

  const k = await t.call(member, "POST", `${R}/${id}/initialize`, { amount: 1000 });
  t.ps.txs.get(k.j.data.reference).metadata.payment_type = "deposit";
  t.ps.setStatus(k.j.data.reference, "success");
  assert.equal((await t.call(member, "POST", `${R}/verify`, { reference: k.j.data.reference })).s, 409);
  assert.deepEqual((await schedule(id)).map((r) => r.p), [0, 0, 0, 0]);
});

test("verify is idempotent and 12 simultaneous verifies leave one pending_confirmation record", async () => {
  const id = await disbursedFacility();
  const i = await t.call(member, "POST", `${R}/${id}/initialize`, { amount: 25000 });
  t.ps.setStatus(i.j.data.reference, "success");
  const rs = await Promise.all(Array.from({ length: 12 }, () => t.call(member, "POST", `${R}/verify`, { reference: i.j.data.reference })));
  assert.ok(rs.every((r) => r.s === 200));
  assert.equal(rs.filter((r) => !r.j.data.alreadyProcessed).length, 1);
  assert.equal(emails.filter((e) => /awaiting confirmation|needs confirmation/i.test(e.subject)).length, 2);
});

test("12 simultaneous confirmations apply the payment exactly once", async () => {
  const id = await disbursedFacility();
  const { id: rid } = await payAndVerify(member, id, 25000);
  const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => confirm(rid, i % 2 ? admin : admin2)));
  assert.equal(rs.filter((r) => r.s === 200).length, 1);
  assert.deepEqual((await schedule(id)).map((r) => r.p), [25000, 0, 0, 0]);
});

test("two different payments confirmed in parallel are both applied, none lost or doubled", async () => {
  const id = await disbursedFacility();
  const a = await payAndVerify(member, id, 25000);
  const b = await payAndVerify(member, id, 25000);
  const rs = await Promise.all([confirm(a.id, admin), confirm(b.id, admin2)]);
  assert.ok(rs.every((r) => r.s === 200));
  assert.deepEqual((await schedule(id)).map((r) => r.p), [25000, 25000, 0, 0]);
});

test("declining requires a reason, applies nothing, and is final", async () => {
  const id = await disbursedFacility();
  const { id: rid } = await payAndVerify(member, id, 25000);
  assert.equal((await t.call(admin, "POST", `${R}/admin/${rid}/decline`, {})).s, 422);
  assert.equal((await t.call(admin, "POST", `${R}/admin/${rid}/decline`, { reason: "Not received" })).s, 200);
  assert.equal((await confirm(rid)).s, 409);
  assert.deepEqual((await schedule(id)).map((r) => r.p), [0, 0, 0, 0]);
});

test("pending payments reduce what can still be paid, including under a race", async () => {
  const id = await disbursedFacility();
  await payAndVerify(member, id, 75000); // awaiting confirmation
  const over = await t.call(member, "POST", `${R}/${id}/initialize`, { amount: 30000 });
  assert.equal(over.s, 409);
  const ok = await t.call(member, "POST", `${R}/${id}/initialize`, { amount: 25000 });
  assert.equal(ok.s, 201);
  const races = await Promise.all([1, 2, 3, 4].map(() => t.call(member, "POST", `${R}/${id}/initialize`, { amount: 1 })));
  assert.ok(races.every((r) => r.s === 409));
});

test("race on the cap: parallel initializes can't together exceed the balance", async () => {
  const id = await disbursedFacility();
  const rs = await Promise.all(Array.from({ length: 6 }, () => t.call(member, "POST", `${R}/${id}/initialize`, { amount: 40000 })));
  assert.equal(rs.filter((r) => r.s === 201).length, 2, "100000 / 40000 -> at most 2");
});

test("overpayment that slipped through is declined on confirm and applies nothing", async () => {
  const id = await disbursedFacility();
  const a = await payAndVerify(member, id, 75000);
  await confirm(a.id);
  await t.db.query(`INSERT INTO finance_facility_repayments (facility_id,user_id,paystack_reference,amount,status,paid_at) VALUES (?,?,'ref_over',40000,'pending_confirmation',NOW())`, [id, member.id]);
  const [[row]] = await t.db.query("SELECT id FROM finance_facility_repayments WHERE paystack_reference='ref_over'");
  const r = await confirm(row.id);
  assert.equal(r.s, 200);
  assert.equal(r.j.data.outcome, "declined");
  assert.deepEqual((await schedule(id)).map((x) => x.p), [25000, 25000, 25000, 0]);
  assert.ok(emails.some((e) => /not applied/i.test(e.subject)));
});

test("Paystack failure/reversal marks the repayment failed; abandoned is left retryable", async () => {
  const id = await disbursedFacility();
  const f = await payAndVerify(member, id, 25000, "failed");
  assert.equal(f.v.j.data.status, "failed");
  const [[row]] = await t.db.query("SELECT status, failure_reason FROM finance_facility_repayments WHERE paystack_reference=?", [f.ref]);
  assert.equal(row.status, "failed");
  assert.ok(row.failure_reason);
  const ab = await payAndVerify(member, id, 25000, "abandoned");
  assert.equal(ab.v.s, 409);
  assert.equal((await t.db.query("SELECT status FROM finance_facility_repayments WHERE paystack_reference=?", [ab.ref]))[0][0].status, "pending");
  t.ps.setStatus(ab.ref, "success");
  assert.equal((await t.call(member, "POST", `${R}/verify`, { reference: ab.ref })).j.data.status, "pending_confirmation");
});

test("a confirmed/declined/failed repayment can never be re-verified into another state", async () => {
  const id = await disbursedFacility();
  const { ref, id: rid } = await payAndVerify(member, id, 25000);
  await confirm(rid);
  t.ps.setStatus(ref, "failed");
  const again = await t.call(member, "POST", `${R}/verify`, { reference: ref });
  assert.equal(again.j.data.status, "success");
  assert.deepEqual((await schedule(id)).map((r) => r.p), [25000, 0, 0, 0]);
});

test("final payment completes the facility; schedule/history stay readable; no further payments", async () => {
  const id = await disbursedFacility();
  const a = await payAndVerify(member, id, 100000);
  const c = await confirm(a.id);
  assert.equal(c.j.data.facilityCompleted, true);
  assert.equal(await status(id), "completed");
  assert.equal((await t.call(member, "GET", `${R}/${id}/schedule`)).s, 200);
  assert.equal((await t.call(member, "GET", `${R}/${id}/balance`)).j.data.completed, true);
  const dash = await t.call(member, "GET", `${R}/dashboard`);
  assert.equal(dash.j.data.facilities.length, 1);
  assert.ok((await t.call(member, "POST", `${R}/${id}/initialize`, { amount: 100 })).s >= 400);
  assert.equal(await fmodel.findActiveByUser(member.id), null);
});

test("webhook recovers a repayment the member never returned for (pending -> awaiting confirmation)", async () => {
  const id = await disbursedFacility();
  const i = await t.call(member, "POST", `${R}/${id}/initialize`, { amount: 25000 });
  t.ps.setStatus(i.j.data.reference, "success");
  assert.equal((await t.webhook({ event: "charge.success", data: { reference: i.j.data.reference } })).s, 200);
  const [[row]] = await t.db.query("SELECT status FROM finance_facility_repayments WHERE paystack_reference=?", [i.j.data.reference]);
  assert.equal(row.status, "pending_confirmation");
  assert.deepEqual((await schedule(id)).map((r) => r.p), [0, 0, 0, 0], "webhook must never apply money by itself");
});

test("repayment reconcile sweep handles paid, failed and unpaid stale payments", async () => {
  const id = await disbursedFacility();
  const paid = await t.call(member, "POST", `${R}/${id}/initialize`, { amount: 10000 });
  const failed = await t.call(member, "POST", `${R}/${id}/initialize`, { amount: 10000 });
  const unpaid = await t.call(member, "POST", `${R}/${id}/initialize`, { amount: 10000 });
  t.ps.setStatus(paid.j.data.reference, "success");
  t.ps.setStatus(failed.j.data.reference, "failed");
  await t.db.query("UPDATE finance_facility_repayments SET created_at = NOW() - INTERVAL 1 HOUR");
  const r = await t.call(admin, "POST", `${R}/admin/reconcile`, {});
  assert.equal(r.s, 200);
  assert.deepEqual([r.j.data.awaitingConfirmation, r.j.data.failed, r.j.data.stillPending], [1, 1, 1]);
  assert.equal((await t.call(member, "POST", `${R}/admin/reconcile`, {})).s, 403);
});

test("invariant: schedule amount_paid always equals the sum of confirmed repayments", async () => {
  const id = await disbursedFacility();
  const ids = [];
  for (const amt of [10000, 15000, 5000, 20000]) ids.push((await payAndVerify(member, id, amt)).id);
  await confirm(ids[0]);
  await t.call(admin, "POST", `${R}/admin/${ids[1]}/decline`, { reason: "x" });
  await confirm(ids[2], admin2);
  await confirm(ids[3]);
  const [[conf]] = await t.db.query("SELECT COALESCE(SUM(amount),0) s FROM finance_facility_repayments WHERE facility_id=? AND status='success'", [id]);
  const paid = (await schedule(id)).reduce((x, r) => x + Math.round(r.p * 100), 0);
  assert.equal(paid, Math.round(Number(conf.s) * 100));
});

test("repayment API errors use the same { error } shape as the rest of the API", async () => {
  const r = await t.call(member, "POST", `${R}/verify`, { reference: "" });
  assert.equal(r.s, 400);
  assert.ok(typeof r.j.error === "string" && r.j.error.length > 0);
});

test("the global error handler keeps application status codes (409 stays 409)", async () => {
  const id = await mkApp(member.id, "disbursed");
  const r = await t.call(admin, "POST", `${A}/${id}/disburse`, {});
  assert.equal(r.s, 409);
  assert.ok(r.j.error && r.j.code);
});

test("dashboard figures: outstanding only drops on confirmation; verified money shows as awaiting", async () => {
  const fac = await disbursedFacility();
  const dash = async () => (await t.call(member, "GET", `${R}/dashboard`)).j.data.facilities[0];

  let f = await dash();
  assert.equal(f.outstandingBalance, 100000);
  assert.equal(f.totalPaid, 0);
  assert.equal(f.awaitingConfirmation, 0);
  assert.equal(f.installmentCount, 4);

  const p = await payAndVerify(member, fac, 30000);
  f = await dash();
  assert.equal(f.outstandingBalance, 100000, "unconfirmed money must not reduce the balance");
  assert.equal(f.awaitingConfirmation, 30000);

  assert.equal((await confirm(p.id)).s, 200);
  f = await dash();
  assert.equal(f.outstandingBalance, 70000);
  assert.equal(f.totalPaid, 30000);
  assert.equal(f.awaitingConfirmation, 0);
  assert.equal(f.nextRepayment.remainingAmount, 20000);
  assert.equal(f.outstandingBalance, f.totalRepayable - f.totalPaid);
});
