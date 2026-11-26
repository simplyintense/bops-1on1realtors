/** Shared page-window math for the staff desk lists. Pure: no I/O, no framework. */

export const PAGE_SIZE = 25;
export const CARD_PAGE_SIZE = 20;

export type QueryParams = Record<string, string | string[] | undefined>;

export type PageWindow = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  offset: number;
  /** 1-based first item on this page, or 0 when the list is empty. */
  from: number;
  /** 1-based last item on this page, or 0 when the list is empty. */
  to: number;
};

/** The first string value of a query param, or undefined when missing or empty. */
export function firstParam(raw: QueryParams, key: string): string | undefined {
  const v = raw[key];
  const one = Array.isArray(v) ? v[0] : v;
  return one ? one : undefined;
}

/** A 1-based page number; anything unreadable becomes 1 (clamping to the last page is pageWindow's job). */
export function parsePage(raw: unknown): number {
  const one = Array.isArray(raw) ? raw[0] : raw;
  const n = typeof one === "number" ? one : Number.parseInt(String(one ?? ""), 10);
  return Number.isFinite(n) ? Math.trunc(n) : 1;
}

/**
 * A clamped window over `total` items. Page < 1 becomes 1; page > totalPages becomes totalPages.
 * An empty list is page 1 of 1, with from and to at 0.
 */
export function pageWindow(o: { page?: unknown; pageSize: number; total: number }): PageWindow {
  const pageSize = Math.max(1, Math.trunc(o.pageSize) || 1);
  const total = Math.max(0, Math.trunc(o.total) || 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  let page = parsePage(o.page);
  if (page < 1) page = 1;
  if (page > totalPages) page = totalPages;
  const offset = (page - 1) * pageSize;
  return {
    page,
    pageSize,
    total,
    totalPages,
    offset,
    from: total === 0 ? 0 : offset + 1,
    to: Math.min(offset + pageSize, total),
  };
}

export function slicePage<T>(rows: readonly T[], w: PageWindow): T[] {
  return rows.slice(w.offset, w.offset + w.pageSize);
}

/**
 * The page number from `?page=` (or `pageKey`), falling back to a legacy `?offset=` so older Message Search
 * links still open the same page.
 */
export function pageFromSearch(raw: QueryParams, pageSize: number, pageKey = "page"): number {
  const page = firstParam(raw, pageKey);
  if (page != null) return parsePage(page);
  const offset = firstParam(raw, "offset");
  if (offset != null) {
    const n = Number.parseInt(offset, 10);
    if (Number.isFinite(n) && n > 0) return Math.floor(n / Math.max(1, pageSize)) + 1;
  }
  return 1;
}

/** This path with the current query, plus any overrides. A blank or undefined override drops that key. Page 1 is omitted. */
export function hrefWithParams(path: string, raw: QueryParams, changes: Record<string, string | undefined>): string {
  const merged: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(raw)) {
    const one = Array.isArray(v) ? v[0] : v;
    if (one) merged[k] = one;
  }
  for (const [k, v] of Object.entries(changes)) merged[k] = v;
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(merged)) {
    if (v) p.set(k, v);
  }
  const qs = p.toString();
  return qs ? `${path}?${qs}` : path;
}

/** A pager link: page 1 drops the param (and a leftover offset) so the URL stays clean. */
export function pageHref(path: string, raw: QueryParams, page: number, pageKey = "page"): string {
  return hrefWithParams(path, raw, { [pageKey]: page <= 1 ? undefined : String(page), offset: undefined });
}

/** Load one page, then clamp and reload if `page` was past the end. */
export function resolvePage<T>(
  page: unknown,
  pageSize: number,
  load: (offset: number, limit: number) => { rows: T[]; total: number },
): { window: PageWindow; rows: T[] } {
  const size = Math.max(1, Math.trunc(pageSize) || 1);
  const req = Math.max(1, parsePage(page));
  const offsetGuess = (req - 1) * size;
  const listed = load(offsetGuess, size);
  const w = pageWindow({ page: req, pageSize: size, total: listed.total });
  return { window: w, rows: w.offset === offsetGuess ? listed.rows : load(w.offset, w.pageSize).rows };
}

