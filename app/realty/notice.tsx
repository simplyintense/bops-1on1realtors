import type { ReactNode } from "react";

/** A one-line notice in the realty theme. `warn` is for "not set up / not available", `error` for a failed call. */
export function Notice({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "warn" | "error" }) {
  const cls = tone === "warn" ? "rt-notice rt-notice-warn" : tone === "error" ? "rt-notice rt-notice-error" : "rt-notice";
  return <p className={cls}>{children}</p>;
}
