import Link from "next/link";
import { pageHref, type PageWindow, type QueryParams } from "@/realty/flow/pagination.ts";

/**
 * The 1on1 CRM pager: "Showing X–Y of Z", Previous / Next, and "Page N of M".
 * Hidden when the list is empty. One page still shows the count, with Previous and Next disabled.
 * Links keep every current filter and drop a leftover offset.
 */
export function PaginationBar({
  path,
  raw,
  window: w,
  param = "page",
}: {
  path: string;
  raw: QueryParams;
  window: PageWindow;
  param?: string;
}) {
  if (w.total === 0) return null;
  const prev = w.page > 1 ? pageHref(path, raw, w.page - 1, param) : null;
  const next = w.page < w.totalPages ? pageHref(path, raw, w.page + 1, param) : null;
  return (
    <nav aria-label="Pages" className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
      <p className="rt-muted">
        Showing {w.from}–{w.to} of {w.total}
      </p>
      <div className="flex items-center gap-2">
        {prev ? (
          <Link href={prev} className="rt-page-btn">
            Previous
          </Link>
        ) : (
          <span className="rt-page-btn is-off">Previous</span>
        )}
        <span className="rt-muted">
          Page {w.page} of {w.totalPages}
        </span>
        {next ? (
          <Link href={next} className="rt-page-btn">
            Next
          </Link>
        ) : (
          <span className="rt-page-btn is-off">Next</span>
        )}
      </div>
    </nav>
  );
}
