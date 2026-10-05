import { wrapEmail, heading, paragraph, escapeHtml } from "./layout.js";

const PURPOSE_COPY = {
  email_verification: {
    subject: "Verify your email — 363 Cooperative Society",
    heading: "Confirm your email address",
    body: "Use the code below to finish creating your 363 Cooperative Society account.",
  },
  login_2fa: {
    subject: "Your login code — 363 Cooperative Society",
    heading: "Confirm it's you",
    body: "Use the code below to finish signing in to your 363 Cooperative Society account.",
  },
  withdrawal: {
    subject: "Confirm your withdrawal — 363 Cooperative Society",
    heading: "Confirm your withdrawal request",
    body: "Use the code below to confirm the withdrawal request you just submitted.",
  },
};

export function renderOtpEmail({ purpose, code, expiresMinutes, fullName }) {
  const copy = PURPOSE_COPY[purpose] || PURPOSE_COPY.login_2fa;
  const greetingName = fullName ? fullName.split(" ")[0] : "there";

  const inner = `
    ${heading(copy.heading)}
    ${paragraph(`Hi ${escapeHtml(greetingName)}, ${copy.body}`)}
    <div style="background:#FFF4EA;border:1px solid #FFE4CC;border-radius:12px;padding:18px;text-align:center;margin-bottom:20px;">
      <span style="font-family:'Courier New',monospace;font-size:32px;font-weight:700;letter-spacing:8px;color:#0A0A6E;">${code}</span>
    </div>
    ${paragraph(`This code expires in <strong>${expiresMinutes} minutes</strong> and can only be used once.`)}
    ${paragraph("Didn't request this? You can safely ignore this email — your account is still secure.", { muted: true })}
  `;

  const text = `${copy.heading}\n\nYour code is: ${code}\nIt expires in ${expiresMinutes} minutes and can only be used once.\n\nDidn't request this? You can safely ignore this email.`;

  return { subject: copy.subject, html: wrapEmail(inner), text };
}
