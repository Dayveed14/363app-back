import multer from "multer";
import { env } from "../config/env.js";

const ALLOWED_MIME = new Set(["application/pdf", "image/jpeg", "image/png"]);

function fileFilter(req, file, cb) {
  if (!ALLOWED_MIME.has(file.mimetype)) {
    return cb(new Error("Only PDF, JPEG, or PNG files are accepted."));
  }
  cb(null, true);
}

// In-memory, not disk — files go straight to Cloudinary as a buffer
// (src/services/storage.service.js), so nothing ever touches this
// container's filesystem. That also means nothing to clean up and nothing
// lost on a redeploy.
export const uploadKycDocuments = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: env.uploads.maxFileSizeMb * 1024 * 1024 },
}).fields([
  { name: "idDocument", maxCount: 1 },
  { name: "proofOfAddress", maxCount: 1 },
]);

/**
 * multer reports its own errors (file too large, bad field name, our
 * fileFilter rejection) by calling next(err) rather than throwing — wrap
 * the route so those come back as a normal 422 instead of a raw 500.
 */
export function handleUploadErrors(req, res, next) {
  uploadKycDocuments(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError || err.message) {
      return res.status(422).json({ error: err.message || "Upload failed." });
    }
    next(err);
  });
}

// Finance facility documents: one file per request (field name "document"),
// uploaded individually per checklist item rather than all at once.
const uploadFacilityDocument = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: env.uploads.maxFileSizeMb * 1024 * 1024 },
}).single("document");

export function handleFacilityUploadErrors(req, res, next) {
  uploadFacilityDocument(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError || err.message) {
      return res.status(422).json({ error: err.message || "Upload failed." });
    }
    next(err);
  });
}
