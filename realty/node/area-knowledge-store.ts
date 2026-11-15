import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AreaKnowledgeIndex } from "../flow/area-knowledge.ts";

export function knowledgePath(root: string): string {
  return root.endsWith(".json") ? root : `${root.replace(/\/$/, "")}/area-knowledge.json`;
}

export function loadAreaKnowledge(path: string): AreaKnowledgeIndex | null {
  if (!existsSync(path)) return null;
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as AreaKnowledgeIndex;
    if (!j || !Array.isArray(j.places)) return null;
    return j;
  } catch {
    return null;
  }
}

export function saveAreaKnowledge(path: string, index: AreaKnowledgeIndex): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
}

/** Snapshot shipped with the image; the volume file at `.data/realty/area-knowledge.json` wins when present. */
export function bundledKnowledgePath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../data/area-knowledge.json");
}

export function resolveAreaKnowledge(volumePath: string): AreaKnowledgeIndex | null {
  return loadAreaKnowledge(volumePath) ?? loadAreaKnowledge(bundledKnowledgePath());
}
