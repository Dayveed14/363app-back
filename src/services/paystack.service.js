import { env } from "../config/env.js";

const BASE_URL = "https://api.paystack.co";

async function paystackFetch(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${env.paystack.secretKey}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const data = await res.json();
  if (!res.ok || data.status === false) {
    throw new Error(data.message || "Paystack request failed.");
  }
  return data;
}

/**
 * Starts a Paystack checkout. `amount` is in naira; Paystack expects kobo.
 * Returns the hosted checkout URL to redirect the member to.
 */
export async function initializeTransaction({ email, amountNaira, reference }) {
  const data = await paystackFetch("/transaction/initialize", {
    method: "POST",
    body: JSON.stringify({
      email,
      amount: Math.round(amountNaira * 100),
      reference,
      callback_url: env.paystack.callbackUrl,
    }),
  });
  return { authorizationUrl: data.data.authorization_url, accessCode: data.data.access_code };
}

/**
 * Server-side verification — the only source of truth for whether a charge
 * actually succeeded. Never trust the frontend's word that a payment went
 * through; always verify the reference against Paystack directly.
 */
export async function verifyTransaction(reference) {
  const data = await paystackFetch(`/transaction/verify/${encodeURIComponent(reference)}`);
  const tx = data.data;
  return {
    success: tx.status === "success",
    amountNaira: tx.amount / 100,
    paystackId: String(tx.id),
    gatewayResponse: tx.gateway_response,
  };
}
