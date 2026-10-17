import * as repaymentService from "../services/financeFacilityRepayment.service.js";
import { pool } from "../config/db.js";

/**
 * Consistent error body: `error` is what the frontend reads (same shape as
 * every other API in this app); `message` is kept so older clients still work.
 */
function fail(res, statusCode, message, code) {
  return res.status(statusCode).json({
    success: false,
    error: message,
    message,
    ...(code ? { code } : {}),
  });
}

function handleError(res, error, fallbackMessage) {
  const statusCode = Number(error.statusCode) || 500;

  if (statusCode >= 500) {
    console.error("[Finance Facility Repayment]", error);
  }

  return fail(
    res,
    statusCode,
    statusCode < 500 ? error.message : fallbackMessage || "An unexpected error occurred.",
    statusCode < 500 ? error.code : undefined
  );
}

/**

* Resolve the authenticated member ID.
*
* This assumes the existing authentication middleware attaches
* the authenticated user to req.user.
  */
  function getUserId(req) {
  return req.user?.id ?? req.user?.userId ?? null;
  }

/**

* GET /api/finance-facility-repayments/dashboard
*
* Return the authenticated member's disbursed facilities, balances,
* next repayment due, and repayment history.
  */
  function verifyMessage(result) {
  if (result.status === "failed") return "Paystack reported this payment as failed.";
  if (result.status === "pending_confirmation")
    return result.alreadyProcessed
      ? "This repayment is already awaiting admin confirmation."
      : "Payment received. It will reflect on your facility once an admin confirms it.";
  if (result.status === "success") return "This repayment has already been confirmed.";
  if (result.status === "declined") return "This repayment was declined.";
  return "Repayment checked.";
}

export async function getMemberDashboard(req, res) {
  const userId = getUserId(req);

if (!userId) {
return fail(res, 401, "Authentication required.");
}

try {
const [facilities] = await pool.query(
`SELECT id, user_id, business_name, approved_amount,
              installment_amount, repayment_frequency, term_months,
              disbursed_at, disbursement_reference
       FROM finance_facility_applications
       WHERE user_id = :userId
         AND status IN ('disbursed', 'completed')
       ORDER BY disbursed_at DESC, id DESC`,
{ userId }
);


const results = await Promise.all(
  facilities.map(async (facility) => {
    const [balance, nextRepayment, schedule] = await Promise.all([
      repaymentService.getOutstandingBalance(facility.id, userId),
      repaymentService.getNextRepaymentDue(facility.id, userId),
      repaymentService.getRepaymentSchedule(facility.id, userId),
    ]);

    return {
      facilityId: Number(facility.id),
      businessName: facility.business_name,
      approvedAmount: Number(facility.approved_amount),
      installmentAmount:
        facility.installment_amount === null
          ? null
          : Number(facility.installment_amount),
      repaymentFrequency: facility.repayment_frequency,
      termMonths: facility.term_months,
      disbursedAt: facility.disbursed_at,
      disbursementReference: facility.disbursement_reference,
      outstandingBalance: balance.outstandingBalance,
      totalRepayable: balance.totalRepayable,
      totalPaid: balance.totalPaid,
      completed: balance.completed,
      nextRepayment,
      schedule,
    };
  })
);

const history = await repaymentService.getMemberRepaymentHistory(userId);

return res.json({
  success: true,
  data: {
    facilities: results,
    totalOutstandingBalance: Number(
      results
        .reduce(
          (total, facility) =>
            total + facility.outstandingBalance,
          0
        )
        .toFixed(2)
    ),
    repaymentHistory: history,
  },
});


} catch (error) {
return handleError(
res,
error,
"Unable to load your repayment dashboard."
);
}
}

/**

* GET /api/finance-facility-repayments/:facilityId/schedule
*
* Return the authenticated member's schedule for one facility.
  */
  export async function getMemberRepaymentSchedule(req, res) {
  const userId = getUserId(req);
  const { facilityId } = req.params;

if (!userId) {
return fail(res, 401, "Authentication required.");
}

try {
const schedule = await repaymentService.getRepaymentSchedule(
facilityId,
userId
);


return res.json({
  success: true,
  data: schedule,
});


} catch (error) {
return handleError(
res,
error,
"Unable to load the repayment schedule."
);
}
}

/**

* GET /api/finance-facility-repayments/:facilityId/balance
*
* Return the authenticated member's outstanding balance.
  */
  export async function getMemberOutstandingBalance(req, res) {
  const userId = getUserId(req);
  const { facilityId } = req.params;

if (!userId) {
return fail(res, 401, "Authentication required.");
}

try {
const balance = await repaymentService.getOutstandingBalance(
facilityId,
userId
);


return res.json({
  success: true,
  data: balance,
});


} catch (error) {
return handleError(
res,
error,
"Unable to retrieve the outstanding balance."
);
}
}

/**

* GET /api/finance-facility-repayments/history
*
* Return successful repayments belonging to the authenticated member.
  */
  export async function getMemberRepaymentHistory(req, res) {
  const userId = getUserId(req);

if (!userId) {
return fail(res, 401, "Authentication required.");
}

try {
const history =
await repaymentService.getMemberRepaymentHistory(userId);


return res.json({
  success: true,
  data: history,
});


} catch (error) {
return handleError(
res,
error,
"Unable to retrieve repayment history."
);
}
}

