import rateLimit from "express-rate-limit";

// Automated tests make hundreds of auth calls from one IP; they skip the
// limiters unless a test opts in with TEST_RATE_LIMITS=1.
const skipInTests = () => process.env.NODE_ENV === "test" && !process.env.TEST_RATE_LIMITS;

// Applies to register/login: slows down credential-stuffing / brute force.
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  skip: skipInTests,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please try again later." },
});

// Tighter limit specifically for OTP requests and verification, since these
// guard the 2FA step itself.
export const otpLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 8,
  skip: skipInTests,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many OTP requests. Please wait a few minutes and try again." },
});
