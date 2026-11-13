import { normalizePhone } from "../extract.ts";
import type { Channel, Draft } from "./outbox.ts";
import type { Inquiry, Lead } from "./engine.ts";
import type { CoBrokeHit } from "./market-search.ts";
import type { FlowAgent, Listing } from "./source.ts";
import { runtimeEnv } from "./env.ts";

/**
 * The words the flow sends, in plain English for Trinidad clients and agents. Short, no jargon, no
 * promises the flow can't keep (it never says a time an agent hasn't agreed to).
 */

const TZ = "America/Port_of_Spain";

export function localTime(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}

export function localClock(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}

export const money = (amount: number, currency: string) => `${currency} ${amount.toLocaleString("en-US")}`;

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/** Where the client gets their acknowledgement: WhatsApp if the number is good, else email. */
export function clientChannel(inq: Inquiry): { channel: Channel; address: string } {
  const phone = inq.phone ? normalizePhone(inq.phone) : null;
  if (phone) return { channel: "whatsapp", address: phone };
  return { channel: "email", address: inq.email ?? "(no contact)" };
}

const wants = (inq: Inquiry) => {
  const size = inq.beds ? `${inq.beds}-bed` : null;
  const where = inq.area ? `in ${inq.area}` : null;
  const kind = inq.listingType === "rent" ? "to rent" : inq.listingType === "sale" ? "to buy" : null;
  return [size, kind, where].filter(Boolean).join(" ") || "(no criteria given)";
};

export const DEFAULT_ACK_SENDER = "1 On 1 Realty";

/** ONEON1_ACK_SENDER_NAME, default "1 On 1 Realty". The brand clients hear from, never an individual agent. */
export function ackSenderFromEnv(env: Record<string, string | undefined> = runtimeEnv()): string {
  return env.ONEON1_ACK_SENDER_NAME?.trim() || DEFAULT_ACK_SENDER;
}

export function clientAck(inq: Inquiry, listing: Listing | null, sender: string = DEFAULT_ACK_SENDER): Draft {
  const { channel, address } = clientChannel(inq);
  const about = listing
    ? `"${listing.title}"`
    : inq.listingType === "rent"
      ? `renting${inq.area ? ` in ${inq.area}` : ""}`
      : inq.listingType === "sale"
        ? `buying${inq.area ? ` in ${inq.area}` : ""}`
        : "your property search";
  return {
    kind: "client_ack",
    channel,
    to: { name: inq.name, address },
    from: { name: sender },
    leadId: null,
    subject: channel === "email" ? "We've got your enquiry" : null,
    text: [
      `Hi ${firstName(inq.name)}, thanks for getting in touch with ${sender} about ${about}.`,
      "We've got your enquiry and one of our agents will be in touch shortly.",
      "If it's urgent, just reply here.",
    ].join("\n"),
  };
}

export type AlertContext = {
  lead: Lead;
  agent: FlowAgent;
  reason: string;
  listing: Listing | null;
  ours: Listing[];
  coBroke: CoBrokeHit[];
  coBrokeNote: string;
  /** Set for a backup: the agent who didn't pick the lead up in time. */
  backupOf: FlowAgent | null;
  answerBy: string;
};

const listingLine = (l: Listing) => `${l.title} · ${money(l.price, l.currency)}${l.beds ? ` · ${l.beds} bed` : ""} · ${l.area} (${l.id})`;

const coBrokeLine = (h: CoBrokeHit) =>
  [h.title, h.price !== null && h.currency ? money(h.price, h.currency) : null, h.beds ? `${h.beds} bed` : null, h.area, `via ${h.source}`].filter(Boolean).join(" · ") + (h.url ? ` ${h.url}` : "");

