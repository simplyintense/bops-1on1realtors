import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const SCRIPT = join(import.meta.dirname, "../../docker-entrypoint.sh");

test("the image entrypoint lists files owned by a given user and skips lost+found", () => {
  const syntax = spawnSync("sh", ["-n", SCRIPT], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);

  const dir = mkdtempSync(join(tmpdir(), "bops-data-"));
  mkdirSync(join(dir, "lost+found"), { mode: 0o700 });
  writeFileSync(join(dir, "lost+found", "orphan"), "x");
  writeFileSync(join(dir, "posts.jsonl"), "{}\n");
  mkdirSync(join(dir, "realty"), { mode: 0o700 });
  writeFileSync(join(dir, "realty", "ok.jsonl"), "{}\n");

  const uid = String(process.getuid?.() ?? 0);
  const listed = spawnSync("sh", [SCRIPT, "--list-owned", dir, uid], { encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  const paths = listed.stdout.split("\n").filter(Boolean).map((p) => p.slice(dir.length) || "/");
  assert.ok(paths.includes("/posts.jsonl"), listed.stdout);
  assert.ok(paths.includes("/realty"), listed.stdout);
  assert.ok(paths.includes("/realty/ok.jsonl"), listed.stdout);
  assert.ok(!paths.some((p) => p.includes("lost+found")), listed.stdout);
});
