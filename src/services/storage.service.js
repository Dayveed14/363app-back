import { v2 as cloudinary } from "cloudinary";
import { env } from "../config/env.js";

cloudinary.config({
  cloud_name: env.cloudinary.cloudName,
  api_key: env.cloudinary.apiKey,
  api_secret: env.cloudinary.apiSecret,
  secure: true,
});

/**
 * Uploads a buffer (from multer's memory storage) to Cloudinary under
 * `type: "authenticated"` — this is what keeps a KYC document from being
 * reachable by anyone who happens to guess or leak the URL. An
 * authenticated asset only resolves through a correctly *signed* URL,
 * which only this backend can produce (see getSignedUrl below), and only
 * after it's re-run the owner-or-admin check in kyc.service.js. A public
 * Cloudinary URL for an ID document would defeat that check entirely.
 */
export function uploadKycDocument(buffer, { userId, docType }) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: `kyc/${userId}`,
        public_id: `${docType}-${Date.now()}`,
        resource_type: "auto", // images go in as "image"; PDFs land as "image" too (Cloudinary treats PDF as an image asset) unless Cloudinary decides otherwise for a given file
        type: "authenticated",
        overwrite: true,
      },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    stream.end(buffer);
  });
}

/**
 * Produces a signed delivery URL for an authenticated asset. Signing ties
 * the URL to this exact public_id/resource_type using the account's API
 * secret — it isn't guessable, but note it also doesn't expire on its own
 * (Cloudinary's free/basic tiers don't support time-boxed signed URLs; that
 * needs the paid "token-based authentication" add-on). The mitigation here
 * is that this URL is never hand back to the browser — the controller
 * fetches it server-side and streams the bytes through our own
 * already-authenticated endpoint, so the signed URL itself never leaves
 * the backend.
 */

export async function getSignedUrl({ publicId, resourceType }) {
  const asset = await cloudinary.api.resource(publicId, {
    resource_type: resourceType,
    type: "authenticated",
  });

  return cloudinary.utils.private_download_url(publicId, asset.format, {
    resource_type: resourceType,
    type: "authenticated",
    attachment: false,
  });
}