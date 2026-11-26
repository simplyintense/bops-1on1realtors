import type { Metadata } from "next";
import Link from "next/link";
import { dateAst, listPostPage } from "@/realty/node/group-posts.ts";
import { PAGE_SIZE, resolvePage, type QueryParams } from "@/realty/flow/pagination.ts";
import { PeriskopeStore } from "@/realty/node/periskope-store.ts";
import { viewer } from "../viewer";
import { PhotoThumbs } from "../photo-thumbs";
import { PaginationBar } from "../pagination-bar";
import { contentHashOf } from "@/realty/flow/listing-photos.ts";
import { periskopeRoot } from "@/realty/node/periskope-root.ts";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "All posts · 1on1 Realtors staff", robots: { index: false, follow: false } };

/**
 * WhatsApp group posts the desk has stored, for any signed-in staff member. Each row opens the post's page, which shows the original
 * text next to the parse (any staff member). The group name and chat id stay owners' only: listPostPage adds them only for an owner.
 */
export default async function PostsPage({ searchParams }: { searchParams: Promise<QueryParams> }) {
  const { owner } = await viewer();
  const raw = await searchParams;
  const store = new PeriskopeStore(periskopeRoot());
  const { window: w, rows: posts } = resolvePage(raw.page, PAGE_SIZE, (offset, limit) => listPostPage(store, owner, { limit, offset }));

  return (
    <main className="mx-auto w-full max-w-6xl px-5 py-10">
      <p className="rt-eyebrow">Read only</p>
      <h1 className="mt-2 text-3xl font-semibold">All posts</h1>
      <p className="rt-muted mt-3">
        Posts stored from the allowlisted WhatsApp group. Open a post to see the original text next to
        what the desk parsed.
      </p>
      {w.total === 0 ? (
        <p className="rt-muted mt-8">No posts stored yet.</p>
      ) : (
        <>
          <ul className="mt-8 divide-y" data-tour="posts-list">
            {posts.map((p) => (
              <li key={p.requestId} className="py-3">
                <Link href={`/realty/posts/${p.requestId}`} className="block hover:underline">
                  <span className="font-medium">{dateAst(p.sentAt)}</span>
                  <span className="rt-muted"> · {p.category}{p.cobroke && p.category !== "cobroke" ? " · co-broke" : ""}</span>
                  {p.area ? <span className="rt-muted"> · {p.area}</span> : null}
                  {p.senderName || p.firm ? <span className="rt-muted"> · {p.senderName || p.firm}</span> : null}
                  {p.matchCount ? <span className="rt-muted"> · {p.matchCount} match{p.matchCount === 1 ? "" : "es"}</span> : null}
                </Link>
                <PhotoThumbs hashes={(p.mediaFiles ?? []).flatMap((f) => contentHashOf(f) ?? []).slice(0, 2)} />
              </li>
            ))}
          </ul>
          <PaginationBar path="/realty/posts" raw={raw} window={w} />
        </>
      )}
    </main>
  );
}
