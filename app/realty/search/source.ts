/**
 * Supply & Demand's source (/realty/search?source=…): "groups" is the WhatsApp supply, demand and needs-explanation search (the
 * default); "online" is the buyer-request feed from the market (the old Requests page). Plain functions, so a test can check
 * them without rendering the pages (app/realty/search/page.tsx, app/realty/requests/page.tsx).
 */

export type SearchSource = "groups" | "online";
export type RawParams = Record<string, string | string[] | undefined>;

/** `source=online` is the online feed. Absent, `groups`, or anything else is the groups search. */
export function sourceFrom(raw: RawParams): SearchSource {
  const v = Array.isArray(raw.source) ? raw.source[0] : raw.source;
  return v === "online" ? "online" : "groups";
}

/** The query as URLSearchParams, taking the first value of a repeated key. */
export function toSearchParams(raw: RawParams): URLSearchParams {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(raw)) {
    const one = Array.isArray(v) ? v[0] : v;
    if (one !== undefined) p.set(k, one);
  }
  return p;
}

/** The online feed's URL with these params kept (source is set to online and comes first). */
export function onlineFeedHref(params: URLSearchParams): string {
  const p = new URLSearchParams([["source", "online"]]);
  for (const [k, v] of params) if (k !== "source") p.append(k, v);
  return `/realty/search?${p}`;
}
