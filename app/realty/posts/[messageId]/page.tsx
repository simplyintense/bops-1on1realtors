import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { dateAst, findPostView } from "@/realty/node/group-posts.ts";
import { PeriskopeStore, requestIdOf } from "@/realty/node/periskope-store.ts";
import { photoIndex } from "@/realty/node/listing-media.ts";
import { viewer } from "../../viewer";
import { PhotoThumbs } from "../../photo-thumbs";
import { staffMayOpen } from "../../staff-pages";
import { periskopeRoot } from "@/realty/node/periskope-root.ts";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Post · 1on1 Realtors staff", robots: { index: false, follow: false } };

/**
 * One stored post, for any signed-in staff. Staff see the original WhatsApp text next to the parsed fields, to error-check
 * the parse (the text is the point of this page). The match counts and the all-posts link are owners' only, and the view
 * never carries the group name or chat id unless the viewer is an owner.
 */
export default async function PostDetailPage({ params }: { params: Promise<{ messageId: string }> }) {
  const { owner, staff } = await viewer();
  if (!staffMayOpen({ owner, staff })) redirect("/realty/desk");
  const { messageId } = await params;
  const store = new PeriskopeStore(periskopeRoot());
  const post = findPostView(store, messageId, owner, true);
  if (!post) notFound();
  const photos = photoIndex(store);
  const hashes = photos.photos.get(post.messageId) ?? [];
  const sameAs = photos.links.get(post.messageId) ?? [];

  const rows: [string, string][] = [
    ["Date", dateAst(post.sentAt)],
    ["Category", post.cobroke && post.category !== "cobroke" ? `${post.category} (co-broke)` : post.category],
    ["Agent name", post.senderName ?? post.firm ?? ""],
    ["Agent phone", post.senderPhone ?? ""],
    ["Area", post.area ?? ""],
    ["Price", post.price != null ? `${post.currency ?? ""} ${post.price}`.trim() : ""],
    ["Beds", post.beds != null ? String(post.beds) : ""],
    ["Baths", post.baths != null ? String(post.baths) : ""],
    ["Type", post.type ?? ""],
    ["Buy or rent", post.intent ?? post.listingType ?? ""],
    ["Property class", post.propertyClass ?? ""],
    ["Parsed notes", post.notes ?? ""],
    ...(owner ? [["Matches", `${post.matchCount} (${post.marketMatches} market, ${post.crmMatches} ours)`] as [string, string]] : []),
  ];

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-10">
      <p className="rt-eyebrow">Staff · read-only</p>
      {owner ? (
        <p className="rt-muted mt-2">
          <Link href="/realty/posts" className="underline">
            All posts
          </Link>
        </p>
      ) : null}
      <h1 className="mt-2 text-3xl font-semibold">Post</h1>
      <dl className="rt-card mt-6 grid gap-3 p-4">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt className="text-sm font-medium">{k}</dt>
            <dd className="mt-1 whitespace-pre-wrap">{v || "—"}</dd>
          </div>
        ))}
      </dl>
      {hashes.length || sameAs.length ? (
        <section className="rt-card mt-6 p-4">
          <h2 className="text-lg font-semibold">Photos</h2>
          <PhotoThumbs hashes={hashes} />
          {sameAs.map((id) => (
            <p key={id} className="mt-3 text-sm">
              <Link href={`/realty/posts/${requestIdOf(id)}`} className="rt-link">
                Same photos as another post
              </Link>
            </p>
          ))}
        </section>
      ) : null}
      <section className="rt-card mt-6 p-4">
        <h2 className="text-lg font-semibold">Original text</h2>
        <p className="mt-3 whitespace-pre-wrap">{post.originalText || "—"}</p>
      </section>
    </main>
  );
}