/** The agent's alert: the lead, why they got it, our listings that fit, co-broke candidates, how to answer. */
export function agentAlert(c: AlertContext): Draft {
  const inq = c.lead.inquiry;
  const who = [inq.phone, inq.email].filter(Boolean).join(" · ");
  const head = c.backupOf
    ? `Hi ${firstName(c.agent.name)}, ${firstName(c.backupOf.name)} hasn't picked up lead ${c.lead.id} in time, so it's yours now.`
    : `Hi ${firstName(c.agent.name)}, new lead for you (${c.lead.id}, from ${sourceLabel(inq)}).`;
  const lines = [
    head,
    "",
    `${inq.name}${who ? ` · ${who}` : ""}`,
    `Wants: ${wants(inq)}${inq.budget ? `, budget up to ${money(inq.budget.max, inq.budget.currency)}` : ""}`,
    c.listing ? `About: ${listingLine(c.listing)}` : null,
    inq.message ? `Their message: "${inq.message}"` : null,
    "",
    `Why you: ${c.reason}.`,
    "",
    "Our listings that fit:",
    ...(c.ours.length ? c.ours.map((l) => `  - ${listingLine(l)}`) : ["  - none in the CRM right now"]),
    "",
    `Other agencies' listings (co-broke candidates, ${c.coBrokeNote}):`,
    ...(c.coBroke.length ? c.coBroke.map((h) => `  - ${coBrokeLine(h)}`) : ["  - none to show"]),
    "",
    `Reply ACCEPT ${c.lead.id} by ${c.answerBy} to take it. If you can't, reply PASS ${c.lead.id} and it goes to someone else.`,
  ];
  return {
    kind: c.backupOf ? "backup_alert" : "agent_alert",
    channel: "whatsapp",
    to: { name: c.agent.name, address: c.agent.phone ?? c.agent.email ?? "(no contact)" },
    leadId: c.lead.id,
    subject: null,
    text: lines.filter((l): l is string => l !== null).join("\n"),
  };
}

/**
 * The proposed message to the client about listings an agent approved. From the brand, not the agent.
 * Other agencies' listings are described without their source or link: the agent arranges those.
 */
export function clientMatch(lead: Lead, picks: { listing?: Listing; hit?: CoBrokeHit }[], sender: string = DEFAULT_ACK_SENDER): Draft {
  const inq = lead.inquiry;
  const { channel, address } = clientChannel(inq);
  const hitLine = (h: CoBrokeHit) => [h.title, h.price !== null && h.currency ? money(h.price, h.currency) : null, h.beds ? `${h.beds} bed` : null, h.area].filter(Boolean).join(" · ");
  const line = (p: { listing?: Listing; hit?: CoBrokeHit }) =>
    p.listing ? `  - ${listingLine(p.listing)}${p.listing.url ? ` ${p.listing.url}` : ""}` : p.hit ? `  - ${hitLine(p.hit)}` : null;
  return {
    kind: "client_match",
    channel,
    to: { name: inq.name, address },
    from: { name: sender },
    leadId: lead.id,
    subject: channel === "email" ? "Properties that may suit you" : null,
    text: [
      `Hi ${firstName(inq.name)}, it's ${sender} again. Following your enquiry, here ${picks.length === 1 ? "is a property" : "are some properties"} that may suit you:`,
      ...picks.map(line).filter((l): l is string => l !== null),
      "Reply here if you'd like to view any of them.",
    ].join("\n"),
  };
}

export function sourceLabel(inq: Inquiry): string {
  return { website_contact: "the website contact form", property_inquiry: "a property inquiry on the website", whatsapp: "WhatsApp" }[inq.source];
}

export function adminException(lead: Lead, attempts: string[], now: string, admin: { name: string; address: string }): Draft {
  const inq = lead.inquiry;
  const contact = [inq.phone, inq.email].filter(Boolean).join(" · ") || "no phone or email";
  return {
    kind: "admin_exception",
    channel: "email",
    to: admin,
    leadId: lead.id,
    subject: `Lead ${lead.id} needs a person`,
    text: [
      `Lead ${lead.id} needs a person. The routine flow has nothing else for you.`,
      "",
      `Reason: ${lead.exception}`,
      `Client: ${inq.name} · ${contact}`,
      `From: ${sourceLabel(inq)} (${inq.ref})`,
      `Came in: ${localTime(lead.receivedAt)}, flagged ${localTime(now)}`,
      `Offered to: ${attempts.length ? attempts.join("; ") : "nobody"}`,
    ].join("\n"),
  };
}
