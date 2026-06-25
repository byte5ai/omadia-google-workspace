// tests/tabs.test.ts
import test from "node:test";
import assert from "node:assert/strict";

// src/errors.ts
var GoogleAuthError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "GoogleAuthError";
  }
};
var GoogleApiError = class extends Error {
  constructor(status, reason, message) {
    super(message);
    this.status = status;
    this.reason = reason;
    this.name = "GoogleApiError";
  }
};
var GoogleInputError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "GoogleInputError";
  }
};
function formatToolError(err) {
  if (err instanceof GoogleAuthError) {
    return `Error: Google Workspace authentication failed \u2014 ${err.message}. Check the service-account client email + private key, that domain-wide delegation is configured in the Admin console for the required scopes, and that the impersonated user exists.`;
  }
  if (err instanceof GoogleApiError) {
    const reason = err.reason ? ` [${err.reason}]` : "";
    return `Error: Google API returned HTTP ${err.status}${reason}: ${err.message}`;
  }
  if (err instanceof GoogleInputError) {
    return `Error: ${err.message}`;
  }
  return `Error: ${err instanceof Error ? err.message : String(err)}`;
}

// src/googleClient.ts
var API_BASE = {
  calendar: "https://www.googleapis.com/calendar/v3",
  gmail: "https://gmail.googleapis.com/gmail/v1",
  drive: "https://www.googleapis.com/drive/v3",
  docs: "https://docs.googleapis.com/v1",
  sheets: "https://sheets.googleapis.com/v4",
  directory: "https://admin.googleapis.com/admin/directory/v1",
  people: "https://people.googleapis.com/v1"
};
var DEFAULT_MAX_BYTES = 1024 * 1024;
var DEFAULT_RETRY_BASE_MS = 500;
var DEFAULT_MAX_RETRIES = 3;
var RETRYABLE_STATUS = /* @__PURE__ */ new Set([429, 500, 502, 503, 504]);
var GoogleWorkspaceClient = class {
  auth;
  scopes;
  maxBytes;
  retryBaseMs;
  maxRetries;
  fetchImpl;
  log;
  /** Subjects whose People contacts cache has been warmed this process. */
  warmedContacts = /* @__PURE__ */ new Set();
  constructor(opts) {
    this.auth = opts.auth;
    this.scopes = opts.scopes;
    this.maxBytes = opts.maxBytes && opts.maxBytes > 0 ? opts.maxBytes : DEFAULT_MAX_BYTES;
    this.retryBaseMs = typeof opts.retryBaseMs === "number" && opts.retryBaseMs >= 0 ? opts.retryBaseMs : DEFAULT_RETRY_BASE_MS;
    this.maxRetries = typeof opts.maxRetries === "number" && opts.maxRetries >= 0 ? opts.maxRetries : DEFAULT_MAX_RETRIES;
    this.fetchImpl = opts.fetch;
    this.log = opts.log ?? (() => {
    });
  }
  // -------------------------------------------------------------------------
  // Core request — one retry on 401 (expired/rotated token).
  // -------------------------------------------------------------------------
  async request(api, method, path, opts) {
    const base = path.startsWith("http") ? path : `${API_BASE[api]}${path}`;
    const url = `${base}${buildQueryString(opts.query)}`;
    const send = async () => {
      const token = await this.auth.getToken(opts.subject, this.scopes);
      const headers = {
        Authorization: `Bearer ${token}`,
        Accept: "application/json"
      };
      let serialized;
      if (opts.rawBody !== void 0) {
        if (opts.contentType) headers["Content-Type"] = opts.contentType;
        serialized = opts.rawBody;
      } else if (opts.body !== void 0) {
        headers["Content-Type"] = "application/json; charset=utf-8";
        serialized = JSON.stringify(opts.body);
      }
      return this.fetchImpl(url, { method, headers, body: serialized });
    };
    let tokenRetried = false;
    for (let attempt = 0; ; attempt++) {
      const res = await send();
      if (res.status === 401 && !tokenRetried) {
        this.log("[googleworkspace] 401 \u2014 refreshing token and retrying once");
        tokenRetried = true;
        this.auth.invalidate(opts.subject, this.scopes);
        continue;
      }
      if (RETRYABLE_STATUS.has(res.status) && attempt < this.maxRetries) {
        const delay = this.backoffDelay(attempt, res);
        this.log(
          `[googleworkspace] HTTP ${res.status} on ${api} \u2014 retry ${attempt + 1}/${this.maxRetries} in ${delay}ms`
        );
        await sleep(delay);
        continue;
      }
      if (!res.ok) throw await this.toApiError(res);
      const text = await this.readCapped(res);
      return text ? JSON.parse(text) : {};
    }
  }
  /**
   * Backoff delay for retry `attempt` (0-based). Honours a `Retry-After`
   * header (seconds) when the server sends one, otherwise exponential
   * (`base * 2^attempt`) with a little jitter.
   */
  backoffDelay(attempt, res) {
    const retryAfter = Number(res.headers.get("retry-after") ?? "");
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      return Math.min(retryAfter * 1e3, 3e4);
    }
    const base = this.retryBaseMs * 2 ** attempt;
    const jitter = Math.floor(Math.random() * Math.min(this.retryBaseMs, 250));
    return Math.min(base + jitter, 3e4);
  }
  /** Read a response body, refusing payloads larger than `maxBytes`. */
  async readCapped(res) {
    const declared = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > this.maxBytes) {
      throw new GoogleApiError(
        res.status,
        "ResponseTooLarge",
        `response of ${declared} bytes exceeds maxBytes=${this.maxBytes}`
      );
    }
    const text = await res.text();
    if (text.length > this.maxBytes) {
      throw new GoogleApiError(
        res.status,
        "ResponseTooLarge",
        `response of ${text.length} bytes exceeds maxBytes=${this.maxBytes}`
      );
    }
    return text;
  }
  /** Parse a non-2xx body into a {@link GoogleApiError}. */
  async toApiError(res) {
    let raw = "";
    try {
      raw = await this.readCapped(res);
    } catch (err) {
      if (err instanceof GoogleApiError) return err;
    }
    let reason;
    let message = raw || res.statusText;
    try {
      const env = JSON.parse(raw);
      if (env.error) {
        reason = env.error.status ?? env.error.errors?.[0]?.reason;
        message = env.error.message ?? message;
      }
    } catch {
    }
    return new GoogleApiError(res.status, reason, message);
  }
  /** Acquire a token for `subject` to verify connectivity + delegation. */
  async probe(subject) {
    await this.auth.getToken(subject, this.scopes);
  }
  // =========================================================================
  // Calendar API v3
  // =========================================================================
  /** List events on a calendar (default `primary`). */
  async listEvents(subject, p) {
    const calendarId = p.calendarId || "primary";
    return this.request("calendar", "GET", `/calendars/${encodeURIComponent(calendarId)}/events`, {
      subject,
      query: {
        timeMin: p.timeMin,
        timeMax: p.timeMax,
        q: p.q,
        maxResults: p.maxResults,
        singleEvents: p.singleEvents ?? true,
        orderBy: p.orderBy ?? (p.singleEvents === false ? void 0 : "startTime"),
        pageToken: p.pageToken
      }
    });
  }
  /** Query free/busy windows across one or more calendars. */
  async freeBusy(subject, p) {
    return this.request("calendar", "POST", "/freeBusy", {
      subject,
      body: {
        timeMin: p.timeMin,
        timeMax: p.timeMax,
        items: p.calendarIds.map((id) => ({ id }))
      }
    });
  }
  /** Create a calendar event. */
  async createEvent(subject, calendarId, event, p = {}) {
    return this.request("calendar", "POST", `/calendars/${encodeURIComponent(calendarId)}/events`, {
      subject,
      query: { sendUpdates: p.sendUpdates },
      body: event
    });
  }
  /** Patch (partial update) an existing event. */
  async patchEvent(subject, calendarId, eventId, patch, p = {}) {
    return this.request(
      "calendar",
      "PATCH",
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      { subject, query: { sendUpdates: p.sendUpdates }, body: patch }
    );
  }
  // =========================================================================
  // Gmail API v1 (userId 'me' resolves to the impersonated subject)
  // =========================================================================
  async searchMessages(subject, p) {
    return this.request("gmail", "GET", "/users/me/messages", {
      subject,
      query: {
        q: p.q,
        maxResults: p.maxResults,
        labelIds: p.labelIds,
        pageToken: p.pageToken
      }
    });
  }
  async getMessage(subject, id, p = {}) {
    return this.request("gmail", "GET", `/users/me/messages/${encodeURIComponent(id)}`, {
      subject,
      query: { format: p.format ?? "full" }
    });
  }
  /** Send a message. `raw` is a base64url-encoded RFC 2822 message. */
  async sendMessage(subject, raw) {
    return this.request("gmail", "POST", "/users/me/messages/send", {
      subject,
      body: { raw }
    });
  }
  /** Create a draft. `raw` is a base64url-encoded RFC 2822 message. */
  async createDraft(subject, raw) {
    return this.request("gmail", "POST", "/users/me/drafts", {
      subject,
      body: { message: { raw } }
    });
  }
  // =========================================================================
  // Drive API v3 / Docs v1 / Sheets v4
  // =========================================================================
  async searchFiles(subject, p) {
    return this.request("drive", "GET", "/files", {
      subject,
      query: {
        q: p.q,
        pageSize: p.pageSize,
        orderBy: p.orderBy,
        fields: p.fields ?? "files(id,name,mimeType,modifiedTime,owners(emailAddress),webViewLink,size),nextPageToken",
        pageToken: p.pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true
      }
    });
  }
  async getFile(subject, fileId, p = {}) {
    return this.request("drive", "GET", `/files/${encodeURIComponent(fileId)}`, {
      subject,
      query: {
        fields: p.fields ?? "id,name,mimeType,modifiedTime,createdTime,owners(emailAddress,displayName),webViewLink,size,description",
        supportsAllDrives: true
      }
    });
  }
  async getDocument(subject, documentId) {
    return this.request("docs", "GET", `/documents/${encodeURIComponent(documentId)}`, { subject });
  }
  async getSheetValues(subject, spreadsheetId, range) {
    return this.request(
      "sheets",
      "GET",
      `/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`,
      { subject }
    );
  }
  /**
   * Write values into a Sheets range. `mode: 'overwrite'` (default) PUTs the
   * range (`values.update`); `mode: 'append'` appends rows after the table
   * (`values.append` with `INSERT_ROWS`). `valueInputOption` controls whether
   * inputs are parsed (`USER_ENTERED`) or stored as-is (`RAW`).
   */
  async writeSheetValues(subject, spreadsheetId, range, values, p = {}) {
    const valueInputOption = p.valueInputOption ?? "USER_ENTERED";
    const encoded = `/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`;
    const body = { range, majorDimension: "ROWS", values };
    if (p.mode === "append") {
      return this.request("sheets", "POST", `${encoded}:append`, {
        subject,
        query: { valueInputOption, insertDataOption: "INSERT_ROWS" },
        body
      });
    }
    return this.request("sheets", "PUT", encoded, {
      subject,
      query: { valueInputOption },
      body
    });
  }
  /**
   * Create a Drive file or folder. Metadata-only (no `content`) is a plain
   * `files.create` (folders, empty native Google files). With `content`, a
   * multipart media upload is used so the bytes land in the new file (text
   * content; native Google types are converted from it).
   */
  async createDriveFile(subject, p) {
    const metadata = { name: p.name, mimeType: p.mimeType };
    if (p.parents && p.parents.length > 0) metadata.parents = p.parents;
    const fields = "id,name,mimeType,webViewLink,parents";
    if (p.content === void 0) {
      return this.request("drive", "POST", "/files", {
        subject,
        query: { supportsAllDrives: true, fields },
        body: metadata
      });
    }
    const boundary = `omadia-gw-${Math.random().toString(36).slice(2)}`;
    const rawBody = [
      `--${boundary}`,
      "Content-Type: application/json; charset=UTF-8",
      "",
      JSON.stringify(metadata),
      `--${boundary}`,
      `Content-Type: ${p.contentMimeType ?? "text/plain"}; charset=UTF-8`,
      "",
      p.content,
      `--${boundary}--`,
      ""
    ].join("\r\n");
    return this.request("drive", "POST", "https://www.googleapis.com/upload/drive/v3/files", {
      subject,
      query: { uploadType: "multipart", supportsAllDrives: true, fields },
      rawBody,
      contentType: `multipart/related; boundary=${boundary}`
    });
  }
  /** Read a spreadsheet's tab metadata (title + per-tab sheetId/title/index). READ. */
  async getSpreadsheetMeta(subject, spreadsheetId) {
    return this.request("sheets", "GET", `/spreadsheets/${encodeURIComponent(spreadsheetId)}`, {
      subject,
      query: {
        fields: "properties(title),sheets(properties(sheetId,title,index,gridProperties(rowCount,columnCount)))"
      }
    });
  }
  /**
   * Run a Sheets `spreadsheets.batchUpdate` (e.g. `addSheet`, `duplicateSheet`).
   * WRITE. Returns the raw reply so callers can read back e.g. the new sheetId.
   */
  async batchUpdateSpreadsheet(subject, spreadsheetId, requests) {
    return this.request(
      "sheets",
      "POST",
      `/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
      { subject, body: { requests } }
    );
  }
  // =========================================================================
  // Admin Directory v1 / People v1
  // =========================================================================
  async listDirectoryUsers(subject, p) {
    const useDomain = Boolean(p.domain);
    return this.request("directory", "GET", "/users", {
      subject,
      query: {
        customer: useDomain ? void 0 : p.customer || "my_customer",
        domain: p.domain,
        query: p.query,
        maxResults: p.maxResults,
        orderBy: p.orderBy,
        pageToken: p.pageToken,
        projection: "basic",
        viewType: "admin_view"
      }
    });
  }
  async searchContacts(subject, p) {
    const readMask = p.readMask ?? "names,emailAddresses,phoneNumbers,organizations";
    if (!this.warmedContacts.has(subject)) {
      this.warmedContacts.add(subject);
      try {
        await this.request("people", "GET", "/people:searchContacts", {
          subject,
          query: { query: "", readMask }
        });
      } catch {
      }
    }
    return this.request("people", "GET", "/people:searchContacts", {
      subject,
      query: { query: p.query, pageSize: p.pageSize, readMask }
    });
  }
};
function buildQueryString(query) {
  if (!query) return "";
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === void 0) continue;
    if (Array.isArray(value)) {
      for (const v of value) sp.append(key, String(v));
    } else {
      sp.append(key, String(value));
    }
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// src/toolDeps.ts
function resolveSubject(deps2, user, opts = {}) {
  const u = typeof user === "string" ? user.trim() : "";
  if (u) {
    if (!u.includes("@")) {
      throw new GoogleInputError(`"user" must be a full email address, got: '${u}'`);
    }
    return u;
  }
  const fallback = opts.admin ? deps2.adminSubject : deps2.defaultSubject;
  if (!fallback) {
    throw new GoogleInputError(
      opts.admin ? 'no admin user configured \u2014 set gw_admin_subject (or gw_subject_default) or pass "user".' : 'no default user configured \u2014 set gw_subject_default or pass "user".'
    );
  }
  return fallback;
}

// src/driveTools.ts
var MAX_RESULTS = 50;
var DEFAULT_RESULTS = 20;
function str(value) {
  return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
var driveSearchSpec = {
  name: "gw_drive_search",
  description: `Search Google Drive using Drive query syntax. READ-ONLY. Examples: "name contains 'budget'", "mimeType='application/vnd.google-apps.document'", "'me' in owners and modifiedTime > '2026-01-01T00:00:00'". Returns file metadata (id, name, mimeType, modifiedTime, owner, link).`,
  input_schema: {
    type: "object",
    properties: {
      user: { type: "string", description: "Drive owner to impersonate (email). Omit for default." },
      q: {
        type: "string",
        description: `Drive query. e.g. "name contains 'report' and trashed=false". Omit to list recent files.`
      },
      orderBy: {
        type: "string",
        description: 'Sort, e.g. "modifiedTime desc", "name". Default "modifiedTime desc".'
      },
      pageSize: { type: "number", description: `Max files per page (1\u2013${MAX_RESULTS}, default ${DEFAULT_RESULTS}).` },
      pageToken: {
        type: "string",
        description: `Page cursor from a previous call's "nextPageToken" to fetch the next page.`
      }
    },
    required: []
  }
};
function createSheetListTabsHandler(deps2) {
  return async (raw) => {
    const input = raw ?? {};
    try {
      const subject = resolveSubject(deps2, input.user);
      const spreadsheetId = str(input.spreadsheetId);
      if (!spreadsheetId) throw new GoogleInputError('"spreadsheetId" is required.');
      const key = `sheets:tabs:${subject}:${spreadsheetId}`;
      const meta = await deps2.cache.getOrSet(
        key,
        () => deps2.client.getSpreadsheetMeta(subject, spreadsheetId)
      );
      const props = meta.properties ?? {};
      const tabs = (meta.sheets ?? []).map((s) => {
        const p = s.properties ?? {};
        const grid = p.gridProperties ?? {};
        return {
          sheetId: p.sheetId,
          title: p.title,
          index: p.index,
          rows: grid.rowCount,
          columns: grid.columnCount
        };
      });
      return JSON.stringify({ spreadsheetId, title: props.title, tabs }, null, 2);
    } catch (err) {
      return formatToolError(err);
    }
  };
}
function createSheetAddTabHandler(deps2) {
  return async (raw) => {
    const input = raw ?? {};
    try {
      const subject = resolveSubject(deps2, input.user);
      const spreadsheetId = str(input.spreadsheetId);
      const title = str(input.title);
      if (!spreadsheetId) throw new GoogleInputError('"spreadsheetId" is required.');
      if (!title) throw new GoogleInputError('"title" is required.');
      const properties = { title };
      if (typeof input.index === "number") properties.index = input.index;
      const result = await deps2.client.batchUpdateSpreadsheet(subject, spreadsheetId, [
        { addSheet: { properties } }
      ]);
      deps2.cache.clear();
      const replies = result.replies ?? [];
      const added = replies[0]?.addSheet?.properties;
      return JSON.stringify(
        { added: true, title, sheetId: added?.sheetId, index: added?.index },
        null,
        2
      );
    } catch (err) {
      return formatToolError(err);
    }
  };
}
function createSheetDuplicateTabHandler(deps2) {
  return async (raw) => {
    const input = raw ?? {};
    try {
      const subject = resolveSubject(deps2, input.user);
      const spreadsheetId = str(input.spreadsheetId);
      const newName = str(input.newName);
      if (!spreadsheetId) throw new GoogleInputError('"spreadsheetId" is required.');
      if (!newName) throw new GoogleInputError('"newName" is required.');
      let sourceSheetId = typeof input.sourceSheetId === "number" ? input.sourceSheetId : void 0;
      const sourceTitle = str(input.sourceTitle);
      if (sourceSheetId === void 0) {
        if (!sourceTitle) {
          throw new GoogleInputError('provide "sourceTitle" or "sourceSheetId" of the tab to copy.');
        }
        const meta = await deps2.client.getSpreadsheetMeta(subject, spreadsheetId);
        const match = (meta.sheets ?? []).find((s) => {
          const p = s.properties ?? {};
          return p.title === sourceTitle;
        });
        const props = match?.properties ?? {};
        if (typeof props.sheetId !== "number") {
          throw new GoogleInputError(`no tab named "${sourceTitle}" found in this spreadsheet.`);
        }
        sourceSheetId = props.sheetId;
      }
      const dup = { sourceSheetId, newSheetName: newName };
      if (typeof input.index === "number") dup.insertSheetIndex = input.index;
      const result = await deps2.client.batchUpdateSpreadsheet(subject, spreadsheetId, [
        { duplicateSheet: dup }
      ]);
      deps2.cache.clear();
      const replies = result.replies ?? [];
      const added = replies[0]?.duplicateSheet?.properties;
      return JSON.stringify(
        { duplicated: true, sourceSheetId, newName, newSheetId: added?.sheetId },
        null,
        2
      );
    } catch (err) {
      return formatToolError(err);
    }
  };
}
function createSheetBatchUpdateHandler(deps2) {
  return async (raw) => {
    const input = raw ?? {};
    try {
      const subject = resolveSubject(deps2, input.user);
      const spreadsheetId = str(input.spreadsheetId);
      if (!spreadsheetId) throw new GoogleInputError('"spreadsheetId" is required.');
      if (!Array.isArray(input.requests) || input.requests.length === 0) {
        throw new GoogleInputError('"requests" must be a non-empty array of Sheets API requests.');
      }
      const result = await deps2.client.batchUpdateSpreadsheet(
        subject,
        spreadsheetId,
        input.requests
      );
      deps2.cache.clear();
      return JSON.stringify(
        {
          applied: true,
          spreadsheetId,
          requestCount: input.requests.length,
          replies: result.replies ?? []
        },
        null,
        2
      );
    } catch (err) {
      return formatToolError(err);
    }
  };
}

// tests/_helpers.ts
function fakeAuth() {
  let tokenCalls = 0;
  let invalidations = 0;
  const auth = {
    getToken: async () => {
      tokenCalls += 1;
      return `tok-${tokenCalls}`;
    },
    invalidate: () => {
      invalidations += 1;
    }
  };
  return {
    auth,
    stats: () => ({ tokenCalls, invalidations })
  };
}
function scriptedFetch(steps) {
  const calls = [];
  let i = 0;
  const fetchImpl = async (url, init) => {
    const c = { url, init: init ?? {} };
    calls.push(c);
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    return step(c);
  };
  return { fetchImpl, calls };
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" }
  });
}

