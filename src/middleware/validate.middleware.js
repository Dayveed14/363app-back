import { validationResult } from "express-validator";

export function validate(req, res, next) {
  const result = validationResult(req);
  if (result.isEmpty()) return next();
  return res.status(422).json({
    error: "Validation failed.",
    details: result.array().map((e) => ({ field: e.path, message: e.msg })),
  });
}
