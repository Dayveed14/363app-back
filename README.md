# 363 Cooperative Society — Backend (Phase 1: Auth)

Node.js + Express + MySQL-compatible API (built for **TiDB Cloud**). This
first slice covers **registration and login only**: email/password
accounts, email verification, and email-based 2FA on login — all via
**httpOnly cookies**, never tokens in a JSON body or localStorage.

## Stack

Express · TiDB Cloud / MySQL (`mysql2`, raw parameterized SQL, no ORM) ·
`bcryptjs` · `jsonwebtoken` · **Resend** (email) · **Paystack** (deposits) ·
**Cloudinary** (KYC documents) · `cookie-parser` · `multer` ·
`express-validator` · `express-rate-limit` · `helmet`.

## Getting started

```bash
cp .env.example .env    # fill in real values — see below
npm install
npm run migrate         # creates the users / otps / refresh_tokens tables
npm run dev              # http://localhost:4000
```

Requires a database already created — `npm run migrate` only creates the
tables inside it:

```sql
CREATE DATABASE cooperative_363;
```

## Database: TiDB Cloud

This targets TiDB Cloud (MySQL wire-protocol compatible) rather than
plain MySQL:

- Get `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` from your cluster's
  **Connect** page on the TiDB Cloud console.
- Set `DB_SSL=true` — TiDB Cloud's public endpoint requires TLS. Its
  serverless tier is signed by a publicly trusted CA, so Node's default
  trust store is normally enough; only set `DB_SSL_CA_PATH` if your
  cluster/proxy needs a specific bundle.
- `npm run migrate` works the same way against TiDB Cloud as local MySQL —
  just point `DB_*` at the cluster and run it once.
- Local dev can still use plain MySQL/MariaDB with `DB_SSL=false` if you'd
  rather not hit the cloud cluster for every save — the code path is
  identical either way, only the env vars change.

## Email: Resend

