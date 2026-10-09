import { Router } from "express";
import { body } from "express-validator";
import * as kycControllerRaw from "../controllers/kyc.controller.js";
import { requireAuth, requireAdmin } from "../middleware/auth.middleware.js";
import { handleUploadErrors } from "../middleware/upload.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { wrapAsync } from "../middleware/asyncHandler.js";

const kycController = wrapAsync(kycControllerRaw);

const memberRouter = Router();
const adminRouter = Router();

// --- Member: /api/kyc ---

memberRouter.use(requireAuth);

memberRouter.post(
  "/",
  handleUploadErrors, // must run before validate — it's what parses the multipart body
  [
    body("accountNumber").trim().isLength({ min: 10, max: 10 }).withMessage("Account number must be 10 digits."),
    body("bankName").trim().notEmpty().withMessage("Bank name is required."),
    body("houseAddress").trim().isLength({ min: 5, max: 255 }).withMessage("House address is required."),
  ],
  validate,
  kycController.submit
);

memberRouter.get("/me", kycController.getMine);

memberRouter.get("/:id/documents/:docType", kycController.getDocument);

// --- Admin: /api/admin/kyc ---

adminRouter.use(requireAuth, requireAdmin);

adminRouter.get("/", kycController.list);
adminRouter.post("/:id/approve", kycController.approve);
adminRouter.post(
  "/:id/decline",
  [body("reason").trim().notEmpty().withMessage("A decline reason is required.")],
  validate,
  kycController.decline
);
adminRouter.get("/:id/documents/:docType", kycController.getDocument);

export { memberRouter as kycMemberRoutes, adminRouter as kycAdminRoutes };