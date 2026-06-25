<div align="center">

# @omadia/integration-google-workspace

### Google Workspace for your omadia agents: Calendar, Gmail, Drive and the directory. Allow-listed, cached, read-mostly.

A **Google Workspace** integration for [omadia](https://github.com/byte5ai/omadia).
It publishes a shared, allow-listed Workspace client to the service registry and
contributes tools so agents can answer questions about (and act on) calendars,
mail, files and people across your domain.

[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/built%20with-TypeScript-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Read-mostly](https://img.shields.io/badge/writes-opt--in%20only-brightgreen.svg)](#enabling-writes)

[**omadia**](https://github.com/byte5ai/omadia) · [**Website**](https://omadia.ai) · [**Setup**](#setup-one-time) · [**Tools**](#the-tools) · [**Build**](#build--install)

</div>

---

Auth is a **Google Cloud service account with domain-wide delegation**. It is a
server-to-server JWT-bearer flow with no interactive sign-in. Every request
impersonates a Workspace user, either the `user` passed to a tool or a
configured default.

## How it works

| Concern | Implementation |
|---|---|
| Kind | `integration`. Publishes services and contributes tools. It is not a channel. |
| Transport | HTTPS REST, only through the host-provided `ctx.http` (manifest `network.outbound` allow-list plus a per-plugin rate limit). |
| Auth | A signed RS256 JWT (`sub` = impersonated user) is exchanged for an access token at `oauth2.googleapis.com`, cached per `(subject, scopeSet)` until about a minute before expiry, refreshed on a 401. The JWT is signed with `node:crypto`, so no extra SDK sits between the plugin and the kernel boundary. |
| Services | `googleworkspace.client` resolves to `GoogleWorkspaceClient`, `googleworkspace.cache` to a short-TTL read cache. Read them via `ctx.services.get(...)`. |
| Surfaces | Calendar, Gmail, Drive/Docs/Sheets, Directory/People. Each one is toggled with `gw_surfaces`. |
| Safety | Responses are size-capped (`gw_max_bytes`). Deletes are never exposed. Reads are cached with a short TTL keyed by the impersonated user. Writes clear the cache and are opt-in. Transient 429/5xx responses are retried with backoff. |
| Lifecycle | `export async function activate(ctx): Promise<GoogleWorkspacePluginHandle>`. |

Source map:

```
src/
├── index.ts           # public surface: re-exports activate + GoogleWorkspaceClient (for manifest service_types)
├── plugin.ts          # activate(ctx): builds auth + client, publishes services, registers tools by surface
├── googleAuth.ts      # service-account JWT-bearer (RS256) + per-(subject,scope) token cache
├── googleClient.ts    # per-API fetchers (Calendar/Gmail/Drive/Docs/Sheets/Directory/People) over ctx.http, with retry/backoff
├── responseCache.ts   # short-TTL in-process read cache
├── scopes.ts          # scope catalogue + surface to scope assembly
├── errors.ts          # GoogleAuthError / GoogleApiError / formatToolError
├── toolDeps.ts        # shared deps + subject (impersonation) resolution
├── calendarTools.ts   # gw_calendar_list_events, gw_calendar_freebusy (+ create/update events)
├── gmailTools.ts      # gw_gmail_search, gw_gmail_get_message (+ send/draft)
├── driveTools.ts      # gw_drive_search, gw_drive_get_file, gw_doc_read, gw_sheet_read (+ gw_sheet_write, gw_drive_create)
└── directoryTools.ts  # gw_directory_users, gw_people_search
```

## The tools

Read tools are always on for the enabled surfaces. Pass `user` (an email) to act
for a specific person, or omit it to use the default user.

| Tool | Surface | What it does |
|---|---|---|
| `gw_calendar_list_events` | Calendar | List or search events in an RFC3339 time window. |
| `gw_calendar_freebusy` | Calendar | Free/busy windows across calendars, for "when is X free?". |
| `gw_gmail_search` | Gmail | Search a mailbox with Gmail query syntax. |
| `gw_gmail_get_message` | Gmail | One message as headers, snippet and decoded plain text. |
| `gw_drive_search` | Drive | Find files and folders with Drive query syntax. |
| `gw_drive_get_file` | Drive | File metadata by id. |
| `gw_doc_read` | Docs | A Google Doc's text content, flattened. |
| `gw_sheet_read` | Sheets | Values from a Sheets range (A1 notation). |
| `gw_sheet_list_tabs` | Sheets | List a spreadsheet's tabs (title, sheetId, index). |
| `gw_directory_users` | Directory | Search Workspace users to resolve a name to an email. |
| `gw_people_search` | People | Search a user's personal contacts. |

List tools return a `nextPageToken`; pass it back as `pageToken` to fetch the
next page.

### Enabling writes

With **Enable writes** (`enable_writes`) on, four mutating tools are also
registered, and the matching write scopes must be authorised:

| Tool | What it does |
|---|---|
| `gw_calendar_create_event` | Create a calendar event. |
| `gw_calendar_update_event` | Partial-update an event. |
| `gw_gmail_send` | Send a plain-text email as the user. |
| `gw_gmail_draft` | Create a draft without sending. |
| `gw_sheet_write` | Write a 2D value array into a Sheets range (overwrite or append). Formulas work via `valueInputOption: USER_ENTERED`. |
| `gw_drive_create` | Create a Drive folder or file (optional parent folder and text content). |
| `gw_sheet_add_tab` | Add a new empty tab to a spreadsheet. |
| `gw_sheet_duplicate_tab` | Duplicate a tab with all formatting + formulas, then overwrite values with `gw_sheet_write`. |
| `gw_sheet_batch_update` | Raw Sheets `batchUpdate`: full formatting (number formats, colors, borders), conditional formatting, column widths, merges, formulas. |

Deletes are never exposed to the assistant.

## Setup (one-time)

The full walk-through lives in the in-product setup guide (also in
[`manifest.yaml`](manifest.yaml)). The short version:

1. **Google Cloud Console**: create a project, enable the APIs you need
   (Calendar, Gmail, Drive, Docs, Sheets, Admin SDK, People), create a
   **service account**, and download a **JSON key**.
2. **Workspace Admin console** under **Security → API controls → Domain-wide
   delegation**: authorise the service account's **Client ID** for the exact
   scopes the plugin logs on activation.
3. Fill in the fields: service-account email, private key, default user,
   optional admin user, surfaces, and the writes toggle.

## Build & install

This plugin has no non-host runtime dependencies. It reaches Google only through
`ctx.http` and signs its JWT with `node:crypto`.

```bash
npm install              # dev tooling only (tsc, esbuild, @types/node)
npm run typecheck        # tsc --noEmit (uses the @omadia type sources from an adjacent omadia checkout)
npm test                 # node --test over esbuild-transpiled tests/*.test.ts
npm run build            # esbuild bundle to dist/index.js, tsc declaration emit, then a ZIP in out/
```

`npm run typecheck` resolves `@omadia/plugin-api` from
`../odoo-bot/middleware/packages/plugin-api/dist` (see `tsconfig.json`), so build
that package once in the omadia checkout first.

Install the built ZIP into omadia (admin → install plugin, or via the registry).
To publish it to a Hub registry:

```bash
HUB_PUBLISH_TOKEN=… npm run publish:hub out/omadia-integration-google-workspace-0.1.0.zip
```

## Roadmap

- **v1 (this release):** service-account domain-wide delegation, read-mostly
  across Calendar, Gmail, Drive/Docs/Sheets, Directory/People, with opt-in
  calendar and gmail writes.
- **v2:** per-user OAuth 2.0, so each user connects their own account, behind the
  same `getToken(subject, scopes)` shape. This needs host support for a per-user
  token store and an OAuth callback route.

## License

MIT, byte5 GmbH.
