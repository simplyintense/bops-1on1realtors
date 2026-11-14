/**
 * Google Drive and Gmail over their REST APIs with an OAuth refresh token (from the 1on1 Realtors Google
 * account, or each agent's own for their inbox). No SDK. Read scopes, plus gmail.compose only if drafts
 * are turned on. Nothing here can send mail: there is no send call in this file.
 *
 * Settings: ONEON1_GOOGLE_CLIENT_ID, ONEON1_GOOGLE_CLIENT_SECRET, and a refresh token per account
 * (ONEON1_DRIVE_REFRESH_TOKEN for the WhatsApp folder; ONEON1_GMAIL_REFRESH_TOKEN_<AGENT> per inbox).
 */

export type GoogleCreds = { clientId: string; clientSecret: string; refreshToken: string };

export function googleCreds(refreshToken: string | undefined, env: Record<string, string | undefined> = process.env): GoogleCreds | null {
  const clientId = env.ONEON1_GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.ONEON1_GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret || !refreshToken?.trim()) return null;
  return { clientId, clientSecret, refreshToken: refreshToken.trim() };
}

export class Google {
  private c: GoogleCreds;
  private access: { token: string; until: number } | null = null;
  private fetcher: typeof fetch;

  constructor(c: GoogleCreds, fetcher: typeof fetch = fetch) {
    this.c = c;
    this.fetcher = fetcher;
  }

  private async token(): Promise<string> {
    if (this.access && this.access.until > Date.now() + 60_000) return this.access.token;
    const r = await this.fetcher("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.c.clientId, client_secret: this.c.clientSecret, refresh_token: this.c.refreshToken, grant_type: "refresh_token" }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(`Google sign-in failed (${r.status}); the account may need connecting again`);
    const j = (await r.json()) as { access_token?: string; expires_in?: number };
    if (!j.access_token) throw new Error("Google gave no access token");
    this.access = { token: j.access_token, until: Date.now() + (j.expires_in ?? 3600) * 1000 };
    return this.access.token;
  }

  async get(url: string): Promise<Response> {
    const r = await this.fetcher(url, { headers: { authorization: `Bearer ${await this.token()}` }, signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`Google refused ${new URL(url).pathname} (${r.status})`);
    return r;
  }

  /* ---- Drive ---- */

  /** The WhatsApp exports in a folder (.txt and .zip), newest first. */
  async driveExports(folderId: string): Promise<{ id: string; name: string; modifiedTime: string }[]> {
    if (!/^[\w-]{10,}$/.test(folderId)) throw new Error("ONEON1_WA_DRIVE_FOLDER_ID doesn't look like a Drive folder id");
    const q = `'${folderId}' in parents and trashed = false`;
    const files: { id: string; name: string; modifiedTime: string; mimeType: string }[] = [];
    let page = "";
    do {
      const u = new URL("https://www.googleapis.com/drive/v3/files");
      u.search = new URLSearchParams({
        q,
        fields: "nextPageToken,files(id,name,mimeType,modifiedTime)",
        orderBy: "modifiedTime desc",
        pageSize: "100",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
        ...(page ? { pageToken: page } : {}),
      }).toString();
      const j = (await (await this.get(u.toString())).json()) as { files?: typeof files; nextPageToken?: string };
      files.push(...(j.files ?? []));
      page = j.nextPageToken ?? "";
    } while (page);
    return files.filter((f) => /\.(txt|zip)$/i.test(f.name) || f.mimeType === "application/zip" || f.mimeType === "text/plain");
  }

  async driveDownload(id: string): Promise<Buffer> {
    const r = await this.get(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`);
    return Buffer.from(await r.arrayBuffer());
  }

  /* ---- Gmail ---- */

  async gmailList(query: string, max = 50): Promise<string[]> {
    const u = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    u.search = new URLSearchParams({ q: query, maxResults: String(max) }).toString();
    const j = (await (await this.get(u.toString())).json()) as { messages?: { id: string }[] };
    return (j.messages ?? []).map((m) => m.id);
  }

  async gmailMessage(id: string): Promise<GmailMessage> {
    return (await (await this.get(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`)).json()) as GmailMessage;
  }

  /**
   * A draft in the agent's own mailbox, for them to review and send themselves. Only with
   * ONEON1_INBOX_GMAIL_DRAFTS=1 (the caller checks) and the gmail.compose scope. Never sent from here.
   */
  async gmailCreateDraft(raw: string, threadId: string | null): Promise<string> {
    const r = await this.fetcher("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
      method: "POST",
      headers: { authorization: `Bearer ${await this.token()}`, "content-type": "application/json" },
      body: JSON.stringify({ message: { raw, ...(threadId ? { threadId } : {}) } }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`Gmail refused the draft (${r.status})`);
    return ((await r.json()) as { id?: string }).id ?? "";
  }
}

export type GmailPart = { mimeType?: string; body?: { data?: string }; parts?: GmailPart[]; headers?: { name: string; value: string }[] };
export type GmailMessage = { id: string; threadId: string; internalDate?: string; labelIds?: string[]; payload?: GmailPart; snippet?: string };

const b64 = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

/** The plain text of a Gmail message (text/plain, else text/html with tags stripped), and its headers. */
export function gmailText(m: GmailMessage): { from: string; to: string; subject: string; date: string; messageId: string; body: string } {
  const h = (n: string) => m.payload?.headers?.find((x) => x.name.toLowerCase() === n)?.value ?? "";
  const find = (p: GmailPart | undefined, type: string): string | null => {
    if (!p) return null;
    if (p.mimeType === type && p.body?.data) return b64(p.body.data);
    for (const c of p.parts ?? []) {
      const t = find(c, type);
      if (t) return t;
    }
    return null;
  };
  const plain = find(m.payload, "text/plain");
  const html = plain ? null : find(m.payload, "text/html");
  const body = plain ?? (html ? html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, "").replace(/<br\s*\/?>|<\/p>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&") : m.snippet ?? "");
  const date = m.internalDate ? new Date(Number(m.internalDate)).toISOString() : h("date");
  return { from: h("from"), to: h("to"), subject: h("subject"), date, messageId: h("message-id"), body: body.replace(/\n{3,}/g, "\n\n").trim() };
}

/** An RFC 2822 reply, base64url, for gmailCreateDraft. */
export function rawReply(o: { to: string; subject: string; body: string; inReplyTo: string | null }): string {
  // Headers come from mail someone else wrote: no line breaks may get through into new headers.
  const one = (s: string) => s.replace(/[\r\n]+/g, " ").trim();
  o = { ...o, to: one(o.to), subject: one(o.subject), inReplyTo: o.inReplyTo ? one(o.inReplyTo) : null };
  const subject = /^re:/i.test(o.subject) ? o.subject : `Re: ${o.subject}`;
  const lines = [`To: ${o.to}`, `Subject: ${subject}`, "Content-Type: text/plain; charset=UTF-8", ...(o.inReplyTo ? [`In-Reply-To: ${o.inReplyTo}`, `References: ${o.inReplyTo}`] : []), "", o.body];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
