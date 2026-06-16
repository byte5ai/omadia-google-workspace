/**
 * @omadia/integration-google-workspace — plugin entry point.
 *
 * `kind: integration`. On activate() it:
 *   1. reads the service-account credentials (config + vault secret),
 *   2. constructs a {@link GoogleServiceAccountAuth} (domain-wide delegation,
 *      JWT-bearer) bound to the host's allow-listed `ctx.http` egress,
 *   3. constructs a {@link GoogleWorkspaceClient} over that auth,
 *   4. publishes two services:
 *        - `googleworkspace.client` → GoogleWorkspaceClient
 *        - `googleworkspace.cache`  → ResponseCache (short-TTL read cache)
 *   5. contributes read-only tools for every enabled surface, and — only when
 *      the operator opts in via `enable_writes` — the calendar/gmail write tools.
 *
 * Consumers reach the services via
 *   ctx.services.get<GoogleWorkspaceClient>('googleworkspace.client')
 *   ctx.services.get<ResponseCache>('googleworkspace.cache')
 *
 * Auth note: v1 is service-account domain-wide delegation only — every call
 * impersonates a Workspace user (the `user` tool arg, or the configured
 * default). Per-user 3-legged OAuth is a planned phase 2 behind the same
 * `getToken(subject, scopes)` shape.
 */

import type { PluginContext } from '@omadia/plugin-api';

import { GoogleServiceAccountAuth } from './googleAuth.js';
import { GoogleWorkspaceClient } from './googleClient.js';
import { ResponseCache } from './responseCache.js';
import { assembleScopes, parseScopeOverride, parseSurfaces } from './scopes.js';
import type { ToolDeps } from './toolDeps.js';
import {
  calendarListEventsSpec,
  CALENDAR_LIST_EVENTS_PROMPT_DOC,
  createCalendarListEventsHandler,
  calendarFreeBusySpec,
  CALENDAR_FREEBUSY_PROMPT_DOC,
  createCalendarFreeBusyHandler,
  calendarCreateEventSpec,
  CALENDAR_CREATE_EVENT_PROMPT_DOC,
  createCalendarCreateEventHandler,
  calendarUpdateEventSpec,
  CALENDAR_UPDATE_EVENT_PROMPT_DOC,
  createCalendarUpdateEventHandler,
} from './calendarTools.js';
import {
  gmailSearchSpec,
  GMAIL_SEARCH_PROMPT_DOC,
  createGmailSearchHandler,
  gmailGetMessageSpec,
  GMAIL_GET_MESSAGE_PROMPT_DOC,
  createGmailGetMessageHandler,
  gmailSendSpec,
  GMAIL_SEND_PROMPT_DOC,
  createGmailSendHandler,
  gmailDraftSpec,
  GMAIL_DRAFT_PROMPT_DOC,
  createGmailDraftHandler,
} from './gmailTools.js';
import {
  driveSearchSpec,
  DRIVE_SEARCH_PROMPT_DOC,
  createDriveSearchHandler,
  driveGetFileSpec,
  DRIVE_GET_FILE_PROMPT_DOC,
  createDriveGetFileHandler,
  docReadSpec,
  DOC_READ_PROMPT_DOC,
  createDocReadHandler,
  sheetReadSpec,
  SHEET_READ_PROMPT_DOC,
  createSheetReadHandler,
} from './driveTools.js';
import {
  directoryUsersSpec,
  DIRECTORY_USERS_PROMPT_DOC,
  createDirectoryUsersHandler,
  peopleSearchSpec,
  PEOPLE_SEARCH_PROMPT_DOC,
  createPeopleSearchHandler,
} from './directoryTools.js';

export const GOOGLEWORKSPACE_CLIENT_SERVICE_NAME = 'googleworkspace.client';
export const GOOGLEWORKSPACE_CACHE_SERVICE_NAME = 'googleworkspace.cache';

export interface GoogleWorkspacePluginHandle {
  close(): Promise<void>;
}

