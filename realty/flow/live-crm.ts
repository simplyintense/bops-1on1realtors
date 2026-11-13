import { Crm, crmEnv } from "../crm.ts";
import type { Currency, Inquiry, ListingType } from "./engine.ts";
import { FixtureCrm, type CrmSource, type FlowAgent, type Listing } from "./source.ts";
import { channelFromSource, propertyKindFromCrm } from "./taxonomy.ts";

/**
 * The lead flow's CrmSource over the live 1on1 CRM, read-only. Every request goes through Crm.read /
 * Crm.readAll (GETs on /rest/v1, signed in as the bot login); this file never calls Crm.apply and never
 * sends POST/PATCH/PUT/DELETE to the REST API, whatever ONEON1_CRM_WRITES says. Columns are the ones in
 * the project's table catalog; nothing else is selected.
 *
 * Not in the CRM, so left unset: viewingArrangements (no column; the listing audit flags it) and
 * Inquiry.budget (no budget column on either inquiry table; the message isn't parsed for one).
 *
 * A property with no property_agents row gets agentId 0. No agent has id 0, so routing finds no listing
 * agent and falls through to the agents covering the area and type, the same as a general inquiry.
 *
 * A table the bot login can't read is treated as empty and named in `missing`, so one refused table
 * (images, locations...) doesn't lose the rest. If every table is refused (or sign-in fails) it throws.
 */

type Row = Record<string, unknown>;

const PAGE = 1000;
const MAX_ROWS = 20_000;
/** agents(), listings() and inquiries() in one tick share one read of the property tables. */
const CACHE_MS = 30_000;

const BUNDLE_TABLES = ["properties", "property_agents", "images", "locations"];

const PROPERTY_COLS = [
  "id", "title", "price", "currency", "listing_type", "furnished_status", "address", "city", "region",
  "property_type", "bedrooms", "bathrooms", "square_feet", "lot_size", "features", "url", "google_maps_url",
  "neighborhood", "hoa_fees", "property_taxes", "status",
].join(",");

export function crmSourceFromEnv(env: Record<string, string | undefined> = process.env, fetcher?: typeof fetch): CrmSource {
  const e = crmEnv(env);
  if (!e) return FixtureCrm.load();
  return new LiveCrmSource(new Crm(e, fetcher));
}

type Bundle = {
  listings: Listing[];
  byProperty: Map<string, Listing>;
  /** Per agent: city/neighborhood/region of every property linked to them, and their listings' types. */
  agentAreas: Map<number, Set<string>>;
  agentTypes: Map<number, Set<ListingType>>;
};

export class LiveCrmSource implements CrmSource {
  private readonly crm: Crm;
  private readonly now: () => number;
  private cache: { at: number; bundle: Promise<Bundle> } | null = null;
  /** Tables the last reads couldn't get (refused); their part was treated as empty. */
  readonly missing = new Set<string>();
  private readonly lastError = new Map<string, unknown>();

  constructor(crm: Crm, opts: { now?: () => number } = {}) {
    this.crm = crm;
    this.now = opts.now ?? Date.now;
  }

  async agents(): Promise<FlowAgent[]> {
    const [rows, bundle] = await Promise.all([this.soft("agents", () => this.crm.readAll("agents", "id,name,email,phone")), this.bundle()]);
    this.throwIfAllRefused(["agents", ...BUNDLE_TABLES]);
    return (rows ?? []).map((r) => {
      const id = Number(r.id);
      const areas = [...(bundle.agentAreas.get(id) ?? [])];
      const types = [...(bundle.agentTypes.get(id) ?? [])];
      return {
        id,
        name: str(r.name) ?? "",
        email: str(r.email),
        phone: str(r.phone),
        areas,
        // No listings (or none with a usable type): can still take general inquiries of either type.
        listingTypes: types.length ? types : (["sale", "rent"] as ListingType[]),
      };
    });
  }

  async listings(): Promise<Listing[]> {
    const bundle = await this.bundle();
    this.throwIfAllRefused(BUNDLE_TABLES);
    return bundle.listings;
  }

