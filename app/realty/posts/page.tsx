import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { join } from "node:path";
import { dateAst, listPostViews } from "@/realty/node/group-posts.ts";
import { PeriskopeStore } from "@/realty/node/periskope-store.ts";
import { viewer } from "../viewer";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Group posts · 1on1 Realtors staff", robots: { index: false, follow: false } };

/**
 * Owners only: WhatsApp group posts Bops has stored, with a link to the original text next to the
 * parse. Agents are sent to the desk and never receive the text.
 */
export default async function PostsPage() {
  const { owner } = await viewer();
  if (!owner) redirect("/realty/desk");
  const store = new PeriskopeStore(join(process.cwd(), ".data", "realty", "periskope"));
  const posts = listPostViews(store, true);

  return (
    <main className="mx-auto w-full max-w-6xl px-5 py-10">
      <p className="rt-eyebrow">Owners only · listen-only</p>
      <h1 className="mt-2 text-3xl font-semibold">Group posts</h1>
      <p className="rt-muted mt-3">
        Posts stored from the allowlisted WhatsApp group. Open a post to see the original text next to
        what Bops parsed. Agents do not see this page or the text.
      </p>
      {posts.length === 0 ? (
        <p className="rt-muted mt-8">No posts stored yet.</p>
      ) : (
        <ul className="mt-8 divide-y">
          {posts.map((p) => (
            <li key={p.requestId} className="py-3">
              <Link href={`/realty/posts/${p.requestId}`} className="block hover:underline">
                <span className="font-medium">{dateAst(p.sentAt)}</span>
                <span className="rt-muted"> · {p.category}{p.cobroke && p.category !== "cobroke" ? " · co-broke" : ""}</span>
                {p.area ? <span className="rt-muted"> · {p.area}</span> : null}
                {p.senderName || p.firm ? <span className="rt-muted"> · {p.senderName || p.firm}</span> : null}
                {p.matchCount ? <span className="rt-muted"> · {p.matchCount} match{p.matchCount === 1 ? "" : "es"}</span> : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
