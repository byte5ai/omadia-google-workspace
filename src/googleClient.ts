/**
 * GoogleWorkspaceClient — a thin, read-mostly wrapper over the Google Workspace
 * REST APIs (Calendar, Gmail, Drive, Docs, Sheets, Admin Directory, People).
 *
 * Auth is service-account **domain-wide delegation**: every call impersonates a
 * `subject` (a Workspace user's email) via {@link GoogleServiceAccountAuth}.
 * All egress goes through the injected `fetch` — in the plugin this is
 * `ctx.http.fetch`, allow-listed + rate-limited by the host. The client never
 * touches global `fetch`, so it stays inside the kernel's auditable boundary.
 *
 * Responses are size-capped (`maxBytes`) before `JSON.parse` so a pathological
 * unbounded list can't blow up the host's memory. Each public method names the
 * surface it talks to; the private `request()` resolves the correct API host.
 */

import { GoogleApiError } from './errors.js';
import type { GoogleServiceAccountAuth } from './googleAuth.js';

export type GoogleApi =
  | 'calendar'
  | 'gmail'
  | 'drive'
  | 'docs'
  | 'sheets'
  | 'directory'
  | 'people';

/** Base URL per API (host + version prefix). Hosts are manifest-allow-listed. */
const API_BASE: Record<GoogleApi, string> = {
  calendar: 'https://www.googleapis.com/calendar/v3',
  gmail: 'https://gmail.googleapis.com/gmail/v1',
  drive: 'https://www.googleapis.com/drive/v3',
  docs: 'https://docs.googleapis.com/v1',
  sheets: 'https://sheets.googleapis.com/v4',
  directory: 'https://admin.googleapis.com/admin/directory/v1',
  people: 'https://people.googleapis.com/v1',
};

const DEFAULT_MAX_BYTES = 1024 * 1024; // 1 MiB
const DEFAULT_RETRY_BASE_MS = 500;
const DEFAULT_MAX_RETRIES = 3;
/** Transient statuses worth retrying with exponential backoff. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** Google JSON error envelope (REST): `{ error: { code, message, status, errors } }`. */
interface GoogleErrorEnvelope {
  readonly error?: {
    readonly code?: number;
    readonly message?: string;
    readonly status?: string;
    readonly errors?: ReadonlyArray<{ readonly reason?: string; readonly message?: string }>;
  };
}

type QueryValue = string | number | boolean | readonly string[] | undefined;

export interface GoogleWorkspaceClientOptions {
  readonly auth: GoogleServiceAccountAuth;
  /** The union scope set the access token is requested with. */
  readonly scopes: readonly string[];
  /** Hard cap on a single response body in bytes. Defaults to 1 MiB. */
  readonly maxBytes?: number;
  /** Base delay for exponential backoff on transient errors (ms). Default 500. */
  readonly retryBaseMs?: number;
  /** Max retries on transient (429/5xx) errors. Default 3. */
  readonly maxRetries?: number;
  /** Injected fetch (production: `ctx.http.fetch`). */
  readonly fetch: typeof fetch;
  /** Optional structured logger. */
  readonly log?: (message: string) => void;
}

export interface RequestOptions {
  /** Workspace user to impersonate (DWD `sub`). */
  readonly subject: string;
  readonly query?: Record<string, QueryValue>;
  readonly body?: unknown;
}

export class GoogleWorkspaceClient {
  private readonly auth: GoogleServiceAccountAuth;
  private readonly scopes: readonly string[];
  private readonly maxBytes: number;
  private readonly retryBaseMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (message: string) => void;
  /** Subjects whose People contacts cache has been warmed this process. */
  private readonly warmedContacts = new Set<string>();

  constructor(opts: GoogleWorkspaceClientOptions) {
    this.auth = opts.auth;
    this.scopes = opts.scopes;
    this.maxBytes = opts.maxBytes && opts.maxBytes > 0 ? opts.maxBytes : DEFAULT_MAX_BYTES;
    this.retryBaseMs =
      typeof opts.retryBaseMs === 'number' && opts.retryBaseMs >= 0
        ? opts.retryBaseMs
        : DEFAULT_RETRY_BASE_MS;
    this.maxRetries =
      typeof opts.maxRetries === 'number' && opts.maxRetries >= 0
        ? opts.maxRetries
        : DEFAULT_MAX_RETRIES;
    this.fetchImpl = opts.fetch;
    this.log = opts.log ?? (() => {});
  }

  // -------------------------------------------------------------------------
  // Core request — one retry on 401 (expired/rotated token).
  // -------------------------------------------------------------------------
  private async request<T = Record<string, unknown>>(
    api: GoogleApi,
    method: string,
    path: string,
    opts: RequestOptions,
  ): Promise<T> {
    const url = `${API_BASE[api]}${path}${buildQueryString(opts.query)}`;
    const send = async (): Promise<Response> => {
      const token = await this.auth.getToken(opts.subject, this.scopes);
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      };
      let serialized: string | undefined;
      if (opts.body !== undefined) {
        headers['Content-Type'] = 'application/json; charset=utf-8';
        serialized = JSON.stringify(opts.body);
      }
      return this.fetchImpl(url, { method, headers, body: serialized });
    };