// tests/tabs.test.ts
var cache = {
  getOrSet: async (_k, fn) => fn(),
  clear() {
  }
};
function deps(client) {
  return {
    client,
    cache,
    defaultSubject: "me@x.com",
    adminSubject: "admin@x.com"
  };
}
test("getSpreadsheetMeta GETs the spreadsheet with a tab-properties field mask", async () => {
  const { auth } = fakeAuth();
  const { fetchImpl, calls } = scriptedFetch([
    () => json({ properties: { title: "Finanzen 2023" }, sheets: [{ properties: { sheetId: 0, title: "2025" } }] })
  ]);
  const client = new GoogleWorkspaceClient({ auth, scopes: ["s"], fetch: fetchImpl });
  const r = await client.getSpreadsheetMeta("u@x.com", "sheet1");
  assert.equal(calls[0].init.method ?? "GET", "GET");
  assert.match(calls[0].url, /\/spreadsheets\/sheet1\?/);
  assert.match(calls[0].url, /fields=.*sheets/);
  assert.equal(r.properties.title, "Finanzen 2023");
});
test("batchUpdateSpreadsheet POSTs to :batchUpdate with the requests body", async () => {
  const { auth } = fakeAuth();
  const { fetchImpl, calls } = scriptedFetch([() => json({ replies: [{}] })]);
  const client = new GoogleWorkspaceClient({ auth, scopes: ["s"], fetch: fetchImpl });
  await client.batchUpdateSpreadsheet("u@x.com", "sheet1", [{ addSheet: { properties: { title: "X" } } }]);
  assert.equal(calls[0].init.method, "POST");
  assert.match(calls[0].url, /\/spreadsheets\/sheet1:batchUpdate/);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.requests[0].addSheet.properties.title, "X");
});
test("gw_sheet_list_tabs returns trimmed tabs + title", async () => {
  const client = {
    getSpreadsheetMeta: async () => ({
      properties: { title: "Finanzen 2023" },
      sheets: [
        { properties: { sheetId: 0, title: "2024", index: 0, gridProperties: { rowCount: 100, columnCount: 12 } } },
        { properties: { sheetId: 7, title: "2025", index: 1 } }
      ]
    })
  };
  const out = JSON.parse(await createSheetListTabsHandler(deps(client))({ spreadsheetId: "s" }));
  assert.equal(out.title, "Finanzen 2023");
  assert.equal(out.tabs.length, 2);
  assert.deepEqual(out.tabs[0], { sheetId: 0, title: "2024", index: 0, rows: 100, columns: 12 });
  assert.equal(out.tabs[1].sheetId, 7);
});
test("gw_sheet_add_tab requires a title and returns the new sheetId", async () => {
  assert.match(await createSheetAddTabHandler(deps({}))({ spreadsheetId: "s" }), /Error:.*"title"/);
  const client = {
    batchUpdateSpreadsheet: async (_s, _id, reqs) => {
      assert.equal(reqs[0].addSheet.properties.title, "2026");
      return { replies: [{ addSheet: { properties: { sheetId: 99, index: 2 } } }] };
    }
  };
  const out = JSON.parse(await createSheetAddTabHandler(deps(client))({ spreadsheetId: "s", title: "2026" }));
  assert.equal(out.added, true);
  assert.equal(out.sheetId, 99);
});
test("gw_sheet_duplicate_tab resolves sourceTitle\u2192sheetId then duplicates", async () => {
  let dupReq;
  const client = {
    getSpreadsheetMeta: async () => ({ sheets: [{ properties: { sheetId: 42, title: "2025" } }] }),
    batchUpdateSpreadsheet: async (_s, _id, reqs) => {
      dupReq = reqs[0].duplicateSheet;
      return { replies: [{ duplicateSheet: { properties: { sheetId: 123 } } }] };
    }
  };
  const out = JSON.parse(
    await createSheetDuplicateTabHandler(deps(client))({ spreadsheetId: "s", sourceTitle: "2025", newName: "2026" })
  );
  assert.equal(dupReq.sourceSheetId, 42);
  assert.equal(dupReq.newSheetName, "2026");
  assert.equal(out.duplicated, true);
  assert.equal(out.newSheetId, 123);
});
test("gw_sheet_duplicate_tab errors when sourceTitle is not found", async () => {
  const client = { getSpreadsheetMeta: async () => ({ sheets: [{ properties: { sheetId: 1, title: "Other" } }] }) };
  assert.match(
    await createSheetDuplicateTabHandler(deps(client))({ spreadsheetId: "s", sourceTitle: "Nope", newName: "X" }),
    /Error:.*no tab named/
  );
});
test("gw_sheet_batch_update requires a non-empty requests array and passes it through", async () => {
  assert.match(await createSheetBatchUpdateHandler(deps({}))({ spreadsheetId: "s", requests: [] }), /Error:.*non-empty/);
  let got;
  const client = {
    batchUpdateSpreadsheet: async (_s, _id, reqs2) => {
      got = reqs2;
      return { replies: [{}] };
    }
  };
  const reqs = [{ repeatCell: { range: { sheetId: 0 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "userEnteredFormat.textFormat.bold" } }];
  const out = JSON.parse(await createSheetBatchUpdateHandler(deps(client))({ spreadsheetId: "s", requests: reqs }));
  assert.equal(out.applied, true);
  assert.equal(out.requestCount, 1);
  assert.deepEqual(got, reqs);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vdGVzdHMvdGFicy50ZXN0LnRzIiwgIi4uL3NyYy9lcnJvcnMudHMiLCAiLi4vc3JjL2dvb2dsZUNsaWVudC50cyIsICIuLi9zcmMvdG9vbERlcHMudHMiLCAiLi4vc3JjL2RyaXZlVG9vbHMudHMiLCAiLi4vdGVzdHMvX2hlbHBlcnMudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB0ZXN0IGZyb20gJ25vZGU6dGVzdCc7XG5pbXBvcnQgYXNzZXJ0IGZyb20gJ25vZGU6YXNzZXJ0L3N0cmljdCc7XG5cbmltcG9ydCB7IEdvb2dsZVdvcmtzcGFjZUNsaWVudCB9IGZyb20gJy4uL3NyYy9nb29nbGVDbGllbnQuanMnO1xuaW1wb3J0IHtcbiAgY3JlYXRlU2hlZXRMaXN0VGFic0hhbmRsZXIsXG4gIGNyZWF0ZVNoZWV0QWRkVGFiSGFuZGxlcixcbiAgY3JlYXRlU2hlZXREdXBsaWNhdGVUYWJIYW5kbGVyLFxuICBjcmVhdGVTaGVldEJhdGNoVXBkYXRlSGFuZGxlcixcbn0gZnJvbSAnLi4vc3JjL2RyaXZlVG9vbHMuanMnO1xuaW1wb3J0IHR5cGUgeyBUb29sRGVwcyB9IGZyb20gJy4uL3NyYy90b29sRGVwcy5qcyc7XG5pbXBvcnQgeyBmYWtlQXV0aCwgc2NyaXB0ZWRGZXRjaCwganNvbiB9IGZyb20gJy4vX2hlbHBlcnMuanMnO1xuXG5jb25zdCBjYWNoZSA9IHtcbiAgZ2V0T3JTZXQ6IGFzeW5jIChfazogc3RyaW5nLCBmbjogKCkgPT4gUHJvbWlzZTx1bmtub3duPikgPT4gZm4oKSxcbiAgY2xlYXIoKSB7fSxcbn0gYXMgdW5rbm93biBhcyBUb29sRGVwc1snY2FjaGUnXTtcblxuZnVuY3Rpb24gZGVwcyhjbGllbnQ6IHVua25vd24pOiBUb29sRGVwcyB7XG4gIHJldHVybiB7XG4gICAgY2xpZW50OiBjbGllbnQgYXMgVG9vbERlcHNbJ2NsaWVudCddLFxuICAgIGNhY2hlLFxuICAgIGRlZmF1bHRTdWJqZWN0OiAnbWVAeC5jb20nLFxuICAgIGFkbWluU3ViamVjdDogJ2FkbWluQHguY29tJyxcbiAgfTtcbn1cblxuLy8gLS0tIGNsaWVudCAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbnRlc3QoJ2dldFNwcmVhZHNoZWV0TWV0YSBHRVRzIHRoZSBzcHJlYWRzaGVldCB3aXRoIGEgdGFiLXByb3BlcnRpZXMgZmllbGQgbWFzaycsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgeyBhdXRoIH0gPSBmYWtlQXV0aCgpO1xuICBjb25zdCB7IGZldGNoSW1wbCwgY2FsbHMgfSA9IHNjcmlwdGVkRmV0Y2goW1xuICAgICgpID0+IGpzb24oeyBwcm9wZXJ0aWVzOiB7IHRpdGxlOiAnRmluYW56ZW4gMjAyMycgfSwgc2hlZXRzOiBbeyBwcm9wZXJ0aWVzOiB7IHNoZWV0SWQ6IDAsIHRpdGxlOiAnMjAyNScgfSB9XSB9KSxcbiAgXSk7XG4gIGNvbnN0IGNsaWVudCA9IG5ldyBHb29nbGVXb3Jrc3BhY2VDbGllbnQoeyBhdXRoLCBzY29wZXM6IFsncyddLCBmZXRjaDogZmV0Y2hJbXBsIH0pO1xuICBjb25zdCByID0gYXdhaXQgY2xpZW50LmdldFNwcmVhZHNoZWV0TWV0YSgndUB4LmNvbScsICdzaGVldDEnKTtcbiAgYXNzZXJ0LmVxdWFsKGNhbGxzWzBdLmluaXQubWV0aG9kID8/ICdHRVQnLCAnR0VUJyk7XG4gIGFzc2VydC5tYXRjaChjYWxsc1swXS51cmwsIC9cXC9zcHJlYWRzaGVldHNcXC9zaGVldDFcXD8vKTtcbiAgYXNzZXJ0Lm1hdGNoKGNhbGxzWzBdLnVybCwgL2ZpZWxkcz0uKnNoZWV0cy8pO1xuICBhc3NlcnQuZXF1YWwoKHIucHJvcGVydGllcyBhcyB7IHRpdGxlPzogc3RyaW5nIH0pLnRpdGxlLCAnRmluYW56ZW4gMjAyMycpO1xufSk7XG5cbnRlc3QoJ2JhdGNoVXBkYXRlU3ByZWFkc2hlZXQgUE9TVHMgdG8gOmJhdGNoVXBkYXRlIHdpdGggdGhlIHJlcXVlc3RzIGJvZHknLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHsgYXV0aCB9ID0gZmFrZUF1dGgoKTtcbiAgY29uc3QgeyBmZXRjaEltcGwsIGNhbGxzIH0gPSBzY3JpcHRlZEZldGNoKFsoKSA9PiBqc29uKHsgcmVwbGllczogW3t9XSB9KV0pO1xuICBjb25zdCBjbGllbnQgPSBuZXcgR29vZ2xlV29ya3NwYWNlQ2xpZW50KHsgYXV0aCwgc2NvcGVzOiBbJ3MnXSwgZmV0Y2g6IGZldGNoSW1wbCB9KTtcbiAgYXdhaXQgY2xpZW50LmJhdGNoVXBkYXRlU3ByZWFkc2hlZXQoJ3VAeC5jb20nLCAnc2hlZXQxJywgW3sgYWRkU2hlZXQ6IHsgcHJvcGVydGllczogeyB0aXRsZTogJ1gnIH0gfSB9XSk7XG4gIGFzc2VydC5lcXVhbChjYWxsc1swXS5pbml0Lm1ldGhvZCwgJ1BPU1QnKTtcbiAgYXNzZXJ0Lm1hdGNoKGNhbGxzWzBdLnVybCwgL1xcL3NwcmVhZHNoZWV0c1xcL3NoZWV0MTpiYXRjaFVwZGF0ZS8pO1xuICBjb25zdCBib2R5ID0gSlNPTi5wYXJzZShjYWxsc1swXS5pbml0LmJvZHkgYXMgc3RyaW5nKTtcbiAgYXNzZXJ0LmVxdWFsKGJvZHkucmVxdWVzdHNbMF0uYWRkU2hlZXQucHJvcGVydGllcy50aXRsZSwgJ1gnKTtcbn0pO1xuXG4vLyAtLS0gaGFuZGxlcnMgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxudGVzdCgnZ3dfc2hlZXRfbGlzdF90YWJzIHJldHVybnMgdHJpbW1lZCB0YWJzICsgdGl0bGUnLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGNsaWVudCA9IHtcbiAgICBnZXRTcHJlYWRzaGVldE1ldGE6IGFzeW5jICgpID0+ICh7XG4gICAgICBwcm9wZXJ0aWVzOiB7IHRpdGxlOiAnRmluYW56ZW4gMjAyMycgfSxcbiAgICAgIHNoZWV0czogW1xuICAgICAgICB7IHByb3BlcnRpZXM6IHsgc2hlZXRJZDogMCwgdGl0bGU6ICcyMDI0JywgaW5kZXg6IDAsIGdyaWRQcm9wZXJ0aWVzOiB7IHJvd0NvdW50OiAxMDAsIGNvbHVtbkNvdW50OiAxMiB9IH0gfSxcbiAgICAgICAgeyBwcm9wZXJ0aWVzOiB7IHNoZWV0SWQ6IDcsIHRpdGxlOiAnMjAyNScsIGluZGV4OiAxIH0gfSxcbiAgICAgIF0sXG4gICAgfSksXG4gIH07XG4gIGNvbnN0IG91dCA9IEpTT04ucGFyc2UoYXdhaXQgY3JlYXRlU2hlZXRMaXN0VGFic0hhbmRsZXIoZGVwcyhjbGllbnQpKSh7IHNwcmVhZHNoZWV0SWQ6ICdzJyB9KSk7XG4gIGFzc2VydC5lcXVhbChvdXQudGl0bGUsICdGaW5hbnplbiAyMDIzJyk7XG4gIGFzc2VydC5lcXVhbChvdXQudGFicy5sZW5ndGgsIDIpO1xuICBhc3NlcnQuZGVlcEVxdWFsKG91dC50YWJzWzBdLCB7IHNoZWV0SWQ6IDAsIHRpdGxlOiAnMjAyNCcsIGluZGV4OiAwLCByb3dzOiAxMDAsIGNvbHVtbnM6IDEyIH0pO1xuICBhc3NlcnQuZXF1YWwob3V0LnRhYnNbMV0uc2hlZXRJZCwgNyk7XG59KTtcblxudGVzdCgnZ3dfc2hlZXRfYWRkX3RhYiByZXF1aXJlcyBhIHRpdGxlIGFuZCByZXR1cm5zIHRoZSBuZXcgc2hlZXRJZCcsIGFzeW5jICgpID0+IHtcbiAgYXNzZXJ0Lm1hdGNoKGF3YWl0IGNyZWF0ZVNoZWV0QWRkVGFiSGFuZGxlcihkZXBzKHt9KSkoeyBzcHJlYWRzaGVldElkOiAncycgfSksIC9FcnJvcjouKlwidGl0bGVcIi8pO1xuICBjb25zdCBjbGllbnQgPSB7XG4gICAgYmF0Y2hVcGRhdGVTcHJlYWRzaGVldDogYXN5bmMgKF9zOiBzdHJpbmcsIF9pZDogc3RyaW5nLCByZXFzOiB7IGFkZFNoZWV0OiB7IHByb3BlcnRpZXM6IHsgdGl0bGU6IHN0cmluZyB9IH0gfVtdKSA9PiB7XG4gICAgICBhc3NlcnQuZXF1YWwocmVxc1swXS5hZGRTaGVldC5wcm9wZXJ0aWVzLnRpdGxlLCAnMjAyNicpO1xuICAgICAgcmV0dXJuIHsgcmVwbGllczogW3sgYWRkU2hlZXQ6IHsgcHJvcGVydGllczogeyBzaGVldElkOiA5OSwgaW5kZXg6IDIgfSB9IH1dIH07XG4gICAgfSxcbiAgfTtcbiAgY29uc3Qgb3V0ID0gSlNPTi5wYXJzZShhd2FpdCBjcmVhdGVTaGVldEFkZFRhYkhhbmRsZXIoZGVwcyhjbGllbnQpKSh7IHNwcmVhZHNoZWV0SWQ6ICdzJywgdGl0bGU6ICcyMDI2JyB9KSk7XG4gIGFzc2VydC5lcXVhbChvdXQuYWRkZWQsIHRydWUpO1xuICBhc3NlcnQuZXF1YWwob3V0LnNoZWV0SWQsIDk5KTtcbn0pO1xuXG50ZXN0KCdnd19zaGVldF9kdXBsaWNhdGVfdGFiIHJlc29sdmVzIHNvdXJjZVRpdGxlXHUyMTkyc2hlZXRJZCB0aGVuIGR1cGxpY2F0ZXMnLCBhc3luYyAoKSA9PiB7XG4gIGxldCBkdXBSZXE6IHsgc291cmNlU2hlZXRJZD86IG51bWJlcjsgbmV3U2hlZXROYW1lPzogc3RyaW5nIH0gfCB1bmRlZmluZWQ7XG4gIGNvbnN0IGNsaWVudCA9IHtcbiAgICBnZXRTcHJlYWRzaGVldE1ldGE6IGFzeW5jICgpID0+ICh7IHNoZWV0czogW3sgcHJvcGVydGllczogeyBzaGVldElkOiA0MiwgdGl0bGU6ICcyMDI1JyB9IH1dIH0pLFxuICAgIGJhdGNoVXBkYXRlU3ByZWFkc2hlZXQ6IGFzeW5jIChfczogc3RyaW5nLCBfaWQ6IHN0cmluZywgcmVxczogeyBkdXBsaWNhdGVTaGVldDogdHlwZW9mIGR1cFJlcSB9W10pID0+IHtcbiAgICAgIGR1cFJlcSA9IHJlcXNbMF0uZHVwbGljYXRlU2hlZXQ7XG4gICAgICByZXR1cm4geyByZXBsaWVzOiBbeyBkdXBsaWNhdGVTaGVldDogeyBwcm9wZXJ0aWVzOiB7IHNoZWV0SWQ6IDEyMyB9IH0gfV0gfTtcbiAgICB9LFxuICB9O1xuICBjb25zdCBvdXQgPSBKU09OLnBhcnNlKFxuICAgIGF3YWl0IGNyZWF0ZVNoZWV0RHVwbGljYXRlVGFiSGFuZGxlcihkZXBzKGNsaWVudCkpKHsgc3ByZWFkc2hlZXRJZDogJ3MnLCBzb3VyY2VUaXRsZTogJzIwMjUnLCBuZXdOYW1lOiAnMjAyNicgfSksXG4gICk7XG4gIGFzc2VydC5lcXVhbChkdXBSZXEhLnNvdXJjZVNoZWV0SWQsIDQyKTtcbiAgYXNzZXJ0LmVxdWFsKGR1cFJlcSEubmV3U2hlZXROYW1lLCAnMjAyNicpO1xuICBhc3NlcnQuZXF1YWwob3V0LmR1cGxpY2F0ZWQsIHRydWUpO1xuICBhc3NlcnQuZXF1YWwob3V0Lm5ld1NoZWV0SWQsIDEyMyk7XG59KTtcblxudGVzdCgnZ3dfc2hlZXRfZHVwbGljYXRlX3RhYiBlcnJvcnMgd2hlbiBzb3VyY2VUaXRsZSBpcyBub3QgZm91bmQnLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGNsaWVudCA9IHsgZ2V0U3ByZWFkc2hlZXRNZXRhOiBhc3luYyAoKSA9PiAoeyBzaGVldHM6IFt7IHByb3BlcnRpZXM6IHsgc2hlZXRJZDogMSwgdGl0bGU6ICdPdGhlcicgfSB9XSB9KSB9O1xuICBhc3NlcnQubWF0Y2goXG4gICAgYXdhaXQgY3JlYXRlU2hlZXREdXBsaWNhdGVUYWJIYW5kbGVyKGRlcHMoY2xpZW50KSkoeyBzcHJlYWRzaGVldElkOiAncycsIHNvdXJjZVRpdGxlOiAnTm9wZScsIG5ld05hbWU6ICdYJyB9KSxcbiAgICAvRXJyb3I6LipubyB0YWIgbmFtZWQvLFxuICApO1xufSk7XG5cbnRlc3QoJ2d3X3NoZWV0X2JhdGNoX3VwZGF0ZSByZXF1aXJlcyBhIG5vbi1lbXB0eSByZXF1ZXN0cyBhcnJheSBhbmQgcGFzc2VzIGl0IHRocm91Z2gnLCBhc3luYyAoKSA9PiB7XG4gIGFzc2VydC5tYXRjaChhd2FpdCBjcmVhdGVTaGVldEJhdGNoVXBkYXRlSGFuZGxlcihkZXBzKHt9KSkoeyBzcHJlYWRzaGVldElkOiAncycsIHJlcXVlc3RzOiBbXSB9KSwgL0Vycm9yOi4qbm9uLWVtcHR5Lyk7XG4gIGxldCBnb3Q6IHVua25vd25bXSB8IHVuZGVmaW5lZDtcbiAgY29uc3QgY2xpZW50ID0ge1xuICAgIGJhdGNoVXBkYXRlU3ByZWFkc2hlZXQ6IGFzeW5jIChfczogc3RyaW5nLCBfaWQ6IHN0cmluZywgcmVxczogdW5rbm93bltdKSA9PiB7XG4gICAgICBnb3QgPSByZXFzO1xuICAgICAgcmV0dXJuIHsgcmVwbGllczogW3t9XSB9O1xuICAgIH0sXG4gIH07XG4gIGNvbnN0IHJlcXMgPSBbeyByZXBlYXRDZWxsOiB7IHJhbmdlOiB7IHNoZWV0SWQ6IDAgfSwgY2VsbDogeyB1c2VyRW50ZXJlZEZvcm1hdDogeyB0ZXh0Rm9ybWF0OiB7IGJvbGQ6IHRydWUgfSB9IH0sIGZpZWxkczogJ3VzZXJFbnRlcmVkRm9ybWF0LnRleHRGb3JtYXQuYm9sZCcgfSB9XTtcbiAgY29uc3Qgb3V0ID0gSlNPTi5wYXJzZShhd2FpdCBjcmVhdGVTaGVldEJhdGNoVXBkYXRlSGFuZGxlcihkZXBzKGNsaWVudCkpKHsgc3ByZWFkc2hlZXRJZDogJ3MnLCByZXF1ZXN0czogcmVxcyB9KSk7XG4gIGFzc2VydC5lcXVhbChvdXQuYXBwbGllZCwgdHJ1ZSk7XG4gIGFzc2VydC5lcXVhbChvdXQucmVxdWVzdENvdW50LCAxKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChnb3QsIHJlcXMpO1xufSk7XG4iLCAiLyoqXG4gKiBFcnJvciB0eXBlcyBzaGFyZWQgYWNyb3NzIHRoZSBHb29nbGUgV29ya3NwYWNlIGludGVncmF0aW9uLCBwbHVzIGEgc2luZ2xlXG4gKiBgZm9ybWF0VG9vbEVycm9yYCB0aGF0IHR1cm5zIGFueSB0aHJvd24gZXJyb3IgaW50byBhIHNob3J0LCBtb2RlbC1yZWFkYWJsZVxuICogc3RyaW5nIHdpdGggbm8gc3RhY2sgdHJhY2VzIG9yIHNlY3JldHMuXG4gKi9cblxuLyoqIFJhaXNlZCB3aGVuIHRoZSBzZXJ2aWNlLWFjY291bnQgSldULWJlYXJlciB0b2tlbiBleGNoYW5nZSBmYWlscy4gKi9cbmV4cG9ydCBjbGFzcyBHb29nbGVBdXRoRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIGNvbnN0cnVjdG9yKG1lc3NhZ2U6IHN0cmluZykge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICAgIHRoaXMubmFtZSA9ICdHb29nbGVBdXRoRXJyb3InO1xuICB9XG59XG5cbi8qKiBSYWlzZWQgd2hlbiBhIEdvb2dsZSBBUEkgcmVzcG9uZHMgd2l0aCBhIG5vbi0yeHggc3RhdHVzLiAqL1xuZXhwb3J0IGNsYXNzIEdvb2dsZUFwaUVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICBjb25zdHJ1Y3RvcihcbiAgICBwdWJsaWMgcmVhZG9ubHkgc3RhdHVzOiBudW1iZXIsXG4gICAgcHVibGljIHJlYWRvbmx5IHJlYXNvbjogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICAgIG1lc3NhZ2U6IHN0cmluZyxcbiAgKSB7XG4gICAgc3VwZXIobWVzc2FnZSk7XG4gICAgdGhpcy5uYW1lID0gJ0dvb2dsZUFwaUVycm9yJztcbiAgfVxufVxuXG4vKiogUmFpc2VkIGJ5IGNsaWVudC1zaWRlIGFyZ3VtZW50IHZhbGlkYXRpb24gYmVmb3JlIGFueSBuZXR3b3JrIGNhbGwuICovXG5leHBvcnQgY2xhc3MgR29vZ2xlSW5wdXRFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgY29uc3RydWN0b3IobWVzc2FnZTogc3RyaW5nKSB7XG4gICAgc3VwZXIobWVzc2FnZSk7XG4gICAgdGhpcy5uYW1lID0gJ0dvb2dsZUlucHV0RXJyb3InO1xuICB9XG59XG5cbi8qKlxuICogVHVybiBjbGllbnQgZXJyb3JzIGludG8gYSBzaG9ydCwgbW9kZWwtcmVhZGFibGUgbWVzc2FnZS4gTmV2ZXIgbGVha3MgdGhlXG4gKiBwcml2YXRlIGtleSwgYWNjZXNzIHRva2VuLCBvciBhIHN0YWNrIHRyYWNlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0VG9vbEVycm9yKGVycjogdW5rbm93bik6IHN0cmluZyB7XG4gIGlmIChlcnIgaW5zdGFuY2VvZiBHb29nbGVBdXRoRXJyb3IpIHtcbiAgICByZXR1cm4gYEVycm9yOiBHb29nbGUgV29ya3NwYWNlIGF1dGhlbnRpY2F0aW9uIGZhaWxlZCBcdTIwMTQgJHtlcnIubWVzc2FnZX0uIENoZWNrIHRoZSBzZXJ2aWNlLWFjY291bnQgY2xpZW50IGVtYWlsICsgcHJpdmF0ZSBrZXksIHRoYXQgZG9tYWluLXdpZGUgZGVsZWdhdGlvbiBpcyBjb25maWd1cmVkIGluIHRoZSBBZG1pbiBjb25zb2xlIGZvciB0aGUgcmVxdWlyZWQgc2NvcGVzLCBhbmQgdGhhdCB0aGUgaW1wZXJzb25hdGVkIHVzZXIgZXhpc3RzLmA7XG4gIH1cbiAgaWYgKGVyciBpbnN0YW5jZW9mIEdvb2dsZUFwaUVycm9yKSB7XG4gICAgY29uc3QgcmVhc29uID0gZXJyLnJlYXNvbiA/IGAgWyR7ZXJyLnJlYXNvbn1dYCA6ICcnO1xuICAgIHJldHVybiBgRXJyb3I6IEdvb2dsZSBBUEkgcmV0dXJuZWQgSFRUUCAke2Vyci5zdGF0dXN9JHtyZWFzb259OiAke2Vyci5tZXNzYWdlfWA7XG4gIH1cbiAgaWYgKGVyciBpbnN0YW5jZW9mIEdvb2dsZUlucHV0RXJyb3IpIHtcbiAgICByZXR1cm4gYEVycm9yOiAke2Vyci5tZXNzYWdlfWA7XG4gIH1cbiAgcmV0dXJuIGBFcnJvcjogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YDtcbn1cbiIsICIvKipcbiAqIEdvb2dsZVdvcmtzcGFjZUNsaWVudCBcdTIwMTQgYSB0aGluLCByZWFkLW1vc3RseSB3cmFwcGVyIG92ZXIgdGhlIEdvb2dsZSBXb3Jrc3BhY2VcbiAqIFJFU1QgQVBJcyAoQ2FsZW5kYXIsIEdtYWlsLCBEcml2ZSwgRG9jcywgU2hlZXRzLCBBZG1pbiBEaXJlY3RvcnksIFBlb3BsZSkuXG4gKlxuICogQXV0aCBpcyBzZXJ2aWNlLWFjY291bnQgKipkb21haW4td2lkZSBkZWxlZ2F0aW9uKio6IGV2ZXJ5IGNhbGwgaW1wZXJzb25hdGVzIGFcbiAqIGBzdWJqZWN0YCAoYSBXb3Jrc3BhY2UgdXNlcidzIGVtYWlsKSB2aWEge0BsaW5rIEdvb2dsZVNlcnZpY2VBY2NvdW50QXV0aH0uXG4gKiBBbGwgZWdyZXNzIGdvZXMgdGhyb3VnaCB0aGUgaW5qZWN0ZWQgYGZldGNoYCBcdTIwMTQgaW4gdGhlIHBsdWdpbiB0aGlzIGlzXG4gKiBgY3R4Lmh0dHAuZmV0Y2hgLCBhbGxvdy1saXN0ZWQgKyByYXRlLWxpbWl0ZWQgYnkgdGhlIGhvc3QuIFRoZSBjbGllbnQgbmV2ZXJcbiAqIHRvdWNoZXMgZ2xvYmFsIGBmZXRjaGAsIHNvIGl0IHN0YXlzIGluc2lkZSB0aGUga2VybmVsJ3MgYXVkaXRhYmxlIGJvdW5kYXJ5LlxuICpcbiAqIFJlc3BvbnNlcyBhcmUgc2l6ZS1jYXBwZWQgKGBtYXhCeXRlc2ApIGJlZm9yZSBgSlNPTi5wYXJzZWAgc28gYSBwYXRob2xvZ2ljYWxcbiAqIHVuYm91bmRlZCBsaXN0IGNhbid0IGJsb3cgdXAgdGhlIGhvc3QncyBtZW1vcnkuIEVhY2ggcHVibGljIG1ldGhvZCBuYW1lcyB0aGVcbiAqIHN1cmZhY2UgaXQgdGFsa3MgdG87IHRoZSBwcml2YXRlIGByZXF1ZXN0KClgIHJlc29sdmVzIHRoZSBjb3JyZWN0IEFQSSBob3N0LlxuICovXG5cbmltcG9ydCB7IEdvb2dsZUFwaUVycm9yIH0gZnJvbSAnLi9lcnJvcnMuanMnO1xuaW1wb3J0IHR5cGUgeyBHb29nbGVTZXJ2aWNlQWNjb3VudEF1dGggfSBmcm9tICcuL2dvb2dsZUF1dGguanMnO1xuXG5leHBvcnQgdHlwZSBHb29nbGVBcGkgPVxuICB8ICdjYWxlbmRhcidcbiAgfCAnZ21haWwnXG4gIHwgJ2RyaXZlJ1xuICB8ICdkb2NzJ1xuICB8ICdzaGVldHMnXG4gIHwgJ2RpcmVjdG9yeSdcbiAgfCAncGVvcGxlJztcblxuLyoqIEJhc2UgVVJMIHBlciBBUEkgKGhvc3QgKyB2ZXJzaW9uIHByZWZpeCkuIEhvc3RzIGFyZSBtYW5pZmVzdC1hbGxvdy1saXN0ZWQuICovXG5jb25zdCBBUElfQkFTRTogUmVjb3JkPEdvb2dsZUFwaSwgc3RyaW5nPiA9IHtcbiAgY2FsZW5kYXI6ICdodHRwczovL3d3dy5nb29nbGVhcGlzLmNvbS9jYWxlbmRhci92MycsXG4gIGdtYWlsOiAnaHR0cHM6Ly9nbWFpbC5nb29nbGVhcGlzLmNvbS9nbWFpbC92MScsXG4gIGRyaXZlOiAnaHR0cHM6Ly93d3cuZ29vZ2xlYXBpcy5jb20vZHJpdmUvdjMnLFxuICBkb2NzOiAnaHR0cHM6Ly9kb2NzLmdvb2dsZWFwaXMuY29tL3YxJyxcbiAgc2hlZXRzOiAnaHR0cHM6Ly9zaGVldHMuZ29vZ2xlYXBpcy5jb20vdjQnLFxuICBkaXJlY3Rvcnk6ICdodHRwczovL2FkbWluLmdvb2dsZWFwaXMuY29tL2FkbWluL2RpcmVjdG9yeS92MScsXG4gIHBlb3BsZTogJ2h0dHBzOi8vcGVvcGxlLmdvb2dsZWFwaXMuY29tL3YxJyxcbn07XG5cbmNvbnN0IERFRkFVTFRfTUFYX0JZVEVTID0gMTAyNCAqIDEwMjQ7IC8vIDEgTWlCXG5jb25zdCBERUZBVUxUX1JFVFJZX0JBU0VfTVMgPSA1MDA7XG5jb25zdCBERUZBVUxUX01BWF9SRVRSSUVTID0gMztcbi8qKiBUcmFuc2llbnQgc3RhdHVzZXMgd29ydGggcmV0cnlpbmcgd2l0aCBleHBvbmVudGlhbCBiYWNrb2ZmLiAqL1xuY29uc3QgUkVUUllBQkxFX1NUQVRVUyA9IG5ldyBTZXQoWzQyOSwgNTAwLCA1MDIsIDUwMywgNTA0XSk7XG5cbi8qKiBHb29nbGUgSlNPTiBlcnJvciBlbnZlbG9wZSAoUkVTVCk6IGB7IGVycm9yOiB7IGNvZGUsIG1lc3NhZ2UsIHN0YXR1cywgZXJyb3JzIH0gfWAuICovXG5pbnRlcmZhY2UgR29vZ2xlRXJyb3JFbnZlbG9wZSB7XG4gIHJlYWRvbmx5IGVycm9yPzoge1xuICAgIHJlYWRvbmx5IGNvZGU/OiBudW1iZXI7XG4gICAgcmVhZG9ubHkgbWVzc2FnZT86IHN0cmluZztcbiAgICByZWFkb25seSBzdGF0dXM/OiBzdHJpbmc7XG4gICAgcmVhZG9ubHkgZXJyb3JzPzogUmVhZG9ubHlBcnJheTx7IHJlYWRvbmx5IHJlYXNvbj86IHN0cmluZzsgcmVhZG9ubHkgbWVzc2FnZT86IHN0cmluZyB9PjtcbiAgfTtcbn1cblxudHlwZSBRdWVyeVZhbHVlID0gc3RyaW5nIHwgbnVtYmVyIHwgYm9vbGVhbiB8IHJlYWRvbmx5IHN0cmluZ1tdIHwgdW5kZWZpbmVkO1xuXG5leHBvcnQgaW50ZXJmYWNlIEdvb2dsZVdvcmtzcGFjZUNsaWVudE9wdGlvbnMge1xuICByZWFkb25seSBhdXRoOiBHb29nbGVTZXJ2aWNlQWNjb3VudEF1dGg7XG4gIC8qKiBUaGUgdW5pb24gc2NvcGUgc2V0IHRoZSBhY2Nlc3MgdG9rZW4gaXMgcmVxdWVzdGVkIHdpdGguICovXG4gIHJlYWRvbmx5IHNjb3BlczogcmVhZG9ubHkgc3RyaW5nW107XG4gIC8qKiBIYXJkIGNhcCBvbiBhIHNpbmdsZSByZXNwb25zZSBib2R5IGluIGJ5dGVzLiBEZWZhdWx0cyB0byAxIE1pQi4gKi9cbiAgcmVhZG9ubHkgbWF4Qnl0ZXM/OiBudW1iZXI7XG4gIC8qKiBCYXNlIGRlbGF5IGZvciBleHBvbmVudGlhbCBiYWNrb2ZmIG9uIHRyYW5zaWVudCBlcnJvcnMgKG1zKS4gRGVmYXVsdCA1MDAuICovXG4gIHJlYWRvbmx5IHJldHJ5QmFzZU1zPzogbnVtYmVyO1xuICAvKiogTWF4IHJldHJpZXMgb24gdHJhbnNpZW50ICg0MjkvNXh4KSBlcnJvcnMuIERlZmF1bHQgMy4gKi9cbiAgcmVhZG9ubHkgbWF4UmV0cmllcz86IG51bWJlcjtcbiAgLyoqIEluamVjdGVkIGZldGNoIChwcm9kdWN0aW9uOiBgY3R4Lmh0dHAuZmV0Y2hgKS4gKi9cbiAgcmVhZG9ubHkgZmV0Y2g6IHR5cGVvZiBmZXRjaDtcbiAgLyoqIE9wdGlvbmFsIHN0cnVjdHVyZWQgbG9nZ2VyLiAqL1xuICByZWFkb25seSBsb2c/OiAobWVzc2FnZTogc3RyaW5nKSA9PiB2b2lkO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFJlcXVlc3RPcHRpb25zIHtcbiAgLyoqIFdvcmtzcGFjZSB1c2VyIHRvIGltcGVyc29uYXRlIChEV0QgYHN1YmApLiAqL1xuICByZWFkb25seSBzdWJqZWN0OiBzdHJpbmc7XG4gIHJlYWRvbmx5IHF1ZXJ5PzogUmVjb3JkPHN0cmluZywgUXVlcnlWYWx1ZT47XG4gIC8qKiBKU09OIHJlcXVlc3QgYm9keSAoc2VyaWFsaXplZCArIHNlbnQgYXMgYXBwbGljYXRpb24vanNvbikuICovXG4gIHJlYWRvbmx5IGJvZHk/OiB1bmtub3duO1xuICAvKipcbiAgICogUHJlLXNlcmlhbGl6ZWQgYm9keSBzZW50IHZlcmJhdGltIHdpdGggYGNvbnRlbnRUeXBlYCAoZS5nLiBhIG11bHRpcGFydFxuICAgKiB1cGxvYWQpLiBUYWtlcyBwcmVjZWRlbmNlIG92ZXIgYGJvZHlgLiBVc2VkIGJ5IHRoZSBEcml2ZSBtZWRpYSB1cGxvYWQuXG4gICAqL1xuICByZWFkb25seSByYXdCb2R5Pzogc3RyaW5nO1xuICByZWFkb25seSBjb250ZW50VHlwZT86IHN0cmluZztcbn1cblxuZXhwb3J0IGNsYXNzIEdvb2dsZVdvcmtzcGFjZUNsaWVudCB7XG4gIHByaXZhdGUgcmVhZG9ubHkgYXV0aDogR29vZ2xlU2VydmljZUFjY291bnRBdXRoO1xuICBwcml2YXRlIHJlYWRvbmx5IHNjb3BlczogcmVhZG9ubHkgc3RyaW5nW107XG4gIHByaXZhdGUgcmVhZG9ubHkgbWF4Qnl0ZXM6IG51bWJlcjtcbiAgcHJpdmF0ZSByZWFkb25seSByZXRyeUJhc2VNczogbnVtYmVyO1xuICBwcml2YXRlIHJlYWRvbmx5IG1heFJldHJpZXM6IG51bWJlcjtcbiAgcHJpdmF0ZSByZWFkb25seSBmZXRjaEltcGw6IHR5cGVvZiBmZXRjaDtcbiAgcHJpdmF0ZSByZWFkb25seSBsb2c6IChtZXNzYWdlOiBzdHJpbmcpID0+IHZvaWQ7XG4gIC8qKiBTdWJqZWN0cyB3aG9zZSBQZW9wbGUgY29udGFjdHMgY2FjaGUgaGFzIGJlZW4gd2FybWVkIHRoaXMgcHJvY2Vzcy4gKi9cbiAgcHJpdmF0ZSByZWFkb25seSB3YXJtZWRDb250YWN0cyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXG4gIGNvbnN0cnVjdG9yKG9wdHM6IEdvb2dsZVdvcmtzcGFjZUNsaWVudE9wdGlvbnMpIHtcbiAgICB0aGlzLmF1dGggPSBvcHRzLmF1dGg7XG4gICAgdGhpcy5zY29wZXMgPSBvcHRzLnNjb3BlcztcbiAgICB0aGlzLm1heEJ5dGVzID0gb3B0cy5tYXhCeXRlcyAmJiBvcHRzLm1heEJ5dGVzID4gMCA/IG9wdHMubWF4Qnl0ZXMgOiBERUZBVUxUX01BWF9CWVRFUztcbiAgICB0aGlzLnJldHJ5QmFzZU1zID1cbiAgICAgIHR5cGVvZiBvcHRzLnJldHJ5QmFzZU1zID09PSAnbnVtYmVyJyAmJiBvcHRzLnJldHJ5QmFzZU1zID49IDBcbiAgICAgICAgPyBvcHRzLnJldHJ5QmFzZU1zXG4gICAgICAgIDogREVGQVVMVF9SRVRSWV9CQVNFX01TO1xuICAgIHRoaXMubWF4UmV0cmllcyA9XG4gICAgICB0eXBlb2Ygb3B0cy5tYXhSZXRyaWVzID09PSAnbnVtYmVyJyAmJiBvcHRzLm1heFJldHJpZXMgPj0gMFxuICAgICAgICA/IG9wdHMubWF4UmV0cmllc1xuICAgICAgICA6IERFRkFVTFRfTUFYX1JFVFJJRVM7XG4gICAgdGhpcy5mZXRjaEltcGwgPSBvcHRzLmZldGNoO1xuICAgIHRoaXMubG9nID0gb3B0cy5sb2cgPz8gKCgpID0+IHt9KTtcbiAgfVxuXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgLy8gQ29yZSByZXF1ZXN0IFx1MjAxNCBvbmUgcmV0cnkgb24gNDAxIChleHBpcmVkL3JvdGF0ZWQgdG9rZW4pLlxuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIHByaXZhdGUgYXN5bmMgcmVxdWVzdDxUID0gUmVjb3JkPHN0cmluZywgdW5rbm93bj4+KFxuICAgIGFwaTogR29vZ2xlQXBpLFxuICAgIG1ldGhvZDogc3RyaW5nLFxuICAgIHBhdGg6IHN0cmluZyxcbiAgICBvcHRzOiBSZXF1ZXN0T3B0aW9ucyxcbiAgKTogUHJvbWlzZTxUPiB7XG4gICAgLy8gQW4gYWJzb2x1dGUgYHBhdGhgIChlLmcuIHRoZSBEcml2ZSBtZWRpYS11cGxvYWQgaG9zdCkgaXMgdXNlZCB2ZXJiYXRpbTtcbiAgICAvLyBvdGhlcndpc2UgaXQgaXMgcmVzb2x2ZWQgYWdhaW5zdCB0aGUgcGVyLUFQSSBiYXNlLlxuICAgIGNvbnN0IGJhc2UgPSBwYXRoLnN0YXJ0c1dpdGgoJ2h0dHAnKSA/IHBhdGggOiBgJHtBUElfQkFTRVthcGldfSR7cGF0aH1gO1xuICAgIGNvbnN0IHVybCA9IGAke2Jhc2V9JHtidWlsZFF1ZXJ5U3RyaW5nKG9wdHMucXVlcnkpfWA7XG4gICAgY29uc3Qgc2VuZCA9IGFzeW5jICgpOiBQcm9taXNlPFJlc3BvbnNlPiA9PiB7XG4gICAgICBjb25zdCB0b2tlbiA9IGF3YWl0IHRoaXMuYXV0aC5nZXRUb2tlbihvcHRzLnN1YmplY3QsIHRoaXMuc2NvcGVzKTtcbiAgICAgIGNvbnN0IGhlYWRlcnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gICAgICAgIEF1dGhvcml6YXRpb246IGBCZWFyZXIgJHt0b2tlbn1gLFxuICAgICAgICBBY2NlcHQ6ICdhcHBsaWNhdGlvbi9qc29uJyxcbiAgICAgIH07XG4gICAgICBsZXQgc2VyaWFsaXplZDogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAgICAgaWYgKG9wdHMucmF3Qm9keSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGlmIChvcHRzLmNvbnRlbnRUeXBlKSBoZWFkZXJzWydDb250ZW50LVR5cGUnXSA9IG9wdHMuY29udGVudFR5cGU7XG4gICAgICAgIHNlcmlhbGl6ZWQgPSBvcHRzLnJhd0JvZHk7XG4gICAgICB9IGVsc2UgaWYgKG9wdHMuYm9keSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGhlYWRlcnNbJ0NvbnRlbnQtVHlwZSddID0gJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnO1xuICAgICAgICBzZXJpYWxpemVkID0gSlNPTi5zdHJpbmdpZnkob3B0cy5ib2R5KTtcbiAgICAgIH1cbiAgICAgIHJldHVybiB0aGlzLmZldGNoSW1wbCh1cmwsIHsgbWV0aG9kLCBoZWFkZXJzLCBib2R5OiBzZXJpYWxpemVkIH0pO1xuICAgIH07XG5cbiAgICBsZXQgdG9rZW5SZXRyaWVkID0gZmFsc2U7XG4gICAgZm9yIChsZXQgYXR0ZW1wdCA9IDA7IDsgYXR0ZW1wdCsrKSB7XG4gICAgICBjb25zdCByZXMgPSBhd2FpdCBzZW5kKCk7XG5cbiAgICAgIC8vIEV4cGlyZWQvcm90YXRlZCB0b2tlbiBcdTIwMTQgcmUtbWludCBvbmNlLCBub3QgY291bnRlZCBhZ2FpbnN0IGJhY2tvZmYuXG4gICAgICBpZiAocmVzLnN0YXR1cyA9PT0gNDAxICYmICF0b2tlblJldHJpZWQpIHtcbiAgICAgICAgdGhpcy5sb2coJ1tnb29nbGV3b3Jrc3BhY2VdIDQwMSBcdTIwMTQgcmVmcmVzaGluZyB0b2tlbiBhbmQgcmV0cnlpbmcgb25jZScpO1xuICAgICAgICB0b2tlblJldHJpZWQgPSB0cnVlO1xuICAgICAgICB0aGlzLmF1dGguaW52YWxpZGF0ZShvcHRzLnN1YmplY3QsIHRoaXMuc2NvcGVzKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIC8vIFRyYW5zaWVudCBlcnJvcnMgXHUyMDE0IGV4cG9uZW50aWFsIGJhY2tvZmYgdXAgdG8gbWF4UmV0cmllcy5cbiAgICAgIGlmIChSRVRSWUFCTEVfU1RBVFVTLmhhcyhyZXMuc3RhdHVzKSAmJiBhdHRlbXB0IDwgdGhpcy5tYXhSZXRyaWVzKSB7XG4gICAgICAgIGNvbnN0IGRlbGF5ID0gdGhpcy5iYWNrb2ZmRGVsYXkoYXR0ZW1wdCwgcmVzKTtcbiAgICAgICAgdGhpcy5sb2coXG4gICAgICAgICAgYFtnb29nbGV3b3Jrc3BhY2VdIEhUVFAgJHtyZXMuc3RhdHVzfSBvbiAke2FwaX0gXHUyMDE0IHJldHJ5ICR7YXR0ZW1wdCArIDF9LyR7dGhpcy5tYXhSZXRyaWVzfSBpbiAke2RlbGF5fW1zYCxcbiAgICAgICAgKTtcbiAgICAgICAgYXdhaXQgc2xlZXAoZGVsYXkpO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgaWYgKCFyZXMub2spIHRocm93IGF3YWl0IHRoaXMudG9BcGlFcnJvcihyZXMpO1xuICAgICAgY29uc3QgdGV4dCA9IGF3YWl0IHRoaXMucmVhZENhcHBlZChyZXMpO1xuICAgICAgcmV0dXJuICh0ZXh0ID8gSlNPTi5wYXJzZSh0ZXh0KSA6IHt9KSBhcyBUO1xuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBCYWNrb2ZmIGRlbGF5IGZvciByZXRyeSBgYXR0ZW1wdGAgKDAtYmFzZWQpLiBIb25vdXJzIGEgYFJldHJ5LUFmdGVyYFxuICAgKiBoZWFkZXIgKHNlY29uZHMpIHdoZW4gdGhlIHNlcnZlciBzZW5kcyBvbmUsIG90aGVyd2lzZSBleHBvbmVudGlhbFxuICAgKiAoYGJhc2UgKiAyXmF0dGVtcHRgKSB3aXRoIGEgbGl0dGxlIGppdHRlci5cbiAgICovXG4gIHByaXZhdGUgYmFja29mZkRlbGF5KGF0dGVtcHQ6IG51bWJlciwgcmVzOiBSZXNwb25zZSk6IG51bWJlciB7XG4gICAgY29uc3QgcmV0cnlBZnRlciA9IE51bWJlcihyZXMuaGVhZGVycy5nZXQoJ3JldHJ5LWFmdGVyJykgPz8gJycpO1xuICAgIGlmIChOdW1iZXIuaXNGaW5pdGUocmV0cnlBZnRlcikgJiYgcmV0cnlBZnRlciA+IDApIHtcbiAgICAgIHJldHVybiBNYXRoLm1pbihyZXRyeUFmdGVyICogMTAwMCwgMzBfMDAwKTtcbiAgICB9XG4gICAgY29uc3QgYmFzZSA9IHRoaXMucmV0cnlCYXNlTXMgKiAyICoqIGF0dGVtcHQ7XG4gICAgY29uc3Qgaml0dGVyID0gTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpICogTWF0aC5taW4odGhpcy5yZXRyeUJhc2VNcywgMjUwKSk7XG4gICAgcmV0dXJuIE1hdGgubWluKGJhc2UgKyBqaXR0ZXIsIDMwXzAwMCk7XG4gIH1cblxuICAvKiogUmVhZCBhIHJlc3BvbnNlIGJvZHksIHJlZnVzaW5nIHBheWxvYWRzIGxhcmdlciB0aGFuIGBtYXhCeXRlc2AuICovXG4gIHByaXZhdGUgYXN5bmMgcmVhZENhcHBlZChyZXM6IFJlc3BvbnNlKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgICBjb25zdCBkZWNsYXJlZCA9IE51bWJlcihyZXMuaGVhZGVycy5nZXQoJ2NvbnRlbnQtbGVuZ3RoJykgPz8gJycpO1xuICAgIGlmIChOdW1iZXIuaXNGaW5pdGUoZGVjbGFyZWQpICYmIGRlY2xhcmVkID4gdGhpcy5tYXhCeXRlcykge1xuICAgICAgdGhyb3cgbmV3IEdvb2dsZUFwaUVycm9yKFxuICAgICAgICByZXMuc3RhdHVzLFxuICAgICAgICAnUmVzcG9uc2VUb29MYXJnZScsXG4gICAgICAgIGByZXNwb25zZSBvZiAke2RlY2xhcmVkfSBieXRlcyBleGNlZWRzIG1heEJ5dGVzPSR7dGhpcy5tYXhCeXRlc31gLFxuICAgICAgKTtcbiAgICB9XG4gICAgY29uc3QgdGV4dCA9IGF3YWl0IHJlcy50ZXh0KCk7XG4gICAgaWYgKHRleHQubGVuZ3RoID4gdGhpcy5tYXhCeXRlcykge1xuICAgICAgdGhyb3cgbmV3IEdvb2dsZUFwaUVycm9yKFxuICAgICAgICByZXMuc3RhdHVzLFxuICAgICAgICAnUmVzcG9uc2VUb29MYXJnZScsXG4gICAgICAgIGByZXNwb25zZSBvZiAke3RleHQubGVuZ3RofSBieXRlcyBleGNlZWRzIG1heEJ5dGVzPSR7dGhpcy5tYXhCeXRlc31gLFxuICAgICAgKTtcbiAgICB9XG4gICAgcmV0dXJuIHRleHQ7XG4gIH1cblxuICAvKiogUGFyc2UgYSBub24tMnh4IGJvZHkgaW50byBhIHtAbGluayBHb29nbGVBcGlFcnJvcn0uICovXG4gIHByaXZhdGUgYXN5bmMgdG9BcGlFcnJvcihyZXM6IFJlc3BvbnNlKTogUHJvbWlzZTxHb29nbGVBcGlFcnJvcj4ge1xuICAgIGxldCByYXcgPSAnJztcbiAgICB0cnkge1xuICAgICAgcmF3ID0gYXdhaXQgdGhpcy5yZWFkQ2FwcGVkKHJlcyk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBpZiAoZXJyIGluc3RhbmNlb2YgR29vZ2xlQXBpRXJyb3IpIHJldHVybiBlcnI7XG4gICAgfVxuICAgIGxldCByZWFzb246IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICBsZXQgbWVzc2FnZSA9IHJhdyB8fCByZXMuc3RhdHVzVGV4dDtcbiAgICB0cnkge1xuICAgICAgY29uc3QgZW52ID0gSlNPTi5wYXJzZShyYXcpIGFzIEdvb2dsZUVycm9yRW52ZWxvcGU7XG4gICAgICBpZiAoZW52LmVycm9yKSB7XG4gICAgICAgIHJlYXNvbiA9IGVudi5lcnJvci5zdGF0dXMgPz8gZW52LmVycm9yLmVycm9ycz8uWzBdPy5yZWFzb247XG4gICAgICAgIG1lc3NhZ2UgPSBlbnYuZXJyb3IubWVzc2FnZSA/PyBtZXNzYWdlO1xuICAgICAgfVxuICAgIH0gY2F0Y2gge1xuICAgICAgLyogbm9uLUpTT04gZXJyb3IgYm9keSBcdTIwMTQga2VlcCByYXcgKi9cbiAgICB9XG4gICAgcmV0dXJuIG5ldyBHb29nbGVBcGlFcnJvcihyZXMuc3RhdHVzLCByZWFzb24sIG1lc3NhZ2UpO1xuICB9XG5cbiAgLyoqIEFjcXVpcmUgYSB0b2tlbiBmb3IgYHN1YmplY3RgIHRvIHZlcmlmeSBjb25uZWN0aXZpdHkgKyBkZWxlZ2F0aW9uLiAqL1xuICBhc3luYyBwcm9iZShzdWJqZWN0OiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBhd2FpdCB0aGlzLmF1dGguZ2V0VG9rZW4oc3ViamVjdCwgdGhpcy5zY29wZXMpO1xuICB9XG5cbiAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAvLyBDYWxlbmRhciBBUEkgdjNcbiAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gIC8qKiBMaXN0IGV2ZW50cyBvbiBhIGNhbGVuZGFyIChkZWZhdWx0IGBwcmltYXJ5YCkuICovXG4gIGFzeW5jIGxpc3RFdmVudHMoXG4gICAgc3ViamVjdDogc3RyaW5nLFxuICAgIHA6IHtcbiAgICAgIGNhbGVuZGFySWQ/OiBzdHJpbmc7XG4gICAgICB0aW1lTWluPzogc3RyaW5nO1xuICAgICAgdGltZU1heD86IHN0cmluZztcbiAgICAgIHE/OiBzdHJpbmc7XG4gICAgICBtYXhSZXN1bHRzPzogbnVtYmVyO1xuICAgICAgc2luZ2xlRXZlbnRzPzogYm9vbGVhbjtcbiAgICAgIG9yZGVyQnk/OiBzdHJpbmc7XG4gICAgICBwYWdlVG9rZW4/OiBzdHJpbmc7XG4gICAgfSxcbiAgKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4ge1xuICAgIGNvbnN0IGNhbGVuZGFySWQgPSBwLmNhbGVuZGFySWQgfHwgJ3ByaW1hcnknO1xuICAgIHJldHVybiB0aGlzLnJlcXVlc3QoJ2NhbGVuZGFyJywgJ0dFVCcsIGAvY2FsZW5kYXJzLyR7ZW5jb2RlVVJJQ29tcG9uZW50KGNhbGVuZGFySWQpfS9ldmVudHNgLCB7XG4gICAgICBzdWJqZWN0LFxuICAgICAgcXVlcnk6IHtcbiAgICAgICAgdGltZU1pbjogcC50aW1lTWluLFxuICAgICAgICB0aW1lTWF4OiBwLnRpbWVNYXgsXG4gICAgICAgIHE6IHAucSxcbiAgICAgICAgbWF4UmVzdWx0czogcC5tYXhSZXN1bHRzLFxuICAgICAgICBzaW5nbGVFdmVudHM6IHAuc2luZ2xlRXZlbnRzID8/IHRydWUsXG4gICAgICAgIG9yZGVyQnk6IHAub3JkZXJCeSA/PyAocC5zaW5nbGVFdmVudHMgPT09IGZhbHNlID8gdW5kZWZpbmVkIDogJ3N0YXJ0VGltZScpLFxuICAgICAgICBwYWdlVG9rZW46IHAucGFnZVRva2VuLFxuICAgICAgfSxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKiBRdWVyeSBmcmVlL2J1c3kgd2luZG93cyBhY3Jvc3Mgb25lIG9yIG1vcmUgY2FsZW5kYXJzLiAqL1xuICBhc3luYyBmcmVlQnVzeShcbiAgICBzdWJqZWN0OiBzdHJpbmcsXG4gICAgcDogeyB0aW1lTWluOiBzdHJpbmc7IHRpbWVNYXg6IHN0cmluZzsgY2FsZW5kYXJJZHM6IHJlYWRvbmx5IHN0cmluZ1tdIH0sXG4gICk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcbiAgICByZXR1cm4gdGhpcy5yZXF1ZXN0KCdjYWxlbmRhcicsICdQT1NUJywgJy9mcmVlQnVzeScsIHtcbiAgICAgIHN1YmplY3QsXG4gICAgICBib2R5OiB7XG4gICAgICAgIHRpbWVNaW46IHAudGltZU1pbixcbiAgICAgICAgdGltZU1heDogcC50aW1lTWF4LFxuICAgICAgICBpdGVtczogcC5jYWxlbmRhcklkcy5tYXAoKGlkKSA9PiAoeyBpZCB9KSksXG4gICAgICB9LFxuICAgIH0pO1xuICB9XG5cbiAgLyoqIENyZWF0ZSBhIGNhbGVuZGFyIGV2ZW50LiAqL1xuICBhc3luYyBjcmVhdGVFdmVudChcbiAgICBzdWJqZWN0OiBzdHJpbmcsXG4gICAgY2FsZW5kYXJJZDogc3RyaW5nLFxuICAgIGV2ZW50OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcbiAgICBwOiB7IHNlbmRVcGRhdGVzPzogc3RyaW5nIH0gPSB7fSxcbiAgKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4ge1xuICAgIHJldHVybiB0aGlzLnJlcXVlc3QoJ2NhbGVuZGFyJywgJ1BPU1QnLCBgL2NhbGVuZGFycy8ke2VuY29kZVVSSUNvbXBvbmVudChjYWxlbmRhcklkKX0vZXZlbnRzYCwge1xuICAgICAgc3ViamVjdCxcbiAgICAgIHF1ZXJ5OiB7IHNlbmRVcGRhdGVzOiBwLnNlbmRVcGRhdGVzIH0sXG4gICAgICBib2R5OiBldmVudCxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKiBQYXRjaCAocGFydGlhbCB1cGRhdGUpIGFuIGV4aXN0aW5nIGV2ZW50LiAqL1xuICBhc3luYyBwYXRjaEV2ZW50KFxuICAgIHN1YmplY3Q6IHN0cmluZyxcbiAgICBjYWxlbmRhcklkOiBzdHJpbmcsXG4gICAgZXZlbnRJZDogc3RyaW5nLFxuICAgIHBhdGNoOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcbiAgICBwOiB7IHNlbmRVcGRhdGVzPzogc3RyaW5nIH0gPSB7fSxcbiAgKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4ge1xuICAgIHJldHVybiB0aGlzLnJlcXVlc3QoXG4gICAgICAnY2FsZW5kYXInLFxuICAgICAgJ1BBVENIJyxcbiAgICAgIGAvY2FsZW5kYXJzLyR7ZW5jb2RlVVJJQ29tcG9uZW50KGNhbGVuZGFySWQpfS9ldmVudHMvJHtlbmNvZGVVUklDb21wb25lbnQoZXZlbnRJZCl9YCxcbiAgICAgIHsgc3ViamVjdCwgcXVlcnk6IHsgc2VuZFVwZGF0ZXM6IHAuc2VuZFVwZGF0ZXMgfSwgYm9keTogcGF0Y2ggfSxcbiAgICApO1xuICB9XG5cbiAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAvLyBHbWFpbCBBUEkgdjEgKHVzZXJJZCAnbWUnIHJlc29sdmVzIHRvIHRoZSBpbXBlcnNvbmF0ZWQgc3ViamVjdClcbiAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gIGFzeW5jIHNlYXJjaE1lc3NhZ2VzKFxuICAgIHN1YmplY3Q6IHN0cmluZyxcbiAgICBwOiB7IHE/OiBzdHJpbmc7IG1heFJlc3VsdHM/OiBudW1iZXI7IGxhYmVsSWRzPzogcmVhZG9ubHkgc3RyaW5nW107IHBhZ2VUb2tlbj86IHN0cmluZyB9LFxuICApOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB7XG4gICAgcmV0dXJuIHRoaXMucmVxdWVzdCgnZ21haWwnLCAnR0VUJywgJy91c2Vycy9tZS9tZXNzYWdlcycsIHtcbiAgICAgIHN1YmplY3QsXG4gICAgICBxdWVyeToge1xuICAgICAgICBxOiBwLnEsXG4gICAgICAgIG1heFJlc3VsdHM6IHAubWF4UmVzdWx0cyxcbiAgICAgICAgbGFiZWxJZHM6IHAubGFiZWxJZHMsXG4gICAgICAgIHBhZ2VUb2tlbjogcC5wYWdlVG9rZW4sXG4gICAgICB9LFxuICAgIH0pO1xuICB9XG5cbiAgYXN5bmMgZ2V0TWVzc2FnZShcbiAgICBzdWJqZWN0OiBzdHJpbmcsXG4gICAgaWQ6IHN0cmluZyxcbiAgICBwOiB7IGZvcm1hdD86IHN0cmluZyB9ID0ge30sXG4gICk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcbiAgICByZXR1cm4gdGhpcy5yZXF1ZXN0KCdnbWFpbCcsICdHRVQnLCBgL3VzZXJzL21lL21lc3NhZ2VzLyR7ZW5jb2RlVVJJQ29tcG9uZW50KGlkKX1gLCB7XG4gICAgICBzdWJqZWN0LFxuICAgICAgcXVlcnk6IHsgZm9ybWF0OiBwLmZvcm1hdCA/PyAnZnVsbCcgfSxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKiBTZW5kIGEgbWVzc2FnZS4gYHJhd2AgaXMgYSBiYXNlNjR1cmwtZW5jb2RlZCBSRkMgMjgyMiBtZXNzYWdlLiAqL1xuICBhc3luYyBzZW5kTWVzc2FnZShzdWJqZWN0OiBzdHJpbmcsIHJhdzogc3RyaW5nKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4ge1xuICAgIHJldHVybiB0aGlzLnJlcXVlc3QoJ2dtYWlsJywgJ1BPU1QnLCAnL3VzZXJzL21lL21lc3NhZ2VzL3NlbmQnLCB7XG4gICAgICBzdWJqZWN0LFxuICAgICAgYm9keTogeyByYXcgfSxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKiBDcmVhdGUgYSBkcmFmdC4gYHJhd2AgaXMgYSBiYXNlNjR1cmwtZW5jb2RlZCBSRkMgMjgyMiBtZXNzYWdlLiAqL1xuICBhc3luYyBjcmVhdGVEcmFmdChzdWJqZWN0OiBzdHJpbmcsIHJhdzogc3RyaW5nKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4ge1xuICAgIHJldHVybiB0aGlzLnJlcXVlc3QoJ2dtYWlsJywgJ1BPU1QnLCAnL3VzZXJzL21lL2RyYWZ0cycsIHtcbiAgICAgIHN1YmplY3QsXG4gICAgICBib2R5OiB7IG1lc3NhZ2U6IHsgcmF3IH0gfSxcbiAgICB9KTtcbiAgfVxuXG4gIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgLy8gRHJpdmUgQVBJIHYzIC8gRG9jcyB2MSAvIFNoZWV0cyB2NFxuICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgYXN5bmMgc2VhcmNoRmlsZXMoXG4gICAgc3ViamVjdDogc3RyaW5nLFxuICAgIHA6IHsgcT86IHN0cmluZzsgcGFnZVNpemU/OiBudW1iZXI7IG9yZGVyQnk/OiBzdHJpbmc7IGZpZWxkcz86IHN0cmluZzsgcGFnZVRva2VuPzogc3RyaW5nIH0sXG4gICk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcbiAgICByZXR1cm4gdGhpcy5yZXF1ZXN0KCdkcml2ZScsICdHRVQnLCAnL2ZpbGVzJywge1xuICAgICAgc3ViamVjdCxcbiAgICAgIHF1ZXJ5OiB7XG4gICAgICAgIHE6IHAucSxcbiAgICAgICAgcGFnZVNpemU6IHAucGFnZVNpemUsXG4gICAgICAgIG9yZGVyQnk6IHAub3JkZXJCeSxcbiAgICAgICAgZmllbGRzOlxuICAgICAgICAgIHAuZmllbGRzID8/XG4gICAgICAgICAgJ2ZpbGVzKGlkLG5hbWUsbWltZVR5cGUsbW9kaWZpZWRUaW1lLG93bmVycyhlbWFpbEFkZHJlc3MpLHdlYlZpZXdMaW5rLHNpemUpLG5leHRQYWdlVG9rZW4nLFxuICAgICAgICBwYWdlVG9rZW46IHAucGFnZVRva2VuLFxuICAgICAgICBzdXBwb3J0c0FsbERyaXZlczogdHJ1ZSxcbiAgICAgICAgaW5jbHVkZUl0ZW1zRnJvbUFsbERyaXZlczogdHJ1ZSxcbiAgICAgIH0sXG4gICAgfSk7XG4gIH1cblxuICBhc3luYyBnZXRGaWxlKFxuICAgIHN1YmplY3Q6IHN0cmluZyxcbiAgICBmaWxlSWQ6IHN0cmluZyxcbiAgICBwOiB7IGZpZWxkcz86IHN0cmluZyB9ID0ge30sXG4gICk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcbiAgICByZXR1cm4gdGhpcy5yZXF1ZXN0KCdkcml2ZScsICdHRVQnLCBgL2ZpbGVzLyR7ZW5jb2RlVVJJQ29tcG9uZW50KGZpbGVJZCl9YCwge1xuICAgICAgc3ViamVjdCxcbiAgICAgIHF1ZXJ5OiB7XG4gICAgICAgIGZpZWxkczpcbiAgICAgICAgICBwLmZpZWxkcyA/P1xuICAgICAgICAgICdpZCxuYW1lLG1pbWVUeXBlLG1vZGlmaWVkVGltZSxjcmVhdGVkVGltZSxvd25lcnMoZW1haWxBZGRyZXNzLGRpc3BsYXlOYW1lKSx3ZWJWaWV3TGluayxzaXplLGRlc2NyaXB0aW9uJyxcbiAgICAgICAgc3VwcG9ydHNBbGxEcml2ZXM6IHRydWUsXG4gICAgICB9LFxuICAgIH0pO1xuICB9XG5cbiAgYXN5bmMgZ2V0RG9jdW1lbnQoc3ViamVjdDogc3RyaW5nLCBkb2N1bWVudElkOiBzdHJpbmcpOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB7XG4gICAgcmV0dXJuIHRoaXMucmVxdWVzdCgnZG9jcycsICdHRVQnLCBgL2RvY3VtZW50cy8ke2VuY29kZVVSSUNvbXBvbmVudChkb2N1bWVudElkKX1gLCB7IHN1YmplY3QgfSk7XG4gIH1cblxuICBhc3luYyBnZXRTaGVldFZhbHVlcyhcbiAgICBzdWJqZWN0OiBzdHJpbmcsXG4gICAgc3ByZWFkc2hlZXRJZDogc3RyaW5nLFxuICAgIHJhbmdlOiBzdHJpbmcsXG4gICk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcbiAgICByZXR1cm4gdGhpcy5yZXF1ZXN0KFxuICAgICAgJ3NoZWV0cycsXG4gICAgICAnR0VUJyxcbiAgICAgIGAvc3ByZWFkc2hlZXRzLyR7ZW5jb2RlVVJJQ29tcG9uZW50KHNwcmVhZHNoZWV0SWQpfS92YWx1ZXMvJHtlbmNvZGVVUklDb21wb25lbnQocmFuZ2UpfWAsXG4gICAgICB7IHN1YmplY3QgfSxcbiAgICApO1xuICB9XG5cbiAgLyoqXG4gICAqIFdyaXRlIHZhbHVlcyBpbnRvIGEgU2hlZXRzIHJhbmdlLiBgbW9kZTogJ292ZXJ3cml0ZSdgIChkZWZhdWx0KSBQVVRzIHRoZVxuICAgKiByYW5nZSAoYHZhbHVlcy51cGRhdGVgKTsgYG1vZGU6ICdhcHBlbmQnYCBhcHBlbmRzIHJvd3MgYWZ0ZXIgdGhlIHRhYmxlXG4gICAqIChgdmFsdWVzLmFwcGVuZGAgd2l0aCBgSU5TRVJUX1JPV1NgKS4gYHZhbHVlSW5wdXRPcHRpb25gIGNvbnRyb2xzIHdoZXRoZXJcbiAgICogaW5wdXRzIGFyZSBwYXJzZWQgKGBVU0VSX0VOVEVSRURgKSBvciBzdG9yZWQgYXMtaXMgKGBSQVdgKS5cbiAgICovXG4gIGFzeW5jIHdyaXRlU2hlZXRWYWx1ZXMoXG4gICAgc3ViamVjdDogc3RyaW5nLFxuICAgIHNwcmVhZHNoZWV0SWQ6IHN0cmluZyxcbiAgICByYW5nZTogc3RyaW5nLFxuICAgIHZhbHVlczogdW5rbm93bltdW10sXG4gICAgcDogeyBtb2RlPzogJ292ZXJ3cml0ZScgfCAnYXBwZW5kJzsgdmFsdWVJbnB1dE9wdGlvbj86IHN0cmluZyB9ID0ge30sXG4gICk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcbiAgICBjb25zdCB2YWx1ZUlucHV0T3B0aW9uID0gcC52YWx1ZUlucHV0T3B0aW9uID8/ICdVU0VSX0VOVEVSRUQnO1xuICAgIGNvbnN0IGVuY29kZWQgPSBgL3NwcmVhZHNoZWV0cy8ke2VuY29kZVVSSUNvbXBvbmVudChzcHJlYWRzaGVldElkKX0vdmFsdWVzLyR7ZW5jb2RlVVJJQ29tcG9uZW50KHJhbmdlKX1gO1xuICAgIGNvbnN0IGJvZHkgPSB7IHJhbmdlLCBtYWpvckRpbWVuc2lvbjogJ1JPV1MnLCB2YWx1ZXMgfTtcbiAgICBpZiAocC5tb2RlID09PSAnYXBwZW5kJykge1xuICAgICAgcmV0dXJuIHRoaXMucmVxdWVzdCgnc2hlZXRzJywgJ1BPU1QnLCBgJHtlbmNvZGVkfTphcHBlbmRgLCB7XG4gICAgICAgIHN1YmplY3QsXG4gICAgICAgIHF1ZXJ5OiB7IHZhbHVlSW5wdXRPcHRpb24sIGluc2VydERhdGFPcHRpb246ICdJTlNFUlRfUk9XUycgfSxcbiAgICAgICAgYm9keSxcbiAgICAgIH0pO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcy5yZXF1ZXN0KCdzaGVldHMnLCAnUFVUJywgZW5jb2RlZCwge1xuICAgICAgc3ViamVjdCxcbiAgICAgIHF1ZXJ5OiB7IHZhbHVlSW5wdXRPcHRpb24gfSxcbiAgICAgIGJvZHksXG4gICAgfSk7XG4gIH1cblxuICAvKipcbiAgICogQ3JlYXRlIGEgRHJpdmUgZmlsZSBvciBmb2xkZXIuIE1ldGFkYXRhLW9ubHkgKG5vIGBjb250ZW50YCkgaXMgYSBwbGFpblxuICAgKiBgZmlsZXMuY3JlYXRlYCAoZm9sZGVycywgZW1wdHkgbmF0aXZlIEdvb2dsZSBmaWxlcykuIFdpdGggYGNvbnRlbnRgLCBhXG4gICAqIG11bHRpcGFydCBtZWRpYSB1cGxvYWQgaXMgdXNlZCBzbyB0aGUgYnl0ZXMgbGFuZCBpbiB0aGUgbmV3IGZpbGUgKHRleHRcbiAgICogY29udGVudDsgbmF0aXZlIEdvb2dsZSB0eXBlcyBhcmUgY29udmVydGVkIGZyb20gaXQpLlxuICAgKi9cbiAgYXN5bmMgY3JlYXRlRHJpdmVGaWxlKFxuICAgIHN1YmplY3Q6IHN0cmluZyxcbiAgICBwOiB7XG4gICAgICBuYW1lOiBzdHJpbmc7XG4gICAgICBtaW1lVHlwZTogc3RyaW5nO1xuICAgICAgcGFyZW50cz86IHJlYWRvbmx5IHN0cmluZ1tdO1xuICAgICAgY29udGVudD86IHN0cmluZztcbiAgICAgIGNvbnRlbnRNaW1lVHlwZT86IHN0cmluZztcbiAgICB9LFxuICApOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB7XG4gICAgY29uc3QgbWV0YWRhdGE6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0geyBuYW1lOiBwLm5hbWUsIG1pbWVUeXBlOiBwLm1pbWVUeXBlIH07XG4gICAgaWYgKHAucGFyZW50cyAmJiBwLnBhcmVudHMubGVuZ3RoID4gMCkgbWV0YWRhdGEucGFyZW50cyA9IHAucGFyZW50cztcbiAgICBjb25zdCBmaWVsZHMgPSAnaWQsbmFtZSxtaW1lVHlwZSx3ZWJWaWV3TGluayxwYXJlbnRzJztcblxuICAgIGlmIChwLmNvbnRlbnQgPT09IHVuZGVmaW5lZCkge1xuICAgICAgcmV0dXJuIHRoaXMucmVxdWVzdCgnZHJpdmUnLCAnUE9TVCcsICcvZmlsZXMnLCB7XG4gICAgICAgIHN1YmplY3QsXG4gICAgICAgIHF1ZXJ5OiB7IHN1cHBvcnRzQWxsRHJpdmVzOiB0cnVlLCBmaWVsZHMgfSxcbiAgICAgICAgYm9keTogbWV0YWRhdGEsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICAvLyBNdWx0aXBhcnQgbWVkaWEgdXBsb2FkOiBtZXRhZGF0YSBwYXJ0ICsgbWVkaWEgcGFydC5cbiAgICBjb25zdCBib3VuZGFyeSA9IGBvbWFkaWEtZ3ctJHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyKX1gO1xuICAgIGNvbnN0IHJhd0JvZHkgPSBbXG4gICAgICBgLS0ke2JvdW5kYXJ5fWAsXG4gICAgICAnQ29udGVudC1UeXBlOiBhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PVVURi04JyxcbiAgICAgICcnLFxuICAgICAgSlNPTi5zdHJpbmdpZnkobWV0YWRhdGEpLFxuICAgICAgYC0tJHtib3VuZGFyeX1gLFxuICAgICAgYENvbnRlbnQtVHlwZTogJHtwLmNvbnRlbnRNaW1lVHlwZSA/PyAndGV4dC9wbGFpbid9OyBjaGFyc2V0PVVURi04YCxcbiAgICAgICcnLFxuICAgICAgcC5jb250ZW50LFxuICAgICAgYC0tJHtib3VuZGFyeX0tLWAsXG4gICAgICAnJyxcbiAgICBdLmpvaW4oJ1xcclxcbicpO1xuICAgIHJldHVybiB0aGlzLnJlcXVlc3QoJ2RyaXZlJywgJ1BPU1QnLCAnaHR0cHM6Ly93d3cuZ29vZ2xlYXBpcy5jb20vdXBsb2FkL2RyaXZlL3YzL2ZpbGVzJywge1xuICAgICAgc3ViamVjdCxcbiAgICAgIHF1ZXJ5OiB7IHVwbG9hZFR5cGU6ICdtdWx0aXBhcnQnLCBzdXBwb3J0c0FsbERyaXZlczogdHJ1ZSwgZmllbGRzIH0sXG4gICAgICByYXdCb2R5LFxuICAgICAgY29udGVudFR5cGU6IGBtdWx0aXBhcnQvcmVsYXRlZDsgYm91bmRhcnk9JHtib3VuZGFyeX1gLFxuICAgIH0pO1xuICB9XG5cbiAgLyoqIFJlYWQgYSBzcHJlYWRzaGVldCdzIHRhYiBtZXRhZGF0YSAodGl0bGUgKyBwZXItdGFiIHNoZWV0SWQvdGl0bGUvaW5kZXgpLiBSRUFELiAqL1xuICBhc3luYyBnZXRTcHJlYWRzaGVldE1ldGEoXG4gICAgc3ViamVjdDogc3RyaW5nLFxuICAgIHNwcmVhZHNoZWV0SWQ6IHN0cmluZyxcbiAgKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4ge1xuICAgIHJldHVybiB0aGlzLnJlcXVlc3QoJ3NoZWV0cycsICdHRVQnLCBgL3NwcmVhZHNoZWV0cy8ke2VuY29kZVVSSUNvbXBvbmVudChzcHJlYWRzaGVldElkKX1gLCB7XG4gICAgICBzdWJqZWN0LFxuICAgICAgcXVlcnk6IHtcbiAgICAgICAgZmllbGRzOlxuICAgICAgICAgICdwcm9wZXJ0aWVzKHRpdGxlKSxzaGVldHMocHJvcGVydGllcyhzaGVldElkLHRpdGxlLGluZGV4LGdyaWRQcm9wZXJ0aWVzKHJvd0NvdW50LGNvbHVtbkNvdW50KSkpJyxcbiAgICAgIH0sXG4gICAgfSk7XG4gIH1cblxuICAvKipcbiAgICogUnVuIGEgU2hlZXRzIGBzcHJlYWRzaGVldHMuYmF0Y2hVcGRhdGVgIChlLmcuIGBhZGRTaGVldGAsIGBkdXBsaWNhdGVTaGVldGApLlxuICAgKiBXUklURS4gUmV0dXJucyB0aGUgcmF3IHJlcGx5IHNvIGNhbGxlcnMgY2FuIHJlYWQgYmFjayBlLmcuIHRoZSBuZXcgc2hlZXRJZC5cbiAgICovXG4gIGFzeW5jIGJhdGNoVXBkYXRlU3ByZWFkc2hlZXQoXG4gICAgc3ViamVjdDogc3RyaW5nLFxuICAgIHNwcmVhZHNoZWV0SWQ6IHN0cmluZyxcbiAgICByZXF1ZXN0czogdW5rbm93bltdLFxuICApOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB7XG4gICAgcmV0dXJuIHRoaXMucmVxdWVzdChcbiAgICAgICdzaGVldHMnLFxuICAgICAgJ1BPU1QnLFxuICAgICAgYC9zcHJlYWRzaGVldHMvJHtlbmNvZGVVUklDb21wb25lbnQoc3ByZWFkc2hlZXRJZCl9OmJhdGNoVXBkYXRlYCxcbiAgICAgIHsgc3ViamVjdCwgYm9keTogeyByZXF1ZXN0cyB9IH0sXG4gICAgKTtcbiAgfVxuXG4gIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgLy8gQWRtaW4gRGlyZWN0b3J5IHYxIC8gUGVvcGxlIHYxXG4gIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICBhc3luYyBsaXN0RGlyZWN0b3J5VXNlcnMoXG4gICAgc3ViamVjdDogc3RyaW5nLFxuICAgIHA6IHtcbiAgICAgIGN1c3RvbWVyPzogc3RyaW5nO1xuICAgICAgZG9tYWluPzogc3RyaW5nO1xuICAgICAgcXVlcnk/OiBzdHJpbmc7XG4gICAgICBtYXhSZXN1bHRzPzogbnVtYmVyO1xuICAgICAgb3JkZXJCeT86IHN0cmluZztcbiAgICAgIHBhZ2VUb2tlbj86IHN0cmluZztcbiAgICB9LFxuICApOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB7XG4gICAgLy8gYGN1c3RvbWVyYCBhbmQgYGRvbWFpbmAgYXJlIG11dHVhbGx5IGV4Y2x1c2l2ZTsgZGVmYXVsdCB0byBteV9jdXN0b21lci5cbiAgICBjb25zdCB1c2VEb21haW4gPSBCb29sZWFuKHAuZG9tYWluKTtcbiAgICByZXR1cm4gdGhpcy5yZXF1ZXN0KCdkaXJlY3RvcnknLCAnR0VUJywgJy91c2VycycsIHtcbiAgICAgIHN1YmplY3QsXG4gICAgICBxdWVyeToge1xuICAgICAgICBjdXN0b21lcjogdXNlRG9tYWluID8gdW5kZWZpbmVkIDogcC5jdXN0b21lciB8fCAnbXlfY3VzdG9tZXInLFxuICAgICAgICBkb21haW46IHAuZG9tYWluLFxuICAgICAgICBxdWVyeTogcC5xdWVyeSxcbiAgICAgICAgbWF4UmVzdWx0czogcC5tYXhSZXN1bHRzLFxuICAgICAgICBvcmRlckJ5OiBwLm9yZGVyQnksXG4gICAgICAgIHBhZ2VUb2tlbjogcC5wYWdlVG9rZW4sXG4gICAgICAgIHByb2plY3Rpb246ICdiYXNpYycsXG4gICAgICAgIHZpZXdUeXBlOiAnYWRtaW5fdmlldycsXG4gICAgICB9LFxuICAgIH0pO1xuICB9XG5cbiAgYXN5bmMgc2VhcmNoQ29udGFjdHMoXG4gICAgc3ViamVjdDogc3RyaW5nLFxuICAgIHA6IHsgcXVlcnk6IHN0cmluZzsgcGFnZVNpemU/OiBudW1iZXI7IHJlYWRNYXNrPzogc3RyaW5nIH0sXG4gICk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcbiAgICBjb25zdCByZWFkTWFzayA9IHAucmVhZE1hc2sgPz8gJ25hbWVzLGVtYWlsQWRkcmVzc2VzLHBob25lTnVtYmVycyxvcmdhbml6YXRpb25zJztcbiAgICAvLyBQZW9wbGUgYHNlYXJjaENvbnRhY3RzYCByZXF1aXJlcyBhIHdhcm11cCAoZW1wdHktcXVlcnkpIHJlcXVlc3QgdG8gcHJpbWVcbiAgICAvLyB0aGUgc2VydmVyLXNpZGUgY2FjaGUgYmVmb3JlIHRoZSBmaXJzdCByZWFsIHNlYXJjaCwgb3RoZXJ3aXNlIHJlc3VsdHNcbiAgICAvLyBjb21lIGJhY2sgZW1wdHkuIEJlc3QtZWZmb3J0LCBvbmNlIHBlciBzdWJqZWN0IHBlciBwcm9jZXNzLlxuICAgIGlmICghdGhpcy53YXJtZWRDb250YWN0cy5oYXMoc3ViamVjdCkpIHtcbiAgICAgIHRoaXMud2FybWVkQ29udGFjdHMuYWRkKHN1YmplY3QpO1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgdGhpcy5yZXF1ZXN0KCdwZW9wbGUnLCAnR0VUJywgJy9wZW9wbGU6c2VhcmNoQ29udGFjdHMnLCB7XG4gICAgICAgICAgc3ViamVjdCxcbiAgICAgICAgICBxdWVyeTogeyBxdWVyeTogJycsIHJlYWRNYXNrIH0sXG4gICAgICAgIH0pO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8vIFdhcm11cCBpcyBiZXN0LWVmZm9ydDsgdGhlIHJlYWwgcXVlcnkgYmVsb3cgc3VyZmFjZXMgYW55IHJlYWwgZXJyb3IuXG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiB0aGlzLnJlcXVlc3QoJ3Blb3BsZScsICdHRVQnLCAnL3Blb3BsZTpzZWFyY2hDb250YWN0cycsIHtcbiAgICAgIHN1YmplY3QsXG4gICAgICBxdWVyeTogeyBxdWVyeTogcC5xdWVyeSwgcGFnZVNpemU6IHAucGFnZVNpemUsIHJlYWRNYXNrIH0sXG4gICAgfSk7XG4gIH1cbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBIZWxwZXJzXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqXG4gKiBCdWlsZCBhIHF1ZXJ5IHN0cmluZyBmcm9tIGEgZmxhdCByZWNvcmQuIGB1bmRlZmluZWRgIHZhbHVlcyBhcmUgc2tpcHBlZDtcbiAqIGFycmF5cyBleHBhbmQgaW50byByZXBlYXRlZCBwYXJhbXMgKGUuZy4gYGxhYmVsSWRzPUEmbGFiZWxJZHM9QmApLiBSZXR1cm5zXG4gKiBgJydgIHdoZW4gbm90aGluZyBpcyBzZXQuXG4gKi9cbmZ1bmN0aW9uIGJ1aWxkUXVlcnlTdHJpbmcocXVlcnk6IFJlY29yZDxzdHJpbmcsIFF1ZXJ5VmFsdWU+IHwgdW5kZWZpbmVkKTogc3RyaW5nIHtcbiAgaWYgKCFxdWVyeSkgcmV0dXJuICcnO1xuICBjb25zdCBzcCA9IG5ldyBVUkxTZWFyY2hQYXJhbXMoKTtcbiAgZm9yIChjb25zdCBba2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMocXVlcnkpKSB7XG4gICAgaWYgKHZhbHVlID09PSB1bmRlZmluZWQpIGNvbnRpbnVlO1xuICAgIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgZm9yIChjb25zdCB2IG9mIHZhbHVlKSBzcC5hcHBlbmQoa2V5LCBTdHJpbmcodikpO1xuICAgIH0gZWxzZSB7XG4gICAgICBzcC5hcHBlbmQoa2V5LCBTdHJpbmcodmFsdWUpKTtcbiAgICB9XG4gIH1cbiAgY29uc3QgcyA9IHNwLnRvU3RyaW5nKCk7XG4gIHJldHVybiBzID8gYD8ke3N9YCA6ICcnO1xufVxuXG4vKiogUHJvbWlzZS1iYXNlZCBzbGVlcCB1c2VkIGZvciByZXRyeSBiYWNrb2ZmLiAqL1xuZnVuY3Rpb24gc2xlZXAobXM6IG51bWJlcik6IFByb21pc2U8dm9pZD4ge1xuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHNldFRpbWVvdXQocmVzb2x2ZSwgbXMpKTtcbn1cbiIsICIvKipcbiAqIFNoYXJlZCBkZXBlbmRlbmN5IGJ1bmRsZSBoYW5kZWQgdG8gZXZlcnkgdG9vbCBoYW5kbGVyIGZhY3RvcnksIHBsdXMgdGhlXG4gKiBzdWJqZWN0LXJlc29sdXRpb24gcnVsZSB1c2VkIGFjcm9zcyBhbGwgc3VyZmFjZXMuXG4gKlxuICogSW1wZXJzb25hdGlvbiBzdWJqZWN0IHByZWNlZGVuY2U6XG4gKiAgIDEuIHRoZSBleHBsaWNpdCBgdXNlcmAgYXJndW1lbnQgb24gdGhlIHRvb2wgY2FsbCAoYW4gZW1haWwpLCBpZiBnaXZlbjtcbiAqICAgMi4gdGhlIGFkbWluIHN1YmplY3QgZm9yIGRpcmVjdG9yeS9hZG1pbiByZWFkcyAoYGFkbWluOiB0cnVlYCk7XG4gKiAgIDMuIHRoZSBkZWZhdWx0IHN1YmplY3QgZnJvbSBjb25maWcuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBHb29nbGVXb3Jrc3BhY2VDbGllbnQgfSBmcm9tICcuL2dvb2dsZUNsaWVudC5qcyc7XG5pbXBvcnQgdHlwZSB7IFJlc3BvbnNlQ2FjaGUgfSBmcm9tICcuL3Jlc3BvbnNlQ2FjaGUuanMnO1xuaW1wb3J0IHsgR29vZ2xlSW5wdXRFcnJvciB9IGZyb20gJy4vZXJyb3JzLmpzJztcblxuZXhwb3J0IGludGVyZmFjZSBUb29sRGVwcyB7XG4gIHJlYWRvbmx5IGNsaWVudDogR29vZ2xlV29ya3NwYWNlQ2xpZW50O1xuICByZWFkb25seSBjYWNoZTogUmVzcG9uc2VDYWNoZTtcbiAgLyoqIERlZmF1bHQgdXNlciB0aGUgaW50ZWdyYXRpb24gYWN0cyBhcyB3aGVuIGEgdG9vbCBvbWl0cyBgdXNlcmAuICovXG4gIHJlYWRvbmx5IGRlZmF1bHRTdWJqZWN0OiBzdHJpbmc7XG4gIC8qKiBBZG1pbiB1c2VyIGltcGVyc29uYXRlZCBmb3IgRGlyZWN0b3J5L0FkbWluIFNESyByZWFkcy4gKi9cbiAgcmVhZG9ubHkgYWRtaW5TdWJqZWN0OiBzdHJpbmc7XG59XG5cbi8qKiBSZXNvbHZlIHRoZSBpbXBlcnNvbmF0aW9uIHN1YmplY3QgZm9yIGEgdG9vbCBjYWxsLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVTdWJqZWN0KFxuICBkZXBzOiBUb29sRGVwcyxcbiAgdXNlcjogdW5rbm93bixcbiAgb3B0czogeyBhZG1pbj86IGJvb2xlYW4gfSA9IHt9LFxuKTogc3RyaW5nIHtcbiAgY29uc3QgdSA9IHR5cGVvZiB1c2VyID09PSAnc3RyaW5nJyA/IHVzZXIudHJpbSgpIDogJyc7XG4gIGlmICh1KSB7XG4gICAgaWYgKCF1LmluY2x1ZGVzKCdAJykpIHtcbiAgICAgIHRocm93IG5ldyBHb29nbGVJbnB1dEVycm9yKGBcInVzZXJcIiBtdXN0IGJlIGEgZnVsbCBlbWFpbCBhZGRyZXNzLCBnb3Q6ICcke3V9J2ApO1xuICAgIH1cbiAgICByZXR1cm4gdTtcbiAgfVxuICBjb25zdCBmYWxsYmFjayA9IG9wdHMuYWRtaW4gPyBkZXBzLmFkbWluU3ViamVjdCA6IGRlcHMuZGVmYXVsdFN1YmplY3Q7XG4gIGlmICghZmFsbGJhY2spIHtcbiAgICB0aHJvdyBuZXcgR29vZ2xlSW5wdXRFcnJvcihcbiAgICAgIG9wdHMuYWRtaW5cbiAgICAgICAgPyAnbm8gYWRtaW4gdXNlciBjb25maWd1cmVkIFx1MjAxNCBzZXQgZ3dfYWRtaW5fc3ViamVjdCAob3IgZ3dfc3ViamVjdF9kZWZhdWx0KSBvciBwYXNzIFwidXNlclwiLidcbiAgICAgICAgOiAnbm8gZGVmYXVsdCB1c2VyIGNvbmZpZ3VyZWQgXHUyMDE0IHNldCBnd19zdWJqZWN0X2RlZmF1bHQgb3IgcGFzcyBcInVzZXJcIi4nLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIGZhbGxiYWNrO1xufVxuIiwgIi8qKlxuICogR29vZ2xlIERyaXZlIC8gRG9jcyAvIFNoZWV0cyB0b29scyAoYWxsIFJFQUQtT05MWSBpbiB2MSkuXG4gKlxuICogICAtIGBnd19kcml2ZV9zZWFyY2hgICAgXHUyMDE0IGZpbmQgZmlsZXMvZm9sZGVycyB3aXRoIERyaXZlIHF1ZXJ5IHN5bnRheC5cbiAqICAgLSBgZ3dfZHJpdmVfZ2V0X2ZpbGVgIFx1MjAxNCBmaWxlIG1ldGFkYXRhIGJ5IGlkLlxuICogICAtIGBnd19kb2NfcmVhZGAgICAgICAgXHUyMDE0IGEgR29vZ2xlIERvYydzIHRleHQgY29udGVudCAoZmxhdHRlbmVkKS5cbiAqICAgLSBgZ3dfc2hlZXRfcmVhZGAgICAgIFx1MjAxNCB2YWx1ZXMgZnJvbSBhIFNoZWV0cyByYW5nZS5cbiAqXG4gKiBBbGwgcmVhZHMgZ28gdGhyb3VnaCB0aGUgc2hvcnQtVFRMIGNhY2hlIGtleWVkIGJ5IHRoZSBpbXBlcnNvbmF0ZWQgc3ViamVjdC5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IE5hdGl2ZVRvb2xIYW5kbGVyLCBOYXRpdmVUb29sU3BlYyB9IGZyb20gJ0BvbWFkaWEvcGx1Z2luLWFwaSc7XG5cbmltcG9ydCB7IGZvcm1hdFRvb2xFcnJvciwgR29vZ2xlSW5wdXRFcnJvciB9IGZyb20gJy4vZXJyb3JzLmpzJztcbmltcG9ydCB7IHJlc29sdmVTdWJqZWN0LCB0eXBlIFRvb2xEZXBzIH0gZnJvbSAnLi90b29sRGVwcy5qcyc7XG5cbmNvbnN0IE1BWF9SRVNVTFRTID0gNTA7XG5jb25zdCBERUZBVUxUX1JFU1VMVFMgPSAyMDtcblxuZnVuY3Rpb24gY2xhbXAodmFsdWU6IHVua25vd24sIGRlZjogbnVtYmVyLCBtYXg6IG51bWJlcik6IG51bWJlciB7XG4gIGNvbnN0IG4gPSB0eXBlb2YgdmFsdWUgPT09ICdudW1iZXInID8gdmFsdWUgOiBOdW1iZXIodmFsdWUpO1xuICBpZiAoIU51bWJlci5pc0Zpbml0ZShuKSB8fCBuIDw9IDApIHJldHVybiBkZWY7XG4gIHJldHVybiBNYXRoLm1pbihNYXRoLmZsb29yKG4pLCBtYXgpO1xufVxuZnVuY3Rpb24gc3RyKHZhbHVlOiB1bmtub3duKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycgJiYgdmFsdWUudHJpbSgpID8gdmFsdWUudHJpbSgpIDogdW5kZWZpbmVkO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIGd3X2RyaXZlX3NlYXJjaFxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5leHBvcnQgY29uc3QgZHJpdmVTZWFyY2hTcGVjOiBOYXRpdmVUb29sU3BlYyA9IHtcbiAgbmFtZTogJ2d3X2RyaXZlX3NlYXJjaCcsXG4gIGRlc2NyaXB0aW9uOlxuICAgICdTZWFyY2ggR29vZ2xlIERyaXZlIHVzaW5nIERyaXZlIHF1ZXJ5IHN5bnRheC4gUkVBRC1PTkxZLiBFeGFtcGxlczogXCJuYW1lIGNvbnRhaW5zIFxcJ2J1ZGdldFxcJ1wiLCBcIm1pbWVUeXBlPVxcJ2FwcGxpY2F0aW9uL3ZuZC5nb29nbGUtYXBwcy5kb2N1bWVudFxcJ1wiLCBcIlxcJ21lXFwnIGluIG93bmVycyBhbmQgbW9kaWZpZWRUaW1lID4gXFwnMjAyNi0wMS0wMVQwMDowMDowMFxcJ1wiLiBSZXR1cm5zIGZpbGUgbWV0YWRhdGEgKGlkLCBuYW1lLCBtaW1lVHlwZSwgbW9kaWZpZWRUaW1lLCBvd25lciwgbGluaykuJyxcbiAgaW5wdXRfc2NoZW1hOiB7XG4gICAgdHlwZTogJ29iamVjdCcsXG4gICAgcHJvcGVydGllczoge1xuICAgICAgdXNlcjogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICdEcml2ZSBvd25lciB0byBpbXBlcnNvbmF0ZSAoZW1haWwpLiBPbWl0IGZvciBkZWZhdWx0LicgfSxcbiAgICAgIHE6IHtcbiAgICAgICAgdHlwZTogJ3N0cmluZycsXG4gICAgICAgIGRlc2NyaXB0aW9uOlxuICAgICAgICAgIFwiRHJpdmUgcXVlcnkuIGUuZy4gXFxcIm5hbWUgY29udGFpbnMgJ3JlcG9ydCcgYW5kIHRyYXNoZWQ9ZmFsc2VcXFwiLiBPbWl0IHRvIGxpc3QgcmVjZW50IGZpbGVzLlwiLFxuICAgICAgfSxcbiAgICAgIG9yZGVyQnk6IHtcbiAgICAgICAgdHlwZTogJ3N0cmluZycsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAnU29ydCwgZS5nLiBcIm1vZGlmaWVkVGltZSBkZXNjXCIsIFwibmFtZVwiLiBEZWZhdWx0IFwibW9kaWZpZWRUaW1lIGRlc2NcIi4nLFxuICAgICAgfSxcbiAgICAgIHBhZ2VTaXplOiB7IHR5cGU6ICdudW1iZXInLCBkZXNjcmlwdGlvbjogYE1heCBmaWxlcyBwZXIgcGFnZSAoMVx1MjAxMyR7TUFYX1JFU1VMVFN9LCBkZWZhdWx0ICR7REVGQVVMVF9SRVNVTFRTfSkuYCB9LFxuICAgICAgcGFnZVRva2VuOiB7XG4gICAgICAgIHR5cGU6ICdzdHJpbmcnLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ1BhZ2UgY3Vyc29yIGZyb20gYSBwcmV2aW91cyBjYWxsXFwncyBcIm5leHRQYWdlVG9rZW5cIiB0byBmZXRjaCB0aGUgbmV4dCBwYWdlLicsXG4gICAgICB9LFxuICAgIH0sXG4gICAgcmVxdWlyZWQ6IFtdLFxuICB9LFxufTtcblxuZXhwb3J0IGNvbnN0IERSSVZFX1NFQVJDSF9QUk9NUFRfRE9DID1cbiAgJ1xcbi0gYGd3X2RyaXZlX3NlYXJjaGA6IFJFQUQtT05MWSBHb29nbGUgRHJpdmUgc2VhcmNoIChEcml2ZSBxdWVyeSBzeW50YXg6IGBuYW1lIGNvbnRhaW5zIFxcJ3hcXCdgLCBgbWltZVR5cGU9XFwnXHUyMDI2XFwnYCwgYG1vZGlmaWVkVGltZSA+IFxcJ1x1MjAyNlxcJ2ApLiBSZXR1cm5zIGZpbGUgbWV0YWRhdGEgKyBpZHM7IHVzZSB0aGUgaWQgd2l0aCBgZ3dfZHJpdmVfZ2V0X2ZpbGVgLCBgZ3dfZG9jX3JlYWRgIG9yIGBnd19zaGVldF9yZWFkYC5cXG4nO1xuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlRHJpdmVTZWFyY2hIYW5kbGVyKGRlcHM6IFRvb2xEZXBzKTogTmF0aXZlVG9vbEhhbmRsZXIge1xuICByZXR1cm4gYXN5bmMgKHJhdzogdW5rbm93bik6IFByb21pc2U8c3RyaW5nPiA9PiB7XG4gICAgY29uc3QgaW5wdXQgPSAocmF3ID8/IHt9KSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICB0cnkge1xuICAgICAgY29uc3Qgc3ViamVjdCA9IHJlc29sdmVTdWJqZWN0KGRlcHMsIGlucHV0LnVzZXIpO1xuICAgICAgY29uc3QgcGFyYW1zID0ge1xuICAgICAgICBxOiBzdHIoaW5wdXQucSksXG4gICAgICAgIG9yZGVyQnk6IHN0cihpbnB1dC5vcmRlckJ5KSA/PyAnbW9kaWZpZWRUaW1lIGRlc2MnLFxuICAgICAgICBwYWdlU2l6ZTogY2xhbXAoaW5wdXQucGFnZVNpemUsIERFRkFVTFRfUkVTVUxUUywgTUFYX1JFU1VMVFMpLFxuICAgICAgICBwYWdlVG9rZW46IHN0cihpbnB1dC5wYWdlVG9rZW4pLFxuICAgICAgfTtcbiAgICAgIGNvbnN0IGtleSA9IGBkcml2ZTpzZWFyY2g6JHtzdWJqZWN0fToke0pTT04uc3RyaW5naWZ5KHBhcmFtcyl9YDtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRlcHMuY2FjaGUuZ2V0T3JTZXQoa2V5LCAoKSA9PiBkZXBzLmNsaWVudC5zZWFyY2hGaWxlcyhzdWJqZWN0LCBwYXJhbXMpKTtcbiAgICAgIGNvbnN0IGZpbGVzID0gKHJlc3VsdC5maWxlcyBhcyB1bmtub3duW10pID8/IFtdO1xuICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KFxuICAgICAgICB7IHN1YmplY3QsIGNvdW50OiBmaWxlcy5sZW5ndGgsIG5leHRQYWdlVG9rZW46IHJlc3VsdC5uZXh0UGFnZVRva2VuLCBmaWxlcyB9LFxuICAgICAgICBudWxsLFxuICAgICAgICAyLFxuICAgICAgKTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIHJldHVybiBmb3JtYXRUb29sRXJyb3IoZXJyKTtcbiAgICB9XG4gIH07XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gZ3dfZHJpdmVfZ2V0X2ZpbGVcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuZXhwb3J0IGNvbnN0IGRyaXZlR2V0RmlsZVNwZWM6IE5hdGl2ZVRvb2xTcGVjID0ge1xuICBuYW1lOiAnZ3dfZHJpdmVfZ2V0X2ZpbGUnLFxuICBkZXNjcmlwdGlvbjpcbiAgICAnR2V0IG1ldGFkYXRhIGZvciBvbmUgR29vZ2xlIERyaXZlIGZpbGUgYnkgaWQgKG5hbWUsIG1pbWVUeXBlLCBvd25lcnMsIHRpbWVzdGFtcHMsIGxpbmssIHNpemUpLiBSRUFELU9OTFkuIEZvciBkb2N1bWVudCB0ZXh0IHVzZSBnd19kb2NfcmVhZDsgZm9yIHNwcmVhZHNoZWV0IHZhbHVlcyB1c2UgZ3dfc2hlZXRfcmVhZC4nLFxuICBpbnB1dF9zY2hlbWE6IHtcbiAgICB0eXBlOiAnb2JqZWN0JyxcbiAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICB1c2VyOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ0RyaXZlIG93bmVyIHRvIGltcGVyc29uYXRlIChlbWFpbCkuIE9taXQgZm9yIGRlZmF1bHQuJyB9LFxuICAgICAgZmlsZUlkOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ0RyaXZlIGZpbGUgaWQgKHJlcXVpcmVkKS4nIH0sXG4gICAgfSxcbiAgICByZXF1aXJlZDogWydmaWxlSWQnXSxcbiAgfSxcbn07XG5cbmV4cG9ydCBjb25zdCBEUklWRV9HRVRfRklMRV9QUk9NUFRfRE9DID1cbiAgJ1xcbi0gYGd3X2RyaXZlX2dldF9maWxlYDogUkVBRC1PTkxZIFx1MjAxNCBtZXRhZGF0YSBmb3Igb25lIERyaXZlIGZpbGUgYnkgYGZpbGVJZGAuIEZvciBEb2MgdGV4dCB1c2UgYGd3X2RvY19yZWFkYDsgZm9yIFNoZWV0IHZhbHVlcyB1c2UgYGd3X3NoZWV0X3JlYWRgLlxcbic7XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVEcml2ZUdldEZpbGVIYW5kbGVyKGRlcHM6IFRvb2xEZXBzKTogTmF0aXZlVG9vbEhhbmRsZXIge1xuICByZXR1cm4gYXN5bmMgKHJhdzogdW5rbm93bik6IFByb21pc2U8c3RyaW5nPiA9PiB7XG4gICAgY29uc3QgaW5wdXQgPSAocmF3ID8/IHt9KSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICB0cnkge1xuICAgICAgY29uc3Qgc3ViamVjdCA9IHJlc29sdmVTdWJqZWN0KGRlcHMsIGlucHV0LnVzZXIpO1xuICAgICAgY29uc3QgZmlsZUlkID0gc3RyKGlucHV0LmZpbGVJZCk7XG4gICAgICBpZiAoIWZpbGVJZCkgdGhyb3cgbmV3IEdvb2dsZUlucHV0RXJyb3IoJ1wiZmlsZUlkXCIgaXMgcmVxdWlyZWQuJyk7XG4gICAgICBjb25zdCBrZXkgPSBgZHJpdmU6ZmlsZToke3N1YmplY3R9OiR7ZmlsZUlkfWA7XG4gICAgICBjb25zdCBmaWxlID0gYXdhaXQgZGVwcy5jYWNoZS5nZXRPclNldChrZXksICgpID0+IGRlcHMuY2xpZW50LmdldEZpbGUoc3ViamVjdCwgZmlsZUlkKSk7XG4gICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoeyBzdWJqZWN0LCBmaWxlIH0sIG51bGwsIDIpO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgcmV0dXJuIGZvcm1hdFRvb2xFcnJvcihlcnIpO1xuICAgIH1cbiAgfTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBnd19kb2NfcmVhZFxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5leHBvcnQgY29uc3QgZG9jUmVhZFNwZWM6IE5hdGl2ZVRvb2xTcGVjID0ge1xuICBuYW1lOiAnZ3dfZG9jX3JlYWQnLFxuICBkZXNjcmlwdGlvbjpcbiAgICBcIlJlYWQgYSBHb29nbGUgRG9jJ3MgdGV4dCBjb250ZW50IGJ5IGRvY3VtZW50IGlkLiBSRUFELU9OTFkuIFJldHVybnMgdGhlIHRpdGxlIGFuZCB0aGUgZmxhdHRlbmVkIHBsYWluIHRleHQgb2YgdGhlIGJvZHkgKGNhcHBlZCkuIFVzZSBnd19kcml2ZV9zZWFyY2ggdG8gZmluZCB0aGUgZG9jdW1lbnQgaWQuXCIsXG4gIGlucHV0X3NjaGVtYToge1xuICAgIHR5cGU6ICdvYmplY3QnLFxuICAgIHByb3BlcnRpZXM6IHtcbiAgICAgIHVzZXI6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAnT3duZXIgdG8gaW1wZXJzb25hdGUgKGVtYWlsKS4gT21pdCBmb3IgZGVmYXVsdC4nIH0sXG4gICAgICBkb2N1bWVudElkOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ0dvb2dsZSBEb2MgaWQgKHJlcXVpcmVkKS4nIH0sXG4gICAgfSxcbiAgICByZXF1aXJlZDogWydkb2N1bWVudElkJ10sXG4gIH0sXG59O1xuXG5leHBvcnQgY29uc3QgRE9DX1JFQURfUFJPTVBUX0RPQyA9XG4gICdcXG4tIGBnd19kb2NfcmVhZGA6IFJFQUQtT05MWSBcdTIwMTQgZmxhdHRlbiBhIEdvb2dsZSBEb2MgdG8gcGxhaW4gdGV4dCBieSBgZG9jdW1lbnRJZGAgKGZpbmQgaXQgdmlhIGBnd19kcml2ZV9zZWFyY2hgKS5cXG4nO1xuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlRG9jUmVhZEhhbmRsZXIoZGVwczogVG9vbERlcHMpOiBOYXRpdmVUb29sSGFuZGxlciB7XG4gIHJldHVybiBhc3luYyAocmF3OiB1bmtub3duKTogUHJvbWlzZTxzdHJpbmc+ID0+IHtcbiAgICBjb25zdCBpbnB1dCA9IChyYXcgPz8ge30pIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBzdWJqZWN0ID0gcmVzb2x2ZVN1YmplY3QoZGVwcywgaW5wdXQudXNlcik7XG4gICAgICBjb25zdCBkb2N1bWVudElkID0gc3RyKGlucHV0LmRvY3VtZW50SWQpO1xuICAgICAgaWYgKCFkb2N1bWVudElkKSB0aHJvdyBuZXcgR29vZ2xlSW5wdXRFcnJvcignXCJkb2N1bWVudElkXCIgaXMgcmVxdWlyZWQuJyk7XG4gICAgICBjb25zdCBrZXkgPSBgZG9jczpyZWFkOiR7c3ViamVjdH06JHtkb2N1bWVudElkfWA7XG4gICAgICBjb25zdCBkb2MgPSBhd2FpdCBkZXBzLmNhY2hlLmdldE9yU2V0KGtleSwgKCkgPT4gZGVwcy5jbGllbnQuZ2V0RG9jdW1lbnQoc3ViamVjdCwgZG9jdW1lbnRJZCkpO1xuICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KFxuICAgICAgICB7XG4gICAgICAgICAgc3ViamVjdCxcbiAgICAgICAgICBkb2N1bWVudElkLFxuICAgICAgICAgIHRpdGxlOiBkb2MudGl0bGUsXG4gICAgICAgICAgdGV4dDogZmxhdHRlbkRvY1RleHQoZG9jKS5zbGljZSgwLCA0MF8wMDApLFxuICAgICAgICB9LFxuICAgICAgICBudWxsLFxuICAgICAgICAyLFxuICAgICAgKTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIHJldHVybiBmb3JtYXRUb29sRXJyb3IoZXJyKTtcbiAgICB9XG4gIH07XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gZ3dfc2hlZXRfcmVhZFxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5leHBvcnQgY29uc3Qgc2hlZXRSZWFkU3BlYzogTmF0aXZlVG9vbFNwZWMgPSB7XG4gIG5hbWU6ICdnd19zaGVldF9yZWFkJyxcbiAgZGVzY3JpcHRpb246XG4gICAgJ1JlYWQgY2VsbCB2YWx1ZXMgZnJvbSBhIEdvb2dsZSBTaGVldHMgcmFuZ2UgKEExIG5vdGF0aW9uLCBlLmcuIFwiU2hlZXQxIUExOkQ1MFwiKS4gUkVBRC1PTkxZLiBSZXR1cm5zIGEgMkQgYXJyYXkgb2YgdmFsdWVzLicsXG4gIGlucHV0X3NjaGVtYToge1xuICAgIHR5cGU6ICdvYmplY3QnLFxuICAgIHByb3BlcnRpZXM6IHtcbiAgICAgIHVzZXI6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAnT3duZXIgdG8gaW1wZXJzb25hdGUgKGVtYWlsKS4gT21pdCBmb3IgZGVmYXVsdC4nIH0sXG4gICAgICBzcHJlYWRzaGVldElkOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ0dvb2dsZSBTaGVldHMgaWQgKHJlcXVpcmVkKS4nIH0sXG4gICAgICByYW5nZToge1xuICAgICAgICB0eXBlOiAnc3RyaW5nJyxcbiAgICAgICAgZGVzY3JpcHRpb246ICdBMSByYW5nZSwgZS5nLiBcIlNoZWV0MSFBMTpENTBcIiBvciBcIkE6Q1wiLiBSZXF1aXJlZC4nLFxuICAgICAgfSxcbiAgICB9LFxuICAgIHJlcXVpcmVkOiBbJ3NwcmVhZHNoZWV0SWQnLCAncmFuZ2UnXSxcbiAgfSxcbn07XG5cbmV4cG9ydCBjb25zdCBTSEVFVF9SRUFEX1BST01QVF9ET0MgPVxuICAnXFxuLSBgZ3dfc2hlZXRfcmVhZGA6IFJFQUQtT05MWSBcdTIwMTQgcmVhZCBhIEdvb2dsZSBTaGVldHMgcmFuZ2UgaW4gQTEgbm90YXRpb24gKGUuZy4gYFNoZWV0MSFBMTpENTBgKSBpbnRvIGEgMkQgYXJyYXkuXFxuJztcblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVNoZWV0UmVhZEhhbmRsZXIoZGVwczogVG9vbERlcHMpOiBOYXRpdmVUb29sSGFuZGxlciB7XG4gIHJldHVybiBhc3luYyAocmF3OiB1bmtub3duKTogUHJvbWlzZTxzdHJpbmc+ID0+IHtcbiAgICBjb25zdCBpbnB1dCA9IChyYXcgPz8ge30pIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBzdWJqZWN0ID0gcmVzb2x2ZVN1YmplY3QoZGVwcywgaW5wdXQudXNlcik7XG4gICAgICBjb25zdCBzcHJlYWRzaGVldElkID0gc3RyKGlucHV0LnNwcmVhZHNoZWV0SWQpO1xuICAgICAgY29uc3QgcmFuZ2UgPSBzdHIoaW5wdXQucmFuZ2UpO1xuICAgICAgaWYgKCFzcHJlYWRzaGVldElkKSB0aHJvdyBuZXcgR29vZ2xlSW5wdXRFcnJvcignXCJzcHJlYWRzaGVldElkXCIgaXMgcmVxdWlyZWQuJyk7XG4gICAgICBpZiAoIXJhbmdlKSB0aHJvdyBuZXcgR29vZ2xlSW5wdXRFcnJvcignXCJyYW5nZVwiIChBMSBub3RhdGlvbikgaXMgcmVxdWlyZWQuJyk7XG4gICAgICBjb25zdCBrZXkgPSBgc2hlZXRzOnJlYWQ6JHtzdWJqZWN0fToke3NwcmVhZHNoZWV0SWR9OiR7cmFuZ2V9YDtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRlcHMuY2FjaGUuZ2V0T3JTZXQoa2V5LCAoKSA9PlxuICAgICAgICBkZXBzLmNsaWVudC5nZXRTaGVldFZhbHVlcyhzdWJqZWN0LCBzcHJlYWRzaGVldElkLCByYW5nZSksXG4gICAgICApO1xuICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KFxuICAgICAgICB7IHN1YmplY3QsIHNwcmVhZHNoZWV0SWQsIHJhbmdlOiByZXN1bHQucmFuZ2UsIHZhbHVlczogcmVzdWx0LnZhbHVlcyA/PyBbXSB9LFxuICAgICAgICBudWxsLFxuICAgICAgICAyLFxuICAgICAgKTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIHJldHVybiBmb3JtYXRUb29sRXJyb3IoZXJyKTtcbiAgICB9XG4gIH07XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gZ3dfc2hlZXRfd3JpdGUgKHdyaXRlKVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5leHBvcnQgY29uc3Qgc2hlZXRXcml0ZVNwZWM6IE5hdGl2ZVRvb2xTcGVjID0ge1xuICBuYW1lOiAnZ3dfc2hlZXRfd3JpdGUnLFxuICBkZXNjcmlwdGlvbjpcbiAgICAnV3JpdGUgY2VsbCB2YWx1ZXMgaW50byBhIEdvb2dsZSBTaGVldHMgcmFuZ2UgKEExIG5vdGF0aW9uKS4gV1JJVEUgXHUyMDE0IG9ubHkgY2FsbCBhZnRlciB0aGUgdXNlciBjb25maXJtcyB0aGUgdGFyZ2V0IHNoZWV0LCByYW5nZSBhbmQgZGF0YS4gbW9kZSBcIm92ZXJ3cml0ZVwiIChkZWZhdWx0KSByZXBsYWNlcyB0aGUgcmFuZ2U7IG1vZGUgXCJhcHBlbmRcIiBhZGRzIHJvd3MgYWZ0ZXIgdGhlIGV4aXN0aW5nIHRhYmxlLiBWYWx1ZXMgYXJlIGEgMkQgYXJyYXkgKHJvd3Mgb2YgY2VsbHMpLicsXG4gIGlucHV0X3NjaGVtYToge1xuICAgIHR5cGU6ICdvYmplY3QnLFxuICAgIHByb3BlcnRpZXM6IHtcbiAgICAgIHVzZXI6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAnT3duZXIgdG8gaW1wZXJzb25hdGUgKGVtYWlsKS4gT21pdCBmb3IgZGVmYXVsdC4nIH0sXG4gICAgICBzcHJlYWRzaGVldElkOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ0dvb2dsZSBTaGVldHMgaWQgKHJlcXVpcmVkKS4nIH0sXG4gICAgICByYW5nZToge1xuICAgICAgICB0eXBlOiAnc3RyaW5nJyxcbiAgICAgICAgZGVzY3JpcHRpb246ICdBMSByYW5nZSwgZS5nLiBcIlNoZWV0MSFBMTpDM1wiIChvdmVyd3JpdGUpIG9yIFwiU2hlZXQxIUExXCIgKGFwcGVuZCBhbmNob3IpLiBSZXF1aXJlZC4nLFxuICAgICAgfSxcbiAgICAgIHZhbHVlczoge1xuICAgICAgICB0eXBlOiAnYXJyYXknLFxuICAgICAgICBpdGVtczogeyB0eXBlOiAnYXJyYXknLCBpdGVtczoge30gfSxcbiAgICAgICAgZGVzY3JpcHRpb246ICdSb3dzIG9mIGNlbGwgdmFsdWVzLCBlLmcuIFtbXCJOYW1lXCIsXCJUb3RhbFwiXSxbXCJBY21lXCIsNDJdXS4gUmVxdWlyZWQuJyxcbiAgICAgIH0sXG4gICAgICBtb2RlOiB7XG4gICAgICAgIHR5cGU6ICdzdHJpbmcnLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ1wib3ZlcndyaXRlXCIgKGRlZmF1bHQsIHJlcGxhY2VzIHRoZSByYW5nZSkgb3IgXCJhcHBlbmRcIiAoYWRkcyByb3dzIGFmdGVyIHRoZSB0YWJsZSkuJyxcbiAgICAgIH0sXG4gICAgICB2YWx1ZUlucHV0T3B0aW9uOiB7XG4gICAgICAgIHR5cGU6ICdzdHJpbmcnLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ1wiVVNFUl9FTlRFUkVEXCIgKGRlZmF1bHQsIHBhcnNlcyBmb3JtdWxhcy9kYXRlcykgb3IgXCJSQVdcIiAoc3RvcmUgbGl0ZXJhbGx5KS4nLFxuICAgICAgfSxcbiAgICB9LFxuICAgIHJlcXVpcmVkOiBbJ3NwcmVhZHNoZWV0SWQnLCAncmFuZ2UnLCAndmFsdWVzJ10sXG4gIH0sXG59O1xuXG5leHBvcnQgY29uc3QgU0hFRVRfV1JJVEVfUFJPTVBUX0RPQyA9XG4gICdcXG4tIGBnd19zaGVldF93cml0ZWA6IFdSSVRFIFx1MjAxNCB3cml0ZSBhIDJEIGB2YWx1ZXNgIGFycmF5IGludG8gYSBHb29nbGUgU2hlZXRzIGByYW5nZWAgKEExKS4gYG1vZGU6XCJvdmVyd3JpdGVcImAgcmVwbGFjZXMgdGhlIHJhbmdlLCBgbW9kZTpcImFwcGVuZFwiYCBhZGRzIHJvd3MgYWZ0ZXIgdGhlIHRhYmxlLiBDb25maXJtIHRoZSB0YXJnZXQgd2l0aCB0aGUgdXNlciBmaXJzdC5cXG4nO1xuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlU2hlZXRXcml0ZUhhbmRsZXIoZGVwczogVG9vbERlcHMpOiBOYXRpdmVUb29sSGFuZGxlciB7XG4gIHJldHVybiBhc3luYyAocmF3OiB1bmtub3duKTogUHJvbWlzZTxzdHJpbmc+ID0+IHtcbiAgICBjb25zdCBpbnB1dCA9IChyYXcgPz8ge30pIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBzdWJqZWN0ID0gcmVzb2x2ZVN1YmplY3QoZGVwcywgaW5wdXQudXNlcik7XG4gICAgICBjb25zdCBzcHJlYWRzaGVldElkID0gc3RyKGlucHV0LnNwcmVhZHNoZWV0SWQpO1xuICAgICAgY29uc3QgcmFuZ2UgPSBzdHIoaW5wdXQucmFuZ2UpO1xuICAgICAgaWYgKCFzcHJlYWRzaGVldElkKSB0aHJvdyBuZXcgR29vZ2xlSW5wdXRFcnJvcignXCJzcHJlYWRzaGVldElkXCIgaXMgcmVxdWlyZWQuJyk7XG4gICAgICBpZiAoIXJhbmdlKSB0aHJvdyBuZXcgR29vZ2xlSW5wdXRFcnJvcignXCJyYW5nZVwiIChBMSBub3RhdGlvbikgaXMgcmVxdWlyZWQuJyk7XG4gICAgICBpZiAoIUFycmF5LmlzQXJyYXkoaW5wdXQudmFsdWVzKSB8fCAhaW5wdXQudmFsdWVzLmV2ZXJ5KChyKSA9PiBBcnJheS5pc0FycmF5KHIpKSkge1xuICAgICAgICB0aHJvdyBuZXcgR29vZ2xlSW5wdXRFcnJvcignXCJ2YWx1ZXNcIiBtdXN0IGJlIGEgMkQgYXJyYXkgKHJvd3Mgb2YgY2VsbHMpLicpO1xuICAgICAgfVxuICAgICAgY29uc3QgbW9kZSA9IHN0cihpbnB1dC5tb2RlKSA9PT0gJ2FwcGVuZCcgPyAnYXBwZW5kJyA6ICdvdmVyd3JpdGUnO1xuICAgICAgY29uc3QgdmFsdWVJbnB1dE9wdGlvbiA9IHN0cihpbnB1dC52YWx1ZUlucHV0T3B0aW9uKSA9PT0gJ1JBVycgPyAnUkFXJyA6ICdVU0VSX0VOVEVSRUQnO1xuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZGVwcy5jbGllbnQud3JpdGVTaGVldFZhbHVlcyhcbiAgICAgICAgc3ViamVjdCxcbiAgICAgICAgc3ByZWFkc2hlZXRJZCxcbiAgICAgICAgcmFuZ2UsXG4gICAgICAgIGlucHV0LnZhbHVlcyBhcyB1bmtub3duW11bXSxcbiAgICAgICAgeyBtb2RlLCB2YWx1ZUlucHV0T3B0aW9uIH0sXG4gICAgICApO1xuICAgICAgZGVwcy5jYWNoZS5jbGVhcigpO1xuICAgICAgLy8gYHVwZGF0ZWAgcmV0dXJucyB1cGRhdGVkKiBhdCB0aGUgdG9wIGxldmVsOyBgYXBwZW5kYCBuZXN0cyB0aGVtIHVuZGVyIGB1cGRhdGVzYC5cbiAgICAgIGNvbnN0IHVwZGF0ZXMgPSAocmVzdWx0LnVwZGF0ZXMgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID8/IHJlc3VsdDtcbiAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeShcbiAgICAgICAge1xuICAgICAgICAgIHdyaXR0ZW46IHRydWUsXG4gICAgICAgICAgbW9kZSxcbiAgICAgICAgICBzcHJlYWRzaGVldElkLFxuICAgICAgICAgIHVwZGF0ZWRSYW5nZTogdXBkYXRlcy51cGRhdGVkUmFuZ2UsXG4gICAgICAgICAgdXBkYXRlZFJvd3M6IHVwZGF0ZXMudXBkYXRlZFJvd3MsXG4gICAgICAgICAgdXBkYXRlZENlbGxzOiB1cGRhdGVzLnVwZGF0ZWRDZWxscyxcbiAgICAgICAgfSxcbiAgICAgICAgbnVsbCxcbiAgICAgICAgMixcbiAgICAgICk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICByZXR1cm4gZm9ybWF0VG9vbEVycm9yKGVycik7XG4gICAgfVxuICB9O1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIGd3X2RyaXZlX2NyZWF0ZSAod3JpdGUpXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbmNvbnN0IERSSVZFX1RZUEVfTUlNRTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgZm9sZGVyOiAnYXBwbGljYXRpb24vdm5kLmdvb2dsZS1hcHBzLmZvbGRlcicsXG4gIGRvY3VtZW50OiAnYXBwbGljYXRpb24vdm5kLmdvb2dsZS1hcHBzLmRvY3VtZW50JyxcbiAgc3ByZWFkc2hlZXQ6ICdhcHBsaWNhdGlvbi92bmQuZ29vZ2xlLWFwcHMuc3ByZWFkc2hlZXQnLFxuICBwcmVzZW50YXRpb246ICdhcHBsaWNhdGlvbi92bmQuZ29vZ2xlLWFwcHMucHJlc2VudGF0aW9uJyxcbiAgZmlsZTogJ3RleHQvcGxhaW4nLFxufTtcblxuZXhwb3J0IGNvbnN0IGRyaXZlQ3JlYXRlU3BlYzogTmF0aXZlVG9vbFNwZWMgPSB7XG4gIG5hbWU6ICdnd19kcml2ZV9jcmVhdGUnLFxuICBkZXNjcmlwdGlvbjpcbiAgICAnQ3JlYXRlIGEgR29vZ2xlIERyaXZlIGl0ZW0uIFdSSVRFIFx1MjAxNCBvbmx5IGNhbGwgYWZ0ZXIgdGhlIHVzZXIgY29uZmlybXMuIFwidHlwZVwiOiBmb2xkZXIgfCBkb2N1bWVudCB8IHNwcmVhZHNoZWV0IHwgcHJlc2VudGF0aW9uIHwgZmlsZSAoZGVmYXVsdCBmb2xkZXIpLiBPcHRpb25hbCBcInBhcmVudElkXCIgcGxhY2VzIGl0IGluIGEgZm9sZGVyLCBcImNvbnRlbnRcIiBmaWxscyBhIHRleHQvZG9jdW1lbnQgYm9keSwgXCJtaW1lVHlwZVwiIG92ZXJyaWRlcyB0aGUgdHlwZS4gUmV0dXJucyB0aGUgbmV3IGl0ZW0gaWQgKyBsaW5rLicsXG4gIGlucHV0X3NjaGVtYToge1xuICAgIHR5cGU6ICdvYmplY3QnLFxuICAgIHByb3BlcnRpZXM6IHtcbiAgICAgIHVzZXI6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAnT3duZXIgdG8gaW1wZXJzb25hdGUgKGVtYWlsKS4gT21pdCBmb3IgZGVmYXVsdC4nIH0sXG4gICAgICBuYW1lOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ05hbWUvdGl0bGUgb2YgdGhlIG5ldyBpdGVtIChyZXF1aXJlZCkuJyB9LFxuICAgICAgdHlwZToge1xuICAgICAgICB0eXBlOiAnc3RyaW5nJyxcbiAgICAgICAgZGVzY3JpcHRpb246ICdmb2xkZXIgfCBkb2N1bWVudCB8IHNwcmVhZHNoZWV0IHwgcHJlc2VudGF0aW9uIHwgZmlsZS4gRGVmYXVsdCBmb2xkZXIuJyxcbiAgICAgIH0sXG4gICAgICBwYXJlbnRJZDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICdJZCBvZiB0aGUgcGFyZW50IGZvbGRlci4gT21pdCBmb3IgdGhlIGRyaXZlIHJvb3QuJyB9LFxuICAgICAgY29udGVudDoge1xuICAgICAgICB0eXBlOiAnc3RyaW5nJyxcbiAgICAgICAgZGVzY3JpcHRpb246ICdPcHRpb25hbCB0ZXh0IGNvbnRlbnQuIEZvciBcImZpbGVcIiBpdCBiZWNvbWVzIHRoZSBib2R5OyBmb3IgXCJkb2N1bWVudFwiIGl0IGlzIGltcG9ydGVkIGFzIHRoZSBkb2MgdGV4dC4nLFxuICAgICAgfSxcbiAgICAgIG1pbWVUeXBlOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ0FkdmFuY2VkOiBleHBsaWNpdCBNSU1FIHR5cGUsIG92ZXJyaWRlcyBcInR5cGVcIi4nIH0sXG4gICAgfSxcbiAgICByZXF1aXJlZDogWyduYW1lJ10sXG4gIH0sXG59O1xuXG5leHBvcnQgY29uc3QgRFJJVkVfQ1JFQVRFX1BST01QVF9ET0MgPVxuICAnXFxuLSBgZ3dfZHJpdmVfY3JlYXRlYDogV1JJVEUgXHUyMDE0IGNyZWF0ZSBhIERyaXZlIGl0ZW0gYnkgYG5hbWVgIGFuZCBgdHlwZWAgKGZvbGRlciB8IGRvY3VtZW50IHwgc3ByZWFkc2hlZXQgfCBwcmVzZW50YXRpb24gfCBmaWxlKS4gT3B0aW9uYWwgYHBhcmVudElkYCAoZm9sZGVyKSBhbmQgYGNvbnRlbnRgICh0ZXh0IGJvZHkgLyBkb2MgaW1wb3J0KS4gQ29uZmlybSB3aXRoIHRoZSB1c2VyIGZpcnN0Llxcbic7XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVEcml2ZUNyZWF0ZUhhbmRsZXIoZGVwczogVG9vbERlcHMpOiBOYXRpdmVUb29sSGFuZGxlciB7XG4gIHJldHVybiBhc3luYyAocmF3OiB1bmtub3duKTogUHJvbWlzZTxzdHJpbmc+ID0+IHtcbiAgICBjb25zdCBpbnB1dCA9IChyYXcgPz8ge30pIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBzdWJqZWN0ID0gcmVzb2x2ZVN1YmplY3QoZGVwcywgaW5wdXQudXNlcik7XG4gICAgICBjb25zdCBuYW1lID0gc3RyKGlucHV0Lm5hbWUpO1xuICAgICAgaWYgKCFuYW1lKSB0aHJvdyBuZXcgR29vZ2xlSW5wdXRFcnJvcignXCJuYW1lXCIgaXMgcmVxdWlyZWQuJyk7XG4gICAgICBjb25zdCB0eXBlID0gKHN0cihpbnB1dC50eXBlKSA/PyAnZm9sZGVyJykudG9Mb3dlckNhc2UoKTtcbiAgICAgIGNvbnN0IG1pbWVUeXBlID0gc3RyKGlucHV0Lm1pbWVUeXBlKSA/PyBEUklWRV9UWVBFX01JTUVbdHlwZV07XG4gICAgICBpZiAoIW1pbWVUeXBlKSB7XG4gICAgICAgIHRocm93IG5ldyBHb29nbGVJbnB1dEVycm9yKFxuICAgICAgICAgIGB1bmtub3duIFwidHlwZVwiOiAke3R5cGV9LiBVc2UgZm9sZGVyIHwgZG9jdW1lbnQgfCBzcHJlYWRzaGVldCB8IHByZXNlbnRhdGlvbiB8IGZpbGUsIG9yIHBhc3MgXCJtaW1lVHlwZVwiLmAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBjb25zdCBjb250ZW50ID0gdHlwZW9mIGlucHV0LmNvbnRlbnQgPT09ICdzdHJpbmcnID8gaW5wdXQuY29udGVudCA6IHVuZGVmaW5lZDtcbiAgICAgIGlmIChjb250ZW50ICE9PSB1bmRlZmluZWQgJiYgdHlwZSA9PT0gJ2ZvbGRlcicpIHtcbiAgICAgICAgdGhyb3cgbmV3IEdvb2dsZUlucHV0RXJyb3IoJ2EgZm9sZGVyIGNhbm5vdCBoYXZlIFwiY29udGVudFwiLicpO1xuICAgICAgfVxuICAgICAgY29uc3QgcGFyZW50cyA9IHN0cihpbnB1dC5wYXJlbnRJZCkgPyBbc3RyKGlucHV0LnBhcmVudElkKSBhcyBzdHJpbmddIDogdW5kZWZpbmVkO1xuICAgICAgY29uc3QgZmlsZSA9IGF3YWl0IGRlcHMuY2xpZW50LmNyZWF0ZURyaXZlRmlsZShzdWJqZWN0LCB7IG5hbWUsIG1pbWVUeXBlLCBwYXJlbnRzLCBjb250ZW50IH0pO1xuICAgICAgZGVwcy5jYWNoZS5jbGVhcigpO1xuICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KFxuICAgICAgICB7IGNyZWF0ZWQ6IHRydWUsIGlkOiBmaWxlLmlkLCBuYW1lOiBmaWxlLm5hbWUsIG1pbWVUeXBlOiBmaWxlLm1pbWVUeXBlLCB3ZWJWaWV3TGluazogZmlsZS53ZWJWaWV3TGluayB9LFxuICAgICAgICBudWxsLFxuICAgICAgICAyLFxuICAgICAgKTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIHJldHVybiBmb3JtYXRUb29sRXJyb3IoZXJyKTtcbiAgICB9XG4gIH07XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gZ3dfc2hlZXRfbGlzdF90YWJzIChyZWFkKVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5leHBvcnQgY29uc3Qgc2hlZXRMaXN0VGFic1NwZWM6IE5hdGl2ZVRvb2xTcGVjID0ge1xuICBuYW1lOiAnZ3dfc2hlZXRfbGlzdF90YWJzJyxcbiAgZGVzY3JpcHRpb246XG4gICAgJ0xpc3QgdGhlIHRhYnMgKHNoZWV0cykgb2YgYSBHb29nbGUgU3ByZWFkc2hlZXQ6IHRpdGxlLCBzaGVldElkLCBpbmRleCBhbmQgc2l6ZS4gUkVBRC1PTkxZLiBVc2UgdGhpcyB0byBjaGVjayB3aGV0aGVyIGEgdGFiIGFscmVhZHkgZXhpc3RzLCBvciB0byBnZXQgYSB0YWJcXCdzIHNoZWV0SWQgYmVmb3JlIGR1cGxpY2F0aW5nIGl0LicsXG4gIGlucHV0X3NjaGVtYToge1xuICAgIHR5cGU6ICdvYmplY3QnLFxuICAgIHByb3BlcnRpZXM6IHtcbiAgICAgIHVzZXI6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAnT3duZXIgdG8gaW1wZXJzb25hdGUgKGVtYWlsKS4gT21pdCBmb3IgZGVmYXVsdC4nIH0sXG4gICAgICBzcHJlYWRzaGVldElkOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ0dvb2dsZSBTaGVldHMgaWQgKHJlcXVpcmVkKS4nIH0sXG4gICAgfSxcbiAgICByZXF1aXJlZDogWydzcHJlYWRzaGVldElkJ10sXG4gIH0sXG59O1xuXG5leHBvcnQgY29uc3QgU0hFRVRfTElTVF9UQUJTX1BST01QVF9ET0MgPVxuICAnXFxuLSBgZ3dfc2hlZXRfbGlzdF90YWJzYDogUkVBRC1PTkxZIFx1MjAxNCBsaXN0IGEgc3ByZWFkc2hlZXRcXCdzIHRhYnMgKHRpdGxlLCBzaGVldElkLCBpbmRleCkuIFVzZSBpdCB0byBjaGVjayBpZiBhIHRhYiBleGlzdHMgYW5kIHRvIGdldCB0aGUgYHNoZWV0SWRgIG5lZWRlZCBieSBgZ3dfc2hlZXRfZHVwbGljYXRlX3RhYmAuXFxuJztcblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVNoZWV0TGlzdFRhYnNIYW5kbGVyKGRlcHM6IFRvb2xEZXBzKTogTmF0aXZlVG9vbEhhbmRsZXIge1xuICByZXR1cm4gYXN5bmMgKHJhdzogdW5rbm93bik6IFByb21pc2U8c3RyaW5nPiA9PiB7XG4gICAgY29uc3QgaW5wdXQgPSAocmF3ID8/IHt9KSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICB0cnkge1xuICAgICAgY29uc3Qgc3ViamVjdCA9IHJlc29sdmVTdWJqZWN0KGRlcHMsIGlucHV0LnVzZXIpO1xuICAgICAgY29uc3Qgc3ByZWFkc2hlZXRJZCA9IHN0cihpbnB1dC5zcHJlYWRzaGVldElkKTtcbiAgICAgIGlmICghc3ByZWFkc2hlZXRJZCkgdGhyb3cgbmV3IEdvb2dsZUlucHV0RXJyb3IoJ1wic3ByZWFkc2hlZXRJZFwiIGlzIHJlcXVpcmVkLicpO1xuICAgICAgY29uc3Qga2V5ID0gYHNoZWV0czp0YWJzOiR7c3ViamVjdH06JHtzcHJlYWRzaGVldElkfWA7XG4gICAgICBjb25zdCBtZXRhID0gYXdhaXQgZGVwcy5jYWNoZS5nZXRPclNldChrZXksICgpID0+XG4gICAgICAgIGRlcHMuY2xpZW50LmdldFNwcmVhZHNoZWV0TWV0YShzdWJqZWN0LCBzcHJlYWRzaGVldElkKSxcbiAgICAgICk7XG4gICAgICBjb25zdCBwcm9wcyA9IChtZXRhLnByb3BlcnRpZXMgYXMgeyB0aXRsZT86IHN0cmluZyB9KSA/PyB7fTtcbiAgICAgIGNvbnN0IHRhYnMgPSAoKG1ldGEuc2hlZXRzIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+W10pID8/IFtdKS5tYXAoKHMpID0+IHtcbiAgICAgICAgY29uc3QgcCA9IChzLnByb3BlcnRpZXMgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID8/IHt9O1xuICAgICAgICBjb25zdCBncmlkID0gKHAuZ3JpZFByb3BlcnRpZXMgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID8/IHt9O1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHNoZWV0SWQ6IHAuc2hlZXRJZCxcbiAgICAgICAgICB0aXRsZTogcC50aXRsZSxcbiAgICAgICAgICBpbmRleDogcC5pbmRleCxcbiAgICAgICAgICByb3dzOiBncmlkLnJvd0NvdW50LFxuICAgICAgICAgIGNvbHVtbnM6IGdyaWQuY29sdW1uQ291bnQsXG4gICAgICAgIH07XG4gICAgICB9KTtcbiAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeSh7IHNwcmVhZHNoZWV0SWQsIHRpdGxlOiBwcm9wcy50aXRsZSwgdGFicyB9LCBudWxsLCAyKTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIHJldHVybiBmb3JtYXRUb29sRXJyb3IoZXJyKTtcbiAgICB9XG4gIH07XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gZ3dfc2hlZXRfYWRkX3RhYiAod3JpdGUpXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbmV4cG9ydCBjb25zdCBzaGVldEFkZFRhYlNwZWM6IE5hdGl2ZVRvb2xTcGVjID0ge1xuICBuYW1lOiAnZ3dfc2hlZXRfYWRkX3RhYicsXG4gIGRlc2NyaXB0aW9uOlxuICAgICdBZGQgYSBuZXcsIEVNUFRZIHRhYiAoc2hlZXQpIHRvIGEgR29vZ2xlIFNwcmVhZHNoZWV0LiBXUklURSBcdTIwMTQgY29uZmlybSB3aXRoIHRoZSB1c2VyIGZpcnN0LiBDcmVhdGVzIGEgYmxhbmsgdGFiIHdpdGggbm8gZm9ybWF0dGluZzsgdG8ga2VlcCBhbiBleGlzdGluZyB0YWJcXCdzIGZvcm1hdHRpbmcvZm9ybXVsYXMgdXNlIGd3X3NoZWV0X2R1cGxpY2F0ZV90YWIgaW5zdGVhZC4gUmV0dXJucyB0aGUgbmV3IHNoZWV0SWQuJyxcbiAgaW5wdXRfc2NoZW1hOiB7XG4gICAgdHlwZTogJ29iamVjdCcsXG4gICAgcHJvcGVydGllczoge1xuICAgICAgdXNlcjogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICdPd25lciB0byBpbXBlcnNvbmF0ZSAoZW1haWwpLiBPbWl0IGZvciBkZWZhdWx0LicgfSxcbiAgICAgIHNwcmVhZHNoZWV0SWQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAnR29vZ2xlIFNoZWV0cyBpZCAocmVxdWlyZWQpLicgfSxcbiAgICAgIHRpdGxlOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ1RpdGxlIG9mIHRoZSBuZXcgdGFiIChyZXF1aXJlZCkuJyB9LFxuICAgICAgaW5kZXg6IHsgdHlwZTogJ251bWJlcicsIGRlc2NyaXB0aW9uOiAnT3B0aW9uYWwgMC1iYXNlZCBwb3NpdGlvbiBhbW9uZyB0aGUgdGFicy4nIH0sXG4gICAgfSxcbiAgICByZXF1aXJlZDogWydzcHJlYWRzaGVldElkJywgJ3RpdGxlJ10sXG4gIH0sXG59O1xuXG5leHBvcnQgY29uc3QgU0hFRVRfQUREX1RBQl9QUk9NUFRfRE9DID1cbiAgJ1xcbi0gYGd3X3NoZWV0X2FkZF90YWJgOiBXUklURSBcdTIwMTQgYWRkIGEgbmV3IEVNUFRZIHRhYiB0byBhIHNwcmVhZHNoZWV0IChubyBmb3JtYXR0aW5nKS4gRm9yIGEgZm9ybWF0dGVkIGNvcHkgb2YgYW4gZXhpc3RpbmcgdGFiIHVzZSBgZ3dfc2hlZXRfZHVwbGljYXRlX3RhYmAuIENvbmZpcm0gd2l0aCB0aGUgdXNlciBmaXJzdC5cXG4nO1xuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlU2hlZXRBZGRUYWJIYW5kbGVyKGRlcHM6IFRvb2xEZXBzKTogTmF0aXZlVG9vbEhhbmRsZXIge1xuICByZXR1cm4gYXN5bmMgKHJhdzogdW5rbm93bik6IFByb21pc2U8c3RyaW5nPiA9PiB7XG4gICAgY29uc3QgaW5wdXQgPSAocmF3ID8/IHt9KSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICB0cnkge1xuICAgICAgY29uc3Qgc3ViamVjdCA9IHJlc29sdmVTdWJqZWN0KGRlcHMsIGlucHV0LnVzZXIpO1xuICAgICAgY29uc3Qgc3ByZWFkc2hlZXRJZCA9IHN0cihpbnB1dC5zcHJlYWRzaGVldElkKTtcbiAgICAgIGNvbnN0IHRpdGxlID0gc3RyKGlucHV0LnRpdGxlKTtcbiAgICAgIGlmICghc3ByZWFkc2hlZXRJZCkgdGhyb3cgbmV3IEdvb2dsZUlucHV0RXJyb3IoJ1wic3ByZWFkc2hlZXRJZFwiIGlzIHJlcXVpcmVkLicpO1xuICAgICAgaWYgKCF0aXRsZSkgdGhyb3cgbmV3IEdvb2dsZUlucHV0RXJyb3IoJ1widGl0bGVcIiBpcyByZXF1aXJlZC4nKTtcbiAgICAgIGNvbnN0IHByb3BlcnRpZXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0geyB0aXRsZSB9O1xuICAgICAgaWYgKHR5cGVvZiBpbnB1dC5pbmRleCA9PT0gJ251bWJlcicpIHByb3BlcnRpZXMuaW5kZXggPSBpbnB1dC5pbmRleDtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRlcHMuY2xpZW50LmJhdGNoVXBkYXRlU3ByZWFkc2hlZXQoc3ViamVjdCwgc3ByZWFkc2hlZXRJZCwgW1xuICAgICAgICB7IGFkZFNoZWV0OiB7IHByb3BlcnRpZXMgfSB9LFxuICAgICAgXSk7XG4gICAgICBkZXBzLmNhY2hlLmNsZWFyKCk7XG4gICAgICBjb25zdCByZXBsaWVzID0gKHJlc3VsdC5yZXBsaWVzIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+W10pID8/IFtdO1xuICAgICAgY29uc3QgYWRkZWQgPSAocmVwbGllc1swXT8uYWRkU2hlZXQgYXMgeyBwcm9wZXJ0aWVzPzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfSk/LnByb3BlcnRpZXM7XG4gICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoXG4gICAgICAgIHsgYWRkZWQ6IHRydWUsIHRpdGxlLCBzaGVldElkOiBhZGRlZD8uc2hlZXRJZCwgaW5kZXg6IGFkZGVkPy5pbmRleCB9LFxuICAgICAgICBudWxsLFxuICAgICAgICAyLFxuICAgICAgKTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIHJldHVybiBmb3JtYXRUb29sRXJyb3IoZXJyKTtcbiAgICB9XG4gIH07XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gZ3dfc2hlZXRfZHVwbGljYXRlX3RhYiAod3JpdGUpXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbmV4cG9ydCBjb25zdCBzaGVldER1cGxpY2F0ZVRhYlNwZWM6IE5hdGl2ZVRvb2xTcGVjID0ge1xuICBuYW1lOiAnZ3dfc2hlZXRfZHVwbGljYXRlX3RhYicsXG4gIGRlc2NyaXB0aW9uOlxuICAgICdEdXBsaWNhdGUgYW4gZXhpc3RpbmcgdGFiIHdpdGhpbiBhIEdvb2dsZSBTcHJlYWRzaGVldCwga2VlcGluZyBBTEwgZm9ybWF0dGluZywgZm9ybXVsYXMsIG51bWJlciBmb3JtYXRzIGFuZCBjb25kaXRpb25hbCBmb3JtYXR0aW5nLiBXUklURSBcdTIwMTQgY29uZmlybSBmaXJzdC4gSWRlbnRpZnkgdGhlIHNvdXJjZSBieSBzb3VyY2VUaXRsZSBvciBzb3VyY2VTaGVldElkOyB0aGUgY29weSBnZXRzIG5ld05hbWUuIFRoZW4gdXNlIGd3X3NoZWV0X3dyaXRlIHRvIG92ZXJ3cml0ZSBqdXN0IHRoZSB2YWx1ZXMuIFJldHVybnMgdGhlIG5ldyBzaGVldElkLicsXG4gIGlucHV0X3NjaGVtYToge1xuICAgIHR5cGU6ICdvYmplY3QnLFxuICAgIHByb3BlcnRpZXM6IHtcbiAgICAgIHVzZXI6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAnT3duZXIgdG8gaW1wZXJzb25hdGUgKGVtYWlsKS4gT21pdCBmb3IgZGVmYXVsdC4nIH0sXG4gICAgICBzcHJlYWRzaGVldElkOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ0dvb2dsZSBTaGVldHMgaWQgKHJlcXVpcmVkKS4nIH0sXG4gICAgICBzb3VyY2VUaXRsZTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICdUaXRsZSBvZiB0aGUgdGFiIHRvIGNvcHkgKG9yIHVzZSBzb3VyY2VTaGVldElkKS4nIH0sXG4gICAgICBzb3VyY2VTaGVldElkOiB7IHR5cGU6ICdudW1iZXInLCBkZXNjcmlwdGlvbjogJ3NoZWV0SWQgb2YgdGhlIHRhYiB0byBjb3B5IChmcm9tIGd3X3NoZWV0X2xpc3RfdGFicykuJyB9LFxuICAgICAgbmV3TmFtZTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICdOYW1lIG9mIHRoZSBkdXBsaWNhdGVkIHRhYiAocmVxdWlyZWQpLicgfSxcbiAgICAgIGluZGV4OiB7IHR5cGU6ICdudW1iZXInLCBkZXNjcmlwdGlvbjogJ09wdGlvbmFsIDAtYmFzZWQgaW5zZXJ0IHBvc2l0aW9uIGZvciB0aGUgY29weS4nIH0sXG4gICAgfSxcbiAgICByZXF1aXJlZDogWydzcHJlYWRzaGVldElkJywgJ25ld05hbWUnXSxcbiAgfSxcbn07XG5cbmV4cG9ydCBjb25zdCBTSEVFVF9EVVBMSUNBVEVfVEFCX1BST01QVF9ET0MgPVxuICAnXFxuLSBgZ3dfc2hlZXRfZHVwbGljYXRlX3RhYmA6IFdSSVRFIFx1MjAxNCBkdXBsaWNhdGUgYSB0YWIgV0lUSCBhbGwgZm9ybWF0dGluZyArIGZvcm11bGFzICh0aGUgcmlnaHQgd2F5IHRvIG1ha2UgZS5nLiBhIG5ldyB5ZWFyXFwncyBzaGVldCBmcm9tIGEgdGVtcGxhdGUpLiBHaXZlIGBzb3VyY2VUaXRsZWAgb3IgYHNvdXJjZVNoZWV0SWRgICsgYG5ld05hbWVgLCB0aGVuIG92ZXJ3cml0ZSB2YWx1ZXMgd2l0aCBgZ3dfc2hlZXRfd3JpdGVgLiBDb25maXJtIGZpcnN0Llxcbic7XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVTaGVldER1cGxpY2F0ZVRhYkhhbmRsZXIoZGVwczogVG9vbERlcHMpOiBOYXRpdmVUb29sSGFuZGxlciB7XG4gIHJldHVybiBhc3luYyAocmF3OiB1bmtub3duKTogUHJvbWlzZTxzdHJpbmc+ID0+IHtcbiAgICBjb25zdCBpbnB1dCA9IChyYXcgPz8ge30pIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBzdWJqZWN0ID0gcmVzb2x2ZVN1YmplY3QoZGVwcywgaW5wdXQudXNlcik7XG4gICAgICBjb25zdCBzcHJlYWRzaGVldElkID0gc3RyKGlucHV0LnNwcmVhZHNoZWV0SWQpO1xuICAgICAgY29uc3QgbmV3TmFtZSA9IHN0cihpbnB1dC5uZXdOYW1lKTtcbiAgICAgIGlmICghc3ByZWFkc2hlZXRJZCkgdGhyb3cgbmV3IEdvb2dsZUlucHV0RXJyb3IoJ1wic3ByZWFkc2hlZXRJZFwiIGlzIHJlcXVpcmVkLicpO1xuICAgICAgaWYgKCFuZXdOYW1lKSB0aHJvdyBuZXcgR29vZ2xlSW5wdXRFcnJvcignXCJuZXdOYW1lXCIgaXMgcmVxdWlyZWQuJyk7XG5cbiAgICAgIGxldCBzb3VyY2VTaGVldElkID1cbiAgICAgICAgdHlwZW9mIGlucHV0LnNvdXJjZVNoZWV0SWQgPT09ICdudW1iZXInID8gaW5wdXQuc291cmNlU2hlZXRJZCA6IHVuZGVmaW5lZDtcbiAgICAgIGNvbnN0IHNvdXJjZVRpdGxlID0gc3RyKGlucHV0LnNvdXJjZVRpdGxlKTtcbiAgICAgIGlmIChzb3VyY2VTaGVldElkID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgaWYgKCFzb3VyY2VUaXRsZSkge1xuICAgICAgICAgIHRocm93IG5ldyBHb29nbGVJbnB1dEVycm9yKCdwcm92aWRlIFwic291cmNlVGl0bGVcIiBvciBcInNvdXJjZVNoZWV0SWRcIiBvZiB0aGUgdGFiIHRvIGNvcHkuJyk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgbWV0YSA9IGF3YWl0IGRlcHMuY2xpZW50LmdldFNwcmVhZHNoZWV0TWV0YShzdWJqZWN0LCBzcHJlYWRzaGVldElkKTtcbiAgICAgICAgY29uc3QgbWF0Y2ggPSAoKG1ldGEuc2hlZXRzIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+W10pID8/IFtdKS5maW5kKChzKSA9PiB7XG4gICAgICAgICAgY29uc3QgcCA9IChzLnByb3BlcnRpZXMgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID8/IHt9O1xuICAgICAgICAgIHJldHVybiBwLnRpdGxlID09PSBzb3VyY2VUaXRsZTtcbiAgICAgICAgfSk7XG4gICAgICAgIGNvbnN0IHByb3BzID0gKG1hdGNoPy5wcm9wZXJ0aWVzIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA/PyB7fTtcbiAgICAgICAgaWYgKHR5cGVvZiBwcm9wcy5zaGVldElkICE9PSAnbnVtYmVyJykge1xuICAgICAgICAgIHRocm93IG5ldyBHb29nbGVJbnB1dEVycm9yKGBubyB0YWIgbmFtZWQgXCIke3NvdXJjZVRpdGxlfVwiIGZvdW5kIGluIHRoaXMgc3ByZWFkc2hlZXQuYCk7XG4gICAgICAgIH1cbiAgICAgICAgc291cmNlU2hlZXRJZCA9IHByb3BzLnNoZWV0SWQ7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGR1cDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7IHNvdXJjZVNoZWV0SWQsIG5ld1NoZWV0TmFtZTogbmV3TmFtZSB9O1xuICAgICAgaWYgKHR5cGVvZiBpbnB1dC5pbmRleCA9PT0gJ251bWJlcicpIGR1cC5pbnNlcnRTaGVldEluZGV4ID0gaW5wdXQuaW5kZXg7XG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBkZXBzLmNsaWVudC5iYXRjaFVwZGF0ZVNwcmVhZHNoZWV0KHN1YmplY3QsIHNwcmVhZHNoZWV0SWQsIFtcbiAgICAgICAgeyBkdXBsaWNhdGVTaGVldDogZHVwIH0sXG4gICAgICBdKTtcbiAgICAgIGRlcHMuY2FjaGUuY2xlYXIoKTtcbiAgICAgIGNvbnN0IHJlcGxpZXMgPSAocmVzdWx0LnJlcGxpZXMgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj5bXSkgPz8gW107XG4gICAgICBjb25zdCBhZGRlZCA9IChyZXBsaWVzWzBdPy5kdXBsaWNhdGVTaGVldCBhcyB7IHByb3BlcnRpZXM/OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB9KVxuICAgICAgICA/LnByb3BlcnRpZXM7XG4gICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoXG4gICAgICAgIHsgZHVwbGljYXRlZDogdHJ1ZSwgc291cmNlU2hlZXRJZCwgbmV3TmFtZSwgbmV3U2hlZXRJZDogYWRkZWQ/LnNoZWV0SWQgfSxcbiAgICAgICAgbnVsbCxcbiAgICAgICAgMixcbiAgICAgICk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICByZXR1cm4gZm9ybWF0VG9vbEVycm9yKGVycik7XG4gICAgfVxuICB9O1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIGd3X3NoZWV0X2JhdGNoX3VwZGF0ZSAod3JpdGUpIFx1MjAxNCBmdWxsIGZvcm1hdHRpbmcvZm9ybXVsYS9zdHJ1Y3R1cmFsIHN1cmZhY2Vcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuZXhwb3J0IGNvbnN0IHNoZWV0QmF0Y2hVcGRhdGVTcGVjOiBOYXRpdmVUb29sU3BlYyA9IHtcbiAgbmFtZTogJ2d3X3NoZWV0X2JhdGNoX3VwZGF0ZScsXG4gIGRlc2NyaXB0aW9uOlxuICAgICdBZHZhbmNlZCByYXcgR29vZ2xlIFNoZWV0cyBzcHJlYWRzaGVldHMuYmF0Y2hVcGRhdGUuIFdSSVRFIFx1MjAxNCBjb25maXJtIGZpcnN0LiBUaGlzIGlzIHRoZSBDT01QTEVURSBTaGVldHMgd3JpdGUgc3VyZmFjZSBmb3IgZm9ybWF0dGluZyBhbmQgc3RydWN0dXJlIHRoYXQgZ3dfc2hlZXRfd3JpdGUgKHZhbHVlcyBvbmx5KSBjYW5ub3QgZG86IG51bWJlci9jdXJyZW5jeS9wZXJjZW50IGZvcm1hdHMsIGJvbGQvaXRhbGljL2NvbG9ycy9ib3JkZXJzIChyZXBlYXRDZWxsLCB1cGRhdGVDZWxscyksIGNvbmRpdGlvbmFsIGZvcm1hdHRpbmcgKGFkZENvbmRpdGlvbmFsRm9ybWF0UnVsZSksIGNvbHVtbiB3aWR0aHMgKHVwZGF0ZURpbWVuc2lvblByb3BlcnRpZXMpLCBtZXJnZXMgKG1lcmdlQ2VsbHMpLCBhbmQgZm9ybXVsYXMgKHVzZXJFbnRlcmVkVmFsdWUuZm9ybXVsYVZhbHVlKS4gUGFzcyB0aGUgcmF3IFwicmVxdWVzdHNcIiBhcnJheSBleGFjdGx5IGFzIHRoZSBTaGVldHMgQVBJIGV4cGVjdHMuIFBvd2VyZnVsOiBpdCBjYW4gYWxzbyBkZWxldGUgb3IgcmVzdHJ1Y3R1cmUsIHNvIHVzZSBkZWxpYmVyYXRlbHkuIEdldCBhIHRhYlxcJ3Mgc2hlZXRJZCBmcm9tIGd3X3NoZWV0X2xpc3RfdGFicyBmb3IgdGhlIEdyaWRSYW5nZS4nLFxuICBpbnB1dF9zY2hlbWE6IHtcbiAgICB0eXBlOiAnb2JqZWN0JyxcbiAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICB1c2VyOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ093bmVyIHRvIGltcGVyc29uYXRlIChlbWFpbCkuIE9taXQgZm9yIGRlZmF1bHQuJyB9LFxuICAgICAgc3ByZWFkc2hlZXRJZDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICdHb29nbGUgU2hlZXRzIGlkIChyZXF1aXJlZCkuJyB9LFxuICAgICAgcmVxdWVzdHM6IHtcbiAgICAgICAgdHlwZTogJ2FycmF5JyxcbiAgICAgICAgaXRlbXM6IHsgdHlwZTogJ29iamVjdCcgfSxcbiAgICAgICAgZGVzY3JpcHRpb246XG4gICAgICAgICAgJ1JhdyBTaGVldHMgQVBJIGJhdGNoVXBkYXRlIHJlcXVlc3Qgb2JqZWN0cy4gRXhhbXBsZXM6IGJvbGQrXHUyMEFDLWZvcm1hdCBhIHJhbmdlIFx1MjE5MiBbe1wicmVwZWF0Q2VsbFwiOntcInJhbmdlXCI6e1wic2hlZXRJZFwiOjAsXCJzdGFydFJvd0luZGV4XCI6MCxcImVuZFJvd0luZGV4XCI6MX0sXCJjZWxsXCI6e1widXNlckVudGVyZWRGb3JtYXRcIjp7XCJ0ZXh0Rm9ybWF0XCI6e1wiYm9sZFwiOnRydWV9LFwibnVtYmVyRm9ybWF0XCI6e1widHlwZVwiOlwiQ1VSUkVOQ1lcIixcInBhdHRlcm5cIjpcIiMsIyMwLjAwIFx1MjBBQ1wifX19LFwiZmllbGRzXCI6XCJ1c2VyRW50ZXJlZEZvcm1hdCh0ZXh0Rm9ybWF0LG51bWJlckZvcm1hdClcIn19XTsgc2V0IGEgY29sdW1uIHdpZHRoIFx1MjE5MiBbe1widXBkYXRlRGltZW5zaW9uUHJvcGVydGllc1wiOntcInJhbmdlXCI6e1wic2hlZXRJZFwiOjAsXCJkaW1lbnNpb25cIjpcIkNPTFVNTlNcIixcInN0YXJ0SW5kZXhcIjowLFwiZW5kSW5kZXhcIjoxfSxcInByb3BlcnRpZXNcIjp7XCJwaXhlbFNpemVcIjoxNjB9LFwiZmllbGRzXCI6XCJwaXhlbFNpemVcIn19XS4gUmVxdWlyZWQsIG5vbi1lbXB0eS4nLFxuICAgICAgfSxcbiAgICB9LFxuICAgIHJlcXVpcmVkOiBbJ3NwcmVhZHNoZWV0SWQnLCAncmVxdWVzdHMnXSxcbiAgfSxcbn07XG5cbmV4cG9ydCBjb25zdCBTSEVFVF9CQVRDSF9VUERBVEVfUFJPTVBUX0RPQyA9XG4gICdcXG4tIGBnd19zaGVldF9iYXRjaF91cGRhdGVgOiBXUklURSBcdTIwMTQgcmF3IEdvb2dsZSBTaGVldHMgYGJhdGNoVXBkYXRlYCBmb3IgdGhlIEZVTEwgZm9ybWF0dGluZy9zdHJ1Y3R1cmUgc3VyZmFjZSAobnVtYmVyIGZvcm1hdHMsIGJvbGQvY29sb3JzL2JvcmRlcnMgdmlhIGByZXBlYXRDZWxsYCwgY29uZGl0aW9uYWwgZm9ybWF0dGluZywgY29sdW1uIHdpZHRocywgbWVyZ2VzLCBmb3JtdWxhcykuIFVzZSBmb3IgYW55dGhpbmcgYGd3X3NoZWV0X3dyaXRlYCAodmFsdWVzIG9ubHkpIGNhbm5vdCBkby4gR2V0IGBzaGVldElkYCBmcm9tIGBnd19zaGVldF9saXN0X3RhYnNgLiBDb25maXJtIHdpdGggdGhlIHVzZXI7IGl0IGNhbiBhbHNvIGRlbGV0ZS9yZXN0cnVjdHVyZS5cXG4nO1xuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlU2hlZXRCYXRjaFVwZGF0ZUhhbmRsZXIoZGVwczogVG9vbERlcHMpOiBOYXRpdmVUb29sSGFuZGxlciB7XG4gIHJldHVybiBhc3luYyAocmF3OiB1bmtub3duKTogUHJvbWlzZTxzdHJpbmc+ID0+IHtcbiAgICBjb25zdCBpbnB1dCA9IChyYXcgPz8ge30pIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBzdWJqZWN0ID0gcmVzb2x2ZVN1YmplY3QoZGVwcywgaW5wdXQudXNlcik7XG4gICAgICBjb25zdCBzcHJlYWRzaGVldElkID0gc3RyKGlucHV0LnNwcmVhZHNoZWV0SWQpO1xuICAgICAgaWYgKCFzcHJlYWRzaGVldElkKSB0aHJvdyBuZXcgR29vZ2xlSW5wdXRFcnJvcignXCJzcHJlYWRzaGVldElkXCIgaXMgcmVxdWlyZWQuJyk7XG4gICAgICBpZiAoIUFycmF5LmlzQXJyYXkoaW5wdXQucmVxdWVzdHMpIHx8IGlucHV0LnJlcXVlc3RzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICB0aHJvdyBuZXcgR29vZ2xlSW5wdXRFcnJvcignXCJyZXF1ZXN0c1wiIG11c3QgYmUgYSBub24tZW1wdHkgYXJyYXkgb2YgU2hlZXRzIEFQSSByZXF1ZXN0cy4nKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRlcHMuY2xpZW50LmJhdGNoVXBkYXRlU3ByZWFkc2hlZXQoXG4gICAgICAgIHN1YmplY3QsXG4gICAgICAgIHNwcmVhZHNoZWV0SWQsXG4gICAgICAgIGlucHV0LnJlcXVlc3RzIGFzIHVua25vd25bXSxcbiAgICAgICk7XG4gICAgICBkZXBzLmNhY2hlLmNsZWFyKCk7XG4gICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoXG4gICAgICAgIHtcbiAgICAgICAgICBhcHBsaWVkOiB0cnVlLFxuICAgICAgICAgIHNwcmVhZHNoZWV0SWQsXG4gICAgICAgICAgcmVxdWVzdENvdW50OiAoaW5wdXQucmVxdWVzdHMgYXMgdW5rbm93bltdKS5sZW5ndGgsXG4gICAgICAgICAgcmVwbGllczogcmVzdWx0LnJlcGxpZXMgPz8gW10sXG4gICAgICAgIH0sXG4gICAgICAgIG51bGwsXG4gICAgICAgIDIsXG4gICAgICApO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgcmV0dXJuIGZvcm1hdFRvb2xFcnJvcihlcnIpO1xuICAgIH1cbiAgfTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBIZWxwZXJzIFx1MjAxNCBmbGF0dGVuIGEgRG9jcyBkb2N1bWVudCBpbnRvIHBsYWluIHRleHQuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbmludGVyZmFjZSBEb2NzVGV4dFJ1biB7XG4gIGNvbnRlbnQ/OiBzdHJpbmc7XG59XG5pbnRlcmZhY2UgRG9jc1BhcmFncmFwaEVsZW1lbnQge1xuICB0ZXh0UnVuPzogRG9jc1RleHRSdW47XG59XG5pbnRlcmZhY2UgRG9jc1BhcmFncmFwaCB7XG4gIGVsZW1lbnRzPzogRG9jc1BhcmFncmFwaEVsZW1lbnRbXTtcbn1cbmludGVyZmFjZSBEb2NzU3RydWN0dXJhbEVsZW1lbnQge1xuICBwYXJhZ3JhcGg/OiBEb2NzUGFyYWdyYXBoO1xuICB0YWJsZT86IHsgdGFibGVSb3dzPzogeyB0YWJsZUNlbGxzPzogeyBjb250ZW50PzogRG9jc1N0cnVjdHVyYWxFbGVtZW50W10gfVtdIH1bXSB9O1xufVxuXG5mdW5jdGlvbiBmbGF0dGVuRG9jVGV4dChkb2M6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogc3RyaW5nIHtcbiAgY29uc3QgYm9keSA9IGRvYy5ib2R5IGFzIHsgY29udGVudD86IERvY3NTdHJ1Y3R1cmFsRWxlbWVudFtdIH0gfCB1bmRlZmluZWQ7XG4gIGlmICghYm9keT8uY29udGVudCkgcmV0dXJuICcnO1xuICBjb25zdCBvdXQ6IHN0cmluZ1tdID0gW107XG4gIGNvbGxlY3REb2NUZXh0KGJvZHkuY29udGVudCwgb3V0KTtcbiAgcmV0dXJuIG91dC5qb2luKCcnKS5yZXBsYWNlKC9cXG57Myx9L2csICdcXG5cXG4nKS50cmltKCk7XG59XG5cbmZ1bmN0aW9uIGNvbGxlY3REb2NUZXh0KGNvbnRlbnQ6IERvY3NTdHJ1Y3R1cmFsRWxlbWVudFtdLCBvdXQ6IHN0cmluZ1tdKTogdm9pZCB7XG4gIGZvciAoY29uc3QgZWwgb2YgY29udGVudCkge1xuICAgIGlmIChlbC5wYXJhZ3JhcGg/LmVsZW1lbnRzKSB7XG4gICAgICBmb3IgKGNvbnN0IHBlIG9mIGVsLnBhcmFncmFwaC5lbGVtZW50cykge1xuICAgICAgICBpZiAocGUudGV4dFJ1bj8uY29udGVudCkgb3V0LnB1c2gocGUudGV4dFJ1bi5jb250ZW50KTtcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKGVsLnRhYmxlPy50YWJsZVJvd3MpIHtcbiAgICAgIGZvciAoY29uc3Qgcm93IG9mIGVsLnRhYmxlLnRhYmxlUm93cykge1xuICAgICAgICBmb3IgKGNvbnN0IGNlbGwgb2Ygcm93LnRhYmxlQ2VsbHMgPz8gW10pIHtcbiAgICAgICAgICBpZiAoY2VsbC5jb250ZW50KSBjb2xsZWN0RG9jVGV4dChjZWxsLmNvbnRlbnQsIG91dCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH1cbn1cbiIsICIvKipcbiAqIFRlc3QgaGVscGVycyBcdTIwMTQgZmFrZSBhdXRoLCBhIHNjcmlwdGVkIGZldGNoLCBhbmQgYSBKU09OIFJlc3BvbnNlIGJ1aWxkZXIuXG4gKiBObyBuZXR3b3JrLCBubyByZWFsIGNyZWRlbnRpYWxzLlxuICovXG5cbmltcG9ydCB0eXBlIHsgR29vZ2xlU2VydmljZUFjY291bnRBdXRoIH0gZnJvbSAnLi4vc3JjL2dvb2dsZUF1dGguanMnO1xuXG5leHBvcnQgZnVuY3Rpb24gZmFrZUF1dGgoKToge1xuICBhdXRoOiBHb29nbGVTZXJ2aWNlQWNjb3VudEF1dGg7XG4gIHN0YXRzOiAoKSA9PiB7IHRva2VuQ2FsbHM6IG51bWJlcjsgaW52YWxpZGF0aW9uczogbnVtYmVyIH07XG59IHtcbiAgbGV0IHRva2VuQ2FsbHMgPSAwO1xuICBsZXQgaW52YWxpZGF0aW9ucyA9IDA7XG4gIGNvbnN0IGF1dGggPSB7XG4gICAgZ2V0VG9rZW46IGFzeW5jICgpID0+IHtcbiAgICAgIHRva2VuQ2FsbHMgKz0gMTtcbiAgICAgIHJldHVybiBgdG9rLSR7dG9rZW5DYWxsc31gO1xuICAgIH0sXG4gICAgaW52YWxpZGF0ZTogKCkgPT4ge1xuICAgICAgaW52YWxpZGF0aW9ucyArPSAxO1xuICAgIH0sXG4gIH07XG4gIHJldHVybiB7XG4gICAgYXV0aDogYXV0aCBhcyB1bmtub3duIGFzIEdvb2dsZVNlcnZpY2VBY2NvdW50QXV0aCxcbiAgICBzdGF0czogKCkgPT4gKHsgdG9rZW5DYWxscywgaW52YWxpZGF0aW9ucyB9KSxcbiAgfTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBDYXB0dXJlZCB7XG4gIHVybDogc3RyaW5nO1xuICBpbml0OiB7IG1ldGhvZD86IHN0cmluZzsgaGVhZGVycz86IFJlY29yZDxzdHJpbmcsIHN0cmluZz47IGJvZHk/OiBzdHJpbmcgfTtcbn1cblxuLyoqXG4gKiBBIGZldGNoIHN0dWIgZHJpdmVuIGJ5IGFuIGFycmF5IG9mIHN0ZXAgZnVuY3Rpb25zLiBDYWxsIE4gdXNlcyBzdGVwIE4gKHRoZVxuICogbGFzdCBzdGVwIHJlcGVhdHMgZm9yIGFueSBmdXJ0aGVyIGNhbGxzKS4gUmVjb3JkcyBldmVyeSBjYWxsLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2NyaXB0ZWRGZXRjaChzdGVwczogQXJyYXk8KGM6IENhcHR1cmVkKSA9PiBSZXNwb25zZT4pOiB7XG4gIGZldGNoSW1wbDogdHlwZW9mIGZldGNoO1xuICBjYWxsczogQ2FwdHVyZWRbXTtcbn0ge1xuICBjb25zdCBjYWxsczogQ2FwdHVyZWRbXSA9IFtdO1xuICBsZXQgaSA9IDA7XG4gIGNvbnN0IGZldGNoSW1wbCA9IChhc3luYyAodXJsOiBzdHJpbmcsIGluaXQ6IENhcHR1cmVkWydpbml0J10pID0+IHtcbiAgICBjb25zdCBjOiBDYXB0dXJlZCA9IHsgdXJsLCBpbml0OiBpbml0ID8/IHt9IH07XG4gICAgY2FsbHMucHVzaChjKTtcbiAgICBjb25zdCBzdGVwID0gc3RlcHNbTWF0aC5taW4oaSwgc3RlcHMubGVuZ3RoIC0gMSldO1xuICAgIGkgKz0gMTtcbiAgICByZXR1cm4gc3RlcChjKTtcbiAgfSkgYXMgdW5rbm93biBhcyB0eXBlb2YgZmV0Y2g7XG4gIHJldHVybiB7IGZldGNoSW1wbCwgY2FsbHMgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGpzb24ob2JqOiB1bmtub3duLCBzdGF0dXMgPSAyMDApOiBSZXNwb25zZSB7XG4gIHJldHVybiBuZXcgUmVzcG9uc2UoSlNPTi5zdHJpbmdpZnkob2JqKSwge1xuICAgIHN0YXR1cyxcbiAgICBoZWFkZXJzOiB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbicgfSxcbiAgfSk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiO0FBQUEsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTs7O0FDTVosSUFBTSxrQkFBTixjQUE4QixNQUFNO0FBQUEsRUFDekMsWUFBWSxTQUFpQjtBQUMzQixVQUFNLE9BQU87QUFDYixTQUFLLE9BQU87QUFBQSxFQUNkO0FBQ0Y7QUFHTyxJQUFNLGlCQUFOLGNBQTZCLE1BQU07QUFBQSxFQUN4QyxZQUNrQixRQUNBLFFBQ2hCLFNBQ0E7QUFDQSxVQUFNLE9BQU87QUFKRztBQUNBO0FBSWhCLFNBQUssT0FBTztBQUFBLEVBQ2Q7QUFDRjtBQUdPLElBQU0sbUJBQU4sY0FBK0IsTUFBTTtBQUFBLEVBQzFDLFlBQVksU0FBaUI7QUFDM0IsVUFBTSxPQUFPO0FBQ2IsU0FBSyxPQUFPO0FBQUEsRUFDZDtBQUNGO0FBTU8sU0FBUyxnQkFBZ0IsS0FBc0I7QUFDcEQsTUFBSSxlQUFlLGlCQUFpQjtBQUNsQyxXQUFPLHdEQUFtRCxJQUFJLE9BQU87QUFBQSxFQUN2RTtBQUNBLE1BQUksZUFBZSxnQkFBZ0I7QUFDakMsVUFBTSxTQUFTLElBQUksU0FBUyxLQUFLLElBQUksTUFBTSxNQUFNO0FBQ2pELFdBQU8s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
