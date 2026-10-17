import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { boot } from "./helpers.js";

let t, admin, admin2, alice, bob;
before(async () => {
  t = await boot();
  await t.wipe();
  admin = await t.mkUser("admin");
  admin2 = await t.mkUser("admin");
  alice = await t.mkUser("member", { available: 50000 });
  bob = await t.mkUser("member", { available: 50000 });
});
after(async () => t.close());

/** Walk Express's router and list every registered route as {method, path}. */
function listRoutes(app) {
  const out = [];
  const mountPath = (layer) => {
    const src = layer.regexp.source;
    return src
      .replace("^\\/", "/")
      .replace("\\/?(?=\\/|$)", "")
      .replace(/\\\//g, "/")
      .replace(/\$$/, "");
  };
  const walk = (stack, prefix) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const method of Object.keys(layer.route.methods)) out.push({ method: method.toUpperCase(), path: prefix + layer.route.path });
      } else if (layer.name === "router" && layer.handle.stack) {
        walk(layer.handle.stack, prefix + mountPath(layer));
      }
    }
  };
  walk(app._router.stack, "");
  return out;
}
const fill = (p) => p.replace(/:[A-Za-z]+/g, "1");

test("every admin route rejects anonymous callers (401) and members (403)", async () => {
  const routes = listRoutes(t.app).filter((r) => /^\/api\/admin\//.test(r.path) || /^\/api\/finance-facility-repayments\/admin/.test(r.path));
  assert.ok(routes.length >= 25, `expected to find the admin routes, found ${routes.length}`);
  for (const r of routes) {
    const path = fill(r.path);
    const anon = await t.call(null, r.method, path, {});
    assert.equal(anon.s, 401, `anon ${r.method} ${r.path} -> ${anon.s}`);
    const member = await t.call(alice, r.method, path, {});
    assert.equal(member.s, 403, `member ${r.method} ${r.path} -> ${member.s}`);
  }
});

test("every non-public route rejects anonymous callers", async () => {
  const PUBLIC = [/^\/health$/, /^\/api\/auth\//, /^\/api\/webhooks\//];
  const routes = listRoutes(t.app).filter((r) => !PUBLIC.some((p) => p.test(r.path)) && r.path !== "/");
  for (const r of routes) {
    const anon = await t.call(null, r.method, fill(r.path), {});
    assert.equal(anon.s, 401, `anon ${r.method} ${r.path} -> ${anon.s}`);
  }
});

// ---------- cross-member access ----------

async function kycFor(user) {
  const [r] = await t.db.query(
    `INSERT INTO kyc_submissions (user_id, account_number, bank_name, house_address, id_document_public_id, proof_of_address_public_id, status)
     VALUES (:u, '0123456789', 'B', 'addr', 'x/id', 'x/addr', 'pending')`, { u: user.id });
  return r.insertId;
}

test("a member cannot download another member's KYC documents; owner/admin pass the access check", async () => {
  const id = await kycFor(alice);
  const bobTry = await t.call(bob, "GET", `/api/kyc/${id}/documents/idDocument`);
  assert.equal(bobTry.s, 403);
  // Owner and admin get past the authorization check (storage then fails in the sandbox, which is not a 403/401).
  for (const who of [alice, admin]) {
    const r = await t.call(who, "GET", `/api/kyc/${id}/documents/idDocument`);
    assert.ok(![401, 403, 404].includes(r.s), `owner/admin should pass authz, got ${r.s}`);
  }
});

async function mkApp(userId, status = "under_review") {
  const [r] = await t.db.query(
    `INSERT INTO finance_facility_applications (user_id,amount_requested,purpose,purpose_description,expected_benefit,repayment_source,expected_monthly_income,expected_monthly_expenses,business_name,business_type,business_address,years_in_business,status)
     VALUES (:u,100000,'inventory','d','b','s',1,1,'B','T','A',1,:s)`, { u: userId, s: status });
  return r.insertId;
}

test("a member cannot read, upload to, or download documents of another member's facility application", async () => {
  const appId = await mkApp(alice.id);
  await t.db.query(`INSERT INTO finance_facility_documents (application_id, document_type, cloudinary_public_id, resource_type, file_name, mime_type) VALUES (?, 'bank_statement', 'x/doc', 'image', 'a.pdf', 'application/pdf')`, [appId]);
  const [[doc]] = await t.db.query("SELECT id FROM finance_facility_documents WHERE application_id=?", [appId]);
  assert.equal((await t.call(bob, "GET", `/api/finance-facilities/${appId}`)).s, 403);
  assert.equal((await t.call(bob, "GET", `/api/finance-facilities/${appId}/documents/${doc.id}`)).s, 403);
  assert.equal((await t.call(bob, "POST", `/api/finance-facilities/${appId}/documents`, { documentType: "x" })).s, 403);
  assert.equal((await t.call(alice, "GET", `/api/finance-facilities/${appId}`)).s, 200);
  assert.equal((await t.call(admin, "GET", `/api/admin/finance-facilities/${appId}`)).s, 200);
});

test("a document id from another application cannot be fetched through your own application", async () => {
  const mine = await mkApp(bob.id);
  const theirs = await mkApp(alice.id);
  await t.db.query(`INSERT INTO finance_facility_documents (application_id, document_type, cloudinary_public_id, resource_type, file_name, mime_type) VALUES (?, 'bank_statement', 'x/doc', 'image', 'a.pdf', 'application/pdf')`, [theirs]);
  const [[doc]] = await t.db.query("SELECT id FROM finance_facility_documents WHERE application_id=?", [theirs]);
  const r = await t.call(bob, "GET", `/api/finance-facilities/${mine}/documents/${doc.id}`);
  assert.equal(r.s, 404);
});

test("a member cannot see another member's deposit status", async () => {
  const init = await t.call(alice, "POST", "/api/deposits/initialize", { amount: 1000 });
  const r = await t.call(bob, "GET", `/api/deposits/verify/${init.j.reference}`);
  assert.equal(r.s, 403);
  const list = await t.call(bob, "GET", "/api/deposits/me");
  assert.ok(!JSON.stringify(list.j).includes(init.j.reference));
});

test("a member cannot see another member's withdrawals", async () => {
  await t.db.query(`INSERT INTO withdrawals (user_id, amount, bank_name, account_number, account_name) VALUES (?, 500, 'B', '0123456789', 'Alice')`, [alice.id]);
  const list = await t.call(bob, "GET", "/api/withdrawals/me");
  assert.equal(list.j.withdrawals.length, 0);
});

test("a member cannot read or pay against another member's loan schedule/balance", async () => {
  const appId = await mkApp(alice.id, "disbursed");
  await t.db.query(`INSERT INTO finance_facility_repayment_schedules (facility_id,user_id,installment_number,due_date,amount_due) VALUES (?,?,1,'2030-01-01',1000)`, [appId, alice.id]);
  assert.equal((await t.call(bob, "GET", `/api/finance-facility-repayments/${appId}/schedule`)).s, 404);
  assert.equal((await t.call(bob, "GET", `/api/finance-facility-repayments/${appId}/balance`)).s, 404);
  assert.equal((await t.call(bob, "POST", `/api/finance-facility-repayments/${appId}/initialize`, { amount: 500 })).s, 404);
  assert.equal((await t.call(alice, "GET", `/api/finance-facility-repayments/${appId}/schedule`)).s, 200);
});

test("a member cannot verify (and so cannot trigger processing of) another member's repayment reference", async () => {
  const appId = await mkApp(alice.id, "disbursed");
  await t.db.query(`INSERT INTO finance_facility_repayment_schedules (facility_id,user_id,installment_number,due_date,amount_due) VALUES (?,?,1,'2030-01-01',1000)`, [appId, alice.id]);
  const init = await t.call(alice, "POST", `/api/finance-facility-repayments/${appId}/initialize`, { amount: 500 });
  t.ps.setStatus(init.j.data.reference, "success");
  const r = await t.call(bob, "POST", "/api/finance-facility-repayments/verify", { reference: init.j.data.reference });
  assert.equal(r.s, 403);
});

// ---------- administrator limits ----------

test("an admin cannot approve or decline their own KYC; non-pending KYC cannot be re-decided", async () => {
  const mine = await kycFor(admin);
  assert.equal((await t.call(admin, "POST", `/api/admin/kyc/${mine}/approve`)).s, 403);
  assert.equal((await t.call(admin, "POST", `/api/admin/kyc/${mine}/decline`, { reason: "x" })).s, 403);

  const theirs = await kycFor(bob);
  assert.equal((await t.call(admin, "POST", `/api/admin/kyc/${theirs}/approve`)).s, 200);
  assert.equal((await t.call(admin2, "POST", `/api/admin/kyc/${theirs}/approve`)).s, 409);
  assert.equal((await t.call(admin2, "POST", `/api/admin/kyc/${theirs}/decline`, { reason: "late" })).s, 409);
});

test("an admin cannot confirm/decline their own deposit", async () => {
  const init = await t.call(admin, "POST", "/api/deposits/initialize", { amount: 1000 });
  t.ps.setStatus(init.j.reference, "success");
  await t.call(admin, "GET", `/api/deposits/verify/${init.j.reference}`);
  const [[dep]] = await t.db.query("SELECT id FROM deposits WHERE reference=?", [init.j.reference]);
  assert.equal((await t.call(admin, "POST", `/api/admin/deposits/${dep.id}/confirm`)).s, 403);
  assert.equal((await t.call(admin, "POST", `/api/admin/deposits/${dep.id}/decline`, { reason: "x" })).s, 403);
  assert.equal((await t.call(admin2, "POST", `/api/admin/deposits/${dep.id}/confirm`)).s, 200);
});

test("an admin cannot approve/process their own withdrawal", async () => {
  const [r] = await t.db.query(`INSERT INTO withdrawals (user_id, amount, bank_name, account_number, account_name) VALUES (?, 500, 'B', '0123456789', 'Adm')`, [admin.id]);
  assert.equal((await t.call(admin, "POST", `/api/admin/withdrawals/${r.insertId}/approve`)).s, 403);
  assert.equal((await t.call(admin, "POST", `/api/admin/withdrawals/${r.insertId}/decline`, { reason: "x" })).s, 403);
  assert.equal((await t.call(admin2, "POST", `/api/admin/withdrawals/${r.insertId}/approve`)).s, 200);
  assert.equal((await t.call(admin, "POST", `/api/admin/withdrawals/${r.insertId}/process`)).s, 403);
});

test("an admin cannot act on their own facility application or repayment", async () => {
  const appId = await mkApp(admin.id);
  const terms = { approvedAmount: 1000, interestRate: 1, termMonths: 2, repaymentFrequency: "monthly", installmentAmount: 500 };
  assert.equal((await t.call(admin, "POST", `/api/admin/finance-facilities/${appId}/approve`, terms)).s, 403);
  assert.equal((await t.call(admin, "POST", `/api/admin/finance-facilities/${appId}/decline`, { reason: "x" })).s, 403);
  assert.equal((await t.call(admin, "POST", `/api/admin/finance-facilities/${appId}/request-info`, { request: "x" })).s, 403);
  const accepted = await mkApp(admin.id, "offer_accepted");
  assert.equal((await t.call(admin, "POST", `/api/admin/finance-facilities/${accepted}/disburse`, {})).s, 403);

  const disbursed = await mkApp(admin.id, "disbursed");
  const [rep] = await t.db.query(`INSERT INTO finance_facility_repayments (facility_id,user_id,paystack_reference,amount,status) VALUES (?,?,'own_ref',100,'pending_confirmation')`, [disbursed, admin.id]);
  assert.equal((await t.call(admin, "POST", `/api/finance-facility-repayments/admin/${rep.insertId}/confirm`)).s, 403);
  assert.equal((await t.call(admin, "POST", `/api/finance-facility-repayments/admin/${rep.insertId}/decline`, { reason: "x" })).s, 403);
});

test("a member's role cannot be escalated by sending role fields in a request body", async () => {
  const r = await t.call(bob, "POST", "/api/deposits/initialize", { amount: 500, role: "admin", userId: alice.id });
  assert.equal(r.s, 201);
  const [[u]] = await t.db.query("SELECT role FROM users WHERE id=?", [bob.id]);
  assert.equal(u.role, "member");
  const [[d]] = await t.db.query("SELECT user_id FROM deposits WHERE reference=?", [r.j.reference]);
  assert.equal(Number(d.user_id), bob.id);
});

test("expired/garbage tokens are rejected", async () => {
  const r = await t.call({ cookie: "access_token=not.a.jwt" }, "GET", "/api/deposits/me");
  assert.equal(r.s, 401);
});

test("unexpected application errors do not leak internals", async () => {
  const r = await t.call(alice, "GET", "/api/finance-facilities/not-a-number");
  assert.ok(r.s >= 400);
  assert.ok(!JSON.stringify(r.j).match(/sql|stack|at .*\.js/i));
});
