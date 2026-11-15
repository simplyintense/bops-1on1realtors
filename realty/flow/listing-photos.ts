import type { PostRecord } from "./periskope.ts";

/**
 * Listing photos, the pure rules (the bytes and the disk are in realty/node/listing-media.ts). A display image is re-encoded
 * at most DISPLAY_SIDE px a side and a thumb at THUMB_SIDE, WebP (JPEG if WebP fails). A picture's fingerprint is its dHash:
 * 64 bits from a 9x8 greyscale grid, so a re-encode or a resize of the same picture stays close.
 */

export const DISPLAY_SIDE = 1280;
export const THUMB_SIDE = 320;
export const PHOTO_QUALITY = 80;
/** Media files not written or read for this long (by modification time) are deleted. */
export const MEDIA_RETENTION_DAYS = 180;
/** At or above this many bytes under the media root, no new photos are saved. */
export const MEDIA_CAP_BYTES = 2 * 1024 ** 3;
/** Two photos are the same picture when their dHashes differ in at most this many of the 64 bits. */
export const PHOTO_MAX_DISTANCE = 5;
/** Prices agree when within this share of the higher one. */
export const PRICE_BAND = 0.15;

const LISTING_CATEGORIES = new Set<string>(["listing_for_sale", "listing_for_rent", "cobroke"]);
const CONTENT_PATH = /^media\/([0-9a-f]{2})\/([0-9a-f]{64})(?:-thumb)?\.(?:webp|jpg)$/;

/** A 64-bit dHash (16 hex) from 72 greyscale bytes: each bit is whether a pixel is brighter than its right neighbour. */
export function dHashOf(gray: Uint8Array): string {
  if (gray.length !== 72) throw new Error("dHash needs a 9x8 greyscale grid");
  let bits = "";
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) bits += gray[row * 9 + col] > gray[row * 9 + col + 1] ? "1" : "0";
  }
  return (bits.match(/.{4}/g) ?? []).map((nibble) => parseInt(nibble, 2).toString(16)).join("");
}

const BITS_IN_NIBBLE = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

/** Differing bits between two dHashes. A malformed hash is 64 (never a match). */
export function hammingDistance(a: string, b: string): number {
  if (!/^[0-9a-f]{16}$/.test(a) || !/^[0-9a-f]{16}$/.test(b)) return 64;
  let n = 0;
  for (let i = 0; i < 16; i++) n += BITS_IN_NIBBLE[parseInt(a[i], 16) ^ parseInt(b[i], 16)];
  return n;
}

/** The content hash in a stored photo's path (media/<aa>/<sha256>.webp, or the thumb), or null for any other path. */
export function contentHashOf(file: string): string | null {
  const m = CONTENT_PATH.exec(file);
  return m && m[1] === m[2].slice(0, 2) ? m[2] : null;
}

export const isContentHash = (s: string): boolean => /^[0-9a-f]{64}$/.test(s);

export const isListingCategory = (category: string): boolean => LISTING_CATEGORIES.has(category);

export type PhotoPost = Pick<PostRecord, "messageId" | "senderPhone" | "category" | "listingType" | "area" | "development" | "price" | "currency" | "mediaHashes">;

const same = (a: string | null | undefined, b: string | null | undefined): boolean => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

function pricesAgree(a: PhotoPost, b: PhotoPost): boolean {
  if (a.price == null && b.price == null) return true;
  if (a.price == null || b.price == null) return false;
  if ((a.currency ?? null) !== (b.currency ?? null)) return false;
  return Math.abs(a.price - b.price) <= PRICE_BAND * Math.max(a.price, b.price);
}

/**
 * Two supply posts from different senders are the same property when they show a picture within PHOTO_MAX_DISTANCE of each
 * other, the same sale or rent, the same area or development, and prices within PRICE_BAND (or both unpriced). Conservative on
 * purpose: any disagreement, or a missing field, is no link.
 */
export function photoLinked(a: PhotoPost, b: PhotoPost): boolean {
  if (!a.senderPhone || a.senderPhone === b.senderPhone) return false;
  if (!a.listingType || a.listingType !== b.listingType) return false;
  if (!same(a.area, b.area) && !same(a.development, b.development)) return false;
  if (!pricesAgree(a, b)) return false;
  return (a.mediaHashes ?? []).some((x) => (b.mediaHashes ?? []).some((y) => hammingDistance(x, y) <= PHOTO_MAX_DISTANCE));
}

/** For each supply post with photos, the message ids of the other supply posts it is linked to. A signal for the desk, never a merge. */
export function photoLinks(posts: PhotoPost[]): Map<string, string[]> {
  const listed = posts.filter((p) => isListingCategory(p.category) && (p.mediaHashes?.length ?? 0) > 0);
  const links = new Map<string, string[]>();
  for (let i = 0; i < listed.length; i++) {
    for (let j = i + 1; j < listed.length; j++) {
      if (!photoLinked(listed[i], listed[j])) continue;
      links.set(listed[i].messageId, [...(links.get(listed[i].messageId) ?? []), listed[j].messageId]);
      links.set(listed[j].messageId, [...(links.get(listed[j].messageId) ?? []), listed[i].messageId]);
    }
  }
  return links;
}
