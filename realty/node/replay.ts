import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCaller } from "../flow/areas.ts";
import { runtimeEnv, type Env } from "../flow/env.ts";
import { marketConfigFromEnv } from "../flow/market-search.ts";
import { requestLabel, type LiveMatchStatus, type LiveRequest } from "../flow/live-match.ts";
import type { MatchItem } from "../flow/recommendations.ts";
import { SAMPLE_CHAT, SAMPLE_MESSAGES, sampleEnvelope, type SampleMessage } from "../fixtures/whatsapp-samples.ts";
import { handleWebhook, setConsent } from "./periskope-intake.ts";
import { PeriskopeStore } from "./periskope-store.ts";

/**
 * The owners' dry run: the sample WhatsApp messages (fixtures/whatsapp-samples.ts) go through the real webhook path,
 * signature check included, into a throwaway store, and come back as what the intake made of them: kind, the parsed
 * request and its live matches. The matches are real (match_buyer on the market) when market search is set up here.
 *
 * Nothing persists and nothing is sent: the store is a temp directory removed afterwards, the signing key is random
 * for this run only (never stored or shown), no CRM is used (so no lead flow), and the market-ingest adapter is
 * switched off for the run, so no sample reaches market-ingest. The server's real intake data is never touched.
 */

export type ReplayMessage = {
  id: string;
  expect: SampleMessage["expect"];
  /** The webhook's answer, e.g. "buyer request stored (no CRM: not routed)". */
  result: string;
  request: LiveRequest | null;
  label: string | null;
  status: LiveMatchStatus | "pending" | null;
  matches: MatchItem[];
};

export type ReplayResult = {
  ranAt: string;
  market: "configured" | "not-configured";
  messages: ReplayMessage[];
  /** The first sample delivered a second time: it must be "ignored: already seen". */
  duplicate: string;
};

export type ReplayOptions = { env?: Env; market?: ToolCaller | null; fetch?: typeof fetch; now?: () => Date };

export async function replaySamples(o: ReplayOptions = {}): Promise<ReplayResult> {
  const base = o.env ?? runtimeEnv();
  const root = mkdtempSync(join(tmpdir(), "bops-replay-"));
  const key = randomBytes(32).toString("hex");
  const env: Env = { ...base, PERISKOPE_SIGNING_KEY: key, PERISKOPE_ALLOWED_CHATS: "", ONEON1_MARKET_WRITE_URL: "", ONEON1_MARKET_INGEST_TOKEN: "" };
  const opts = { root, areasRoot: join(root, "areas"), env, crm: null, market: o.market, fetch: o.fetch, now: o.now };
  const deliver = async (m: SampleMessage) => {
    const raw = Buffer.from(JSON.stringify(sampleEnvelope(m)));
    const sig = createHmac("sha256", key).update(raw).digest("hex");
    return handleWebhook(raw, sig, opts);
  };
  try {
    const at = (o.now?.() ?? new Date()).toISOString();
    await setConsent({ chatId: SAMPLE_CHAT, groupName: "Sample group (replay)", noticePostedAt: at, adminOkBy: "Replay", adminOkAt: at, active: true }, opts);
    const results: { m: SampleMessage; result: string }[] = [];
    for (const m of SAMPLE_MESSAGES) {
      const r = await deliver(m);
      results.push({ m, result: String(r.body.result ?? r.body.error ?? r.status) });
    }
    const again = await deliver(SAMPLE_MESSAGES[0]);
    const live = new PeriskopeStore(root).live();
    return {
      ranAt: at,
      market: (o.market !== undefined ? o.market !== null : marketConfigFromEnv(base) !== null) ? "configured" : "not-configured",
      messages: results.map(({ m, result }) => {
        const row = live.find((l) => l.messageId === m.id) ?? null;
        return {
          id: m.id,
          expect: m.expect,
          result,
          request: row?.request ?? null,
          label: row ? requestLabel(row.request) : null,
          status: row?.status ?? null,
          matches: row?.matches ?? [],
        };
      }),
      duplicate: String(again.body.result ?? again.status),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
