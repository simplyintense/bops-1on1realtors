"use client";

import { contactLinks, whatsappText } from "@/realty/flow/listing-contact.ts";

/**
 * The agent, agency and Call / WhatsApp / Email buttons for one listing, shared by the market popup and the desk's match rows.
 * Each button shows only when its target is valid (a phone for Call, a WhatsApp number or the phone for WhatsApp, an email
 * for Email); nothing is sent by Bops, staff tap the links. A missing field is left out, never shown as "undefined".
 */

export type Contact = {
  agent?: string | null;
  agency?: string | null;
  agentPhone?: string | null;
  agentWhatsapp?: string | null;
  agentEmail?: string | null;
};

const BUTTON = "rounded border px-3 py-1.5 text-sm font-medium";

export function ContactBlock({ c, listing }: { c: Contact; listing: { title: string; url: string | null } }) {
  const links = contactLinks({ phone: c.agentPhone, whatsapp: c.agentWhatsapp, email: c.agentEmail }, whatsappText(listing));
  return (
    <div className="mt-3 space-y-1 border-t pt-3" onClick={(e) => e.stopPropagation()}>
      {c.agent ? (
        <p>
          Listed by <span className="font-medium">{c.agent}</span>
        </p>
      ) : null}
      {c.agency ? <p className="rt-muted">{c.agency}</p> : null}
      {links.phoneText ? <p>{links.phoneText}</p> : null}
      {links.email ? <p className="break-all">{links.email}</p> : null}
      {links.tel || links.whatsapp ? null : <p className="rt-muted">No phone listed</p>}
      {links.tel || links.whatsapp || links.mail ? (
        <div className="flex flex-wrap gap-2 pt-1">
          {links.tel ? (
            <a href={links.tel} className={BUTTON}>
              Call
            </a>
          ) : null}
          {links.whatsapp ? (
            <a href={links.whatsapp} target="_blank" rel="noopener noreferrer" className={BUTTON}>
              WhatsApp
            </a>
          ) : null}
          {links.mail ? (
            <a href={links.mail} className={BUTTON}>
              Email
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
