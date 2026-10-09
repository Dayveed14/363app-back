import { wrapEmail, heading, paragraph, calloutBox, escapeHtml } from "./layout.js";

function render({ subject, headingText, bodyHtml }) {
  const inner = `${heading(headingText)}${bodyHtml}`;
  return { subject, html: wrapEmail(inner) };
}

const naira = (n) => "₦" + Number(n).toLocaleString("en-NG", { minimumFractionDigits: 2 });

// --- KYC ---

export function kycSubmittedAdminEmail({ memberName, memberEmail }) {
  return render({
    subject: "New KYC submission — 363 Cooperative Society",
    headingText: "A member submitted KYC for review",
    bodyHtml:
      paragraph(`<strong>${escapeHtml(memberName)}</strong> (${escapeHtml(memberEmail)}) has submitted KYC documents and is waiting for review.`) +
      paragraph("Sign in to the admin dashboard to review the submission.", { muted: true }),
  });
}

export function kycApprovedEmail({ fullName }) {
  return render({
    subject: "Your KYC has been approved — 363 Cooperative Society",
    headingText: "You're verified",
    bodyHtml:
      paragraph(`Hi ${escapeHtml(fullName.split(" ")[0])}, your KYC documents have been reviewed and approved.`) +
      calloutBox("Your account is now fully active.", { tone: "success" }) +
      paragraph("You can now make deposits and use your account.", { muted: true }),
  });
}

export function kycDeclinedEmail({ fullName, reason }) {
  return render({
    subject: "Action needed on your KYC submission — 363 Cooperative Society",
    headingText: "Your KYC submission needs changes",
    bodyHtml:
      paragraph(`Hi ${escapeHtml(fullName.split(" ")[0])}, we weren't able to approve your KYC submission.`) +
      calloutBox(escapeHtml(reason), { tone: "danger" }) +
      paragraph("Please sign in and resubmit your documents with the issue above corrected.", { muted: true }),
  });
}

// --- Deposits ---

export function depositPendingAdminEmail({ memberName, memberEmail, amount, reference }) {
  return render({
    subject: "Deposit awaiting confirmation — 363 Cooperative Society",
    headingText: "A deposit needs confirmation",
    bodyHtml:
      paragraph(`<strong>${escapeHtml(memberName)}</strong> (${escapeHtml(memberEmail)}) made a deposit of <strong>${naira(amount)}</strong> that Paystack has confirmed as paid.`) +
      paragraph(`Reference: <code>${escapeHtml(reference)}</code>`, { muted: true }) +
      paragraph("It's sitting in their book balance until an admin confirms it in the dashboard.", { muted: true }),
  });
}

export function depositConfirmedEmail({ fullName, amount }) {
  return render({
    subject: "Deposit confirmed — 363 Cooperative Society",
    headingText: "Your deposit has been confirmed",
    bodyHtml:
      paragraph(`Hi ${escapeHtml(fullName.split(" ")[0])}, your deposit of <strong>${naira(amount)}</strong> has been confirmed and is now available in your account.`) +
      calloutBox(`${naira(amount)} added to your available balance`, { tone: "success" }),
  });
}

export function depositDeclinedEmail({ fullName, amount, reason }) {
  return render({
    subject: "Deposit could not be confirmed — 363 Cooperative Society",
    headingText: "We couldn't confirm your deposit",
    bodyHtml:
      paragraph(`Hi ${escapeHtml(fullName.split(" ")[0])}, your deposit of <strong>${naira(amount)}</strong> could not be confirmed.`) +
      calloutBox(escapeHtml(reason), { tone: "danger" }) +
      paragraph("If you believe this is a mistake, please contact the cooperative office.", { muted: true }),
  });
}

export function depositFailedEmail({ fullName, amount, reason }) {
  return render({
    subject: "Deposit not successful — 363 Cooperative Society",
    headingText: "Your deposit wasn't successful",
    bodyHtml:
      paragraph(`Hi ${escapeHtml(fullName.split(" ")[0])}, your attempted deposit of <strong>${naira(amount)}</strong> was not successful.`) +
      calloutBox(escapeHtml(reason || "Please contact your bank, or try again with a different card."), { tone: "danger" }),
  });
}

// --- Withdrawals ---