  async inquiries(): Promise<Inquiry[]> {
    const [bundle, props, contacts] = await Promise.all([
      this.bundle(),
      this.soft("property_inquiries", () =>
        this.crm.readAll("property_inquiries", "id,property_id,name,email,phone,message,created_at", { deleted_at: "is.null" }),
      ),
      this.soft("contact_submissions", () =>
        this.crm.readAll("contact_submissions", "id,name,email,phone,message,created_at", { deleted_at: "is.null" }),
      ),
    ]);
    const out: { at: string; inq: Inquiry }[] = [];
    const add = (r: Row, source: "property_inquiry" | "website_contact") => {
      const listingId = r.property_id == null || r.property_id === "" ? null : String(r.property_id);
      const listing = listingId ? bundle.byProperty.get(listingId) : undefined;
      const message = str(r.message) ?? "";
      out.push({
        at: str(r.created_at) ?? "",
        inq: {
          ref: String(r.id),
          source,
          name: str(r.name) ?? "",
          phone: str(r.phone),
          email: str(r.email),
          listingId,
          listingType: listing?.listingType ?? null,
          area: listing?.area || null,
          budget: null,
          beds: listing ? listing.beds : null,
          message,
          channel: channelFromSource(source, message),
          propertyKind: listing?.propertyKind ?? null,
        },
      });
    };
    this.throwIfAllRefused(["property_inquiries", "contact_submissions"]);
    for (const r of props ?? []) add(r, "property_inquiry");
    for (const r of contacts ?? []) add(r, "website_contact");
    out.sort((a, b) => a.at.localeCompare(b.at));
    return out.map((x) => x.inq);
  }

  private bundle(): Promise<Bundle> {
    if (this.cache && this.now() - this.cache.at < CACHE_MS) return this.cache.bundle;
    const bundle = this.loadBundle();
    this.cache = { at: this.now(), bundle };
    bundle.catch(() => {
      if (this.cache?.bundle === bundle) this.cache = null;
    });
    return bundle;
  }

  private async loadBundle(): Promise<Bundle> {
    const [propsOrNull, linksOrNull, imagesOrNull, locationsOrNull] = await Promise.all([
      this.soft("properties", () => this.crm.readAll("properties", PROPERTY_COLS)),
      // A join table may have no id column, so it pages by its own key instead of readAll's id.asc.
      this.soft("property_agents", () => this.pages("property_agents", "property_id,agent_id", "property_id.asc,agent_id.asc")),
      this.soft("images", () => this.crm.readAll("images", "property_id")),
      this.soft("locations", () => this.pages("locations", "property_id,address,google_maps_url", "property_id.asc")),
    ]);

    const [props, links, images, locations] = [propsOrNull ?? [], linksOrNull ?? [], imagesOrNull ?? [], locationsOrNull ?? []];
    const agentOf = new Map<string, number>();
    for (const r of links) {
      const key = String(r.property_id);
      if (!agentOf.has(key) && r.agent_id != null) agentOf.set(key, Number(r.agent_id));
    }
    const photos = new Map<string, number>();
    for (const r of images) {
      if (r.property_id == null) continue;
      const key = String(r.property_id);
      photos.set(key, (photos.get(key) ?? 0) + 1);
    }
    const loc = new Map<string, Row>();
    for (const r of locations) if (r.property_id != null && !loc.has(String(r.property_id))) loc.set(String(r.property_id), r);

    const listings: Listing[] = [];
    const agentAreas = new Map<number, Set<string>>();
    const agentTypes = new Map<number, Set<ListingType>>();
    for (const r of props) {
      const agentId = agentOf.get(String(r.id)) ?? 0;
      const l = toListing(r, agentId, photos.get(String(r.id)) ?? 0, loc.get(String(r.id)));
      if (l) listings.push(l);
      if (!agentId) continue;
      const areas = agentAreas.get(agentId) ?? new Set<string>();
      for (const a of [r.city, r.neighborhood, r.region]) if (str(a)) areas.add(str(a) as string);
      agentAreas.set(agentId, areas);
      if (l) agentTypes.set(agentId, (agentTypes.get(agentId) ?? new Set<ListingType>()).add(l.listingType));
    }
    return { listings, byProperty: new Map(listings.map((l) => [l.id, l])), agentAreas, agentTypes };
  }

