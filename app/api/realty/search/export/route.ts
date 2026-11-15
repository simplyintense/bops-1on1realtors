import { ownerAccess } from "@/realty/node/periskope-intake.ts";
import { exportSheets } from "@/realty/node/search-store.ts";
import { periskopeRoot } from "@/realty/node/periskope-root.ts";

export const dynamic = "force-dynamic";

/**
 * Owners only. The three search tabs as JSON: a header row, then one row per record, all strings, times in AST.
 * Includes phone numbers and original text.
 *   GET → 200 { Supply: string[][], Demand: string[][], "Needs explanation": string[][] }
 */
export async function GET(request: Request) {
  const denied = await ownerAccess(request);
  if (denied) return Response.json(denied.body, { status: denied.status });
  return Response.json(exportSheets(periskopeRoot()));
}
