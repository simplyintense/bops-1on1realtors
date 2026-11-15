import { periskopeRoot } from "../node/periskope-root.ts";

/** Shared by the search CLIs: the default root and `--flag value` parsing. */

export function searchRoot(argv = process.argv.slice(2)): string {
  return argValue("root", argv) || periskopeRoot();
}

/** The value after `--name`, or undefined. */
export function argValue(name: string, argv = process.argv.slice(2)): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
}

export function hasFlag(name: string, argv = process.argv.slice(2)): boolean {
  return argv.includes(`--${name}`);
}

/** Every `--kebab-name value` pair as a camelCase record, for searchInputFrom (`--min-price 2m` → minPrice). */
export function filterParams(argv = process.argv.slice(2)): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--") || a === "--root" || a === "--json" || a === "--out") continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) continue;
    const key = a.slice(2).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    out[key] = next;
    i++;
  }
  return out;
}