OTP emails go out through [Resend](https://resend.com), not SMTP:

- `RESEND_API_KEY` — from the Resend dashboard → API Keys.
- `EMAIL_FROM` — must be on a domain you've **verified** in Resend. Until
  then, Resend's sandbox sender only delivers to the email address on your
  own Resend account — real members won't receive anything, so verify your
  domain before testing with other people's inboxes.
- The mailer (`src/services/mailer.service.js`) logs only a masked
  recipient address and the Resend message id on success — never the OTP,
  never the email body.

## Auth cookies

Every token this API issues — access, refresh, and the short-lived
pending-2FA token — is set as an **httpOnly cookie**. None of them are ever
returned in a JSON response body, and none of them are readable by
frontend JavaScript (which is the point: it closes off token theft via
XSS). Concretely:

| Cookie | Set on | Scope | Lifetime |
|---|---|---|---|
| `pending_2fa_token` | `POST /login` (password OK) | `/api/auth` | 10 min |
| `access_token` | `POST /login/verify-otp`, `POST /refresh` | `/` | 15 min |
| `refresh_token` | `POST /login/verify-otp`, `POST /refresh` | `/api/auth` | 7 days |

Cookie flags (`src/utils/cookies.js`):
- `httpOnly: true` always.
- `secure: true` in production (requires HTTPS — Render provides this),
  `false` in local dev (plain `http://localhost` can't set Secure cookies).
- `sameSite: "none"` in production — the frontend (e.g. Vercel) and this
  API (Render) are on different domains, which is cross-site as far as
  cookies are concerned, and cross-site cookies require `SameSite=None` +
  `Secure`. In dev, `sameSite: "lax"` works fine since `localhost:5173` →
  `localhost:4000` counts as same-site (same registrable domain, different
  port).

**The frontend must send `credentials: "include"` on every request** for
any of this to work (already done in the companion frontend's
`src/api/client.js`) — otherwise the browser won't attach or accept these
cookies at all.

**CSRF note:** since auth now rides on cookies instead of a bearer token
in a header, cross-site request forgery is a real consideration once
state-changing, fund-moving endpoints exist (withdrawals, etc.). Right
now, every state-changing route requires a JSON body, which forces a CORS
preflight that only this app's exact `CLIENT_ORIGIN` can pass — that
blocks the common CSRF vectors (plain forms, simple cross-site fetches)
but isn't a substitute for real CSRF tokens. Worth adding explicit CSRF
protection (e.g. double-submit cookie) before Phase 3 (money movement)
ships.

## Auth flow

**Registration**
1. `POST /api/auth/register` — creates the account (`status:
   pending_verification`), emails a 6-digit verification code via Resend.
2. `POST /api/auth/verify-email` — verifying moves the account to `status:
   pending_kyc` (KYC submission/officer review is the next phase).

**Login (password + email 2FA)**
1. `POST /api/auth/login` — checks email/password. On success, emails a
   second 6-digit code and sets the `pending_2fa_token` cookie (10 min).
   Response body carries no token at all — just a message.
2. `POST /api/auth/login/verify-otp` — reads the pending-2FA cookie
   automatically (nothing to send from the client except the code). On
   success, sets `access_token` + `refresh_token` cookies and clears the
   pending one.

**Session maintenance**
- `POST /api/auth/refresh` — reads the refresh cookie, rotates both
  cookies (old refresh token is revoked immediately on use).
- `POST /api/auth/logout` — reads the refresh cookie, revokes it, clears
  all three cookies.
- `GET /api/auth/me` — example protected route; `requireAuth` reads the
  access cookie, no header needed.
- `POST /api/auth/resend-otp` — body `{ email, purpose }`, purpose is
  `email_verification` or `login_2fa`. Invalidates any still-active code
  for that purpose first.

None of these endpoints take a token in the request body anymore — the
browser handles all of it via cookies once `credentials: "include"` is set
on the client.

## The OTP implementation, against spec

- **6 digits** — `OTP_LENGTH`, default 6.
- **Cryptographically secure** — `crypto.randomInt()` (Node's CSPRNG), not
  `Math.random()`. See `src/utils/otpCrypto.js`.
- **5-minute expiry** — `OTP_EXPIRES_MINUTES`, checked on every verify.
- **Single-use** — a matched code is marked `consumed_at` immediately.
- **Max 5 verification attempts** — `OTP_MAX_ATTEMPTS`; hitting the cap
  invalidates the code outright rather than leaving it guessable forever.
- **New OTP invalidates the old one** — `createOtp()` runs in a transaction
  that marks any other active OTP for that user+purpose invalid first.
- **Never logged** — the plaintext code exists only inside the
  `issueAndSendOtp` → `sendOtpEmail` call stack. The mailer logs a masked
  email and the Resend message id, never the code or body.
- **Hash, not plaintext, stored** — `HMAC-SHA256(code, OTP_HASH_PEPPER)`,
  compared with `crypto.timingSafeEqual`. The pepper lives only in server
  env, so a database leak alone isn't enough to brute-force codes offline.

There's also a request-level rate limiter (`otpLimiter`) on every
OTP-related endpoint — 8 requests per 5 minutes — independent of the
per-code attempt cap.

## Security notes

- Passwords: `bcryptjs`, cost factor 12.
- Refresh tokens are opaque random values (not JWTs); only a SHA-256 hash
  is stored, so a DB leak doesn't hand out live sessions.
- Generic error messages on login avoid confirming which emails are
  registered.
- `helmet` for headers, `cors` locked to `CLIENT_ORIGIN` with
  `credentials: true`, JSON body size capped at 100kb, `express-validator`
  on every input field.
- Request logging (`morgan`) logs method/path/status/timing only — bodies
  are never logged.

## Deploying (Render)

1. New Web Service → point at this repo/folder, build `npm install`, start
   `npm start`.
2. Add every `.env.example` variable as a Render environment variable
   (real generated secrets, real Resend key, real TiDB Cloud credentials
   with `DB_SSL=true`).
3. Run `npm run migrate` once against the TiDB Cloud database (via Render's
   shell, or locally with `DB_*` pointed at the remote cluster).
4. Set `CLIENT_ORIGIN` to the deployed frontend's exact URL — required both
   for CORS and for cookies to be accepted cross-site.

## Phase 2: KYC, deposits, and roles

Added on top of the auth slice above — same JWT/cookie approach throughout.

### Roles

`users.role` is `member` or `admin`, baked into the access token at login
(so `requireAdmin` is a cheap claim check, not a DB hit on every request).
There's deliberately no signup-time or HTTP way to become an admin — that's
a privilege-escalation surface this project doesn't need yet. Promote
someone directly:

```sql
UPDATE users SET role = 'admin' WHERE email = 'someone@example.com';
```

A role change takes effect the next time that person's access token
refreshes (≤15 min) — expected, and safer than the reverse (a demoted
admin keeps old access briefly, never gains new access early).

### KYC

- `POST /api/kyc` (member, `multipart/form-data`) — `accountNumber`,
  `bankName`, `houseAddress`, plus `idDocument` and `proofOfAddress` files
  (PDF/JPEG/PNG, 5MB cap — see `UPLOAD_MAX_FILE_SIZE_MB`). One submission
  row per member; resubmitting after a decline overwrites it. Emails every
  admin.
- `GET /api/kyc/me` (member) — own submission + status/decline reason.
- `GET /api/admin/kyc?status=pending|approved|declined` (admin) — review
  queue.
- `POST /api/admin/kyc/:id/approve` / `.../decline` (admin, decline needs
  `{ reason }`) — approve flips the member's `status` to `active`; both
  email the member.
- `GET /api/kyc/:id/documents/:docType` and the `/api/admin/...` twin
  (`docType` is `idDocument` or `proofOfAddress`) — streams the file after
  checking the requester is either the submission's owner or an admin.

#### Document storage: Cloudinary

Documents go straight from the upload request into Cloudinary — `multer`
holds each file in memory only long enough to hand it off
(`src/middleware/upload.middleware.js` uses `multer.memoryStorage()`, not
disk), so nothing ever touches this container's filesystem. Set
`CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET`
(from your Cloudinary dashboard → Settings → API Keys) and that's the only
config needed.

What actually happens, end to end (`src/services/storage.service.js`,
`src/services/kyc.service.js`, `src/controllers/kyc.controller.js`):

1. On submit, each file's buffer is uploaded with
   `type: "authenticated"` — Cloudinary's access-restricted delivery mode.
   An authenticated asset doesn't resolve via a plain URL; it only
   resolves via a correctly *signed* one, and only this backend's API
   secret can produce that signature. A public Cloudinary link for someone's
   ID document would defeat the owner-or-admin check entirely, which is
   why `type: "upload"` (Cloudinary's default, publicly accessible) is
   deliberately not used here.
2. The DB stores only Cloudinary's `public_id` and `resource_type` per
   document (`kyc_submissions.id_document_public_id` /
   `..._resource_type`, same for `proof_of_address_...`) — not a URL,
   since the signed URL has to be freshly generated per request anyway.
3. On a document request, `getDocumentUrl()` re-runs the owner-or-admin
   check, *then* generates a signed URL (`cloudinary.url(..., { sign_url:
   true })`). That URL is fetched server-side and the bytes are piped
   back as the response — the signed URL itself never reaches the
   browser. This means the frontend's existing blob-fetch code
   (`api.kyc.document` / `api.admin.kyc.document`) didn't need to change
   at all when this moved off local disk.

One nuance worth knowing: Cloudinary's signed URLs don't expire on their
own on the free/basic plan (time-boxed access needs the paid token-auth
add-on) — the signature just ties the URL to one exact asset. The
mitigation here is that the signed URL is never exposed to begin with
(see step 3), so this is a reasonable posture for now, not a loose end to
fix today.

Known rough edge: resubmitting KYC after a decline uploads new documents
and overwrites the DB row's `public_id`s, but doesn't delete the old
Cloudinary assets — they just become orphaned. Fine for now; worth a
cleanup pass (or a Cloudinary auto-deletion/retention rule) before this is
handling real volume.

### Deposits (Paystack)

Two balances on every user: `bookBalance` (credited the instant Paystack
confirms a charge) and `availableBalance` (only credited once an admin
confirms the deposit). This split is deliberate — Paystack confirming a
charge and the cooperative reconciling it are treated as separate steps:

1. `POST /api/deposits/initialize` (member, `{ amount }`) — opens a
   Paystack checkout, returns `authorizationUrl` to redirect the member to.
2. Paystack redirects back to `PAYSTACK_CALLBACK_URL` with
   `?reference=...`. The frontend's callback page calls
   `GET /api/deposits/verify/:reference`, which verifies **server-side**
   against Paystack directly (never trusts the redirect alone):
   - Paystack says failed → deposit marked `failed`, nothing credited.
     The reason is returned in the response for the frontend to show
     ("contact your bank" territory).
   - Paystack says success → `bookBalance` credited immediately, deposit
     moves to `pending_confirmation`, every admin is emailed.
3. `GET /api/admin/deposits?status=pending_confirmation` (admin) — queue.
4. `POST /api/admin/deposits/:id/confirm` (admin) — atomically moves the
   amount from `bookBalance` to `availableBalance`. Member is emailed.
5. `POST /api/admin/deposits/:id/decline` (admin, `{ reason }`) — reverses
   the `bookBalance` credit (it never reaches `availableBalance`). Member
   is emailed with the reason.
6. `GET /api/deposits/me` (member) — own deposit history.

Verification is idempotent — a page refresh or Paystack's redirect firing
twice doesn't double-process (anything past `initialized` is returned
as-is rather than re-verified).

### Withdrawals

A withdrawal only ever pays out to the member's own **KYC-approved** bank
account — there's no separate multi-bank-account manager, and no way to
withdraw to a third party. Confirmed by **email OTP** (reusing the same
mechanism as login's 2FA, not a separate PIN system). Two-step, same
shape as deposits:

1. `POST /api/withdrawals/initiate` (member, `{ amount }`) — requires an
   **approved** KYC submission on file and `amount ≤ availableBalance`.
   Nothing is persisted yet. Emails a 6-digit code and sets a
   `pending_withdrawal_token` cookie (10 min, scoped to
   `/api/withdrawals`) — the amount and bank details are baked into that
   signed token, not re-read from the client on confirm, so there's no
   window to confirm different numbers than what was actually OTP'd for.
2. `POST /api/withdrawals/confirm` (member, `{ code }`) — verifies the
   OTP, **then and only then** holds the funds
   (`userModel.holdAvailableBalance`, an atomic check-and-deduct so two
   racing requests can't both succeed against the same balance) and
   creates the `withdrawals` row (`status: pending`). Every admin is
   emailed. An abandoned request (OTP never confirmed) leaves no row and
   holds no funds.
3. `GET /api/admin/withdrawals?status=pending` (admin) — queue.
4. `POST /api/admin/withdrawals/:id/approve` (admin) — `status: approved`.
   Does **not** touch the balance — it was already held at step 2. Member
   is emailed.
5. `POST /api/admin/withdrawals/:id/process` (admin) — `status: processed`,
   once the admin has actually sent the bank transfer (there's no
   automated payout — per the original proposal, the cooperative doesn't
   have programmatic access to a bank account to push funds from). Member
   is emailed that it's been paid.
6. `POST /api/admin/withdrawals/:id/decline` (admin, `{ reason }`) —
   refunds the held amount back to `availableBalance`, the only point
   after confirm that a withdrawal's amount moves again. Member is
   emailed with the reason.
7. `GET /api/withdrawals/me` (member) — own withdrawal history.

### Business Finance Facility (phase 1: through approve/decline)

Covers the front half of the facility lifecycle: **eligibility check →
application → documents → officer review → approve (with possibly
different terms) / decline / request more information**. Deliberately
stops short of offer acceptance, agreement generation/signing,
disbursement, the active-facility record, repayment schedules, and
appeals — those are their own build, and the schema keeps *application*
and *facility* as separate concepts (a declined application never becomes
a facility; only an accepted, disbursed one will) so adding them later
doesn't mean reshaping what's here.

- `GET /api/finance-facilities/eligibility` (member) — computed entirely
  server-side from the member's real data (KYC status, membership age,
  **confirmed** deposits and **processed** withdrawals only — not
  pending/failed/declined attempts, existing active application). Returns
  `{ eligible, note, checks, metrics }`. "Eligible" here is explicitly
  *preliminary* — business purpose can't be assessed until an application
  exists, so this never claims a final yes.
- `POST /api/finance-facilities/apply` (member, JSON) — requires an
  **approved** KYC submission, and blocks a second application while one
  is in `submitted` / `under_review` / `additional_information_required` /
  `approved`. A declined application doesn't block reapplying. Emails
  every admin.
- `POST /api/finance-facilities/:id/documents` (member, multipart, one
  `document` file + `documentType` per call) — facility-specific
  documents only (business registration, bank statement, etc.), uploaded
  to Cloudinary under `finance-facility/<userId>/<applicationId>/` with
  the same `authenticated` access-restriction as KYC documents. Identity
  and address proof are **not** re-requested or duplicated for a member
  with approved KYC; the officer review reads those via the existing KYC
  document routes. Uploading while an application is in
  `additional_information_required` automatically moves it back into
  `under_review`.
- `GET /api/finance-facilities/me`, `GET /api/finance-facilities/:id`
  (member; owner-or-admin enforced in the service) and `GET
  .../:id/documents/:docId` (same proxy-through-our-endpoint pattern as
  KYC documents — the signed Cloudinary URL never reaches the browser).
- Admin (`/api/admin/finance-facilities`): `GET /` (queue, filterable by
  `status`), `GET /:id` (full detail — the admin additionally gets
  `accountAnalysis` metrics, a KYC summary, and current balances; **a
  member's own view of their application deliberately omits these**), `POST
  /:id/request-info`, `POST /:id/approve`, `POST /:id/decline`. Opening a
  `submitted` application as an admin quietly moves it to `under_review`
  (no separate "start review" click). Approval takes
  `approvedAmount`, `interestRate`, `termMonths`, `repaymentFrequency`
  and `installmentAmount` — the officer enters the installment directly
  rather than the backend computing it, since flat vs. reducing-balance
  amortization is a lending-policy choice the cooperative hasn't made yet.

**Eligibility thresholds are placeholders, not policy.** They live as
named constants at the top of `src/services/financeFacility.service.js`
(`ELIGIBILITY_RULES`: minimum membership months, minimum confirmed
deposits, minimum average monthly deposit) specifically so whoever owns
this product can tune them in one place. Treat the current values as
reasonable starting guesses, not a lending policy — they encode real
credit-risk judgment this codebase isn't qualified to make for the
cooperative.

### Error handling across all routes

Every route file wraps its controller with `wrapAsync()`
(`src/middleware/asyncHandler.js`). This matters: Express 4 doesn't
forward a rejected promise from an async handler to error middleware, and
every controller re-`throw`s anything that isn't a known `HttpError` —
without the wrapper that becomes an unhandled promise rejection that
**crashes the entire Node process** (taking down every member's session,
not just the one request). It surfaced while testing document upload
against an unreachable Cloudinary; any unexpected failure anywhere
(a DB hiccup, a storage outage) would have done the same. Now an
unexpected error returns a normal 500 from the global handler in
`app.js` and the server keeps running.

### Database

`src/db/migrations/` is a tracked, ordered sequence (`001_init.sql`,
`002_kyc_and_deposits.sql`, `003_kyc_documents_to_cloudinary.sql`,
`004_withdrawals.sql`, `005_finance_facility_applications.sql`). `npm run
migrate` records what's applied in a `schema_migrations` table and skips
anything already run — safe to re-run, and the pattern for the next phase
is just adding `006_*.sql`.

## What's next (not in this slice)

Finance facility phase 2 — offer acceptance/decline, agreement
generation + signed-agreement upload, disbursement, the active-facility
record with repayment schedule, and appeals of declined applications —
plus broader admin reporting and audit logs. Revisit the CSRF note above
before any of those move money; deposits and withdrawals already do, and
disbursement/repayments will too, so it's worth prioritizing soon.
