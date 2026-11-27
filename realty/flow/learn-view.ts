import { dateAst } from "./ast-time.ts";
import { islandNamedIn } from "./areas.ts";
import { interpret, listingTypeOf, type Kind } from "./periskope.ts";
import type { KnownTerm } from "./knowledge.ts";
import { islandOfMarket, taughtPlaceOf, type TaughtAreas } from "./taught-areas.ts";

/**
 * What the Teach page shows staff, pure: the queue card's meta line, and "Test how the desk reads this" (readingOf). Neither
 * shows a WhatsApp group name or an internal product name: the meta line is time, sender and times seen, and the reading is
 * only the structured facts. Portable: no node:*, no next, no bare process.
 */

/** A queue card's meta line: time (AST), sender, times seen. Group names are never shown to staff. */
export function queueLine(r: { lastSentAt: string; senderName: string | null; timesSeen: number }): string {
  return `${dateAst(r.lastSentAt)} · ${r.senderName ?? "Unnamed sender"} · ×${r.timesSeen}`;
}

/** How the desk reads a sample: the record's side (interpret's kind), its sale/rent/short let, and the place and price it found. */
export type Reading = {
  kind: "supply" | "demand" | "chatter";
  listingType: "sale" | "rent" | "shortlet" | null;
  area: string | null;
  island: "Trinidad" | "Tobago" | null;
  region: string | null;
  bedrooms: number | null;
  price: number | null;
  currency: string | null;
  /** The property type, for the vague check only. Not part of the response. */
  type: string | null;
};

const SIDE: Record<Kind, Reading["kind"]> = { cobroke_listing: "supply", buyer_request: "demand", other: "chatter" };

/**
 * The desk's reading of a sample (a place name or a message), with the taught terms and taught places. The parser is interpret()
 * (the same one ingest uses). A whole text that is a taught place (or alias) is that place, so "Westhills" reads as West Hills and
 * its market. Its island is the one the text names, else the taught market's. No network: the market resolver is never asked.
 */
export function readingOf(text: string, terms: readonly KnownTerm[], taught: TaughtAreas | null): Reading {
  const body = text.trim();
  const { kind, facts } = interpret(body, terms);
  const place = taughtPlaceOf(taught, body) ?? taughtPlaceOf(taught, facts.area);
  return {
    kind: SIDE[kind],
    listingType: facts.listingType ?? listingTypeOf(facts),
    area: place ? place.name : facts.area,
    island: islandNamedIn(body) ?? islandOfMarket(place?.market),
    region: place?.market ?? null,
    bedrooms: facts.beds,
    price: facts.budget?.max ?? null,
    currency: facts.budget?.currency ?? null,
    type: facts.type,
  };
}
