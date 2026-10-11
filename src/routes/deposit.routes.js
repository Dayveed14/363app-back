import { Router } from "express";
import { body } from "express-validator";
import * as depositControllerRaw from "../controllers/deposit.controller.js";
import { requireAuth, requireAdmin } from "../middleware/auth.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { wrapAsync } from "../middleware/asyncHandler.js";

const depositController = wrapAsync(depositControllerRaw);

const memberRouter = Router();
const adminRouter = Router();

// --- Member: /api/deposits ---

memberRouter.use(requireAuth);

memberRouter.post(
  "/initialize",
  [body("amount").isFloat({ min: 100 }).withMessage("The minimum deposit is ₦100.")],
  validate,
  depositController.initialize
);

// Called by the frontend's /deposit/callback page after Paystack redirects back.
memberRouter.get("/verify/:reference", depositController.verify);

memberRouter.get("/me", depositController.listMine);

// --- Admin: /api/admin/deposits ---

adminRouter.use(requireAuth, requireAdmin);

adminRouter.get("/", depositController.list);
adminRouter.post("/:id/confirm", depositController.confirm);
adminRouter.post(
  "/:id/decline",
  [body("reason").trim().notEmpty().withMessage("A decline reason is required.")],
  validate,
  depositController.decline
);

export { memberRouter as depositMemberRoutes, adminRouter as depositAdminRoutes };
