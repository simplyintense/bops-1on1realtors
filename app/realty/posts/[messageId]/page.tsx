import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { join } from "node:path";
import { dateAst, findPostView } from "@/realty/node/group-posts.ts";
import { PeriskopeStore } from "@/realty/node/periskope-store.ts";
import { viewer } from "../../viewer";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Group post · 1on1 Realtors staff", robots: { index: false, follow: false } };

/**
 * Owners only: one stored post, original text next to the parsed fields and category. Agents are
 * sent to the desk.
 */
export default async function PostDetailPage({ params }: { params: Promise<{ messageId: string }> }) {
  const { owner } = await viewer();
  if (!owner) redirect("/realty/desk");
  const { messageId } = await params;
  const store = new PeriskopeStore(join(process.cwd(), ".data", "realty", "periskope"));
  const post = findPostView(store, messageId, true);
  if (!post) notFound();

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
    ["Matches", `${post.matchCount} (${post.marketMatches} market, ${post.crmMatches} ours)`],
  ];

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-10">
      <p className="rt-eyebrow">Owners only</p>
      <p className="rt-muted mt-2">
        <Link href="/realty/posts" className="underline">
          All group posts
        </Link>
      </p>
      <h1 className="mt-2 text-3xl font-semibold">Group post</h1>
      <dl className="rt-card mt-6 grid gap-3 p-4">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt className="text-sm font-medium">{k}</dt>
            <dd className="mt-1 whitespace-pre-wrap">{v || "—"}</dd>
          </div>
        ))}
      </dl>
      <section className="rt-card mt-6 p-4">
        <h2 className="text-lg font-semibold">Original text</h2>
        <p className="mt-3 whitespace-pre-wrap">{post.originalText || "—"}</p>
      </section>
    </main>
  );
}
