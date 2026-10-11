import { Router } from "express";
import { body } from "express-validator";
import * as withdrawalControllerRaw from "../controllers/withdrawal.controller.js";
import { requireAuth, requireAdmin } from "../middleware/auth.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { otpLimiter } from "../middleware/rateLimit.middleware.js";
import { wrapAsync } from "../middleware/asyncHandler.js";

const withdrawalController = wrapAsync(withdrawalControllerRaw);

const memberRouter = Router();
const adminRouter = Router();

// --- Member: /api/withdrawals ---

memberRouter.use(requireAuth);

memberRouter.post(
  "/initiate",
  otpLimiter,
  [body("amount").isFloat({ min: 100 }).withMessage("The minimum withdrawal is ₦100.")],
  validate,
  withdrawalController.initiate
);

memberRouter.post(
  "/confirm",
  otpLimiter,
  [
    body("code")
      .trim()
      .isLength({ min: 6, max: 6 })
      .withMessage("Code must be 6 digits.")
      .isNumeric()
      .withMessage("Code must be numeric."),
  ],
  validate,
  withdrawalController.confirm
);

memberRouter.get("/me", withdrawalController.listMine);

// --- Admin: /api/admin/withdrawals ---

adminRouter.use(requireAuth, requireAdmin);

adminRouter.get("/", withdrawalController.list);
adminRouter.post("/:id/approve", withdrawalController.approve);
adminRouter.post(
  "/:id/decline",
  [body("reason").trim().notEmpty().withMessage("A decline reason is required.")],
  validate,
  withdrawalController.decline
);
adminRouter.post("/:id/process", withdrawalController.process);

export { memberRouter as withdrawalMemberRoutes, adminRouter as withdrawalAdminRoutes };
