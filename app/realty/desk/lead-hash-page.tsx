"use client";

import { useEffect } from "react";
import { pageHref, type QueryParams } from "@/realty/flow/pagination.ts";

/**
 * Admin digest links land on /realty/desk#<card-id>. When that card is on another page, jump there and keep the hash.
 */
export function LeadCardHashPage({
  ids,
  pageSize,
  path,
  raw,
  param = "page",
}: {
  ids: string[];
  pageSize: number;
  path: string;
  raw: QueryParams;
  param?: string;
}) {
  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, "");
    if (!hash || document.getElementById(hash)) return;
    const i = ids.indexOf(hash);
    if (i < 0) return;
    const href = pageHref(path, raw, Math.floor(i / pageSize) + 1, param);
    window.location.replace(`${href}#${hash}`);
  }, [ids, pageSize, path, raw, param]);
  return null;
}
