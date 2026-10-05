import * as kycService from "../services/kyc.service.js";
import { HttpError } from "../utils/errors.js";
function sendError(res, err) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  throw err;
}

// --- Member ---

export async function submit(req, res) {
  try {
    const submission = await kycService.submit({
      userId: req.user.id,
      accountNumber: req.body.accountNumber,
      bankName: req.body.bankName,
      houseAddress: req.body.houseAddress,
      files: req.files,
    });
    res.status(201).json({ message: "KYC submitted for review.", submission });
  } catch (err) {
    sendError(res, err);
  }
}

export async function getMine(req, res) {
  try {
    const submission = await kycService.getMine(req.user.id);
    res.json({ submission });
  } catch (err) {
    sendError(res, err);
  }
}

// --- Admin ---

export async function list(req, res) {
  try {
    const submissions = await kycService.listForAdmin(req.query.status);
    res.json({ submissions });
  } catch (err) {
    sendError(res, err);
  }
}

export async function approve(req, res) {
  try {
    const submission = await kycService.approve({
      submissionId: Number(req.params.id),
      reviewerId: req.user.id,
    });
    res.json({ message: "KYC approved.", submission });
  } catch (err) {
    sendError(res, err);
  }
}

export async function decline(req, res) {
  try {
    const submission = await kycService.decline({
      submissionId: Number(req.params.id),
      reviewerId: req.user.id,
      reason: req.body.reason,
    });
    res.json({ message: "KYC declined.", submission });
  } catch (err) {
    sendError(res, err);
  }
}

// --- Shared (owner or admin) ---

export async function getDocument(req, res) {
  try {
    const signedUrl = await kycService.getDocumentUrl({
      submissionId: Number(req.params.id),
      docType: req.params.docType,
      requester: req.user,
    });
    // The signed Cloudinary URL is fetched here, server-side, and never
    // handed to the browser — the response the client actually gets is
    // just file bytes from *our* already-authenticated endpoint, exactly
    // like when documents lived on local disk. This is what lets the
    // frontend's existing blob-fetch code (api.kyc.document /
    // api.admin.kyc.document) keep working completely unchanged.
    const upstream = await fetch(signedUrl);

    if (!upstream.ok) {
      console.error(`[kyc] Cloudinary fetch failed: ${upstream.status} ${upstream.statusText}`);
      return res.status(502).json({ error: "Couldn't retrieve this document from storage." });
    }

    res.set("Content-Type", upstream.headers.get("content-type") || "application/octet-stream");
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    sendError(res, err);
  }
}
