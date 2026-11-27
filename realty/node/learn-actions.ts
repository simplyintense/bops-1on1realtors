import { readingOf, type Reading } from "../flow/learn-view.ts";
import { placeTeachOf, type PlaceTeach } from "../flow/taught-areas.ts";
import { PeriskopeStore } from "./periskope-store.ts";
import { exclusive } from "./periskope-intake.ts";
import { isVague, SearchInputError, SearchStore, type TeachInput } from "./search-store.ts";

/**
 * The Teach page's writes and the "Test how the desk reads this" box (app/api/realty/learn/...). Each one goes through the same
 * store the CLI and the queue use: taught places and pairs (teachAreas), the ignored state (a kind override, as "Not a lead" writes
 * it), and the taught knowledge rows (updateTaught, deleteTaught). Nothing here calls the network or writes to the CRM.
 */

/** The reason an ignored queue item carries: the kind override's reason, as "Not a lead" sets it. */
export const NOT_A_LISTING = "Not a listing";

/** Teaches a place (and its alias, coordinates and nearby pairs) to the taught-area tables. Teachers only (the route checks). */
export function teachPlace(root: string, body: unknown, by: string, at = new Date().toISOString()): PlaceTeach {
  const store = SearchStore.open(root);
  try {
    const r = placeTeachOf(body, store.taughtAreas());
    if (!r.ok) throw new SearchInputError(r.error);
    store.teachAreas(r.file, by, at);
    return r.summary;
  } finally {
    store.close();
  }
}

/**
 * Marks one queue item as not a listing: each of its posts gets a kind override with status "ignored", so the item leaves the open
 * queue (and every other tab), the same state "Not a lead" sets. Then the observation is rebuilt and the store synced. Runs one at a
 * time with the other writers to the post files. NotInQueueError when the id isn't on the queue.
 */
export function ignoreQueueItem(root: string, id: string, by: string, at = new Date().toISOString()): Promise<{ id: string; ignored: true }> {
  return exclusive(() => {
    const store = SearchStore.open(root);
    try {
      const messageIds = store.queuedMessageIds(id);
      const posts = new PeriskopeStore(root);
      for (const messageId of messageIds) posts.setKindOverride({ messageId, status: "ignored", reason: NOT_A_LISTING, by, at });
      posts.reprojectObservation(posts.posts());
      store.sync({ force: true });
      return { id, ignored: true as const };
    } finally {
      store.close();
    }
  });
}

/** How the desk reads a sample, for the preview box: the reading and whether it is too vague to match. No text is returned. */
export function previewText(root: string, text: string): Omit<Reading, "type"> & { vague: boolean } {
  const store = SearchStore.open(root);
  try {
    const { type, ...r } = readingOf(text, store.knownTerms(), store.taughtAreas());
    return { ...r, vague: isVague({ area: r.area, type, price: r.price, listingType: r.listingType }) };
  } finally {
    store.close();
  }
}

/** A PATCH body as a patch: only the fields it names change. */
export function taughtPatchOf(body: unknown): Partial<TeachInput> {
  const o = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" ? v : null);
  const patch: Partial<TeachInput> = {};
  if ("answer" in o) patch.answer = s(o.answer) ?? "";
  if ("term" in o) patch.term = s(o.term);
  if ("area" in o) patch.area = s(o.area);
  if ("development" in o) patch.development = s(o.development);
  if ("type" in o) patch.type = s(o.type);
  if ("listingType" in o) patch.listingType = s(o.listingType);
  return patch;
}

/** Edits one past answer. Teachers only (the route checks). NotTaughtError for a seeded row or an unknown id. */
export function editTaught(root: string, id: number, patch: Partial<TeachInput>, by: string) {
  const store = SearchStore.open(root);
  try {
    return store.updateTaught(id, patch, by);
  } finally {
    store.close();
  }
}

/** Deletes one past answer. Teachers only (the route checks). NotTaughtError for a seeded row or an unknown id. */
export function removeTaught(root: string, id: number) {
  const store = SearchStore.open(root);
  try {
    return store.deleteTaught(id);
  } finally {
    store.close();
  }
}