    let tokenRetried = false;
    for (let attempt = 0; ; attempt++) {
      const res = await send();

      // Expired/rotated token — re-mint once, not counted against backoff.
      if (res.status === 401 && !tokenRetried) {
        this.log('[googleworkspace] 401 — refreshing token and retrying once');
        tokenRetried = true;
        this.auth.invalidate(opts.subject, this.scopes);
        continue;
      }

      // Transient errors — exponential backoff up to maxRetries.
      if (RETRYABLE_STATUS.has(res.status) && attempt < this.maxRetries) {
        const delay = this.backoffDelay(attempt, res);
        this.log(
          `[googleworkspace] HTTP ${res.status} on ${api} — retry ${attempt + 1}/${this.maxRetries} in ${delay}ms`,
        );
        await sleep(delay);
        continue;
      }

      if (!res.ok) throw await this.toApiError(res);
      const text = await this.readCapped(res);
      return (text ? JSON.parse(text) : {}) as T;
    }
  }

  /**
   * Backoff delay for retry `attempt` (0-based). Honours a `Retry-After`
   * header (seconds) when the server sends one, otherwise exponential
   * (`base * 2^attempt`) with a little jitter.
   */
  private backoffDelay(attempt: number, res: Response): number {
    const retryAfter = Number(res.headers.get('retry-after') ?? '');
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      return Math.min(retryAfter * 1000, 30_000);
    }
    const base = this.retryBaseMs * 2 ** attempt;
    const jitter = Math.floor(Math.random() * Math.min(this.retryBaseMs, 250));
    return Math.min(base + jitter, 30_000);
  }

  /** Read a response body, refusing payloads larger than `maxBytes`. */
  private async readCapped(res: Response): Promise<string> {
    const declared = Number(res.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > this.maxBytes) {
      throw new GoogleApiError(
        res.status,
        'ResponseTooLarge',
        `response of ${declared} bytes exceeds maxBytes=${this.maxBytes}`,
      );
    }
    const text = await res.text();
    if (text.length > this.maxBytes) {
      throw new GoogleApiError(
        res.status,
        'ResponseTooLarge',
        `response of ${text.length} bytes exceeds maxBytes=${this.maxBytes}`,
      );
    }
    return text;
  }

  /** Parse a non-2xx body into a {@link GoogleApiError}. */
  private async toApiError(res: Response): Promise<GoogleApiError> {
    let raw = '';
    try {
      raw = await this.readCapped(res);
    } catch (err) {
      if (err instanceof GoogleApiError) return err;
    }
    let reason: string | undefined;
    let message = raw || res.statusText;
    try {
      const env = JSON.parse(raw) as GoogleErrorEnvelope;
      if (env.error) {
        reason = env.error.status ?? env.error.errors?.[0]?.reason;
        message = env.error.message ?? message;
      }
    } catch {
      /* non-JSON error body — keep raw */
    }
    return new GoogleApiError(res.status, reason, message);
  }

  /** Acquire a token for `subject` to verify connectivity + delegation. */
  async probe(subject: string): Promise<void> {
    await this.auth.getToken(subject, this.scopes);
  }

  // =========================================================================
  // Calendar API v3
  // =========================================================================

  /** List events on a calendar (default `primary`). */
  async listEvents(
    subject: string,
    p: {
      calendarId?: string;
      timeMin?: string;
      timeMax?: string;
      q?: string;
      maxResults?: number;
      singleEvents?: boolean;
      orderBy?: string;
      pageToken?: string;
    },
  ): Promise<Record<string, unknown>> {
    const calendarId = p.calendarId || 'primary';
    return this.request('calendar', 'GET', `/calendars/${encodeURIComponent(calendarId)}/events`, {
      subject,
      query: {
        timeMin: p.timeMin,
        timeMax: p.timeMax,
        q: p.q,
        maxResults: p.maxResults,
        singleEvents: p.singleEvents ?? true,
        orderBy: p.orderBy ?? (p.singleEvents === false ? undefined : 'startTime'),
        pageToken: p.pageToken,
      },
    });
  }

  /** Query free/busy windows across one or more calendars. */
  async freeBusy(
    subject: string,
    p: { timeMin: string; timeMax: string; calendarIds: readonly string[] },
  ): Promise<Record<string, unknown>> {
    return this.request('calendar', 'POST', '/freeBusy', {
      subject,
      body: {
        timeMin: p.timeMin,
        timeMax: p.timeMax,
        items: p.calendarIds.map((id) => ({ id })),
      },
    });
  }

  /** Create a calendar event. */
  async createEvent(
    subject: string,
    calendarId: string,
    event: Record<string, unknown>,
    p: { sendUpdates?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.request('calendar', 'POST', `/calendars/${encodeURIComponent(calendarId)}/events`, {
      subject,
      query: { sendUpdates: p.sendUpdates },
      body: event,
    });
  }

  /** Patch (partial update) an existing event. */
  async patchEvent(
    subject: string,
    calendarId: string,
    eventId: string,
    patch: Record<string, unknown>,
    p: { sendUpdates?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.request(
      'calendar',
      'PATCH',
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      { subject, query: { sendUpdates: p.sendUpdates }, body: patch },
    );
  }

  // =========================================================================
  // Gmail API v1 (userId 'me' resolves to the impersonated subject)
  // =========================================================================

  async searchMessages(
    subject: string,
    p: { q?: string; maxResults?: number; labelIds?: readonly string[]; pageToken?: string },
  ): Promise<Record<string, unknown>> {
    return this.request('gmail', 'GET', '/users/me/messages', {
      subject,
      query: {
        q: p.q,
        maxResults: p.maxResults,
        labelIds: p.labelIds,
        pageToken: p.pageToken,
      },
    });
  }

  async getMessage(
    subject: string,
    id: string,
    p: { format?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.request('gmail', 'GET', `/users/me/messages/${encodeURIComponent(id)}`, {
      subject,
      query: { format: p.format ?? 'full' },
    });
  }

  /** Send a message. `raw` is a base64url-encoded RFC 2822 message. */
  async sendMessage(subject: string, raw: string): Promise<Record<string, unknown>> {
    return this.request('gmail', 'POST', '/users/me/messages/send', {
      subject,
      body: { raw },
    });
  }

  /** Create a draft. `raw` is a base64url-encoded RFC 2822 message. */
  async createDraft(subject: string, raw: string): Promise<Record<string, unknown>> {
    return this.request('gmail', 'POST', '/users/me/drafts', {
      subject,
      body: { message: { raw } },
    });
  }

  // =========================================================================
  // Drive API v3 / Docs v1 / Sheets v4
  // =========================================================================

  async searchFiles(
    subject: string,
    p: { q?: string; pageSize?: number; orderBy?: string; fields?: string; pageToken?: string },
  ): Promise<Record<string, unknown>> {
    return this.request('drive', 'GET', '/files', {
      subject,
      query: {
        q: p.q,
        pageSize: p.pageSize,
        orderBy: p.orderBy,
        fields:
          p.fields ??
          'files(id,name,mimeType,modifiedTime,owners(emailAddress),webViewLink,size),nextPageToken',
        pageToken: p.pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      },
    });
  }

  async getFile(
    subject: string,
    fileId: string,
    p: { fields?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.request('drive', 'GET', `/files/${encodeURIComponent(fileId)}`, {
      subject,
      query: {
        fields:
          p.fields ??
          'id,name,mimeType,modifiedTime,createdTime,owners(emailAddress,displayName),webViewLink,size,description',
        supportsAllDrives: true,
      },
    });
  }

  async getDocument(subject: string, documentId: string): Promise<Record<string, unknown>> {
    return this.request('docs', 'GET', `/documents/${encodeURIComponent(documentId)}`, { subject });
  }

  async getSheetValues(
    subject: string,
    spreadsheetId: string,
    range: string,
  ): Promise<Record<string, unknown>> {
    return this.request(
      'sheets',
      'GET',
      `/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`,
      { subject },
    );
  }

  // =========================================================================
  // Admin Directory v1 / People v1
  // =========================================================================

  async listDirectoryUsers(
    subject: string,
    p: {
      customer?: string;
      domain?: string;
      query?: string;
      maxResults?: number;
      orderBy?: string;
      pageToken?: string;
    },
  ): Promise<Record<string, unknown>> {
    // `customer` and `domain` are mutually exclusive; default to my_customer.
    const useDomain = Boolean(p.domain);
    return this.request('directory', 'GET', '/users', {
      subject,
      query: {
        customer: useDomain ? undefined : p.customer || 'my_customer',
        domain: p.domain,
        query: p.query,
        maxResults: p.maxResults,
        orderBy: p.orderBy,
        pageToken: p.pageToken,
        projection: 'basic',
        viewType: 'admin_view',
      },
    });
  }

  async searchContacts(
    subject: string,
    p: { query: string; pageSize?: number; readMask?: string },
  ): Promise<Record<string, unknown>> {
    const readMask = p.readMask ?? 'names,emailAddresses,phoneNumbers,organizations';
    // People `searchContacts` requires a warmup (empty-query) request to prime
    // the server-side cache before the first real search, otherwise results
    // come back empty. Best-effort, once per subject per process.
    if (!this.warmedContacts.has(subject)) {
      this.warmedContacts.add(subject);
      try {
        await this.request('people', 'GET', '/people:searchContacts', {
          subject,
          query: { query: '', readMask },
        });
      } catch {
        // Warmup is best-effort; the real query below surfaces any real error.
      }
    }
    return this.request('people', 'GET', '/people:searchContacts', {
      subject,
      query: { query: p.query, pageSize: p.pageSize, readMask },
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a query string from a flat record. `undefined` values are skipped;
 * arrays expand into repeated params (e.g. `labelIds=A&labelIds=B`). Returns
 * `''` when nothing is set.
 */
function buildQueryString(query: Record<string, QueryValue> | undefined): string {
  if (!query) return '';
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) sp.append(key, String(v));
    } else {
      sp.append(key, String(value));
    }
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/** Promise-based sleep used for retry backoff. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
