import { Router } from "express";

import {
  getMemberDashboard,
  getMemberRepaymentSchedule,
  getMemberOutstandingBalance,
  getMemberRepaymentHistory,
  initializeMemberRepayment,
  verifyMemberRepayment,
  getAdminRepaymentHistory,
  verifyAdminRepayment,
  generateAdminRepaymentSchedule,
} from "../controllers/financeFacilityRepayment.controller.js";

import {
  requireAuth,
  requireAdmin,
} from "../middleware/auth.middleware.js";

const router = Router();

// Member repayment endpoints
router.get("/dashboard", requireAuth, getMemberDashboard);
router.get("/history", requireAuth, getMemberRepaymentHistory);

router.get(
  "/:facilityId/schedule",
  requireAuth,
  getMemberRepaymentSchedule
);

router.get(
  "/:facilityId/balance",
  requireAuth,
  getMemberOutstandingBalance
);

router.post(
  "/:facilityId/initialize",
  requireAuth,
  initializeMemberRepayment
);

router.post("/verify", requireAuth, verifyMemberRepayment);

// Admin repayment endpoints
router.get(
  "/admin",
  requireAuth,
  requireAdmin,
  getAdminRepaymentHistory
);

router.post(
  "/admin/verify",
  requireAuth,
  requireAdmin,
  verifyAdminRepayment
);

router.post(
  "/admin/facilities/:facilityId/generate-schedule",
  requireAuth,
  requireAdmin,
  generateAdminRepaymentSchedule
);

export default router;