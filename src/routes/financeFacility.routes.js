import { Router } from "express";
import { body } from "express-validator";
import * as controllerRaw from "../controllers/financeFacility.controller.js";
import { requireAuth, requireAdmin } from "../middleware/auth.middleware.js";
import { handleFacilityUploadErrors } from "../middleware/upload.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { wrapAsync } from "../middleware/asyncHandler.js";

const controller = wrapAsync(controllerRaw);

const memberRouter = Router();
const adminRouter = Router();

const applicationFormValidators = [
  body("amountRequested").isFloat({ gt: 0 }).withMessage("Enter a valid amount."),
  body("purpose")
    .isIn(["working_capital", "inventory", "equipment", "expansion", "other"])
    .withMessage("Select a valid purpose."),
  body("purposeDescription").trim().notEmpty().withMessage("Describe how the facility will be used."),
  body("expectedBenefit").trim().notEmpty().withMessage("Describe the expected business benefit."),
  body("repaymentSource").trim().notEmpty().withMessage("Describe your expected repayment source."),
  body("expectedMonthlyIncome").isFloat({ min: 0 }).withMessage("Enter expected monthly income."),
  body("expectedMonthlyExpenses").isFloat({ min: 0 }).withMessage("Enter expected monthly expenses."),
  body("businessName").trim().notEmpty().withMessage("Business name is required."),
  body("businessType").trim().notEmpty().withMessage("Business type is required."),
  body("businessAddress").trim().notEmpty().withMessage("Business address is required."),
  body("yearsInBusiness").isFloat({ min: 0 }).withMessage("Enter years in business."),
];

// --- Member: /api/finance-facilities ---

memberRouter.use(requireAuth);

memberRouter.get("/eligibility", controller.getEligibility);
memberRouter.post("/apply", applicationFormValidators, validate, controller.apply);
memberRouter.get("/me", controller.listMine);
memberRouter.get("/:id", controller.getOne); // owner-or-admin check happens in the service
memberRouter.post(
  "/:id/documents",
  handleFacilityUploadErrors,
  [body("documentType").trim().notEmpty().withMessage("Document type is required.")],
  validate,
  controller.addDocument
);
memberRouter.get("/:id/documents/:docId", controller.getDocument);

// --- Admin: /api/admin/finance-facilities ---

adminRouter.use(requireAuth, requireAdmin);

adminRouter.get("/", controller.list);
adminRouter.get("/:id", controller.getOne);
adminRouter.get("/:id/documents/:docId", controller.getDocument);
adminRouter.post(
  "/:id/request-info",
  [body("request").trim().notEmpty().withMessage("Describe what information is needed.")],
  validate,
  controller.requestMoreInfo
);
adminRouter.post(
  "/:id/approve",
  [
    body("approvedAmount").isFloat({ gt: 0 }).withMessage("Enter a valid approved amount."),
    body("interestRate").isFloat({ min: 0 }).withMessage("Enter an interest rate."),
    body("termMonths").isInt({ gt: 0 }).withMessage("Enter a term in months."),
    body("repaymentFrequency").isIn(["weekly", "biweekly", "monthly"]).withMessage("Select a repayment frequency."),
    body("installmentAmount").isFloat({ gt: 0 }).withMessage("Enter an installment amount."),
  ],
  validate,
  controller.approve
);
adminRouter.post(
  "/:id/decline",
  [body("reason").trim().notEmpty().withMessage("A decline reason is required.")],
  validate,
  controller.decline
);
adminRouter.post(
  "/:id/disburse",
  controller.disburse
);

export { memberRouter as financeFacilityMemberRoutes, adminRouter as financeFacilityAdminRoutes };
