import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The CPU fix (Nov 23): the poller and the webhook must not run a full Auto-Match sync per message.
test("the poller's ingest skips the per-message Auto-Match sync and runs one per poll", () => {
  const src = readFileSync(new URL("../node/periskope-poll.ts", import.meta.url), "utf8");
  assert.match(src, /opts: \{ root, env, now: \(\) => at, crm: opts\.crm, alertSync: "skip" \}/);
  assert.match(src, /if \(fullSyncDue\(at\.getTime\(\)\)\) await runFullAutoMatchSync\(\{ root, env, now: at \}\)/);
});

test("the webhook path coalesces Auto-Match syncs by default in production", () => {
  const src = readFileSync(new URL("../node/periskope-intake.ts", import.meta.url), "utf8");
  assert.match(src, /o\.alertSync \?\? \(o\.now !== undefined \|\| o\.root !== undefined \? "inline" : "coalesced"\)/);
  assert.equal((src.match(/syncIntakeAlerts\(o,/g) ?? []).length, 2);
});

test("/login, /signin and /sign-in go to Google sign-in", () => {
  const src = readFileSync(new URL("../../proxy.ts", import.meta.url), "utf8");
  assert.match(src, /LOGIN_ALIASES = new Set\(\["\/login", "\/signin", "\/sign-in"\]\)/);
  assert.ok(src.includes('.toLowerCase())) return NextResponse.redirect(new URL("/api/gate/login", cfg.publicUrl));'));
});
