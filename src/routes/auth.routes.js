import { Router } from "express";
import { body } from "express-validator";
import * as authControllerRaw from "../controllers/auth.controller.js";
import { wrapAsync } from "../middleware/asyncHandler.js";
import { validate } from "../middleware/validate.middleware.js";

const authController = wrapAsync(authControllerRaw);
import { authLimiter, otpLimiter } from "../middleware/rateLimit.middleware.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { OTP_PURPOSE } from "../services/otp.service.js";

const router = Router();

const otpCodeValidator = body("code")
  .trim()
  .isLength({ min: 6, max: 6 })
  .withMessage("Code must be 6 digits.")
  .isNumeric()
  .withMessage("Code must be numeric.");

router.post(
  "/register",
  authLimiter,
  [
    body("fullName").trim().isLength({ min: 2, max: 150 }).withMessage("Full name is required."),
    body("email").trim().isEmail().withMessage("A valid email is required.").normalizeEmail(),
    body("phone")
      .trim()
      .matches(/^\+?[0-9]{10,15}$/)
      .withMessage("A valid phone number is required."),
    body("password")
      .isLength({ min: 8 })
      .withMessage("Password must be at least 8 characters.")
      .matches(/[A-Z]/)
      .withMessage("Password must include an uppercase letter.")
      .matches(/[0-9]/)
      .withMessage("Password must include a number."),
  ],
  validate,
  authController.register
);

router.post(
  "/verify-email",
  otpLimiter,
  [body("email").trim().isEmail().normalizeEmail(), otpCodeValidator],
  validate,
  authController.verifyEmail
);

router.post(
  "/resend-otp",
  otpLimiter,
  [
    body("email").trim().isEmail().normalizeEmail(),
    body("purpose").isIn(Object.values(OTP_PURPOSE)).withMessage("Invalid purpose."),
  ],
  validate,
  authController.resendOtp
);

router.post(
  "/login",
  authLimiter,
  [
    body("email").trim().isEmail().withMessage("A valid email is required.").normalizeEmail(),
    body("password").notEmpty().withMessage("Password is required."),
  ],
  validate,
  authController.login
);

router.post(
  "/login/verify-otp",
  otpLimiter,
  [otpCodeValidator],
  validate,
  authController.verifyLoginOtp
);

// No body validation needed for these two — both read their token from an
// httpOnly cookie the browser attaches automatically, not from the request
// body.
router.post("/refresh", authController.refresh);

router.post("/logout", authController.logout);

router.get("/me", requireAuth, authController.me);

export default router;
