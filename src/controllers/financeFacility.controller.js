import * as facilityService from "../services/financeFacility.service.js";
import { HttpError } from "../utils/errors.js";

function sendError(res, err) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  throw err;
}

// --- Member ---

export async function getEligibility(req, res) {
  try {
    const result = await facilityService.getEligibility(req.user.id);
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
}

export async function apply(req, res) {
  try {
    const application = await facilityService.submit({ userId: req.user.id, form: req.body });
    res.status(201).json({ message: "Application submitted for review.", application });
  } catch (err) {
    sendError(res, err);
  }
}

export async function listMine(req, res) {
  try {
    const applications = await facilityService.listMine(req.user.id);
    res.json({ applications });
  } catch (err) {
    sendError(res, err);
  }
}

export async function getOne(req, res) {
  try {
    const application = await facilityService.getOne({
      applicationId: Number(req.params.id),
      requester: req.user,
    });
    res.json({ application });
  } catch (err) {
    sendError(res, err);
  }
}

export async function addDocument(req, res) {
  try {
    const document = await facilityService.addDocument({
      applicationId: Number(req.params.id),
      requester: req.user,
      documentType: req.body.documentType,
      file: req.file,
    });
    res.status(201).json({ message: "Document uploaded.", document });
  } catch (err) {
    sendError(res, err);
  }
}

export async function getDocument(req, res) {
  try {
    const signedUrl = await facilityService.getDocumentUrl({
      applicationId: Number(req.params.id),
      documentId: Number(req.params.docId),
      requester: req.user,
    });

    const upstream = await fetch(signedUrl);
    if (!upstream.ok) {
      return res.status(502).json({ error: "Couldn't retrieve this document from storage." });
    }
    res.set("Content-Type", upstream.headers.get("content-type") || "application/octet-stream");
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    sendError(res, err);
  }
}

// --- Admin ---

export async function list(req, res) {
  try {
    const applications = await facilityService.listForAdmin(req.query.status);
    res.json({ applications });
  } catch (err) {
    sendError(res, err);
  }
}

export async function requestMoreInfo(req, res) {
  try {
    const application = await facilityService.requestMoreInfo({
      applicationId: Number(req.params.id),
      officerId: req.user.id,
      request: req.body.request,
    });
    res.json({ message: "Information request sent.", application });
  } catch (err) {
    sendError(res, err);
  }
}

export async function approve(req, res) {
  try {
    const application = await facilityService.approve({
      applicationId: Number(req.params.id),
      officerId: req.user.id,
      approvedAmount: Number(req.body.approvedAmount),
      interestRate: Number(req.body.interestRate),
      termMonths: Number(req.body.termMonths),
      repaymentFrequency: req.body.repaymentFrequency,
      installmentAmount: Number(req.body.installmentAmount),
    });
    res.json({ message: "Application approved.", application });
  } catch (err) {
    sendError(res, err);
  }
}

export async function decline(req, res) {
  try {
    const application = await facilityService.decline({
      applicationId: Number(req.params.id),
      officerId: req.user.id,
      reason: req.body.reason,
    });
    res.json({ message: "Application declined.", application });
  } catch (err) {
    sendError(res, err);
  }
}
