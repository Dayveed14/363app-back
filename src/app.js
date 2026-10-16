import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import morgan from "morgan";
import { env } from "./config/env.js";
import authRoutes from "./routes/auth.routes.js";
import { kycMemberRoutes, kycAdminRoutes } from "./routes/kyc.routes.js";
import { depositMemberRoutes, depositAdminRoutes } from "./routes/deposit.routes.js";
import { withdrawalMemberRoutes, withdrawalAdminRoutes } from "./routes/withdrawal.routes.js";
import { financeFacilityMemberRoutes, financeFacilityAdminRoutes } from "./routes/financeFacility.routes.js";
import { HttpError } from "./utils/errors.js";
import financeFacilityRepaymentRoutes from "./routes/financeFacilityRepayment.routes.js";

export const app = express();


const allowedOrigins = [
  "http://localhost:5173",
  "https://363app-front.vercel.app",
  "https://localhost",
];

app.set("trust proxy", 1); // needed on Render so req.ip / rate limiting / Secure cookies see the real client connection

app.use(helmet());
app.use(
  cors({
    // Must be an exact origin (not "*") for the browser to accept
    // credentialed (cookie-bearing) requests.
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  })
);
app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());

// Standard combined-style log line only (method, path, status, timing) —
// request bodies are never logged, so passwords/OTPs can't end up in logs.
app.use(morgan(env.nodeEnv === "production" ? "combined" : "dev"));

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.use("/api/auth", authRoutes);
app.use("/api/kyc", kycMemberRoutes);
app.use("/api/admin/kyc", kycAdminRoutes);
app.use("/api/deposits", depositMemberRoutes);
app.use("/api/admin/deposits", depositAdminRoutes);
app.use("/api/withdrawals", withdrawalMemberRoutes);
app.use("/api/admin/withdrawals", withdrawalAdminRoutes);
app.use("/api/finance-facilities", financeFacilityMemberRoutes);
app.use("/api/admin/finance-facilities", financeFacilityAdminRoutes);
app.use("/api/finance-facility-repayments", financeFacilityRepaymentRoutes);
app.use((req, res) => {
  res.status(404).json({ error: "Not found." });
});

// Global error handler — last middleware.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  if (err && err.message === "Not allowed by CORS") {
    return res.status(403).json({ error: "Not allowed by CORS." });
  }
  console.error("[unhandled error]", err);
  res.status(500).json({ error: "Something went wrong. Please try again." });
});
