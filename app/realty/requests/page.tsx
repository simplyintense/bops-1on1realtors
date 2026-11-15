import { redirect } from "next/navigation";
import { onlineFeedHref, toSearchParams, type RawParams } from "../search/source";

/**
 * The old buyer-request page. It now lives on Supply & Demand as the online feed (?source=online), and every filter and sort
 * in the query carries over. Owners are checked there, so nothing is read here.
 */
export default async function RequestsRedirect({ searchParams }: { searchParams: Promise<RawParams> }) {
  redirect(onlineFeedHref(toSearchParams(await searchParams)));
}
