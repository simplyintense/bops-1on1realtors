import { ownerAccess } from "@/realty/node/periskope-intake.ts";
import { SearchInputError, searchInputFrom, withSearchStore } from "@/realty/node/search-store.ts";
import { periskopeRoot } from "@/realty/node/periskope-root.ts";

export const dynamic = "force-dynamic";

/**
 * Owners only. Searches the WhatsApp supply, demand and needs-explanation tabs. Filters are query params (see
 * searchInputFrom). Rows include phone numbers and original text, so agents never receive this.
 *   GET → 200 { kind, total, limit, offset, rows } · 400 { error } for a bad filter
 */
export async function GET(request: Request) {
  const denied = await ownerAccess(request);
  if (denied) return Response.json(denied.body, { status: denied.status });
  try {
    const input = searchInputFrom(new URL(request.url).searchParams);
    return Response.json(withSearchStore(periskopeRoot(), (store) => store.search(input)));
  } catch (e) {
    if (e instanceof SearchInputError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