  /** Like Crm.readAll, but with an explicit order for tables that may not have an id column. */
  private async pages(table: string, select: string, order: string): Promise<Row[]> {
    const out: Row[] = [];
    for (let off = 0; off < MAX_ROWS; off += PAGE) {
      const rows = await this.crm.read(table, { select, order, limit: String(PAGE), offset: String(off) });
      out.push(...rows);
      if (rows.length < PAGE) break;
    }
    return out;
  }

  /** The table's rows, or null (and the table named in `missing`) if the read failed. */
  private async soft(table: string, read: () => Promise<Row[]>): Promise<Row[] | null> {
    try {
      const rows = await read();
      this.missing.delete(table);
      this.lastError.delete(table);
      return rows;
    } catch (err) {
      this.missing.add(table);
      this.lastError.set(table, err);
      return null;
    }
  }

  /** Every table this call needed failed (sign-in refused, or no access at all): that's an error, not "no data". */
  private throwIfAllRefused(tables: string[]) {
    if (tables.every((t) => this.missing.has(t))) throw this.lastError.get(tables[0]) ?? new Error("the 1on1 CRM refused every table");
  }
}

function toListing(r: Row, agentId: number, photoCount: number, loc: Row | undefined): Listing | null {
  const propertyKind = propertyKindFromCrm(str(r.listing_type), str(r.property_type)) ?? undefined;
  let listingType = listingTypeFromCrm(str(r.listing_type));
  if (!listingType) {
    // No usable rent/sale type: keep land and commercial (as sale), skip anything else rather than guess.
    if (propertyKind === "land" || propertyKind === "commercial") listingType = "sale";
    else return null;
  }
  const hoa = numOrNull(r.hoa_fees);
  const taxes = numOrNull(r.property_taxes);
  const features = r.features;
  const amenities = Array.isArray(features)
    ? features.map((f) => (typeof f === "string" ? f.trim() : "")).filter(Boolean)
    : str(features)
      ? [str(features) as string]
      : [];
  return {
    id: String(r.id),
    title: str(r.title) ?? "",
    listingType,
    area: str(r.neighborhood) ?? str(r.city) ?? str(r.region) ?? "",
    price: numOrNull(r.price) ?? 0,
    currency: currencyOf(r.currency),
    beds: numOrNull(r.bedrooms) ?? 0,
    baths: numOrNull(r.bathrooms) ?? 0,
    agentId,
    status: statusOf(r.status),
    url: str(r.url) ?? "",
    propertyKind,
    address: str(r.address) ?? str(loc?.address),
    directions: str(r.google_maps_url) ?? str(loc?.google_maps_url),
    fees: hoa === null && taxes === null ? null : (hoa ?? 0) + (taxes ?? 0),
    squareFeet: measure(r.square_feet),
    lotSize: measure(r.lot_size),
    amenities: amenities.length ? amenities : null,
    furnishing: str(r.furnished_status),
    viewingArrangements: null,
    photoCount,
  };
}

export function listingTypeFromCrm(v: string | null): ListingType | null {
  const t = (v ?? "").trim().toLowerCase().replace(/[-_\s]+/g, " ");
  if (/^(for )?(rent|rental|lease)$/.test(t)) return "rent";
  if (/^(for )?sale$/.test(t)) return "sale";
  return null;
}

export function statusOf(v: unknown): Listing["status"] {
  const s = (str(v) ?? "").toLowerCase().replace(/[-_\s]+/g, " ");
  if (["sold", "rented", "let"].includes(s)) return "sold";
  if (["withdrawn", "unavailable", "off market"].includes(s)) return "withdrawn";
  return "active";
}

const currencyOf = (v: unknown): Currency => ((str(v) ?? "").toUpperCase() === "USD" ? "USD" : "TTD");

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t : null;
}

function numOrNull(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function measure(v: unknown): string | number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  return str(v);
}