function parseBoolean(raw: string | undefined): boolean {
  return String(raw ?? '').trim().toLowerCase() === 'true';
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function activate(ctx: PluginContext): Promise<GoogleWorkspacePluginHandle> {
  ctx.log('activating google-workspace integration');

  // Outbound HTTP is declared in the manifest (network.outbound); without it
  // ctx.http is undefined and we cannot reach Google's token/API hosts at all.
  if (!ctx.http) {
    throw new Error(
      '@omadia/integration-google-workspace: ctx.http is unavailable — the manifest must declare permissions.network.outbound (oauth2.googleapis.com + the API hosts)',
    );
  }
  const httpFetch = ctx.http.fetch.bind(ctx.http) as typeof fetch;

  const clientEmail = ctx.config.require<string>('gw_sa_client_email');
  const privateKey = await ctx.secrets.require('gw_sa_private_key');
  const defaultSubject = ctx.config.require<string>('gw_subject_default');
  const adminSubject = ctx.config.get<string>('gw_admin_subject') || defaultSubject;
  const tokenUrl = ctx.config.get<string>('gw_token_url') || undefined;
  const maxBytes = parsePositiveInt(ctx.config.get<string>('gw_max_bytes'), 1024 * 1024);
  const cacheTtlSeconds = parsePositiveInt(ctx.config.get<string>('gw_cache_ttl_seconds'), 60);
  const enableWrites = parseBoolean(ctx.config.get<string>('enable_writes'));

  const surfaces = parseSurfaces(ctx.config.get<string>('gw_surfaces'));
  const scopes =
    parseScopeOverride(ctx.config.get<string>('gw_delegated_scopes')) ??
    assembleScopes(surfaces, enableWrites);

  const auth = new GoogleServiceAccountAuth({
    clientEmail,
    privateKey,
    tokenUrl,
    fetch: httpFetch,
    log: (msg) => ctx.log(msg),
  });
  const client = new GoogleWorkspaceClient({
    auth,
    scopes,
    maxBytes,
    fetch: httpFetch,
    log: (msg) => ctx.log(msg),
  });
  const cache = new ResponseCache({ ttlMs: cacheTtlSeconds * 1000 });

  const deps: ToolDeps = { client, cache, defaultSubject, adminSubject };

  const disposers: Array<() => void> = [];
  disposers.push(
    ctx.services.provide<GoogleWorkspaceClient>(GOOGLEWORKSPACE_CLIENT_SERVICE_NAME, client),
  );
  disposers.push(ctx.services.provide<ResponseCache>(GOOGLEWORKSPACE_CACHE_SERVICE_NAME, cache));

  const reg = (
    spec: Parameters<typeof ctx.tools.register>[0],
    handler: Parameters<typeof ctx.tools.register>[1],
    promptDoc: string,
  ): void => {
    disposers.push(ctx.tools.register(spec, handler, { promptDoc }));
  };

  const enabled = new Set(surfaces);
  const contributed: string[] = [];

  // --- Calendar -----------------------------------------------------------
  if (enabled.has('calendar')) {
    reg(calendarListEventsSpec, createCalendarListEventsHandler(deps), CALENDAR_LIST_EVENTS_PROMPT_DOC);
    reg(calendarFreeBusySpec, createCalendarFreeBusyHandler(deps), CALENDAR_FREEBUSY_PROMPT_DOC);
    contributed.push('gw_calendar_list_events', 'gw_calendar_freebusy');
    if (enableWrites) {
      reg(calendarCreateEventSpec, createCalendarCreateEventHandler(deps), CALENDAR_CREATE_EVENT_PROMPT_DOC);
      reg(calendarUpdateEventSpec, createCalendarUpdateEventHandler(deps), CALENDAR_UPDATE_EVENT_PROMPT_DOC);
      contributed.push('gw_calendar_create_event', 'gw_calendar_update_event');
    }
  }

  // --- Gmail --------------------------------------------------------------
  if (enabled.has('gmail')) {
    reg(gmailSearchSpec, createGmailSearchHandler(deps), GMAIL_SEARCH_PROMPT_DOC);
    reg(gmailGetMessageSpec, createGmailGetMessageHandler(deps), GMAIL_GET_MESSAGE_PROMPT_DOC);
    contributed.push('gw_gmail_search', 'gw_gmail_get_message');
    if (enableWrites) {
      reg(gmailSendSpec, createGmailSendHandler(deps), GMAIL_SEND_PROMPT_DOC);
      reg(gmailDraftSpec, createGmailDraftHandler(deps), GMAIL_DRAFT_PROMPT_DOC);
      contributed.push('gw_gmail_send', 'gw_gmail_draft');
    }
  }

  // --- Drive / Docs / Sheets ---------------------------------------------
  if (enabled.has('drive')) {
    reg(driveSearchSpec, createDriveSearchHandler(deps), DRIVE_SEARCH_PROMPT_DOC);
    reg(driveGetFileSpec, createDriveGetFileHandler(deps), DRIVE_GET_FILE_PROMPT_DOC);
    reg(docReadSpec, createDocReadHandler(deps), DOC_READ_PROMPT_DOC);
    reg(sheetReadSpec, createSheetReadHandler(deps), SHEET_READ_PROMPT_DOC);
    contributed.push('gw_drive_search', 'gw_drive_get_file', 'gw_doc_read', 'gw_sheet_read');
  }

  // --- Directory / People -------------------------------------------------
  if (enabled.has('directory')) {
    reg(directoryUsersSpec, createDirectoryUsersHandler(deps), DIRECTORY_USERS_PROMPT_DOC);
    contributed.push('gw_directory_users');
  }
  if (enabled.has('people')) {
    reg(peopleSearchSpec, createPeopleSearchHandler(deps), PEOPLE_SEARCH_PROMPT_DOC);
    contributed.push('gw_people_search');
  }

  ctx.log(
    `[googleworkspace] ready (sa=${clientEmail}, defaultSubject=${defaultSubject}, surfaces=[${surfaces.join(
      ',',
    )}], writes=${String(enableWrites)}) — services '${GOOGLEWORKSPACE_CLIENT_SERVICE_NAME}' + '${GOOGLEWORKSPACE_CACHE_SERVICE_NAME}' published, tools: ${contributed.join(', ')}`,
  );
  ctx.log(`[googleworkspace] delegated scopes (authorise these in the Admin console): ${scopes.join(' ')}`);

  // Non-blocking connectivity probe — keeps activate() inside its budget while
  // surfacing a clear log line if the credentials / delegation are wrong.
  // Skipped during the kernel's schema smoke probe (no live call needed there).
  if (!ctx.smokeMode) {
    void client
      .probe(defaultSubject)
      .then(() => ctx.log(`[googleworkspace] connected (impersonating ${defaultSubject})`))
      .catch((err: unknown) =>
        ctx.log(
          `[googleworkspace] WARNING: initial token probe failed — ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );
  }

  return {
    async close(): Promise<void> {
      ctx.log('deactivating google-workspace integration');
      for (const dispose of disposers.reverse()) dispose();
      cache.clear();
    },
  };
}
