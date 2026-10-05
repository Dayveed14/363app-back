import { Resend } from "resend";
import { env } from "../config/env.js";
import { renderOtpEmail } from "../templates/otpEmail.js";

let client;

function getClient() {
  if (!client) client = new Resend(env.resend.apiKey);
  return client;
}

/**
 * Sends an OTP email via Resend. Deliberately logs only metadata (recipient,
 * purpose) — never the OTP itself and never the full message body, so the
 * code can't leak into application logs, log aggregators, or error trackers.
 */
export async function sendOtpEmail({ to, fullName, purpose, code, expiresMinutes }) {
  const { subject, html, text } = renderOtpEmail({ purpose, code, expiresMinutes, fullName });

  const { data, error } = await getClient().emails.send({
    from: env.resend.from,
    to: [to],
    subject,
    html,
    text,
  });

  if (error) {
    // `error` from the Resend SDK is a {name, message} object describing the
    // API failure (bad key, unverified domain, etc.) — it never contains the
    // email body, so this is safe to log in full.
    console.error("[mailer] Resend failed to send OTP email:", error);
    throw new Error("Could not send the verification email. Please try again.");
  }

  console.log(
    `[mailer] OTP email sent via Resend (purpose=${purpose}, recipient=${maskEmail(to)}, id=${data?.id})`
  );
}

/**
 * Generic sender for non-OTP notifications (KYC/deposit emails) — same
 * Resend client, same masked-recipient logging, just takes an already-
 * rendered {subject, html} instead of generating an OTP template.
 */
export async function sendNotificationEmail({ to, subject, html, text }) {
  const { data, error } = await getClient().emails.send({
    from: env.resend.from,
    to: [to],
    subject,
    html,
    text,
  });

  if (error) {
    console.error("[mailer] Resend failed to send notification email:", error);
    // Notifications are best-effort — a failed admin alert shouldn't fail
    // the member's KYC submission or deposit itself.
    return;
  }

  console.log(`[mailer] Notification email sent (recipient=${maskEmail(to)}, id=${data?.id})`);
}

function maskEmail(email) {
  const [user, domain] = String(email).split("@");
  if (!domain) return "***";
  const visible = user.slice(0, 2);
  return `${visible}${"*".repeat(Math.max(user.length - 2, 1))}@${domain}`;
}