/**

* POST /api/finance-facility-repayments/:facilityId/initialize
*
* Initialize a repayment through Paystack.
*
* Expected body:
* {
* "amount": 25000,
* "callbackUrl": "https://your-frontend.example/payment/callback"
* }
*
* The member's email is loaded from the database rather than accepted
* from the request body.
  */
  export async function initializeMemberRepayment(req, res) {
  const userId = getUserId(req);
  const { facilityId } = req.params;
  const { amount, callbackUrl } = req.body ?? {};

if (!userId) {
return fail(res, 401, "Authentication required.");
}

if (
amount === undefined ||
amount === null ||
amount === "" ||
!Number.isFinite(Number(amount)) ||
Number(amount) <= 0
) {
return fail(res, 400, "Enter a valid repayment amount.");
}

try {
const [users] = await pool.query(
`SELECT id, email
       FROM users
       WHERE id = :userId
       LIMIT 1`,
{ userId }
);


const member = users[0];

if (!member) {
  return fail(res, 404, "Member account not found.");
}

if (!member.email) {
  return fail(res, 400, "A valid email address is required for payment.");
}

const payment = await repaymentService.initializeRepayment({
  facilityId,
  userId,
  email: member.email,
  amount: Number(amount),
  callbackUrl,
});

return res.status(201).json({
  success: true,
  message: "Payment initialized successfully.",
  data: payment,
});


} catch (error) {
return handleError(
res,
error,
"Unable to initialize the repayment."
);
}
}

/**

* POST /api/finance-facility-repayments/verify
*
* Verify a Paystack payment and process it.
*
* Expected body:
* {
* "reference": "Paystack-generated-reference"
* }
  */
  export async function verifyMemberRepayment(req, res) {
  const userId = getUserId(req);
  const { reference } = req.body ?? {};

if (!userId) {
return fail(res, 401, "Authentication required.");
}

if (
typeof reference !== "string" ||
reference.trim().length === 0
) {
return fail(res, 400, "A valid Paystack reference is required.");
}

try {
const result =
await repaymentService.verifyAndProcessRepayment({
paystackReference: reference.trim(),
userId,
});


return res.json({
  success: true,
  message: verifyMessage(result),
  data: result,
});


} catch (error) {
return handleError(
res,
error,
"Unable to verify the repayment."
);
}
}

/**

* GET /api/admin/finance-facility-repayments
*
* Admin repayment transaction listing.
*
* Optional query:
* ?status=pending
* ?status=success
* ?status=failed
*
* IMPORTANT:
* Protect this endpoint with your existing admin authorization
* middleware in the routes file.
  */
  export async function getAdminRepaymentHistory(req, res) {
  const { status } = req.query;

const allowedStatuses = new Set([
"pending",
"pending_confirmation",
"success",
"declined",
"failed",
]);

if (status && !allowedStatuses.has(status)) {
return fail(res, 400, "Invalid repayment status filter.");
}

try {
const history =
await repaymentService.getAdminRepaymentHistory({
status: status || null,
});


return res.json({
  success: true,
  data: history,
});


} catch (error) {
return handleError(
res,
error,
"Unable to retrieve repayment transactions."
);
}
}

/**

* POST /api/admin/finance-facility-repayments/verify
*
* Allow an authorized administrator to trigger verification of a
* pending Paystack transaction.
*
* This does not permit an administrator to invent or manually credit
* a repayment. Paystack verification remains mandatory.
  */
  export async function verifyAdminRepayment(req, res) {
  const { reference } = req.body ?? {};

if (
typeof reference !== "string" ||
reference.trim().length === 0
) {
return fail(res, 400, "A valid Paystack reference is required.");
}

try {
const result =
await repaymentService.verifyAndProcessRepayment({
paystackReference: reference.trim(),
});


return res.json({
  success: true,
  message: verifyMessage(result),
  data: result,
});


} catch (error) {
return handleError(
res,
error,
"Unable to verify the repayment."
);
}
}

/**

* POST /api/admin/finance-facility-repayments/facilities/:facilityId/generate-schedule
*
* Generate a repayment schedule for an already-disbursed facility.
*
* This operation must be protected by admin authorization.
  */
  export async function generateAdminRepaymentSchedule(req, res) {
  const { facilityId } = req.params;

try {
const schedule =
await repaymentService.generateRepaymentSchedule(facilityId);


return res.status(200).json({
  success: true,
  message: "Repayment schedule generated successfully.",
  data: schedule,
});


} catch (error) {
return handleError(
res,
error,
"Unable to generate the repayment schedule."
);
}
}


/**
 * POST /api/finance-facility-repayments/admin/:repaymentId/confirm
 * Admin confirms receipt; the schedule allocation runs in this step.
 */
export async function confirmAdminRepayment(req, res) {
  try {
    const result = await repaymentService.confirmRepayment({
      repaymentId: Number(req.params.repaymentId),
      adminId: getUserId(req),
    });
    return res.json({
      success: true,
      message:
        result.outcome === "declined"
          ? "The payment exceeded the outstanding balance, so it was declined."
          : "Repayment confirmed and applied.",
      data: result,
    });
  } catch (error) {
    return handleError(res, error, "Unable to confirm the repayment.");
  }
}

/**
 * POST /api/finance-facility-repayments/admin/:repaymentId/decline
 * Body: { reason }
 */
export async function declineAdminRepayment(req, res) {
  try {
    const result = await repaymentService.declineRepayment({
      repaymentId: Number(req.params.repaymentId),
      adminId: getUserId(req),
      reason: req.body?.reason,
    });
    return res.json({ success: true, message: "Repayment declined.", data: result });
  } catch (error) {
    return handleError(res, error, "Unable to decline the repayment.");
  }
}

/**
 * POST /api/finance-facility-repayments/admin/reconcile
 * Re-verify repayments stuck in 'pending' (member never returned from Paystack).
 */
export async function reconcileAdminRepayments(req, res) {
  try {
    const summary = await repaymentService.reconcileStaleRepayments();
    return res.json({ success: true, message: "Reconciliation finished.", data: summary });
  } catch (error) {
    return handleError(res, error, "Unable to reconcile repayments.");
  }
}
