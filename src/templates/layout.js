export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

/**
 * Wraps inner HTML in the same navy-header card used by every email this
 * app sends, so a new notification type is a few lines of content, not a
 * new template file's worth of boilerplate.
 */
export function wrapEmail(innerHtml) {
  return `
  <div style="background:#f4f6fb;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:460px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e4e8f1;">
      <div style="background:#0A0A6E;padding:20px 28px;">
        <span style="color:#ffffff;font-weight:700;font-size:16px;letter-spacing:.02em;">363 Cooperative Society</span>
      </div>
      <div style="padding:28px;">
        ${innerHtml}
      </div>
    </div>
  </div>`;
}

export function heading(text) {
  return `<h1 style="margin:0 0 12px;font-size:18px;color:#0e1526;">${escapeHtml(text)}</h1>`;
}

export function paragraph(text, { muted = false } = {}) {
  const color = muted ? "#9aa2b4" : "#5b6478";
  return `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${color};">${text}</p>`;
}

export function calloutBox(text, { tone = "neutral" } = {}) {
  const tones = {
    neutral: { bg: "#FFF4EA", border: "#FFE4CC", color: "#0A0A6E" },
    success: { bg: "#ddf6ec", border: "#bdecd9", color: "#0e9f6e" },
    danger: { bg: "#fbe2e5", border: "#f6c4cb", color: "#d9364a" },
  };
  const t = tones[tone] || tones.neutral;
  return `<div style="background:${t.bg};border:1px solid ${t.border};border-radius:12px;padding:16px 18px;margin-bottom:20px;">
    <span style="font-size:14px;font-weight:600;color:${t.color};">${text}</span>
  </div>`;
}
