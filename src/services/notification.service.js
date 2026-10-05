import * as userModel from "../models/user.model.js";
import { sendNotificationEmail } from "./mailer.service.js";
import * as templates from "../templates/notificationEmail.js";

async function notifyAdmins(renderFn, data) {
  const admins = await userModel.findAdmins();
  const { subject, html } = renderFn(data);
  await Promise.all(
    admins.map((admin) => sendNotificationEmail({ to: admin.email, subject, html }))
  );
}

async function notifyMember(email, renderFn, data) {
  const { subject, html } = renderFn(data);
  await sendNotificationEmail({ to: email, subject, html });
}

export const notify = {
  kycSubmitted: (data) => notifyAdmins(templates.kycSubmittedAdminEmail, data),
  kycApproved: (email, data) => notifyMember(email, templates.kycApprovedEmail, data),
  kycDeclined: (email, data) => notifyMember(email, templates.kycDeclinedEmail, data),

  depositPendingConfirmation: (data) => notifyAdmins(templates.depositPendingAdminEmail, data),
  depositConfirmed: (email, data) => notifyMember(email, templates.depositConfirmedEmail, data),
  depositDeclined: (email, data) => notifyMember(email, templates.depositDeclinedEmail, data),
  depositFailed: (email, data) => notifyMember(email, templates.depositFailedEmail, data),

  withdrawalSubmitted: (data) => notifyAdmins(templates.withdrawalSubmittedAdminEmail, data),
  withdrawalApproved: (email, data) => notifyMember(email, templates.withdrawalApprovedEmail, data),
  withdrawalDeclined: (email, data) => notifyMember(email, templates.withdrawalDeclinedEmail, data),
  withdrawalProcessed: (email, data) => notifyMember(email, templates.withdrawalProcessedEmail, data),
};
