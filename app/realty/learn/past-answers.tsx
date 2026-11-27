"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { TaughtRow } from "@/realty/node/search-store.ts";

export type PastRow = TaughtRow & { when: string; means: string };

const LISTING_TYPES = ["", "sale", "rent", "shortlet"] as const;

/**
 * The past answers on this page of the list, with a filter box over these rows (it filters the page, not the whole list). Teachers
 * can edit or delete an answer; the routes check it and refuse seeded rows. Staff see the table only.
 */
export function PastAnswers({ rows, teacher }: { rows: PastRow[]; teacher: boolean }) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const k = q.trim().toLowerCase();
    if (!k) return rows;
    return rows.filter((r) => [r.term, r.area, r.development, r.type, r.listingType, r.note, r.taughtBy, r.means].some((v) => v?.toLowerCase().includes(k)));
  }, [rows, q]);
  const cols = teacher ? 6 : 5;

  return (
    <>
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter this page" aria-label="Filter past answers" className="rt-field mt-3 w-full sm:w-72" />
      <div className="rt-table-wrap mt-3">
        <table className="w-full text-sm">
          <thead className="rt-thead text-left">
            <tr>
              <th className="px-2 py-2">When (AST)</th>
              <th className="px-2 py-2">By</th>
              <th className="px-2 py-2">Term</th>
              <th className="px-2 py-2">Means</th>
              <th className="px-2 py-2">Answer</th>
              {teacher ? <th className="px-2 py-2"><span className="rt-sr-only">Actions</span></th> : null}
            </tr>
          </thead>
          <tbody>
            {shown.map((t) => (
              <PastRowView key={t.id} row={t} teacher={teacher} cols={cols} />
            ))}
            {shown.length === 0 ? (
              <tr>
                <td colSpan={cols} className="rt-muted px-2 py-3">
                  No answers match.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </>
  );
}

function PastRowView({ row, teacher, cols }: { row: PastRow; teacher: boolean; cols: number }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [state, setState] = useState<{ status: "idle" | "saving" | "error"; message?: string }>({ status: "idle" });

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (name: string) => String(f.get(name) ?? "").trim();
    setState({ status: "saving" });
    try {
      const r = await fetch("/api/realty/learn/taught", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: row.id, answer: text("answer"), term: text("term"), area: text("area"), development: text("development"), type: text("type"), listingType: text("listingType") }),
      });
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) return setState({ status: "error", message: body.error ?? `HTTP ${r.status}` });
      setEditing(false);
      setState({ status: "idle" });
      router.refresh();
    } catch {
      setState({ status: "error", message: "Didn't save. Try again." });
    }
  }

  async function remove() {
    if (!window.confirm("Delete this answer? Posts it helped are read again without it.")) return;
    setState({ status: "saving" });
    try {
      const r = await fetch("/api/realty/learn/taught", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: row.id }) });
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) return setState({ status: "error", message: body.error ?? `HTTP ${r.status}` });
      router.refresh();
    } catch {
      setState({ status: "error", message: "Didn't delete. Try again." });
    }
  }

  if (editing) {
    return (
      <tr className="rt-row align-top">
        <td colSpan={cols} className="px-2 py-2">
          <form onSubmit={save} className="grid gap-2 sm:grid-cols-2">
            <input name="answer" required maxLength={300} defaultValue={row.note ?? ""} className="rt-field sm:col-span-2" aria-label="Answer" />
            <input name="term" maxLength={80} defaultValue={row.term ?? ""} placeholder="Term" className="rt-field" aria-label="Term" />
            <input name="area" maxLength={80} defaultValue={row.area ?? ""} placeholder="Area" className="rt-field" aria-label="Area" />
            <input name="development" maxLength={80} defaultValue={row.development ?? ""} placeholder="Development" className="rt-field" aria-label="Development" />
            <input name="type" maxLength={80} defaultValue={row.type ?? ""} placeholder="Type" className="rt-field" aria-label="Type" />
            <select name="listingType" defaultValue={row.listingType ?? ""} className="rt-field" aria-label="Sale / Rent">
              {LISTING_TYPES.map((v) => (
                <option key={v} value={v}>
                  {v === "" ? "Sale / Rent" : v === "shortlet" ? "Short let" : v[0].toUpperCase() + v.slice(1)}
                </option>
              ))}
            </select>
            <div className="flex flex-wrap items-center gap-3">
              <button type="submit" className="rt-btn" disabled={state.status === "saving"}>
                {state.status === "saving" ? "Saving…" : "Save"}
              </button>
              <button type="button" className="rt-btn" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
            {state.status === "error" ? <p className="rt-notice rt-notice-error sm:col-span-2">{state.message}</p> : null}
          </form>
        </td>
      </tr>
    );
  }

  return (
    <tr className="rt-row align-top">
      <td className="px-2 py-2 whitespace-nowrap">{row.when}</td>
      <td className="px-2 py-2">{row.taughtBy ?? ""}</td>
      <td className="px-2 py-2">{row.term ?? ""}</td>
      <td className="px-2 py-2">{row.means}</td>
      <td className="px-2 py-2">{row.note ?? ""}</td>
      {teacher ? (
        <td className="px-2 py-2 whitespace-nowrap">
          <button type="button" className="rt-link text-xs" onClick={() => setEditing(true)} disabled={state.status === "saving"}>
            Edit
          </button>{" "}
          <button type="button" className="rt-link text-xs" onClick={remove} disabled={state.status === "saving"}>
            Delete
          </button>
          {state.status === "error" && !editing ? <span className="rt-notice rt-notice-error ml-2 text-xs">{state.message}</span> : null}
        </td>
      ) : null}
    </tr>
  );
}
