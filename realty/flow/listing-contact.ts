/**
 * Contact helpers for co-broke listings: phone numbers to tel: and wa.me links, a mailto link, and the
 * prefilled WhatsApp text. Pure (no React, no network). Bops sends nothing: these only build links that
 * staff tap themselves.
 */

const TT_COUNTRY = "1868";
const MAX_DIGITS = 15;
const MIN_INTERNATIONAL = 11;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Digits only, in E.164 without the '+'. Local 7-digit numbers get the Trinidad & Tobago prefix (1868), a 10-digit
 * number starting 868 gets the country code 1, and a leading 00 (international prefix) is dropped. Anything that
 * doesn't fit is kept only when it is 11 to 15 digits; otherwise null.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (!digits) return null;
  if (digits.length === 7) return TT_COUNTRY + digits;
  if (digits.length === 10 && digits.startsWith("868")) return "1" + digits;
  if (digits.length >= MIN_INTERNATIONAL && digits.length <= MAX_DIGITS) return digits;
  return null;
}

/** "tel:+<digits>", or null when there's no valid number. */
export function telHref(raw: string | null | undefined): string | null {
  const n = normalizePhone(raw);
  return n ? `tel:+${n}` : null;
}

/** "https://wa.me/<digits>", with "?text=" when text is given; null when there's no valid number. */
export function whatsappHref(raw: string | null | undefined, text?: string | null): string | null {
  const n = normalizePhone(raw);
  if (!n) return null;
  const q = text ? `?text=${encodeURIComponent(text)}` : "";
  return `https://wa.me/${n}${q}`;
}

/** "+1 868 766 0211" for a 1868 number, "+<digits>" for any other valid number, null when invalid. */
export function phoneLabel(raw: string | null | undefined): string | null {
  const n = normalizePhone(raw);
  if (!n) return null;
  if (n.length === 11 && n.startsWith(TT_COUNTRY)) return `+1 868 ${n.slice(4, 7)} ${n.slice(7)}`;
  return `+${n}`;
}

/** A plausible email address, trimmed, or null. */
export function plausibleEmail(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const e = raw.trim();
  return EMAIL.test(e) ? e : null;
}

/** "mailto:<email>", or null when it doesn't look like an email. */
export function mailtoHref(email: string | null | undefined): string | null {
  const e = plausibleEmail(email);
  return e ? `mailto:${e}` : null;
}

/**
 * The contact links for one listing. WhatsApp uses the WhatsApp number when it's valid, else the phone. Each field is null
 * when it isn't valid, so a caller shows only the buttons that have a target.
 */
export function contactLinks(
  c: { phone?: string | null; whatsapp?: string | null; email?: string | null },
  text?: string | null,
): { phoneText: string | null; tel: string | null; whatsapp: string | null; email: string | null; mail: string | null } {
  return {
    phoneText: phoneLabel(c.phone),
    tel: telHref(c.phone),
    whatsapp: whatsappHref(c.whatsapp, text) ?? whatsappHref(c.phone, text),
    email: plausibleEmail(c.email),
    mail: mailtoHref(c.email),
  };
}

const MAX_TEXT = 300;

/** The prefilled WhatsApp message for a listing, kept under about 300 characters. */
export function whatsappText(hit: { title: string; url: string | null }): string {
  const lead = "Hi, I'm with 1on1 Realtors. Is this listing still available?";
  const url = hit.url ? ` ${hit.url}` : "";
  const room = MAX_TEXT - lead.length - 1 - url.length;
  const title = hit.title.length > room ? `${hit.title.slice(0, Math.max(0, room - 1)).trimEnd()}…` : hit.title;
  return `${lead} ${title}${url}`;
}
