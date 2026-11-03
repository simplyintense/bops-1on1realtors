# Morning access checklist (1on1 Realtors bot team)

What Miles (or Wendy) needs to grant so the draft can be switched on. Each item says what it unlocks
and where the value goes. **Never paste a password, key or token into chat, a PR, git or a sheet**: type
values straight into the host's secret store (Fly/Render dashboard) or the app's `.env.local`, or use the
secure box the bot provides.

## 1. 1on1 Realtors Google account (email + Drive + sign-in)

- [ ] A Google account owned by 1on1 Realtors for the bots (for example `bops@1on1realtors.com` if the
      domain is on Google Workspace, else a new Gmail). It owns the Drive folder and the OAuth client.
- [ ] A **Google Cloud project** in that account with the **Drive API** and **Gmail API** turned on and
      one OAuth client of type *Web application*:
  - redirect URIs: `https://bop.1on1realtors.com/api/gate/callback`,
    `https://bop-1on1realtors.fly.dev/api/gate/callback` (or the onrender.com name), and
    `https://developers.google.com/oauthplayground` (to mint the tools' refresh tokens).
  - consent screen: **Internal** if 1on1 is on Workspace (no Google review needed). If it's External in
    "Testing", refresh tokens expire after 7 days, so it would need publishing.
  - fills: `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` (login gate) and
    `ONEON1_GOOGLE_CLIENT_ID` / `ONEON1_GOOGLE_CLIENT_SECRET` (Drive and Gmail tools; can be the same client).

## 2. Drive folder for WhatsApp exports

- [ ] A folder in the 1on1 account's Drive, e.g. "WhatsApp exports", shared with whoever will drop the
      daily exports (the admin lead or agents). Fills `ONEON1_WA_DRIVE_FOLDER_ID` (the id in its URL).
- [ ] A refresh token for the 1on1 account with scope `drive.readonly`. Fills `ONEON1_DRIVE_REFRESH_TOKEN`.
- [ ] Decide who exports which groups each day (WhatsApp → group → ⋮ → More → Export chat → Without media).

## 3. Asana

- [ ] The Asana workspace and a project for the bots' proposed tasks (e.g. "1on1 Realtors: bot tasks").
      Fills `ONEON1_ASANA_PROJECT_ID`. Tonight's build only proposes Asana tasks; creating them needs an
      Asana token later.

## 4. CRM bot login and role (1on1realtors.com Supabase)

- [ ] On the 1on1 site's admin, invite a bot user (e.g. `bops@1on1realtors.com`) and give it the
      **admin** role, linked to no agent. Fills `ONEON1_CRM_BOT_EMAIL` / `ONEON1_CRM_BOT_PASSWORD`.
- [ ] The CRM's public (anon) key and URL. Fill `ONEON1_CRM_ANON_KEY` / `ONEON1_CRM_URL`.
      Never the service-role key.
- [ ] Decide on reading CRM clients: review `docs/1on1-crm-readonly.sql` (a read-only view for the bot
      only) and say whether to apply it. Super admin for the bot is not recommended.
- [ ] Which agent gets unassigned leads and tasks (the admin lead). Fills `ONEON1_DEFAULT_AGENT_ID`.
- [ ] Keep `ONEON1_CRM_WRITES` unset until Wendy and the admin lead have reviewed a few proposal runs.

## 5. OpenAI keys

- [ ] Two API keys in an OpenAI project for 1on1 (set a monthly spend limit on the project).
      Fill `OPENAI_API_KEY` (chat, calls) and `OPENAI_EXECUTOR_API_KEY` (the bots' computer runs).
- [ ] The rotated Orgo key is already saved for setup; it also goes in the host as `ORGO_API_KEY`.

## 6. Hosting account

- [ ] A **Fly.io** account (or Render) owned by 1on1 or Simply Intense, with a card on file. The app is one
      always-on 2 GB machine plus a 3 GB volume.
- [ ] Who may sign in: the list for `BOPS_ALLOWED_EMAILS` (e.g. Miles, Wendy, the admin lead, or
      `@1on1realtors.com` for everyone with a company address).
- [ ] A random 32+ character `BOPS_GATE_SECRET` (Render generates one; on Fly, generate it in the terminal).

## 7. Agents' consent for the inbox bot

- [ ] Each agent who wants the inbox sorter agrees to it (it reads their inbox; it never sends).
- [ ] Each one connects their Gmail once (scope `gmail.readonly`, plus `gmail.compose` only if they want
      drafts saved in Gmail). Fills `ONEON1_GMAIL_REFRESH_TOKEN_<SLUG>`.
- [ ] Their entry in `ONEON1_INBOX_AGENTS` (`slug:email:crmAgentId:Display Name`), then
      `ONEON1_INBOX_SORTER=1`.

## 8. DNS (AWS Bot)

- [ ] Once the host is up: ask AWS Bot to add `bop.1on1realtors.com` as in `docs/1on1-realtors.md`
      ("DNS"): one CNAME to the Fly or Render name, DNS only. Nothing else on the domain changes.

## Then

1. Merge the draft PR (on Miles's word), deploy, sign in at the fly.dev address.
2. AWS Bot points DNS; sign in at bop.1on1realtors.com.
3. First WhatsApp export run in proposals-only mode; review `proposals.md` with the admin lead.
