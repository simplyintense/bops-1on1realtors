# 1on1 Realtors setup

This fork runs Bops for 1on1 Realtors (1on1realtors.com, Trinidad and Tobago).

## The team (lib/realty-team.ts)

A fresh start (or Start over) gets five bots, all on the main bot's computer:

| Bot | Role | What it does |
|---|---|---|
| Uno (main, id `boppy`) | Chief of Staff, 1on1 Realtors | Takes requests and hands them to the specialists |
| Lena | Lead intake | New website leads (contact form + property inquiries), flags ones waiting over 24h, drafts first replies |
| Max | Listing follow-ups | Stale, unviewed or incomplete listings; matches CRM clients to listings |
| Shay | Showing scheduler | Tour/viewing requests, clashes, drafts confirmations |
| Pip | Weekly pipeline report | Monday report: leads, showings, clients, tasks, listings (facts only) |

`BOPS_TEAM_PRESET=bops` brings back upstream's Boppy alone. Nobody is contacted without the owner's OK.

## The CRM connector (lib/server/realty-crm.ts) — read-only stub

The realty_* tools (`realty_new_leads`, `realty_listings`, `realty_showings`, `realty_pipeline`) read the
site's Supabase backend over its REST API, signed in as a dedicated bot login so the CRM's row-level
security decides what they see. They are only offered when all of these are set in `.env.local`:

- `ONEON1_CRM_URL`, `ONEON1_CRM_ANON_KEY` (publishable key only, never the service-role key)
- `ONEON1_CRM_BOT_EMAIL`, `ONEON1_CRM_BOT_PASSWORD`

Writes are not built (`ONEON1_CRM_WRITES` is reserved). Wired into chat turns; computer tasks don't get
them yet.