export function withdrawalSubmittedAdminEmail({ memberName, memberEmail, amount, bankName, accountNumber }) {
  return render({
    subject: "New withdrawal request — 363 Cooperative Society",
    headingText: "A member requested a withdrawal",
    bodyHtml:
      paragraph(`<strong>${escapeHtml(memberName)}</strong> (${escapeHtml(memberEmail)}) requested a withdrawal of <strong>${naira(amount)}</strong>.`) +
      paragraph(`To: ${escapeHtml(bankName)} · ${escapeHtml(accountNumber)}`, { muted: true }) +
      paragraph("The amount is already on hold from their available balance pending your review.", { muted: true }),
  });
}

export function withdrawalApprovedEmail({ fullName, amount }) {
  return render({
    subject: "Withdrawal approved — 363 Cooperative Society",
    headingText: "Your withdrawal was approved",
    bodyHtml:
      paragraph(`Hi ${escapeHtml(fullName.split(" ")[0])}, your withdrawal of <strong>${naira(amount)}</strong> has been approved.`) +
      calloutBox("Payout is being processed and you'll be notified once it's sent.", { tone: "success" }),
  });
}

export function withdrawalDeclinedEmail({ fullName, amount, reason }) {
  return render({
    subject: "Withdrawal declined — 363 Cooperative Society",
    headingText: "Your withdrawal request was declined",
    bodyHtml:
      paragraph(`Hi ${escapeHtml(fullName.split(" ")[0])}, your withdrawal request for <strong>${naira(amount)}</strong> was declined.`) +
      calloutBox(escapeHtml(reason), { tone: "danger" }) +
      paragraph(`${naira(amount)} has been returned to your available balance.`, { muted: true }),
  });
}

export function withdrawalProcessedEmail({ fullName, amount, bankName, accountNumber }) {
  return render({
    subject: "Withdrawal paid out — 363 Cooperative Society",
    headingText: "Your withdrawal has been paid out",
    bodyHtml:
      paragraph(`Hi ${escapeHtml(fullName.split(" ")[0])}, <strong>${naira(amount)}</strong> has been sent to your account.`) +
      calloutBox(`${escapeHtml(bankName)} · ${escapeHtml(accountNumber)}`, { tone: "success" }),
  });
}

// --- Business Finance Facility ---

export function financeFacilitySubmittedAdminEmail({ memberName, memberEmail, amount }) {
  return render({
    subject: "New finance facility application — 363 Cooperative Society",
    headingText: "A member applied for a Business Finance Facility",
    bodyHtml:
      paragraph(`<strong>${escapeHtml(memberName)}</strong> (${escapeHtml(memberEmail)}) requested <strong>${naira(amount)}</strong>.`) +
      paragraph("Sign in to the admin dashboard to review the application.", { muted: true }),
  });
}

export function financeFacilityInfoRequestedEmail({ fullName, request }) {
  return render({
    subject: "Action needed on your finance facility application — 363 Cooperative Society",
    headingText: "We need a bit more information",
    bodyHtml:
      paragraph(`Hi ${escapeHtml(fullName.split(" ")[0])}, an officer reviewing your Business Finance Facility application needs more information:`) +
      calloutBox(escapeHtml(request)) +
      paragraph("Please sign in and respond to continue the review.", { muted: true }),
  });
}

export function financeFacilityApprovedEmail({ fullName, requestedAmount, approvedAmount, termMonths, installmentAmount }) {
  const sameAmount = Number(requestedAmount) === Number(approvedAmount);
  return render({
    subject: "Your finance facility application was approved — 363 Cooperative Society",
    headingText: "Your Business Finance Facility was approved",
    bodyHtml:
      paragraph(`Hi ${escapeHtml(fullName.split(" ")[0])}, your application has been approved${sameAmount ? "" : " for a different amount than requested"}.`) +
      calloutBox(
        `${naira(approvedAmount)} · ${termMonths} months · ${naira(installmentAmount)}/installment`,
        { tone: "success" }
      ) +
      paragraph("Sign in to review and accept the offer.", { muted: true }),
  });
}

export function financeFacilityDeclinedEmail({ fullName, reason }) {
  return render({
    subject: "Your finance facility application was declined — 363 Cooperative Society",
    headingText: "Your Business Finance Facility application was declined",
    bodyHtml:
      paragraph(`Hi ${escapeHtml(fullName.split(" ")[0])}, your application was not approved.`) +
      calloutBox(escapeHtml(reason), { tone: "danger" }),
  });
}
