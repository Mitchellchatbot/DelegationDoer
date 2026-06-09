// Deterministic, brand-styled HTML email renderer used by the Client
// Update composer's "Make fancy" action. The AI returns only the
// CONTENT (greeting / intro / labeled sections / sign-off); this turns
// it into an email-client-safe HTML document with inline styles.
//
// Why deterministic (not model-generated HTML): inline-styled email HTML
// is fiddly and easy to get malformed. Letting the model fill a fixed,
// tested template keeps every "fancy" email on-brand and renders the
// same in Gmail/Outlook every time. The default accent is blue (the app
// accent) — the agency's branded sample used green; this is the blue twin.

const DEFAULT_ACCENT = "#2563eb"; // blue-600
const DEFAULT_ACCENT_DARK = "#1d4ed8"; // blue-700

export interface BrandedSection {
  heading?: string | null;
  body?: string | null;
  bullets?: string[];
}

export interface BrandedEmailContent {
  brandName: string; // shown big in the header band (the client/agency name)
  tagline?: string | null; // optional uppercase subtitle under the brand name
  greeting?: string | null; // "Hi Emilie,"
  intro?: string | null; // opening one-liner / paragraph
  sections: BrandedSection[];
  signoff?: string | null; // "Best,\nShaheer" — newlines become line breaks
  cta?: { text: string; url: string } | null; // optional button
  accent?: string; // hex; defaults to blue
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Turn a plain-text block into <p> paragraphs (blank line = new
// paragraph) with single newlines as <br>. Already-escaped input.
function paragraphs(text: string, style: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p style="${style}">${escapeHtml(p).replace(/\n/g, "<br/>")}</p>`)
    .join("");
}

export function renderBlueEmail(content: BrandedEmailContent): string {
  const accent = content.accent || DEFAULT_ACCENT;
  const accentDark =
    content.accent && content.accent !== DEFAULT_ACCENT ? content.accent : DEFAULT_ACCENT_DARK;

  const pStyle =
    "margin:0 0 14px 0;font-size:15px;line-height:1.6;color:#1f2937;";
  const headingStyle =
    "margin:22px 0 8px 0;font-size:15px;font-weight:700;color:#0f172a;";

  const sectionsHtml = content.sections
    .filter((s) => (s.heading && s.heading.trim()) || (s.body && s.body.trim()) || (s.bullets && s.bullets.length))
    .map((s) => {
      const head = s.heading && s.heading.trim()
        ? `<div style="${headingStyle}">${escapeHtml(s.heading.trim())}</div>`
        : "";
      const bodyHtml = s.body && s.body.trim() ? paragraphs(s.body, pStyle) : "";
      const bulletsHtml = s.bullets && s.bullets.length
        ? `<ul style="margin:0 0 14px 0;padding-left:20px;">${s.bullets
            .map((b) => b.trim())
            .filter(Boolean)
            .map((b) => `<li style="font-size:15px;line-height:1.6;color:#1f2937;margin-bottom:6px;">${escapeHtml(b)}</li>`)
            .join("")}</ul>`
        : "";
      return head + bodyHtml + bulletsHtml;
    })
    .join("");

  const greetingHtml = content.greeting && content.greeting.trim()
    ? `<p style="margin:0 0 14px 0;font-size:16px;line-height:1.6;color:#0f172a;font-weight:600;">${escapeHtml(content.greeting.trim())}</p>`
    : "";
  const introHtml = content.intro && content.intro.trim()
    ? paragraphs(content.intro, pStyle)
    : "";

  const ctaHtml = content.cta && content.cta.text && content.cta.url
    ? `<div style="margin:24px 0;">
        <a href="${escapeHtml(content.cta.url)}" style="display:inline-block;background:${accent};color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 26px;border-radius:8px;">${escapeHtml(content.cta.text)}</a>
       </div>`
    : "";

  const signoffHtml = content.signoff && content.signoff.trim()
    ? `<p style="margin:26px 0 0 0;font-size:15px;line-height:1.6;color:#1f2937;">${escapeHtml(content.signoff.trim()).replace(/\n/g, "<br/>")}</p>`
    : "";

  const taglineHtml = content.tagline && content.tagline.trim()
    ? `<div style="margin-top:6px;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.82);">${escapeHtml(content.tagline.trim())}</div>`
    : "";

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#f1f5f9;-webkit-font-smoothing:antialiased;">
  <div style="padding:28px 12px;background:#f1f5f9;">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:600px;margin:0 auto;border-collapse:collapse;">
      <tr>
        <td style="background:linear-gradient(135deg,${accent} 0%,${accentDark} 100%);border-radius:14px 14px 0 0;padding:30px 34px;">
          <div style="font-size:24px;font-weight:800;color:#ffffff;line-height:1.2;">${escapeHtml(content.brandName)}</div>
          ${taglineHtml}
        </td>
      </tr>
      <tr>
        <td style="background:#ffffff;border-radius:0 0 14px 14px;padding:30px 34px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
          ${greetingHtml}
          ${introHtml}
          ${sectionsHtml}
          ${ctaHtml}
          ${signoffHtml}
        </td>
      </tr>
      <tr>
        <td style="padding:18px 34px 0 34px;text-align:center;">
          <div style="font-size:11px;color:#94a3b8;line-height:1.5;">Sent by ${escapeHtml(content.brandName)}</div>
        </td>
      </tr>
    </table>
  </div>
</body>
</html>`;
}
