/**
 * Security headers on every response (next.config.ts headers()): the app is on the web behind the login gate
 * (bop.1on1realtors.com). Only frame-ancestors in the CSP: a full script policy is too risky for the upstream chat app.
 * SAMEORIGIN / 'self' (not DENY) because the owner chat app frames its own pages. HSTS is harmless off https.
 * A plain module (no Next imports) so node --test can check it.
 */
export type HeaderGroup = { source: string; headers: { key: string; value: string }[] };

export const SECURITY_HEADER_GROUPS: HeaderGroup[] = [
  {
    source: "/:path*",
    headers: [
      { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "SAMEORIGIN" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    ],
  },
  // Not on the pages that set their own sandbox policy (made apps, files, pages): that one must not be replaced.
  { source: "/((?!api/made-apps/|api/files/|api/pages/).*)", headers: [{ key: "Content-Security-Policy", value: "frame-ancestors 'self'" }] },
];
