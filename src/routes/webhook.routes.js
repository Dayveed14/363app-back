import { Router } from "express";
import crypto from "node:crypto";
import { env } from "../config/env.js";
import * as depositService from "../services/deposit.service.js";
import * as repaymentModel from "../models/financeFacilityRepayment.model.js";
import { verifyAndProcessRepayment } from "../services/financeFacilityRepayment.service.js";
import { HttpError } from "../utils/errors.js";

const router = Router();

export function isValidPaystackSignature(rawBody, signature) {
  if (!rawBody || !signature) return false;
  const expected = crypto.createHmac("sha512", env.paystack.secretKey).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(String(signature), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Paystack -> us. This is the recovery path for the case where a member paid
 * but never came back to the callback page.
 *
 * The payload itself is NEVER trusted for amounts or status: it only tells us
 * which reference to look at. We then run the same server-side verification
 * (a direct call to Paystack) as the callback page, which funnels into the
 * same atomic claim — so webhook + callback + sweep racing each other still
 * credit exactly once.
 *
 * Response codes matter: Paystack retries on non-2xx. Unknown references and
 * "not an error we can ever fix by retrying" outcomes return 200; transient
 * failures (provider/database down) return 500 so Paystack retries.
 */
router.post("/paystack", async (req, res) => {
  if (!isValidPaystackSignature(req.rawBody, req.get("x-paystack-signature"))) {
    return res.status(401).json({ error: "Invalid signature." });
  }

  const event = req.body?.event;
  const reference = req.body?.data?.reference;

  if (event !== "charge.success" || typeof reference !== "string" || !reference) {
    return res.status(200).json({ received: true, ignored: true });
  }

  try {
    if (reference.startsWith("363-DEP-")) {
      await depositService.verifyReference(reference);
    } else {
      const repayment = await repaymentModel.findRepaymentByPaystackReference(reference);
      if (!repayment) {
        return res.status(200).json({ received: true, ignored: true });
      }
      await verifyAndProcessRepayment({ paystackReference: reference });
    }
    return res.status(200).json({ received: true });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : Number(err.statusCode) || 500;
    if (status >= 500) {
      console.error(`[webhook] transient failure ref=${reference}:`, err.message);
      return res.status(500).json({ error: "Temporary failure; please retry." });
    }
    console.error(`[webhook] not processed ref=${reference}: ${err.message}`);
    return res.status(200).json({ received: true, processed: false });
  }
});

export default router;
