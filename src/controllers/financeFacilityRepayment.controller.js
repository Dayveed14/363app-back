import * as repaymentService from "../services/financeFacilityRepayment.service.js";
import { pool } from "../config/db.js";

/**

* Send consistent API errors without exposing internal database details.
  */
  function handleError(res, error, fallbackMessage) {
  const statusCode = Number(error.statusCode) || 500;

if (statusCode >= 500) {
console.error("[Finance Facility Repayment]", error);
}

return res.status(statusCode).json({
success: false,
message:
statusCode < 500
? error.message
: fallbackMessage || "An unexpected error occurred.",
});
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
  export async function getMemberDashboard(req, res) {
  const userId = getUserId(req);

if (!userId) {
return res.status(401).json({
success: false,
message: "Authentication required.",
});
}

try {
const [facilities] = await pool.query(
`SELECT id, user_id, business_name, approved_amount,
              installment_amount, repayment_frequency, term_months,
              disbursed_at, disbursement_reference
       FROM finance_facility_applications
       WHERE user_id = :userId
         AND status = 'disbursed'
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
return res.status(401).json({
success: false,
message: "Authentication required.",
});
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
return res.status(401).json({
success: false,
message: "Authentication required.",
});
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
return res.status(401).json({
success: false,
message: "Authentication required.",
});
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
return res.status(401).json({
success: false,
message: "Authentication required.",
});
}

if (
amount === undefined ||
amount === null ||
amount === "" ||
!Number.isFinite(Number(amount)) ||
Number(amount) <= 0
) {
return res.status(400).json({
success: false,
message: "Enter a valid repayment amount.",
});
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
  return res.status(404).json({
    success: false,
    message: "Member account not found.",
  });
}

if (!member.email) {
  return res.status(400).json({
    success: false,
    message: "A valid email address is required for payment.",
  });
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
return res.status(401).json({
success: false,
message: "Authentication required.",
});
}

if (
typeof reference !== "string" ||
reference.trim().length === 0
) {
return res.status(400).json({
success: false,
message: "A valid Paystack reference is required.",
});
}

try {
const result =
await repaymentService.verifyAndProcessRepayment({
paystackReference: reference.trim(),
userId,
});


return res.json({
  success: true,
  message: result.alreadyProcessed
    ? "This repayment has already been processed."
    : "Repayment verified and processed successfully.",
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
"success",
"failed",
]);

if (status && !allowedStatuses.has(status)) {
return res.status(400).json({
success: false,
message: "Invalid repayment status filter.",
});
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
return res.status(400).json({
success: false,
message: "A valid Paystack reference is required.",
});
}

try {
const result =
await repaymentService.verifyAndProcessRepayment({
paystackReference: reference.trim(),
});


return res.json({
  success: true,
  message: result.alreadyProcessed
    ? "This repayment has already been processed."
    : "Repayment verified and processed successfully.",
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
