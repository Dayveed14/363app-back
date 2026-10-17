import "dotenv/config";

function required(name, fallback = undefined) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const baseOrigins = [
  "http://localhost:5173",
  "https://363app-front.vercel.app",
  "https://localhost",
];
const extraOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
const clientOrigin = process.env.CLIENT_ORIGIN || "http://localhost:5173";

export const env = {
  allowedOrigins: [...new Set([...baseOrigins, clientOrigin, ...extraOrigins])],
  nodeEnv: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT || 4000),
  clientOrigin: process.env.CLIENT_ORIGIN || "http://localhost:5173",

  db: {
    host: required("DB_HOST"),
    port: Number(process.env.DB_PORT || 3306),
    user: required("DB_USER"),
    password: process.env.DB_PASSWORD || "",
    database: required("DB_NAME"),
    connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
    // TiDB Cloud requires TLS on its public endpoint. TiDB Cloud's serverless
    // tier is signed by a publicly trusted CA, so Node's default trust store
    // is normally enough (no custom CA file needed) — set DB_SSL_CA_PATH only
    // if your cluster/proxy needs a specific bundle.
    ssl: process.env.DB_SSL === "true",
    sslCaPath: process.env.DB_SSL_CA_PATH || null,
  },

  jwt: {
    accessSecret: required("JWT_ACCESS_SECRET"),
    refreshSecret: required("JWT_REFRESH_SECRET"),
    pending2faSecret: required("JWT_PENDING_2FA_SECRET"),
    pendingWithdrawalSecret: required("JWT_PENDING_WITHDRAWAL_SECRET"),
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || "15m",
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "7d",
    pending2faExpiresIn: process.env.JWT_PENDING_2FA_EXPIRES_IN || "10m",
    pendingWithdrawalExpiresIn: process.env.JWT_PENDING_WITHDRAWAL_EXPIRES_IN || "10m",
  },

  otp: {
    length: Number(process.env.OTP_LENGTH || 6),
    expiresMinutes: Number(process.env.OTP_EXPIRES_MINUTES || 5),
    maxAttempts: Number(process.env.OTP_MAX_ATTEMPTS || 5),
    hashPepper: required("OTP_HASH_PEPPER"),
  },

  cookies: {
    accessName: process.env.COOKIE_ACCESS_NAME || "access_token",
    refreshName: process.env.COOKIE_REFRESH_NAME || "refresh_token",
    pending2faName: process.env.COOKIE_PENDING_2FA_NAME || "pending_2fa_token",
    pendingWithdrawalName: process.env.COOKIE_PENDING_WITHDRAWAL_NAME || "pending_withdrawal_token",
    // Only needed if the frontend and backend end up sharing a parent domain
    // (e.g. app.363resources.com + api.363resources.com → ".363resources.com").
    // Leave unset while they're on unrelated domains (e.g. Vercel + Render).
    domain: process.env.COOKIE_DOMAIN || undefined,
  },

  resend: {
    apiKey: required("RESEND_API_KEY"),
    from: process.env.EMAIL_FROM || "363 Cooperative Society <no-reply@363resources.com>",
  },

  paystack: {
    secretKey: required("PAYSTACK_SECRET_KEY"),
    publicKey: required("PAYSTACK_PUBLIC_KEY"),
    // Paystack redirects the member's browser here after checkout, with
    // ?reference=... in the query string — the frontend route that reads it
    // and calls POST /api/deposits/verify/:reference.
    callbackUrl: process.env.PAYSTACK_CALLBACK_URL || `${process.env.CLIENT_ORIGIN || "http://localhost:5173"}/deposit/callback`,
  },

  uploads: {
    maxFileSizeMb: Number(process.env.UPLOAD_MAX_FILE_SIZE_MB || 5),
  },

  cloudinary: {
    cloudName: required("CLOUDINARY_CLOUD_NAME"),
    apiKey: required("CLOUDINARY_API_KEY"),
    apiSecret: required("CLOUDINARY_API_SECRET"),
  },
};
