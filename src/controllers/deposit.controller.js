import * as depositService from "../services/deposit.service.js";
import { HttpError } from "../utils/errors.js";

function sendError(res, err) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  throw err;
}

// --- Member ---

export async function initialize(req, res) {
  try {
    const result = await depositService.initialize({
      userId: req.user.id,
      amount: Number(req.body.amount),
    });
    res.status(201).json(result);
  } catch (err) {
    sendError(res, err);
  }
}

export async function verify(req, res) {
  try {
    const deposit = await depositService.verify(req.params.reference);
    res.json({ deposit });
  } catch (err) {
    sendError(res, err);
  }
}

export async function listMine(req, res) {
  try {
    const deposits = await depositService.listMine(req.user.id);
    res.json({ deposits });
  } catch (err) {
    sendError(res, err);
  }
}

// --- Admin ---

export async function list(req, res) {
  try {
    const deposits = await depositService.listForAdmin(req.query.status);
    res.json({ deposits });
  } catch (err) {
    sendError(res, err);
  }
}

export async function confirm(req, res) {
  try {
    const deposit = await depositService.confirm({
      depositId: Number(req.params.id),
      reviewerId: req.user.id,
    });
    res.json({ message: "Deposit confirmed.", deposit });
  } catch (err) {
    sendError(res, err);
  }
}

export async function decline(req, res) {
  try {
    const deposit = await depositService.decline({
      depositId: Number(req.params.id),
      reviewerId: req.user.id,
      reason: req.body.reason,
    });
    res.json({ message: "Deposit declined.", deposit });
  } catch (err) {
    sendError(res, err);
  }
}
