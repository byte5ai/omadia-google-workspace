// tests/writes.test.ts
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
function createSheetWriteHandler(deps2) {
  return async (raw) => {
    const input = raw ?? {};
    try {
      const subject = resolveSubject(deps2, input.user);
      const spreadsheetId = str(input.spreadsheetId);
      const range = str(input.range);
      if (!spreadsheetId) throw new GoogleInputError('"spreadsheetId" is required.');
      if (!range) throw new GoogleInputError('"range" (A1 notation) is required.');
      if (!Array.isArray(input.values) || !input.values.every((r) => Array.isArray(r))) {
        throw new GoogleInputError('"values" must be a 2D array (rows of cells).');
      }
      const mode = str(input.mode) === "append" ? "append" : "overwrite";
      const valueInputOption = str(input.valueInputOption) === "RAW" ? "RAW" : "USER_ENTERED";
      const result = await deps2.client.writeSheetValues(
        subject,
        spreadsheetId,
        range,
        input.values,
        { mode, valueInputOption }
      );
      deps2.cache.clear();
      const updates = result.updates ?? result;
      return JSON.stringify(
        {
          written: true,
          mode,
          spreadsheetId,
          updatedRange: updates.updatedRange,
          updatedRows: updates.updatedRows,
          updatedCells: updates.updatedCells
        },
        null,
        2
      );
    } catch (err) {
      return formatToolError(err);
    }
  };
}
var DRIVE_TYPE_MIME = {
  folder: "application/vnd.google-apps.folder",
  document: "application/vnd.google-apps.document",
  spreadsheet: "application/vnd.google-apps.spreadsheet",
  presentation: "application/vnd.google-apps.presentation",
  file: "text/plain"
};
function createDriveCreateHandler(deps2) {
  return async (raw) => {
    const input = raw ?? {};
    try {
      const subject = resolveSubject(deps2, input.user);
      const name = str(input.name);
      if (!name) throw new GoogleInputError('"name" is required.');
      const type = (str(input.type) ?? "folder").toLowerCase();
      const mimeType = str(input.mimeType) ?? DRIVE_TYPE_MIME[type];
      if (!mimeType) {
        throw new GoogleInputError(
          `unknown "type": ${type}. Use folder | document | spreadsheet | presentation | file, or pass "mimeType".`
        );
      }
      const content = typeof input.content === "string" ? input.content : void 0;
      if (content !== void 0 && type === "folder") {
        throw new GoogleInputError('a folder cannot have "content".');
      }
      const parents = str(input.parentId) ? [str(input.parentId)] : void 0;
      const file = await deps2.client.createDriveFile(subject, { name, mimeType, parents, content });
      deps2.cache.clear();
      return JSON.stringify(
        { created: true, id: file.id, name: file.name, mimeType: file.mimeType, webViewLink: file.webViewLink },
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

// tests/writes.test.ts
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
test("writeSheetValues overwrite \u2192 PUT values.update with body + valueInputOption", async () => {
  const { auth } = fakeAuth();
  const { fetchImpl, calls } = scriptedFetch([() => json({ updatedCells: 4, updatedRange: "S!A1:B2" })]);
  const client = new GoogleWorkspaceClient({ auth, scopes: ["s"], fetch: fetchImpl });
  const r = await client.writeSheetValues("u@x.com", "sheet1", "S!A1:B2", [["a", "b"], [1, 2]]);
  assert.equal(calls[0].init.method, "PUT");
  assert.match(calls[0].url, /\/spreadsheets\/sheet1\/values\/S!A1%3AB2\?/);
  assert.match(calls[0].url, /valueInputOption=USER_ENTERED/);
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.values, [["a", "b"], [1, 2]]);
  assert.equal(body.majorDimension, "ROWS");
  assert.equal(r.updatedCells, 4);
});
test("writeSheetValues append \u2192 POST :append with INSERT_ROWS", async () => {
  const { auth } = fakeAuth();
  const { fetchImpl, calls } = scriptedFetch([() => json({ updates: { updatedCells: 2 } })]);
  const client = new GoogleWorkspaceClient({ auth, scopes: ["s"], fetch: fetchImpl });
  await client.writeSheetValues("u@x.com", "sheet1", "S!A1", [["x", "y"]], { mode: "append" });
  assert.equal(calls[0].init.method, "POST");
  assert.match(calls[0].url, /\/values\/S!A1:append\?/);
  assert.match(calls[0].url, /insertDataOption=INSERT_ROWS/);
});
test("createDriveFile metadata-only \u2192 POST /files with metadata body", async () => {
  const { auth } = fakeAuth();
  const { fetchImpl, calls } = scriptedFetch([() => json({ id: "f1", name: "Reports", mimeType: "application/vnd.google-apps.folder" })]);
  const client = new GoogleWorkspaceClient({ auth, scopes: ["s"], fetch: fetchImpl });
  const r = await client.createDriveFile("u@x.com", {
    name: "Reports",
    mimeType: "application/vnd.google-apps.folder",
    parents: ["parent1"]
  });
  assert.equal(calls[0].init.method, "POST");
  assert.match(calls[0].url, /\/drive\/v3\/files\?/);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.name, "Reports");
  assert.deepEqual(body.parents, ["parent1"]);
  assert.equal(r.id, "f1");
});
test("createDriveFile with content \u2192 multipart upload to the upload host", async () => {
  const { auth } = fakeAuth();
  const { fetchImpl, calls } = scriptedFetch([() => json({ id: "f2", name: "notes.txt" })]);
  const client = new GoogleWorkspaceClient({ auth, scopes: ["s"], fetch: fetchImpl });
  await client.createDriveFile("u@x.com", {
    name: "notes.txt",
    mimeType: "text/plain",
    content: "hello body"
  });
  assert.match(calls[0].url, /^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\?/);
  assert.match(calls[0].url, /uploadType=multipart/);
  assert.match(calls[0].init.headers["Content-Type"], /^multipart\/related; boundary=/);
  const raw = calls[0].init.body;
  assert.match(raw, /"name":"notes.txt"/);
  assert.match(raw, /hello body/);
});
test("gw_sheet_write requires a 2D values array", async () => {
  const h = createSheetWriteHandler(deps({}));
  assert.match(await h({ spreadsheetId: "s", range: "A1", values: "nope" }), /Error:.*2D array/);
  assert.match(await h({ spreadsheetId: "s", range: "A1", values: [1, 2] }), /Error:.*2D array/);
});
test("gw_sheet_write happy path returns written + mode + clears cache", async () => {
  let cleared = false;
  let got;
  const localCache = { getOrSet: async (_k, fn) => fn(), clear() {
    cleared = true;
  } };
  const client = {
    writeSheetValues: async (_s, _id, _r, _v, p) => {
      got = p;
      return { updatedRange: "S!A1:B2", updatedRows: 2, updatedCells: 4 };
    }
  };
  const d = { client, cache: localCache, defaultSubject: "me@x.com", adminSubject: "a@x.com" };
  const out = JSON.parse(
    await createSheetWriteHandler(d)({ spreadsheetId: "s", range: "S!A1:B2", values: [["a", "b"], [1, 2]], mode: "append" })
  );
  assert.equal(out.written, true);
  assert.equal(out.mode, "append");
  assert.equal(got.mode, "append");
  assert.equal(out.updatedCells, 4);
  assert.equal(cleared, true);
});
test("gw_drive_create requires a name; folder + content is rejected", async () => {
  const h = createDriveCreateHandler(deps({}));
  assert.match(await h({}), /Error:.*"name"/);
  assert.match(await h({ name: "X", type: "folder", content: "no" }), /Error:.*folder cannot have/);
});
test("gw_drive_create maps type\u2192mimeType and returns the new id", async () => {
  let got;
  const client = {
    createDriveFile: async (_s, p) => {
      got = p;
      return { id: "d1", name: "Q3", mimeType: p.mimeType, webViewLink: "http://x" };
    }
  };
  const out = JSON.parse(
    await createDriveCreateHandler(deps(client))({ name: "Q3", type: "spreadsheet", parentId: "p1" })
  );
  assert.equal(got.mimeType, "application/vnd.google-apps.spreadsheet");
  assert.deepEqual(got.parents, ["p1"]);
  assert.equal(out.created, true);
  assert.equal(out.id, "d1");
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vdGVzdHMvd3JpdGVzLnRlc3QudHMiLCAiLi4vc3JjL2Vycm9ycy50cyIsICIuLi9zcmMvZ29vZ2xlQ2xpZW50LnRzIiwgIi4uL3NyYy90b29sRGVwcy50cyIsICIuLi9zcmMvZHJpdmVUb29scy50cyIsICIuLi90ZXN0cy9faGVscGVycy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHRlc3QgZnJvbSAnbm9kZTp0ZXN0JztcbmltcG9ydCBhc3NlcnQgZnJvbSAnbm9kZTphc3NlcnQvc3RyaWN0JztcblxuaW1wb3J0IHsgR29vZ2xlV29ya3NwYWNlQ2xpZW50IH0gZnJvbSAnLi4vc3JjL2dvb2dsZUNsaWVudC5qcyc7XG5pbXBvcnQge1xuICBjcmVhdGVTaGVldFdyaXRlSGFuZGxlcixcbiAgY3JlYXRlRHJpdmVDcmVhdGVIYW5kbGVyLFxufSBmcm9tICcuLi9zcmMvZHJpdmVUb29scy5qcyc7XG5pbXBvcnQgdHlwZSB7IFRvb2xEZXBzIH0gZnJvbSAnLi4vc3JjL3Rvb2xEZXBzLmpzJztcbmltcG9ydCB7IGZha2VBdXRoLCBzY3JpcHRlZEZldGNoLCBqc29uIH0gZnJvbSAnLi9faGVscGVycy5qcyc7XG5cbmNvbnN0IGNhY2hlID0ge1xuICBnZXRPclNldDogYXN5bmMgKF9rOiBzdHJpbmcsIGZuOiAoKSA9PiBQcm9taXNlPHVua25vd24+KSA9PiBmbigpLFxuICBjbGVhcigpIHt9LFxufSBhcyB1bmtub3duIGFzIFRvb2xEZXBzWydjYWNoZSddO1xuXG5mdW5jdGlvbiBkZXBzKGNsaWVudDogdW5rbm93bik6IFRvb2xEZXBzIHtcbiAgcmV0dXJuIHtcbiAgICBjbGllbnQ6IGNsaWVudCBhcyBUb29sRGVwc1snY2xpZW50J10sXG4gICAgY2FjaGUsXG4gICAgZGVmYXVsdFN1YmplY3Q6ICdtZUB4LmNvbScsXG4gICAgYWRtaW5TdWJqZWN0OiAnYWRtaW5AeC5jb20nLFxuICB9O1xufVxuXG4vLyAtLS0gY2xpZW50OiB3cml0ZVNoZWV0VmFsdWVzIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxudGVzdCgnd3JpdGVTaGVldFZhbHVlcyBvdmVyd3JpdGUgXHUyMTkyIFBVVCB2YWx1ZXMudXBkYXRlIHdpdGggYm9keSArIHZhbHVlSW5wdXRPcHRpb24nLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHsgYXV0aCB9ID0gZmFrZUF1dGgoKTtcbiAgY29uc3QgeyBmZXRjaEltcGwsIGNhbGxzIH0gPSBzY3JpcHRlZEZldGNoKFsoKSA9PiBqc29uKHsgdXBkYXRlZENlbGxzOiA0LCB1cGRhdGVkUmFuZ2U6ICdTIUExOkIyJyB9KV0pO1xuICBjb25zdCBjbGllbnQgPSBuZXcgR29vZ2xlV29ya3NwYWNlQ2xpZW50KHsgYXV0aCwgc2NvcGVzOiBbJ3MnXSwgZmV0Y2g6IGZldGNoSW1wbCB9KTtcbiAgY29uc3QgciA9IGF3YWl0IGNsaWVudC53cml0ZVNoZWV0VmFsdWVzKCd1QHguY29tJywgJ3NoZWV0MScsICdTIUExOkIyJywgW1snYScsICdiJ10sIFsxLCAyXV0pO1xuICBhc3NlcnQuZXF1YWwoY2FsbHNbMF0uaW5pdC5tZXRob2QsICdQVVQnKTtcbiAgYXNzZXJ0Lm1hdGNoKGNhbGxzWzBdLnVybCwgL1xcL3NwcmVhZHNoZWV0c1xcL3NoZWV0MVxcL3ZhbHVlc1xcL1MhQTElM0FCMlxcPy8pO1xuICBhc3NlcnQubWF0Y2goY2FsbHNbMF0udXJsLCAvdmFsdWVJbnB1dE9wdGlvbj1VU0VSX0VOVEVSRUQvKTtcbiAgY29uc3QgYm9keSA9IEpTT04ucGFyc2UoY2FsbHNbMF0uaW5pdC5ib2R5IGFzIHN0cmluZyk7XG4gIGFzc2VydC5kZWVwRXF1YWwoYm9keS52YWx1ZXMsIFtbJ2EnLCAnYiddLCBbMSwgMl1dKTtcbiAgYXNzZXJ0LmVxdWFsKGJvZHkubWFqb3JEaW1lbnNpb24sICdST1dTJyk7XG4gIGFzc2VydC5lcXVhbChyLnVwZGF0ZWRDZWxscywgNCk7XG59KTtcblxudGVzdCgnd3JpdGVTaGVldFZhbHVlcyBhcHBlbmQgXHUyMTkyIFBPU1QgOmFwcGVuZCB3aXRoIElOU0VSVF9ST1dTJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB7IGF1dGggfSA9IGZha2VBdXRoKCk7XG4gIGNvbnN0IHsgZmV0Y2hJbXBsLCBjYWxscyB9ID0gc2NyaXB0ZWRGZXRjaChbKCkgPT4ganNvbih7IHVwZGF0ZXM6IHsgdXBkYXRlZENlbGxzOiAyIH0gfSldKTtcbiAgY29uc3QgY2xpZW50ID0gbmV3IEdvb2dsZVdvcmtzcGFjZUNsaWVudCh7IGF1dGgsIHNjb3BlczogWydzJ10sIGZldGNoOiBmZXRjaEltcGwgfSk7XG4gIGF3YWl0IGNsaWVudC53cml0ZVNoZWV0VmFsdWVzKCd1QHguY29tJywgJ3NoZWV0MScsICdTIUExJywgW1sneCcsICd5J11dLCB7IG1vZGU6ICdhcHBlbmQnIH0pO1xuICBhc3NlcnQuZXF1YWwoY2FsbHNbMF0uaW5pdC5tZXRob2QsICdQT1NUJyk7XG4gIGFzc2VydC5tYXRjaChjYWxsc1swXS51cmwsIC9cXC92YWx1ZXNcXC9TIUExOmFwcGVuZFxcPy8pO1xuICBhc3NlcnQubWF0Y2goY2FsbHNbMF0udXJsLCAvaW5zZXJ0RGF0YU9wdGlvbj1JTlNFUlRfUk9XUy8pO1xufSk7XG5cbi8vIC0tLSBjbGllbnQ6IGNyZWF0ZURyaXZlRmlsZSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG50ZXN0KCdjcmVhdGVEcml2ZUZpbGUgbWV0YWRhdGEtb25seSBcdTIxOTIgUE9TVCAvZmlsZXMgd2l0aCBtZXRhZGF0YSBib2R5JywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB7IGF1dGggfSA9IGZha2VBdXRoKCk7XG4gIGNvbnN0IHsgZmV0Y2hJbXBsLCBjYWxscyB9ID0gc2NyaXB0ZWRGZXRjaChbKCkgPT4ganNvbih7IGlkOiAnZjEnLCBuYW1lOiAnUmVwb3J0cycsIG1pbWVUeXBlOiAnYXBwbGljYXRpb24vdm5kLmdvb2dsZS1hcHBzLmZvbGRlcicgfSldKTtcbiAgY29uc3QgY2xpZW50ID0gbmV3IEdvb2dsZVdvcmtzcGFjZUNsaWVudCh7IGF1dGgsIHNjb3BlczogWydzJ10sIGZldGNoOiBmZXRjaEltcGwgfSk7XG4gIGNvbnN0IHIgPSBhd2FpdCBjbGllbnQuY3JlYXRlRHJpdmVGaWxlKCd1QHguY29tJywge1xuICAgIG5hbWU6ICdSZXBvcnRzJyxcbiAgICBtaW1lVHlwZTogJ2FwcGxpY2F0aW9uL3ZuZC5nb29nbGUtYXBwcy5mb2xkZXInLFxuICAgIHBhcmVudHM6IFsncGFyZW50MSddLFxuICB9KTtcbiAgYXNzZXJ0LmVxdWFsKGNhbGxzWzBdLmluaXQubWV0aG9kLCAnUE9TVCcpO1xuICBhc3NlcnQubWF0Y2goY2FsbHNbMF0udXJsLCAvXFwvZHJpdmVcXC92M1xcL2ZpbGVzXFw/Lyk7XG4gIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKGNhbGxzWzBdLmluaXQuYm9keSBhcyBzdHJpbmcpO1xuICBhc3NlcnQuZXF1YWwoYm9keS5uYW1lLCAnUmVwb3J0cycpO1xuICBhc3NlcnQuZGVlcEVxdWFsKGJvZHkucGFyZW50cywgWydwYXJlbnQxJ10pO1xuICBhc3NlcnQuZXF1YWwoci5pZCwgJ2YxJyk7XG59KTtcblxudGVzdCgnY3JlYXRlRHJpdmVGaWxlIHdpdGggY29udGVudCBcdTIxOTIgbXVsdGlwYXJ0IHVwbG9hZCB0byB0aGUgdXBsb2FkIGhvc3QnLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHsgYXV0aCB9ID0gZmFrZUF1dGgoKTtcbiAgY29uc3QgeyBmZXRjaEltcGwsIGNhbGxzIH0gPSBzY3JpcHRlZEZldGNoKFsoKSA9PiBqc29uKHsgaWQ6ICdmMicsIG5hbWU6ICdub3Rlcy50eHQnIH0pXSk7XG4gIGNvbnN0IGNsaWVudCA9IG5ldyBHb29nbGVXb3Jrc3BhY2VDbGllbnQoeyBhdXRoLCBzY29wZXM6IFsncyddLCBmZXRjaDogZmV0Y2hJbXBsIH0pO1xuICBhd2FpdCBjbGllbnQuY3JlYXRlRHJpdmVGaWxlKCd1QHguY29tJywge1xuICAgIG5hbWU6ICdub3Rlcy50eHQnLFxuICAgIG1pbWVUeXBlOiAndGV4dC9wbGFpbicsXG4gICAgY29udGVudDogJ2hlbGxvIGJvZHknLFxuICB9KTtcbiAgYXNzZXJ0Lm1hdGNoKGNhbGxzWzBdLnVybCwgL15odHRwczpcXC9cXC93d3dcXC5nb29nbGVhcGlzXFwuY29tXFwvdXBsb2FkXFwvZHJpdmVcXC92M1xcL2ZpbGVzXFw/Lyk7XG4gIGFzc2VydC5tYXRjaChjYWxsc1swXS51cmwsIC91cGxvYWRUeXBlPW11bHRpcGFydC8pO1xuICBhc3NlcnQubWF0Y2goY2FsbHNbMF0uaW5pdC5oZWFkZXJzIVsnQ29udGVudC1UeXBlJ10sIC9ebXVsdGlwYXJ0XFwvcmVsYXRlZDsgYm91bmRhcnk9Lyk7XG4gIGNvbnN0IHJhdyA9IGNhbGxzWzBdLmluaXQuYm9keSBhcyBzdHJpbmc7XG4gIGFzc2VydC5tYXRjaChyYXcsIC9cIm5hbWVcIjpcIm5vdGVzLnR4dFwiLyk7XG4gIGFzc2VydC5tYXRjaChyYXcsIC9oZWxsbyBib2R5Lyk7XG59KTtcblxuLy8gLS0tIGhhbmRsZXJzIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbnRlc3QoJ2d3X3NoZWV0X3dyaXRlIHJlcXVpcmVzIGEgMkQgdmFsdWVzIGFycmF5JywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBoID0gY3JlYXRlU2hlZXRXcml0ZUhhbmRsZXIoZGVwcyh7fSkpO1xuICBhc3NlcnQubWF0Y2goYXdhaXQgaCh7IHNwcmVhZHNoZWV0SWQ6ICdzJywgcmFuZ2U6ICdBMScsIHZhbHVlczogJ25vcGUnIH0pLCAvRXJyb3I6LioyRCBhcnJheS8pO1xuICBhc3NlcnQubWF0Y2goYXdhaXQgaCh7IHNwcmVhZHNoZWV0SWQ6ICdzJywgcmFuZ2U6ICdBMScsIHZhbHVlczogWzEsIDJdIH0pLCAvRXJyb3I6LioyRCBhcnJheS8pO1xufSk7XG5cbnRlc3QoJ2d3X3NoZWV0X3dyaXRlIGhhcHB5IHBhdGggcmV0dXJucyB3cml0dGVuICsgbW9kZSArIGNsZWFycyBjYWNoZScsIGFzeW5jICgpID0+IHtcbiAgbGV0IGNsZWFyZWQgPSBmYWxzZTtcbiAgbGV0IGdvdDogeyBtb2RlPzogc3RyaW5nIH0gfCB1bmRlZmluZWQ7XG4gIGNvbnN0IGxvY2FsQ2FjaGUgPSB7IGdldE9yU2V0OiBhc3luYyAoX2s6IHN0cmluZywgZm46ICgpID0+IFByb21pc2U8dW5rbm93bj4pID0+IGZuKCksIGNsZWFyKCkgeyBjbGVhcmVkID0gdHJ1ZTsgfSB9O1xuICBjb25zdCBjbGllbnQgPSB7XG4gICAgd3JpdGVTaGVldFZhbHVlczogYXN5bmMgKF9zOiBzdHJpbmcsIF9pZDogc3RyaW5nLCBfcjogc3RyaW5nLCBfdjogdW5rbm93bltdW10sIHA6IHsgbW9kZT86IHN0cmluZyB9KSA9PiB7XG4gICAgICBnb3QgPSBwO1xuICAgICAgcmV0dXJuIHsgdXBkYXRlZFJhbmdlOiAnUyFBMTpCMicsIHVwZGF0ZWRSb3dzOiAyLCB1cGRhdGVkQ2VsbHM6IDQgfTtcbiAgICB9LFxuICB9O1xuICBjb25zdCBkID0geyBjbGllbnQsIGNhY2hlOiBsb2NhbENhY2hlLCBkZWZhdWx0U3ViamVjdDogJ21lQHguY29tJywgYWRtaW5TdWJqZWN0OiAnYUB4LmNvbScgfSBhcyB1bmtub3duIGFzIFRvb2xEZXBzO1xuICBjb25zdCBvdXQgPSBKU09OLnBhcnNlKFxuICAgIGF3YWl0IGNyZWF0ZVNoZWV0V3JpdGVIYW5kbGVyKGQpKHsgc3ByZWFkc2hlZXRJZDogJ3MnLCByYW5nZTogJ1MhQTE6QjInLCB2YWx1ZXM6IFtbJ2EnLCAnYiddLCBbMSwgMl1dLCBtb2RlOiAnYXBwZW5kJyB9KSxcbiAgKTtcbiAgYXNzZXJ0LmVxdWFsKG91dC53cml0dGVuLCB0cnVlKTtcbiAgYXNzZXJ0LmVxdWFsKG91dC5tb2RlLCAnYXBwZW5kJyk7XG4gIGFzc2VydC5lcXVhbChnb3QhLm1vZGUsICdhcHBlbmQnKTtcbiAgYXNzZXJ0LmVxdWFsKG91dC51cGRhdGVkQ2VsbHMsIDQpO1xuICBhc3NlcnQuZXF1YWwoY2xlYXJlZCwgdHJ1ZSk7XG59KTtcblxudGVzdCgnZ3dfZHJpdmVfY3JlYXRlIHJlcXVpcmVzIGEgbmFtZTsgZm9sZGVyICsgY29udGVudCBpcyByZWplY3RlZCcsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgaCA9IGNyZWF0ZURyaXZlQ3JlYXRlSGFuZGxlcihkZXBzKHt9KSk7XG4gIGFzc2VydC5tYXRjaChhd2FpdCBoKHt9KSwgL0Vycm9yOi4qXCJuYW1lXCIvKTtcbiAgYXNzZXJ0Lm1hdGNoKGF3YWl0IGgoeyBuYW1lOiAnWCcsIHR5cGU6ICdmb2xkZXInLCBjb250ZW50OiAnbm8nIH0pLCAvRXJyb3I6Lipmb2xkZXIgY2Fubm90IGhhdmUvKTtcbn0pO1xuXG50ZXN0KCdnd19kcml2ZV9jcmVhdGUgbWFwcyB0eXBlXHUyMTkybWltZVR5cGUgYW5kIHJldHVybnMgdGhlIG5ldyBpZCcsIGFzeW5jICgpID0+IHtcbiAgbGV0IGdvdDogeyBtaW1lVHlwZT86IHN0cmluZzsgcGFyZW50cz86IHN0cmluZ1tdIH0gfCB1bmRlZmluZWQ7XG4gIGNvbnN0IGNsaWVudCA9IHtcbiAgICBjcmVhdGVEcml2ZUZpbGU6IGFzeW5jIChfczogc3RyaW5nLCBwOiB7IG1pbWVUeXBlPzogc3RyaW5nOyBwYXJlbnRzPzogc3RyaW5nW10gfSkgPT4ge1xuICAgICAgZ290ID0gcDtcbiAgICAgIHJldHVybiB7IGlkOiAnZDEnLCBuYW1lOiAnUTMnLCBtaW1lVHlwZTogcC5taW1lVHlwZSwgd2ViVmlld0xpbms6ICdodHRwOi8veCcgfTtcbiAgICB9LFxuICB9O1xuICBjb25zdCBvdXQgPSBKU09OLnBhcnNlKFxuICAgIGF3YWl0IGNyZWF0ZURyaXZlQ3JlYXRlSGFuZGxlcihkZXBzKGNsaWVudCkpKHsgbmFtZTogJ1EzJywgdHlwZTogJ3NwcmVhZHNoZWV0JywgcGFyZW50SWQ6ICdwMScgfSksXG4gICk7XG4gIGFzc2VydC5lcXVhbChnb3QhLm1pbWVUeXBlLCAnYXBwbGljYXRpb24vdm5kLmdvb2dsZS1hcHBzLnNwcmVhZHNoZWV0Jyk7XG4gIGFzc2VydC5kZWVwRXF1YWwoZ290IS5wYXJlbnRzLCBbJ3AxJ10pO1xuICBhc3NlcnQuZXF1YWwob3V0LmNyZWF0ZWQsIHRydWUpO1xuICBhc3NlcnQuZXF1YWwob3V0LmlkLCAnZDEnKTtcbn0pO1xuIiwgIi8qKlxuICogRXJyb3IgdHlwZXMgc2hhcmVkIGFjcm9zcyB0aGUgR29vZ2xlIFdvcmtzcGFjZSBpbnRlZ3JhdGlvbiwgcGx1cyBhIHNpbmdsZVxuICogYGZvcm1hdFRvb2xFcnJvcmAgdGhhdCB0dXJucyBhbnkgdGhyb3duIGVycm9yIGludG8gYSBzaG9ydCwgbW9kZWwtcmVhZGFibGVcbiAqIHN0cmluZyB3aXRoIG5vIHN0YWNrIHRyYWNlcyBvciBzZWNyZXRzLlxuICovXG5cbi8qKiBSYWlzZWQgd2hlbiB0aGUgc2VydmljZS1hY2NvdW50IEpXVC1iZWFyZXIgdG9rZW4gZXhjaGFuZ2UgZmFpbHMuICovXG5leHBvcnQgY2xhc3MgR29vZ2xlQXV0aEVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICBjb25zdHJ1Y3RvcihtZXNzYWdlOiBzdHJpbmcpIHtcbiAgICBzdXBlcihtZXNzYWdlKTtcbiAgICB0aGlzLm5hbWUgPSAnR29vZ2xlQXV0aEVycm9yJztcbiAgfVxufVxuXG4vKiogUmFpc2VkIHdoZW4gYSBHb29nbGUgQVBJIHJlc3BvbmRzIHdpdGggYSBub24tMnh4IHN0YXR1cy4gKi9cbmV4cG9ydCBjbGFzcyBHb29nbGVBcGlFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgY29uc3RydWN0b3IoXG4gICAgcHVibGljIHJlYWRvbmx5IHN0YXR1czogbnVtYmVyLFxuICAgIHB1YmxpYyByZWFkb25seSByZWFzb246IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgICBtZXNzYWdlOiBzdHJpbmcsXG4gICkge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICAgIHRoaXMubmFtZSA9ICdHb29nbGVBcGlFcnJvcic7XG4gIH1cbn1cblxuLyoqIFJhaXNlZCBieSBjbGllbnQtc2lkZSBhcmd1bWVudCB2YWxpZGF0aW9uIGJlZm9yZSBhbnkgbmV0d29yayBjYWxsLiAqL1xuZXhwb3J0IGNsYXNzIEdvb2dsZUlucHV0RXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIGNvbnN0cnVjdG9yKG1lc3NhZ2U6IHN0cmluZykge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICAgIHRoaXMubmFtZSA9ICdHb29nbGVJbnB1dEVycm9yJztcbiAgfVxufVxuXG4vKipcbiAqIFR1cm4gY2xpZW50IGVycm9ycyBpbnRvIGEgc2hvcnQsIG1vZGVsLXJlYWRhYmxlIG1lc3NhZ2UuIE5ldmVyIGxlYWtzIHRoZVxuICogcHJpdmF0ZSBrZXksIGFjY2VzcyB0b2tlbiwgb3IgYSBzdGFjayB0cmFjZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdFRvb2xFcnJvcihlcnI6IHVua25vd24pOiBzdHJpbmcge1xuICBpZiAoZXJyIGluc3RhbmNlb2YgR29vZ2xlQXV0aEVycm9yKSB7XG4gICAgcmV0dXJuIGBFcnJvcjogR29vZ2xlIFdvcmtzcGFjZSBhdXRoZW50aWNhdGlvbiBmYWlsZWQgXHUyMDE0ICR7ZXJyLm1lc3NhZ2V9LiBDaGVjayB0aGUgc2VydmljZS1hY2NvdW50IGNsaWVudCBlbWFpbCArIHByaXZhdGUga2V5LCB0aGF0IGRvbWFpbi13aWRlIGRlbGVnYXRpb24gaXMgY29uZmlndXJlZCBpbiB0aGUgQWRtaW4gY29uc29sZSBmb3IgdGhlIHJlcXVpcmVkIHNjb3BlcywgYW5kIHRoYXQgdGhlIGltcGVyc29uYXRlZCB1c2VyIGV4aXN0cy5gO1xuICB9XG4gIGlmIChlcnIgaW5zdGFuY2VvZiBHb29nbGVBcGlFcnJvcikge1xuICAgIGNvbnN0IHJlYXNvbiA9IGVyci5yZWFzb24gPyBgIFske2Vyci5yZWFzb259XWAgOiAnJztcbiAgICByZXR1cm4gYEVycm9yOiBHb29nbGUgQVBJIHJldHVybmVkIEhUVFAgJHtlcnIuc3RhdHVzfSR7cmVhc29ufTogJHtlcnIubWVzc2FnZX1gO1xuICB9XG4gIGlmIChlcnIgaW5zdGFuY2VvZiBHb29nbGVJbnB1dEVycm9yKSB7XG4gICAgcmV0dXJuIGBFcnJvcjogJHtlcnIubWVzc2FnZX1gO1xuICB9XG4gIHJldHVybiBgRXJyb3I6ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWA7XG59XG4iLCAiLyoqXG4gKiBHb29nbGVXb3Jrc3BhY2VDbGllbnQgXHUyMDE0IGEgdGhpbiwgcmVhZC1tb3N0bHkgd3JhcHBlciBvdmVyIHRoZSBHb29nbGUgV29ya3NwYWNlXG4gKiBSRVNUIEFQSXMgKENhbGVuZGFyLCBHbWFpbCwgRHJpdmUsIERvY3MsIFNoZWV0cywgQWRtaW4gRGlyZWN0b3J5LCBQZW9wbGUpLlxuICpcbiAqIEF1dGggaXMgc2VydmljZS1hY2NvdW50ICoqZG9tYWluLXdpZGUgZGVsZWdhdGlvbioqOiBldmVyeSBjYWxsIGltcGVyc29uYXRlcyBhXG4gKiBgc3ViamVjdGAgKGEgV29ya3NwYWNlIHVzZXIncyBlbWFpbCkgdmlhIHtAbGluayBHb29nbGVTZXJ2aWNlQWNjb3VudEF1dGh9LlxuICogQWxsIGVncmVzcyBnb2VzIHRocm91Z2ggdGhlIGluamVjdGVkIGBmZXRjaGAgXHUyMDE0IGluIHRoZSBwbHVnaW4gdGhpcyBpc1xuICogYGN0eC5odHRwLmZldGNoYCwgYWxsb3ctbGlzdGVkICsgcmF0ZS1saW1pdGVkIGJ5IHRoZSBob3N0LiBUaGUgY2xpZW50IG5ldmVyXG4gKiB0b3VjaGVzIGdsb2JhbCBgZmV0Y2hgLCBzbyBpdCBzdGF5cyBpbnNpZGUgdGhlIGtlcm5lbCdzIGF1ZGl0YWJsZSBib3VuZGFyeS5cbiAqXG4gKiBSZXNwb25zZXMgYXJlIHNpemUtY2FwcGVkIChgbWF4Qnl0ZXNgKSBiZWZvcmUgYEpTT04ucGFyc2VgIHNvIGEgcGF0aG9sb2dpY2FsXG4gKiB1bmJvdW5kZWQgbGlzdCBjYW4ndCBibG93IHVwIHRoZSBob3N0J3MgbWVtb3J5LiBFYWNoIHB1YmxpYyBtZXRob2QgbmFtZXMgdGhlXG4gKiBzdXJmYWNlIGl0IHRhbGtzIHRvOyB0aGUgcHJpdmF0ZSBgcmVxdWVzdCgpYCByZXNvbHZlcyB0aGUgY29ycmVjdCBBUEkgaG9zdC5cbiAqL1xuXG5pbXBvcnQgeyBHb29nbGVBcGlFcnJvciB9IGZyb20gJy4vZXJyb3JzLmpzJztcbmltcG9ydCB0eXBlIHsgR29vZ2xlU2VydmljZUFjY291bnRBdXRoIH0gZnJvbSAnLi9nb29nbGVBdXRoLmpzJztcblxuZXhwb3J0IHR5cGUgR29vZ2xlQXBpID1cbiAgfCAnY2FsZW5kYXInXG4gIHwgJ2dtYWlsJ1xuICB8ICdkcml2ZSdcbiAgfCAnZG9jcydcbiAgfCAnc2hlZXRzJ1xuICB8ICdkaXJlY3RvcnknXG4gIHwgJ3Blb3BsZSc7XG5cbi8qKiBCYXNlIFVSTCBwZXIgQVBJIChob3N0ICsgdmVyc2lvbiBwcmVmaXgpLiBIb3N0cyBhcmUgbWFuaWZlc3QtYWxsb3ctbGlzdGVkLiAqL1xuY29uc3QgQVBJX0JBU0U6IFJlY29yZDxHb29nbGVBcGksIHN0cmluZz4gPSB7XG4gIGNhbGVuZGFyOiAnaHR0cHM6Ly93d3cuZ29vZ2xlYXBpcy5jb20vY2FsZW5kYXIvdjMnLFxuICBnbWFpbDogJ2h0dHBzOi8vZ21haWwuZ29vZ2xlYXBpcy5jb20vZ21haWwvdjEnLFxuICBkcml2ZTogJ2h0dHBzOi8vd3d3Lmdvb2dsZWFwaXMuY29tL2RyaXZlL3YzJyxcbiAgZG9jczogJ2h0dHBzOi8vZG9jcy5nb29nbGVhcGlzLmNvbS92MScsXG4gIHNoZWV0czogJ2h0dHBzOi8vc2hlZXRzLmdvb2dsZWFwaXMuY29tL3Y0JyxcbiAgZGlyZWN0b3J5OiAnaHR0cHM6Ly9hZG1pbi5nb29nbGVhcGlzLmNvbS9hZG1pbi9kaXJlY3RvcnkvdjEnLFxuICBwZW9wbGU6ICdodHRwczovL3Blb3BsZS5nb29nbGVhcGlzLmNvbS92MScsXG59O1xuXG5jb25zdCBERUZBVUxUX01BWF9CWVRFUyA9IDEwMjQgKiAxMDI0OyAvLyAxIE1pQlxuY29uc3QgREVGQVVMVF9SRVRSWV9CQVNFX01TID0gNTAwO1xuY29uc3QgREVGQVVMVF9NQVhfUkVUUklFUyA9IDM7XG4vKiogVHJhbnNpZW50IHN0YXR1c2VzIHdvcnRoIHJldHJ5aW5nIHdpdGggZXhwb25lbnRpYWwgYmFja29mZi4gKi9cbmNvbnN0IFJFVFJZQUJMRV9TVEFUVVMgPSBuZXcgU2V0KFs0MjksIDUwMCwgNTAyLCA1MDMsIDUwNF0pO1xuXG4vKiogR29vZ2xlIEpTT04gZXJyb3IgZW52ZWxvcGUgKFJFU1QpOiBgeyBlcnJvcjogeyBjb2RlLCBtZXNzYWdlLCBzdGF0dXMsIGVycm9ycyB9IH1gLiAqL1xuaW50ZXJmYWNlIEdvb2dsZUVycm9yRW52ZWxvcGUge1xuICByZWFkb25seSBlcnJvcj86IHtcbiAgICByZWFkb25seSBjb2RlPzogbnVtYmVyO1xuICAgIHJlYWRvbmx5IG1lc3NhZ2U/OiBzdHJpbmc7XG4gICAgcmVhZG9ubHkgc3RhdHVzPzogc3RyaW5nO1xuICAgIHJlYWRvbmx5IGVycm9ycz86IFJlYWRvbmx5QXJyYXk8eyByZWFkb25seSByZWFzb24/OiBzdHJpbmc7IHJlYWRvbmx5IG1lc3NhZ2U/OiBzdHJpbmcgfT47XG4gIH07XG59XG5cbnR5cGUgUXVlcnlWYWx1ZSA9IHN0cmluZyB8IG51bWJlciB8IGJvb2xlYW4gfCByZWFkb25seSBzdHJpbmdbXSB8IHVuZGVmaW5lZDtcblxuZXhwb3J0IGludGVyZmFjZSBHb29nbGVXb3Jrc3BhY2VDbGllbnRPcHRpb25zIHtcbiAgcmVhZG9ubHkgYXV0aDogR29vZ2xlU2VydmljZUFjY291bnRBdXRoO1xuICAvKiogVGhlIHVuaW9uIHNjb3BlIHNldCB0aGUgYWNjZXNzIHRva2VuIGlzIHJlcXVlc3RlZCB3aXRoLiAqL1xuICByZWFkb25seSBzY29wZXM6IHJlYWRvbmx5IHN0cmluZ1tdO1xuICAvKiogSGFyZCBjYXAgb24gYSBzaW5nbGUgcmVzcG9uc2UgYm9keSBpbiBieXRlcy4gRGVmYXVsdHMgdG8gMSBNaUIuICovXG4gIHJlYWRvbmx5IG1heEJ5dGVzPzogbnVtYmVyO1xuICAvKiogQmFzZSBkZWxheSBmb3IgZXhwb25lbnRpYWwgYmFja29mZiBvbiB0cmFuc2llbnQgZXJyb3JzIChtcykuIERlZmF1bHQgNTAwLiAqL1xuICByZWFkb25seSByZXRyeUJhc2VNcz86IG51bWJlcjtcbiAgLyoqIE1heCByZXRyaWVzIG9uIHRyYW5zaWVudCAoNDI5LzV4eCkgZXJyb3JzLiBEZWZhdWx0IDMuICovXG4gIHJlYWRvbmx5IG1heFJldHJpZXM/OiBudW1iZXI7XG4gIC8qKiBJbmplY3RlZCBmZXRjaCAocHJvZHVjdGlvbjogYGN0eC5odHRwLmZldGNoYCkuICovXG4gIHJlYWRvbmx5IGZldGNoOiB0eXBlb2YgZmV0Y2g7XG4gIC8qKiBPcHRpb25hbCBzdHJ1Y3R1cmVkIGxvZ2dlci4gKi9cbiAgcmVhZG9ubHkgbG9nPzogKG1lc3NhZ2U6IHN0cmluZykgPT4gdm9pZDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBSZXF1ZXN0T3B0aW9ucyB7XG4gIC8qKiBXb3Jrc3BhY2UgdXNlciB0byBpbXBlcnNvbmF0ZSAoRFdEIGBzdWJgKS4gKi9cbiAgcmVhZG9ubHkgc3ViamVjdDogc3RyaW5nO1xuICByZWFkb25seSBxdWVyeT86IFJlY29yZDxzdHJpbmcsIFF1ZXJ5VmFsdWU+O1xuICAvKiogSlNPTiByZXF1ZXN0IGJvZHkgKHNlcmlhbGl6ZWQgKyBzZW50IGFzIGFwcGxpY2F0aW9uL2pzb24pLiAqL1xuICByZWFkb25seSBib2R5PzogdW5rbm93bjtcbiAgLyoqXG4gICAqIFByZS1zZXJpYWxpemVkIGJvZHkgc2VudCB2ZXJiYXRpbSB3aXRoIGBjb250ZW50VHlwZWAgKGUuZy4gYSBtdWx0aXBhcnRcbiAgICogdXBsb2FkKS4gVGFrZXMgcHJlY2VkZW5jZSBvdmVyIGBib2R5YC4gVXNlZCBieSB0aGUgRHJpdmUgbWVkaWEgdXBsb2FkLlxuICAgKi9cbiAgcmVhZG9ubHkgcmF3Qm9keT86IHN0cmluZztcbiAgcmVhZG9ubHkgY29udGVudFR5cGU/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjbGFzcyBHb29nbGVXb3Jrc3BhY2VDbGllbnQge1xuICBwcml2YXRlIHJlYWRvbmx5IGF1dGg6IEdvb2dsZVNlcnZpY2VBY2NvdW50QXV0aDtcbiAgcHJpdmF0ZSByZWFkb25seSBzY29wZXM6IHJlYWRvbmx5IHN0cmluZ1tdO1xuICBwcml2YXRlIHJlYWRvbmx5IG1heEJ5dGVzOiBudW1iZXI7XG4gIHByaXZhdGUgcmVhZG9ubHkgcmV0cnlCYXNlTXM6IG51bWJlcjtcbiAgcHJpdmF0ZSByZWFkb25seSBtYXhSZXRyaWVzOiBudW1iZXI7XG4gIHByaXZhdGUgcmVhZG9ubHkgZmV0Y2hJbXBsOiB0eXBlb2YgZmV0Y2g7XG4gIHByaXZhdGUgcmVhZG9ubHkgbG9nOiAobWVzc2FnZTogc3RyaW5nKSA9PiB2b2lkO1xuICAvKiogU3ViamVjdHMgd2hvc2UgUGVvcGxlIGNvbnRhY3RzIGNhY2hlIGhhcyBiZWVuIHdhcm1lZCB0aGlzIHByb2Nlc3MuICovXG4gIHByaXZhdGUgcmVhZG9ubHkgd2FybWVkQ29udGFjdHMgPSBuZXcgU2V0PHN0cmluZz4oKTtcblxuICBjb25zdHJ1Y3RvcihvcHRzOiBHb29nbGVXb3Jrc3BhY2VDbGllbnRPcHRpb25zKSB7XG4gICAgdGhpcy5hdXRoID0gb3B0cy5hdXRoO1xuICAgIHRoaXMuc2NvcGVzID0gb3B0cy5zY29wZXM7XG4gICAgdGhpcy5tYXhCeXRlcyA9IG9wdHMubWF4Qnl0ZXMgJiYgb3B0cy5tYXhCeXRlcyA+IDAgPyBvcHRzLm1heEJ5dGVzIDogREVGQVVMVF9NQVhfQllURVM7XG4gICAgdGhpcy5yZXRyeUJhc2VNcyA9XG4gICAgICB0eXBlb2Ygb3B0cy5yZXRyeUJhc2VNcyA9PT0gJ251bWJlcicgJiYgb3B0cy5yZXRyeUJhc2VNcyA+PSAwXG4gICAgICAgID8gb3B0cy5yZXRyeUJhc2VNc1xuICAgICAgICA6IERFRkFVTFRfUkVUUllfQkFTRV9NUztcbiAgICB0aGlzLm1heFJldHJpZXMgPVxuICAgICAgdHlwZW9mIG9wdHMubWF4UmV0cmllcyA9PT0gJ251bWJlcicgJiYgb3B0cy5tYXhSZXRyaWVzID49IDBcbiAgICAgICAgPyBvcHRzLm1heFJldHJpZXNcbiAgICAgICAgOiBERUZBVUxUX01BWF9SRVRSSUVTO1xuICAgIHRoaXMuZmV0Y2hJbXBsID0gb3B0cy5mZXRjaDtcbiAgICB0aGlzLmxvZyA9IG9wdHMubG9nID8/ICgoKSA9PiB7fSk7XG4gIH1cblxuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIC8vIENvcmUgcmVxdWVzdCBcdTIwMTQgb25lIHJldHJ5IG9uIDQwMSAoZXhwaXJlZC9yb3RhdGVkIHRva2VuKS5cbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBwcml2YXRlIGFzeW5jIHJlcXVlc3Q8VCA9IFJlY29yZDxzdHJpbmcsIHVua25vd24+PihcbiAgICBhcGk6IEdvb2dsZUFwaSxcbiAgICBtZXRob2Q6IHN0cmluZyxcbiAgICBwYXRoOiBzdHJpbmcsXG4gICAgb3B0czogUmVxdWVzdE9wdGlvbnMsXG4gICk6IFByb21pc2U8VD4ge1xuICAgIC8vIEFuIGFic29sdXRlIGBwYXRoYCAoZS5nLiB0aGUgRHJpdmUgbWVkaWEtdXBsb2FkIGhvc3QpIGlzIHVzZWQgdmVyYmF0aW07XG4gICAgLy8gb3RoZXJ3aXNlIGl0IGlzIHJlc29sdmVkIGFnYWluc3QgdGhlIHBlci1BUEkgYmFzZS5cbiAgICBjb25zdCBiYXNlID0gcGF0aC5zdGFydHNXaXRoKCdodHRwJykgPyBwYXRoIDogYCR7QVBJX0JBU0VbYXBpXX0ke3BhdGh9YDtcbiAgICBjb25zdCB1cmwgPSBgJHtiYXNlfSR7YnVpbGRRdWVyeVN0cmluZyhvcHRzLnF1ZXJ5KX1gO1xuICAgIGNvbnN0IHNlbmQgPSBhc3luYyAoKTogUHJvbWlzZTxSZXNwb25zZT4gPT4ge1xuICAgICAgY29uc3QgdG9rZW4gPSBhd2FpdCB0aGlzLmF1dGguZ2V0VG9rZW4ob3B0cy5zdWJqZWN0LCB0aGlzLnNjb3Blcyk7XG4gICAgICBjb25zdCBoZWFkZXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICAgICAgICBBdXRob3JpemF0aW9uOiBgQmVhcmVyICR7dG9rZW59YCxcbiAgICAgICAgQWNjZXB0OiAnYXBwbGljYXRpb24vanNvbicsXG4gICAgICB9O1xuICAgICAgbGV0IHNlcmlhbGl6ZWQ6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICAgIGlmIChvcHRzLnJhd0JvZHkgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICBpZiAob3B0cy5jb250ZW50VHlwZSkgaGVhZGVyc1snQ29udGVudC1UeXBlJ10gPSBvcHRzLmNvbnRlbnRUeXBlO1xuICAgICAgICBzZXJpYWxpemVkID0gb3B0cy5yYXdCb2R5O1xuICAgICAgfSBlbHNlIGlmIChvcHRzLmJvZHkgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICBoZWFkZXJzWydDb250ZW50LVR5cGUnXSA9ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JztcbiAgICAgICAgc2VyaWFsaXplZCA9IEpTT04uc3RyaW5naWZ5KG9wdHMuYm9keSk7XG4gICAgICB9XG4gICAgICByZXR1cm4gdGhpcy5mZXRjaEltcGwodXJsLCB7IG1ldGhvZCwgaGVhZGVycywgYm9keTogc2VyaWFsaXplZCB9KTtcbiAgICB9O1xuXG4gICAgbGV0IHRva2VuUmV0cmllZCA9IGZhbHNlO1xuICAgIGZvciAobGV0IGF0dGVtcHQgPSAwOyA7IGF0dGVtcHQrKykge1xuICAgICAgY29uc3QgcmVzID0gYXdhaXQgc2VuZCgpO1xuXG4gICAgICAvLyBFeHBpcmVkL3JvdGF0ZWQgdG9rZW4gXHUyMDE0IHJlLW1pbnQgb25jZSwgbm90IGNvdW50ZWQgYWdhaW5zdCBiYWNrb2ZmLlxuICAgICAgaWYgKHJlcy5zdGF0dXMgPT09IDQwMSAmJiAhdG9rZW5SZXRyaWVkKSB7XG4gICAgICAgIHRoaXMubG9nKCdbZ29vZ2xld29ya3NwYWNlXSA0MDEgXHUyMDE0IHJlZnJlc2hpbmcgdG9rZW4gYW5kIHJldHJ5aW5nIG9uY2UnKTtcbiAgICAgICAgdG9rZW5SZXRyaWVkID0gdHJ1ZTtcbiAgICAgICAgdGhpcy5hdXRoLmludmFsaWRhdGUob3B0cy5zdWJqZWN0LCB0aGlzLnNjb3Blcyk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICAvLyBUcmFuc2llbnQgZXJyb3JzIFx1MjAxNCBleHBvbmVudGlhbCBiYWNrb2ZmIHVwIHRvIG1heFJldHJpZXMuXG4gICAgICBpZiAoUkVUUllBQkxFX1NUQVRVUy5oYXMocmVzLnN0YXR1cykgJiYgYXR0ZW1wdCA8IHRoaXMubWF4UmV0cmllcykge1xuICAgICAgICBjb25zdCBkZWxheSA9IHRoaXMuYmFja29mZkRlbGF5KGF0dGVtcHQsIHJlcyk7XG4gICAgICAgIHRoaXMubG9nKFxuICAgICAgICAgIGBbZ29vZ2xld29ya3NwYWNlXSBIVFRQICR7cmVzLnN0YXR1c30gb24gJHthcGl9IFx1MjAxNCByZXRyeSAke2F0dGVtcHQgKyAxfS8ke3RoaXMubWF4UmV0cmllc30gaW4gJHtkZWxheX1tc2AsXG4gICAgICAgICk7XG4gICAgICAgIGF3YWl0IHNsZWVwKGRlbGF5KTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIGlmICghcmVzLm9rKSB0aHJvdyBhd2FpdCB0aGlzLnRvQXBpRXJyb3IocmVzKTtcbiAgICAgIGNvbnN0IHRleHQgPSBhd2FpdCB0aGlzLnJlYWRDYXBwZWQocmVzKTtcbiAgICAgIHJldHVybiAodGV4dCA/IEpTT04ucGFyc2UodGV4dCkgOiB7fSkgYXMgVDtcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogQmFja29mZiBkZWxheSBmb3IgcmV0cnkgYGF0dGVtcHRgICgwLWJhc2VkKS4gSG9ub3VycyBhIGBSZXRyeS1BZnRlcmBcbiAgICogaGVhZGVyIChzZWNvbmRzKSB3aGVuIHRoZSBzZXJ2ZXIgc2VuZHMgb25lLCBvdGhlcndpc2UgZXhwb25lbnRpYWxcbiAgICogKGBiYXNlICogMl5hdHRlbXB0YCkgd2l0aCBhIGxpdHRsZSBqaXR0ZXIuXG4gICAqL1xuICBwcml2YXRlIGJhY2tvZmZEZWxheShhdHRlbXB0OiBudW1iZXIsIHJlczogUmVzcG9uc2UpOiBudW1iZXIge1xuICAgIGNvbnN0IHJldHJ5QWZ0ZXIgPSBOdW1iZXIocmVzLmhlYWRlcnMuZ2V0KCdyZXRyeS1hZnRlcicpID8/ICcnKTtcbiAgICBpZiAoTnVtYmVyLmlzRmluaXRlKHJldHJ5QWZ0ZXIpICYmIHJldHJ5QWZ0ZXIgPiAwKSB7XG4gICAgICByZXR1cm4gTWF0aC5taW4ocmV0cnlBZnRlciAqIDEwMDAsIDMwXzAwMCk7XG4gICAgfVxuICAgIGNvbnN0IGJhc2UgPSB0aGlzLnJldHJ5QmFzZU1zICogMiAqKiBhdHRlbXB0O1xuICAgIGNvbnN0IGppdHRlciA9IE1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSAqIE1hdGgubWluKHRoaXMucmV0cnlCYXNlTXMsIDI1MCkpO1xuICAgIHJldHVybiBNYXRoLm1pbihiYXNlICsgaml0dGVyLCAzMF8wMDApO1xuICB9XG5cbiAgLyoqIFJlYWQgYSByZXNwb25zZSBib2R5LCByZWZ1c2luZyBwYXlsb2FkcyBsYXJnZXIgdGhhbiBgbWF4Qnl0ZXNgLiAqL1xuICBwcml2YXRlIGFzeW5jIHJlYWRDYXBwZWQocmVzOiBSZXNwb25zZSk6IFByb21pc2U8c3RyaW5nPiB7XG4gICAgY29uc3QgZGVjbGFyZWQgPSBOdW1iZXIocmVzLmhlYWRlcnMuZ2V0KCdjb250ZW50LWxlbmd0aCcpID8/ICcnKTtcbiAgICBpZiAoTnVtYmVyLmlzRmluaXRlKGRlY2xhcmVkKSAmJiBkZWNsYXJlZCA+IHRoaXMubWF4Qnl0ZXMpIHtcbiAgICAgIHRocm93IG5ldyBHb29nbGVBcGlFcnJvcihcbiAgICAgICAgcmVzLnN0YXR1cyxcbiAgICAgICAgJ1Jlc3BvbnNlVG9vTGFyZ2UnLFxuICAgICAgICBgcmVzcG9uc2Ugb2YgJHtkZWNsYXJlZH0gYnl0ZXMgZXhjZWVkcyBtYXhCeXRlcz0ke3RoaXMubWF4Qnl0ZXN9YCxcbiAgICAgICk7XG4gICAgfVxuICAgIGNvbnN0IHRleHQgPSBhd2FpdCByZXMudGV4dCgpO1xuICAgIGlmICh0ZXh0Lmxlbmd0aCA+IHRoaXMubWF4Qnl0ZXMpIHtcbiAgICAgIHRocm93IG5ldyBHb29nbGVBcGlFcnJvcihcbiAgICAgICAgcmVzLnN0YXR1cyxcbiAgICAgICAgJ1Jlc3BvbnNlVG9vTGFyZ2UnLFxuICAgICAgICBgcmVzcG9uc2Ugb2YgJHt0ZXh0Lmxlbmd0aH0gYnl0ZXMgZXhjZWVkcyBtYXhCeXRlcz0ke3RoaXMubWF4Qnl0ZXN9YCxcbiAgICAgICk7XG4gICAgfVxuICAgIHJldHVybiB0ZXh0O1xuICB9XG5cbiAgLyoqIFBhcnNlIGEgbm9uLTJ4eCBib2R5IGludG8gYSB7QGxpbmsgR29vZ2xlQXBpRXJyb3J9LiAqL1xuICBwcml2YXRlIGFzeW5jIHRvQXBpRXJyb3IocmVzOiBSZXNwb25zZSk6IFByb21pc2U8R29vZ2xlQXBpRXJyb3I+IHtcbiAgICBsZXQgcmF3ID0gJyc7XG4gICAgdHJ5IHtcbiAgICAgIHJhdyA9IGF3YWl0IHRoaXMucmVhZENhcHBlZChyZXMpO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgaWYgKGVyciBpbnN0YW5jZW9mIEdvb2dsZUFwaUVycm9yKSByZXR1cm4gZXJyO1xuICAgIH1cbiAgICBsZXQgcmVhc29uOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gICAgbGV0IG1lc3NhZ2UgPSByYXcgfHwgcmVzLnN0YXR1c1RleHQ7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGVudiA9IEpTT04ucGFyc2UocmF3KSBhcyBHb29nbGVFcnJvckVudmVsb3BlO1xuICAgICAgaWYgKGVudi5lcnJvcikge1xuICAgICAgICByZWFzb24gPSBlbnYuZXJyb3Iuc3RhdHVzID8/IGVudi5lcnJvci5lcnJvcnM/LlswXT8ucmVhc29uO1xuICAgICAgICBtZXNzYWdlID0gZW52LmVycm9yLm1lc3NhZ2UgPz8gbWVzc2FnZTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIG5vbi1KU09OIGVycm9yIGJvZHkgXHUyMDE0IGtlZXAgcmF3ICovXG4gICAgfVxuICAgIHJldHVybiBuZXcgR29vZ2xlQXBpRXJyb3IocmVzLnN0YXR1cywgcmVhc29uLCBtZXNzYWdlKTtcbiAgfVxuXG4gIC8qKiBBY3F1aXJlIGEgdG9rZW4gZm9yIGBzdWJqZWN0YCB0byB2ZXJpZnkgY29ubmVjdGl2aXR5ICsgZGVsZWdhdGlvbi4gKi9cbiAgYXN5bmMgcHJvYmUoc3ViamVjdDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgYXdhaXQgdGhpcy5hdXRoLmdldFRva2VuKHN1YmplY3QsIHRoaXMuc2NvcGVzKTtcbiAgfVxuXG4gIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgLy8gQ2FsZW5kYXIgQVBJIHYzXG4gIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAvKiogTGlzdCBldmVudHMgb24gYSBjYWxlbmRhciAoZGVmYXVsdCBgcHJpbWFyeWApLiAqL1xuICBhc3luYyBsaXN0RXZlbnRzKFxuICAgIHN1YmplY3Q6IHN0cmluZyxcbiAgICBwOiB7XG4gICAgICBjYWxlbmRhcklkPzogc3RyaW5nO1xuICAgICAgdGltZU1pbj86IHN0cmluZztcbiAgICAgIHRpbWVNYXg/OiBzdHJpbmc7XG4gICAgICBxPzogc3RyaW5nO1xuICAgICAgbWF4UmVzdWx0cz86IG51bWJlcjtcbiAgICAgIHNpbmdsZUV2ZW50cz86IGJvb2xlYW47XG4gICAgICBvcmRlckJ5Pzogc3RyaW5nO1xuICAgICAgcGFnZVRva2VuPzogc3RyaW5nO1xuICAgIH0sXG4gICk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcbiAgICBjb25zdCBjYWxlbmRhcklkID0gcC5jYWxlbmRhcklkIHx8ICdwcmltYXJ5JztcbiAgICByZXR1cm4gdGhpcy5yZXF1ZXN0KCdjYWxlbmRhcicsICdHRVQnLCBgL2NhbGVuZGFycy8ke2VuY29kZVVSSUNvbXBvbmVudChjYWxlbmRhcklkKX0vZXZlbnRzYCwge1xuICAgICAgc3ViamVjdCxcbiAgICAgIHF1ZXJ5OiB7XG4gICAgICAgIHRpbWVNaW46IHAudGltZU1pbixcbiAgICAgICAgdGltZU1heDogcC50aW1lTWF4LFxuICAgICAgICBxOiBwLnEsXG4gICAgICAgIG1heFJlc3VsdHM6IHAubWF4UmVzdWx0cyxcbiAgICAgICAgc2luZ2xlRXZlbnRzOiBwLnNpbmdsZUV2ZW50cyA/PyB0cnVlLFxuICAgICAgICBvcmRlckJ5OiBwLm9yZGVyQnkgPz8gKHAuc2luZ2xlRXZlbnRzID09PSBmYWxzZSA/IHVuZGVmaW5lZCA6ICdzdGFydFRpbWUnKSxcbiAgICAgICAgcGFnZVRva2VuOiBwLnBhZ2VUb2tlbixcbiAgICAgIH0sXG4gICAgfSk7XG4gIH1cblxuICAvKiogUXVlcnkgZnJlZS9idXN5IHdpbmRvd3MgYWNyb3NzIG9uZSBvciBtb3JlIGNhbGVuZGFycy4gKi9cbiAgYXN5bmMgZnJlZUJ1c3koXG4gICAgc3ViamVjdDogc3RyaW5nLFxuICAgIHA6IHsgdGltZU1pbjogc3RyaW5nOyB0aW1lTWF4OiBzdHJpbmc7IGNhbGVuZGFySWRzOiByZWFkb25seSBzdHJpbmdbXSB9LFxuICApOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB7XG4gICAgcmV0dXJuIHRoaXMucmVxdWVzdCgnY2FsZW5kYXInLCAnUE9TVCcsICcvZnJlZUJ1c3knLCB7XG4gICAgICBzdWJqZWN0LFxuICAgICAgYm9keToge1xuICAgICAgICB0aW1lTWluOiBwLnRpbWVNaW4sXG4gICAgICAgIHRpbWVNYXg6IHAudGltZU1heCxcbiAgICAgICAgaXRlbXM6IHAuY2FsZW5kYXJJZHMubWFwKChpZCkgPT4gKHsgaWQgfSkpLFxuICAgICAgfSxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKiBDcmVhdGUgYSBjYWxlbmRhciBldmVudC4gKi9cbiAgYXN5bmMgY3JlYXRlRXZlbnQoXG4gICAgc3ViamVjdDogc3RyaW5nLFxuICAgIGNhbGVuZGFySWQ6IHN0cmluZyxcbiAgICBldmVudDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG4gICAgcDogeyBzZW5kVXBkYXRlcz86IHN0cmluZyB9ID0ge30sXG4gICk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcbiAgICByZXR1cm4gdGhpcy5yZXF1ZXN0KCdjYWxlbmRhcicsICdQT1NUJywgYC9jYWxlbmRhcnMvJHtlbmNvZGVVUklDb21wb25lbnQoY2FsZW5kYXJJZCl9L2V2ZW50c2AsIHtcbiAgICAgIHN1YmplY3QsXG4gICAgICBxdWVyeTogeyBzZW5kVXBkYXRlczogcC5zZW5kVXBkYXRlcyB9LFxuICAgICAgYm9keTogZXZlbnQsXG4gICAgfSk7XG4gIH1cblxuICAvKiogUGF0Y2ggKHBhcnRpYWwgdXBkYXRlKSBhbiBleGlzdGluZyBldmVudC4gKi9cbiAgYXN5bmMgcGF0Y2hFdmVudChcbiAgICBzdWJqZWN0OiBzdHJpbmcsXG4gICAgY2FsZW5kYXJJZDogc3RyaW5nLFxuICAgIGV2ZW50SWQ6IHN0cmluZyxcbiAgICBwYXRjaDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG4gICAgcDogeyBzZW5kVXBkYXRlcz86IHN0cmluZyB9ID0ge30sXG4gICk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcbiAgICByZXR1cm4gdGhpcy5yZXF1ZXN0KFxuICAgICAgJ2NhbGVuZGFyJyxcbiAgICAgICdQQVRDSCcsXG4gICAgICBgL2NhbGVuZGFycy8ke2VuY29kZVVSSUNvbXBvbmVudChjYWxlbmRhcklkKX0vZXZlbnRzLyR7ZW5jb2RlVVJJQ29tcG9uZW50KGV2ZW50SWQpfWAsXG4gICAgICB7IHN1YmplY3QsIHF1ZXJ5OiB7IHNlbmRVcGRhdGVzOiBwLnNlbmRVcGRhdGVzIH0sIGJvZHk6IHBhdGNoIH0sXG4gICAgKTtcbiAgfVxuXG4gIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgLy8gR21haWwgQVBJIHYxICh1c2VySWQgJ21lJyByZXNvbHZlcyB0byB0aGUgaW1wZXJzb25hdGVkIHN1YmplY3QpXG4gIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICBhc3luYyBzZWFyY2hNZXNzYWdlcyhcbiAgICBzdWJqZWN0OiBzdHJpbmcsXG4gICAgcDogeyBxPzogc3RyaW5nOyBtYXhSZXN1bHRzPzogbnVtYmVyOyBsYWJlbElkcz86IHJlYWRvbmx5IHN0cmluZ1tdOyBwYWdlVG9rZW4/OiBzdHJpbmcgfSxcbiAgKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4ge1xuICAgIHJldHVybiB0aGlzLnJlcXVlc3QoJ2dtYWlsJywgJ0dFVCcsICcvdXNlcnMvbWUvbWVzc2FnZXMnLCB7XG4gICAgICBzdWJqZWN0LFxuICAgICAgcXVlcnk6IHtcbiAgICAgICAgcTogcC5xLFxuICAgICAgICBtYXhSZXN1bHRzOiBwLm1heFJlc3VsdHMsXG4gICAgICAgIGxhYmVsSWRzOiBwLmxhYmVsSWRzLFxuICAgICAgICBwYWdlVG9rZW46IHAucGFnZVRva2VuLFxuICAgICAgfSxcbiAgICB9KTtcbiAgfVxuXG4gIGFzeW5jIGdldE1lc3NhZ2UoXG4gICAgc3ViamVjdDogc3RyaW5nLFxuICAgIGlkOiBzdHJpbmcsXG4gICAgcDogeyBmb3JtYXQ/OiBzdHJpbmcgfSA9IHt9LFxuICApOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB7XG4gICAgcmV0dXJuIHRoaXMucmVxdWVzdCgnZ21haWwnLCAnR0VUJywgYC91c2Vycy9tZS9tZXNzYWdlcy8ke2VuY29kZVVSSUNvbXBvbmVudChpZCl9YCwge1xuICAgICAgc3ViamVjdCxcbiAgICAgIHF1ZXJ5OiB7IGZvcm1hdDogcC5mb3JtYXQgPz8gJ2Z1bGwnIH0sXG4gICAgfSk7XG4gIH1cblxuICAvKiogU2VuZCBhIG1lc3NhZ2UuIGByYXdgIGlzIGEgYmFzZTY0dXJsLWVuY29kZWQgUkZDIDI4MjIgbWVzc2FnZS4gKi9cbiAgYXN5bmMgc2VuZE1lc3NhZ2Uoc3ViamVjdDogc3RyaW5nLCByYXc6IHN0cmluZyk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcbiAgICByZXR1cm4gdGhpcy5yZXF1ZXN0KCdnbWFpbCcsICdQT1NUJywgJy91c2Vycy9tZS9tZXNzYWdlcy9zZW5kJywge1xuICAgICAgc3ViamVjdCxcbiAgICAgIGJvZHk6IHsgcmF3IH0sXG4gICAgfSk7XG4gIH1cblxuICAvKiogQ3JlYXRlIGEgZHJhZnQuIGByYXdgIGlzIGEgYmFzZTY0dXJsLWVuY29kZWQgUkZDIDI4MjIgbWVzc2FnZS4gKi9cbiAgYXN5bmMgY3JlYXRlRHJhZnQoc3ViamVjdDogc3RyaW5nLCByYXc6IHN0cmluZyk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcbiAgICByZXR1cm4gdGhpcy5yZXF1ZXN0KCdnbWFpbCcsICdQT1NUJywgJy91c2Vycy9tZS9kcmFmdHMnLCB7XG4gICAgICBzdWJqZWN0LFxuICAgICAgYm9keTogeyBtZXNzYWdlOiB7IHJhdyB9IH0sXG4gICAgfSk7XG4gIH1cblxuICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gIC8vIERyaXZlIEFQSSB2MyAvIERvY3MgdjEgLyBTaGVldHMgdjRcbiAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gIGFzeW5jIHNlYXJjaEZpbGVzKFxuICAgIHN1YmplY3Q6IHN0cmluZyxcbiAgICBwOiB7IHE/OiBzdHJpbmc7IHBhZ2VTaXplPzogbnVtYmVyOyBvcmRlckJ5Pzogc3RyaW5nOyBmaWVsZHM/OiBzdHJpbmc7IHBhZ2VUb2tlbj86IHN0cmluZyB9LFxuICApOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB7XG4gICAgcmV0dXJuIHRoaXMucmVxdWVzdCgnZHJpdmUnLCAnR0VUJywgJy9maWxlcycsIHtcbiAgICAgIHN1YmplY3QsXG4gICAgICBxdWVyeToge1xuICAgICAgICBxOiBwLnEsXG4gICAgICAgIHBhZ2VTaXplOiBwLnBhZ2VTaXplLFxuICAgICAgICBvcmRlckJ5OiBwLm9yZGVyQnksXG4gICAgICAgIGZpZWxkczpcbiAgICAgICAgICBwLmZpZWxkcyA/P1xuICAgICAgICAgICdmaWxlcyhpZCxuYW1lLG1pbWVUeXBlLG1vZGlmaWVkVGltZSxvd25lcnMoZW1haWxBZGRyZXNzKSx3ZWJWaWV3TGluayxzaXplKSxuZXh0UGFnZVRva2VuJyxcbiAgICAgICAgcGFnZVRva2VuOiBwLnBhZ2VUb2tlbixcbiAgICAgICAgc3VwcG9ydHNBbGxEcml2ZXM6IHRydWUsXG4gICAgICAgIGluY2x1ZGVJdGVtc0Zyb21BbGxEcml2ZXM6IHRydWUsXG4gICAgICB9LFxuICAgIH0pO1xuICB9XG5cbiAgYXN5bmMgZ2V0RmlsZShcbiAgICBzdWJqZWN0OiBzdHJpbmcsXG4gICAgZmlsZUlkOiBzdHJpbmcsXG4gICAgcDogeyBmaWVsZHM/OiBzdHJpbmcgfSA9IHt9LFxuICApOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB7XG4gICAgcmV0dXJuIHRoaXMucmVxdWVzdCgnZHJpdmUnLCAnR0VUJywgYC9maWxlcy8ke2VuY29kZVVSSUNvbXBvbmVudChmaWxlSWQpfWAsIHtcbiAgICAgIHN1YmplY3QsXG4gICAgICBxdWVyeToge1xuICAgICAgICBmaWVsZHM6XG4gICAgICAgICAgcC5maWVsZHMgPz9cbiAgICAgICAgICAnaWQsbmFtZSxtaW1lVHlwZSxtb2RpZmllZFRpbWUsY3JlYXRlZFRpbWUsb3duZXJzKGVtYWlsQWRkcmVzcyxkaXNwbGF5TmFtZSksd2ViVmlld0xpbmssc2l6ZSxkZXNjcmlwdGlvbicsXG4gICAgICAgIHN1cHBvcnRzQWxsRHJpdmVzOiB0cnVlLFxuICAgICAgfSxcbiAgICB9KTtcbiAgfVxuXG4gIGFzeW5jIGdldERvY3VtZW50KHN1YmplY3Q6IHN0cmluZywgZG9jdW1lbnRJZDogc3RyaW5nKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4ge1xuICAgIHJldHVybiB0aGlzLnJlcXVlc3QoJ2RvY3MnLCAnR0VUJywgYC9kb2N1bWVudHMvJHtlbmNvZGVVUklDb21wb25lbnQoZG9jdW1lbnRJZCl9YCwgeyBzdWJqZWN0IH0pO1xuICB9XG5cbiAgYXN5bmMgZ2V0U2hlZXRWYWx1ZXMoXG4gICAgc3ViamVjdDogc3RyaW5nLFxuICAgIHNwcmVhZHNoZWV0SWQ6IHN0cmluZyxcbiAgICByYW5nZTogc3RyaW5nLFxuICApOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB7XG4gICAgcmV0dXJuIHRoaXMucmVxdWVzdChcbiAgICAgICdzaGVldHMnLFxuICAgICAgJ0dFVCcsXG4gICAgICBgL3NwcmVhZHNoZWV0cy8ke2VuY29kZVVSSUNvbXBvbmVudChzcHJlYWRzaGVldElkKX0vdmFsdWVzLyR7ZW5jb2RlVVJJQ29tcG9uZW50KHJhbmdlKX1gLFxuICAgICAgeyBzdWJqZWN0IH0sXG4gICAgKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBXcml0ZSB2YWx1ZXMgaW50byBhIFNoZWV0cyByYW5nZS4gYG1vZGU6ICdvdmVyd3JpdGUnYCAoZGVmYXVsdCkgUFVUcyB0aGVcbiAgICogcmFuZ2UgKGB2YWx1ZXMudXBkYXRlYCk7IGBtb2RlOiAnYXBwZW5kJ2AgYXBwZW5kcyByb3dzIGFmdGVyIHRoZSB0YWJsZVxuICAgKiAoYHZhbHVlcy5hcHBlbmRgIHdpdGggYElOU0VSVF9ST1dTYCkuIGB2YWx1ZUlucHV0T3B0aW9uYCBjb250cm9scyB3aGV0aGVyXG4gICAqIGlucHV0cyBhcmUgcGFyc2VkIChgVVNFUl9FTlRFUkVEYCkgb3Igc3RvcmVkIGFzLWlzIChgUkFXYCkuXG4gICAqL1xuICBhc3luYyB3cml0ZVNoZWV0VmFsdWVzKFxuICAgIHN1YmplY3Q6IHN0cmluZyxcbiAgICBzcHJlYWRzaGVldElkOiBzdHJpbmcsXG4gICAgcmFuZ2U6IHN0cmluZyxcbiAgICB2YWx1ZXM6IHVua25vd25bXVtdLFxuICAgIHA6IHsgbW9kZT86ICdvdmVyd3JpdGUnIHwgJ2FwcGVuZCc7IHZhbHVlSW5wdXRPcHRpb24/OiBzdHJpbmcgfSA9IHt9LFxuICApOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB7XG4gICAgY29uc3QgdmFsdWVJbnB1dE9wdGlvbiA9IHAudmFsdWVJbnB1dE9wdGlvbiA/PyAnVVNFUl9FTlRFUkVEJztcbiAgICBjb25zdCBlbmNvZGVkID0gYC9zcHJlYWRzaGVldHMvJHtlbmNvZGVVUklDb21wb25lbnQoc3ByZWFkc2hlZXRJZCl9L3ZhbHVlcy8ke2VuY29kZVVSSUNvbXBvbmVudChyYW5nZSl9YDtcbiAgICBjb25zdCBib2R5ID0geyByYW5nZSwgbWFqb3JEaW1lbnNpb246ICdST1dTJywgdmFsdWVzIH07XG4gICAgaWYgKHAubW9kZSA9PT0gJ2FwcGVuZCcpIHtcbiAgICAgIHJldHVybiB0aGlzLnJlcXVlc3QoJ3NoZWV0cycsICdQT1NUJywgYCR7ZW5jb2RlZH06YXBwZW5kYCwge1xuICAgICAgICBzdWJqZWN0LFxuICAgICAgICBxdWVyeTogeyB2YWx1ZUlucHV0T3B0aW9uLCBpbnNlcnREYXRhT3B0aW9uOiAnSU5TRVJUX1JPV1MnIH0sXG4gICAgICAgIGJvZHksXG4gICAgICB9KTtcbiAgICB9XG4gICAgcmV0dXJuIHRoaXMucmVxdWVzdCgnc2hlZXRzJywgJ1BVVCcsIGVuY29kZWQsIHtcbiAgICAgIHN1YmplY3QsXG4gICAgICBxdWVyeTogeyB2YWx1ZUlucHV0T3B0aW9uIH0sXG4gICAgICBib2R5LFxuICAgIH0pO1xuICB9XG5cbiAgLyoqXG4gICAqIENyZWF0ZSBhIERyaXZlIGZpbGUgb3IgZm9sZGVyLiBNZXRhZGF0YS1vbmx5IChubyBgY29udGVudGApIGlzIGEgcGxhaW5cbiAgICogYGZpbGVzLmNyZWF0ZWAgKGZvbGRlcnMsIGVtcHR5IG5hdGl2ZSBHb29nbGUgZmlsZXMpLiBXaXRoIGBjb250ZW50YCwgYVxuICAgKiBtdWx0aXBhcnQgbWVkaWEgdXBsb2FkIGlzIHVzZWQgc28gdGhlIGJ5dGVzIGxhbmQgaW4gdGhlIG5ldyBmaWxlICh0ZXh0XG4gICAqIGNvbnRlbnQ7IG5hdGl2ZSBHb29nbGUgdHlwZXMgYXJlIGNvbnZlcnRlZCBmcm9tIGl0KS5cbiAgICovXG4gIGFzeW5jIGNyZWF0ZURyaXZlRmlsZShcbiAgICBzdWJqZWN0OiBzdHJpbmcsXG4gICAgcDoge1xuICAgICAgbmFtZTogc3RyaW5nO1xuICAgICAgbWltZVR5cGU6IHN0cmluZztcbiAgICAgIHBhcmVudHM/OiByZWFkb25seSBzdHJpbmdbXTtcbiAgICAgIGNvbnRlbnQ/OiBzdHJpbmc7XG4gICAgICBjb250ZW50TWltZVR5cGU/OiBzdHJpbmc7XG4gICAgfSxcbiAgKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4ge1xuICAgIGNvbnN0IG1ldGFkYXRhOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHsgbmFtZTogcC5uYW1lLCBtaW1lVHlwZTogcC5taW1lVHlwZSB9O1xuICAgIGlmIChwLnBhcmVudHMgJiYgcC5wYXJlbnRzLmxlbmd0aCA+IDApIG1ldGFkYXRhLnBhcmVudHMgPSBwLnBhcmVudHM7XG4gICAgY29uc3QgZmllbGRzID0gJ2lkLG5hbWUsbWltZVR5cGUsd2ViVmlld0xpbmsscGFyZW50cyc7XG5cbiAgICBpZiAocC5jb250ZW50ID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHJldHVybiB0aGlzLnJlcXVlc3QoJ2RyaXZlJywgJ1BPU1QnLCAnL2ZpbGVzJywge1xuICAgICAgICBzdWJqZWN0LFxuICAgICAgICBxdWVyeTogeyBzdXBwb3J0c0FsbERyaXZlczogdHJ1ZSwgZmllbGRzIH0sXG4gICAgICAgIGJvZHk6IG1ldGFkYXRhLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgLy8gTXVsdGlwYXJ0IG1lZGlhIHVwbG9hZDogbWV0YWRhdGEgcGFydCArIG1lZGlhIHBhcnQuXG4gICAgY29uc3QgYm91bmRhcnkgPSBgb21hZGlhLWd3LSR7TWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMil9YDtcbiAgICBjb25zdCByYXdCb2R5ID0gW1xuICAgICAgYC0tJHtib3VuZGFyeX1gLFxuICAgICAgJ0NvbnRlbnQtVHlwZTogYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD1VVEYtOCcsXG4gICAgICAnJyxcbiAgICAgIEpTT04uc3RyaW5naWZ5KG1ldGFkYXRhKSxcbiAgICAgIGAtLSR7Ym91bmRhcnl9YCxcbiAgICAgIGBDb250ZW50LVR5cGU6ICR7cC5jb250ZW50TWltZVR5cGUgPz8gJ3RleHQvcGxhaW4nfTsgY2hhcnNldD1VVEYtOGAsXG4gICAgICAnJyxcbiAgICAgIHAuY29udGVudCxcbiAgICAgIGAtLSR7Ym91bmRhcnl9LS1gLFxuICAgICAgJycsXG4gICAgXS5qb2luKCdcXHJcXG4nKTtcbiAgICByZXR1cm4gdGhpcy5yZXF1ZXN0KCdkcml2ZScsICdQT1NUJywgJ2h0dHBzOi8vd3d3Lmdvb2dsZWFwaXMuY29tL3VwbG9hZC9kcml2ZS92My9maWxlcycsIHtcbiAgICAgIHN1YmplY3QsXG4gICAgICBxdWVyeTogeyB1cGxvYWRUeXBlOiAnbXVsdGlwYXJ0Jywgc3VwcG9ydHNBbGxEcml2ZXM6IHRydWUsIGZpZWxkcyB9LFxuICAgICAgcmF3Qm9keSxcbiAgICAgIGNvbnRlbnRUeXBlOiBgbXVsdGlwYXJ0L3JlbGF0ZWQ7IGJvdW5kYXJ5PSR7Ym91bmRhcnl9YCxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKiBSZWFkIGEgc3ByZWFkc2hlZXQncyB0YWIgbWV0YWRhdGEgKHRpdGxlICsgcGVyLXRhYiBzaGVldElkL3RpdGxlL2luZGV4KS4gUkVBRC4gKi9cbiAgYXN5bmMgZ2V0U3ByZWFkc2hlZXRNZXRhKFxuICAgIHN1YmplY3Q6IHN0cmluZyxcbiAgICBzcHJlYWRzaGVldElkOiBzdHJpbmcsXG4gICk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcbiAgICByZXR1cm4gdGhpcy5yZXF1ZXN0KCdzaGVldHMnLCAnR0VUJywgYC9zcHJlYWRzaGVldHMvJHtlbmNvZGVVUklDb21wb25lbnQoc3ByZWFkc2hlZXRJZCl9YCwge1xuICAgICAgc3ViamVjdCxcbiAgICAgIHF1ZXJ5OiB7XG4gICAgICAgIGZpZWxkczpcbiAgICAgICAgICAncHJvcGVydGllcyh0aXRsZSksc2hlZXRzKHByb3BlcnRpZXMoc2hlZXRJZCx0aXRsZSxpbmRleCxncmlkUHJvcGVydGllcyhyb3dDb3VudCxjb2x1bW5Db3VudCkpKScsXG4gICAgICB9LFxuICAgIH0pO1xuICB9XG5cbiAgLyoqXG4gICAqIFJ1biBhIFNoZWV0cyBgc3ByZWFkc2hlZXRzLmJhdGNoVXBkYXRlYCAoZS5nLiBgYWRkU2hlZXRgLCBgZHVwbGljYXRlU2hlZXRgKS5cbiAgICogV1JJVEUuIFJldHVybnMgdGhlIHJhdyByZXBseSBzbyBjYWxsZXJzIGNhbiByZWFkIGJhY2sgZS5nLiB0aGUgbmV3IHNoZWV0SWQuXG4gICAqL1xuICBhc3luYyBiYXRjaFVwZGF0ZVNwcmVhZHNoZWV0KFxuICAgIHN1YmplY3Q6IHN0cmluZyxcbiAgICBzcHJlYWRzaGVldElkOiBzdHJpbmcsXG4gICAgcmVxdWVzdHM6IHVua25vd25bXSxcbiAgKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4ge1xuICAgIHJldHVybiB0aGlzLnJlcXVlc3QoXG4gICAgICAnc2hlZXRzJyxcbiAgICAgICdQT1NUJyxcbiAgICAgIGAvc3ByZWFkc2hlZXRzLyR7ZW5jb2RlVVJJQ29tcG9uZW50KHNwcmVhZHNoZWV0SWQpfTpiYXRjaFVwZGF0ZWAsXG4gICAgICB7IHN1YmplY3QsIGJvZHk6IHsgcmVxdWVzdHMgfSB9LFxuICAgICk7XG4gIH1cblxuICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gIC8vIEFkbWluIERpcmVjdG9yeSB2MSAvIFBlb3BsZSB2MVxuICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgYXN5bmMgbGlzdERpcmVjdG9yeVVzZXJzKFxuICAgIHN1YmplY3Q6IHN0cmluZyxcbiAgICBwOiB7XG4gICAgICBjdXN0b21lcj86IHN0cmluZztcbiAgICAgIGRvbWFpbj86IHN0cmluZztcbiAgICAgIHF1ZXJ5Pzogc3RyaW5nO1xuICAgICAgbWF4UmVzdWx0cz86IG51bWJlcjtcbiAgICAgIG9yZGVyQnk/OiBzdHJpbmc7XG4gICAgICBwYWdlVG9rZW4/OiBzdHJpbmc7XG4gICAgfSxcbiAgKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4ge1xuICAgIC8vIGBjdXN0b21lcmAgYW5kIGBkb21haW5gIGFyZSBtdXR1YWxseSBleGNsdXNpdmU7IGRlZmF1bHQgdG8gbXlfY3VzdG9tZXIuXG4gICAgY29uc3QgdXNlRG9tYWluID0gQm9vbGVhbihwLmRvbWFpbik7XG4gICAgcmV0dXJuIHRoaXMucmVxdWVzdCgnZGlyZWN0b3J5JywgJ0dFVCcsICcvdXNlcnMnLCB7XG4gICAgICBzdWJqZWN0LFxuICAgICAgcXVlcnk6IHtcbiAgICAgICAgY3VzdG9tZXI6IHVzZURvbWFpbiA/IHVuZGVmaW5lZCA6IHAuY3VzdG9tZXIgfHwgJ215X2N1c3RvbWVyJyxcbiAgICAgICAgZG9tYWluOiBwLmRvbWFpbixcbiAgICAgICAgcXVlcnk6IHAucXVlcnksXG4gICAgICAgIG1heFJlc3VsdHM6IHAubWF4UmVzdWx0cyxcbiAgICAgICAgb3JkZXJCeTogcC5vcmRlckJ5LFxuICAgICAgICBwYWdlVG9rZW46IHAucGFnZVRva2VuLFxuICAgICAgICBwcm9qZWN0aW9uOiAnYmFzaWMnLFxuICAgICAgICB2aWV3VHlwZTogJ2FkbWluX3ZpZXcnLFxuICAgICAgfSxcbiAgICB9KTtcbiAgfVxuXG4gIGFzeW5jIHNlYXJjaENvbnRhY3RzKFxuICAgIHN1YmplY3Q6IHN0cmluZyxcbiAgICBwOiB7IHF1ZXJ5OiBzdHJpbmc7IHBhZ2VTaXplPzogbnVtYmVyOyByZWFkTWFzaz86IHN0cmluZyB9LFxuICApOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB7XG4gICAgY29uc3QgcmVhZE1hc2sgPSBwLnJlYWRNYXNrID8/ICduYW1lcyxlbWFpbEFkZHJlc3NlcyxwaG9uZU51bWJlcnMsb3JnYW5pemF0aW9ucyc7XG4gICAgLy8gUGVvcGxlIGBzZWFyY2hDb250YWN0c2AgcmVxdWlyZXMgYSB3YXJtdXAgKGVtcHR5LXF1ZXJ5KSByZXF1ZXN0IHRvIHByaW1lXG4gICAgLy8gdGhlIHNlcnZlci1zaWRlIGNhY2hlIGJlZm9yZSB0aGUgZmlyc3QgcmVhbCBzZWFyY2gsIG90aGVyd2lzZSByZXN1bHRzXG4gICAgLy8gY29tZSBiYWNrIGVtcHR5LiBCZXN0LWVmZm9ydCwgb25jZSBwZXIgc3ViamVjdCBwZXIgcHJvY2Vzcy5cbiAgICBpZiAoIXRoaXMud2FybWVkQ29udGFjdHMuaGFzKHN1YmplY3QpKSB7XG4gICAgICB0aGlzLndhcm1lZENvbnRhY3RzLmFkZChzdWJqZWN0KTtcbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IHRoaXMucmVxdWVzdCgncGVvcGxlJywgJ0dFVCcsICcvcGVvcGxlOnNlYXJjaENvbnRhY3RzJywge1xuICAgICAgICAgIHN1YmplY3QsXG4gICAgICAgICAgcXVlcnk6IHsgcXVlcnk6ICcnLCByZWFkTWFzayB9LFxuICAgICAgICB9KTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvLyBXYXJtdXAgaXMgYmVzdC1lZmZvcnQ7IHRoZSByZWFsIHF1ZXJ5IGJlbG93IHN1cmZhY2VzIGFueSByZWFsIGVycm9yLlxuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gdGhpcy5yZXF1ZXN0KCdwZW9wbGUnLCAnR0VUJywgJy9wZW9wbGU6c2VhcmNoQ29udGFjdHMnLCB7XG4gICAgICBzdWJqZWN0LFxuICAgICAgcXVlcnk6IHsgcXVlcnk6IHAucXVlcnksIHBhZ2VTaXplOiBwLnBhZ2VTaXplLCByZWFkTWFzayB9LFxuICAgIH0pO1xuICB9XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gSGVscGVyc1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICogQnVpbGQgYSBxdWVyeSBzdHJpbmcgZnJvbSBhIGZsYXQgcmVjb3JkLiBgdW5kZWZpbmVkYCB2YWx1ZXMgYXJlIHNraXBwZWQ7XG4gKiBhcnJheXMgZXhwYW5kIGludG8gcmVwZWF0ZWQgcGFyYW1zIChlLmcuIGBsYWJlbElkcz1BJmxhYmVsSWRzPUJgKS4gUmV0dXJuc1xuICogYCcnYCB3aGVuIG5vdGhpbmcgaXMgc2V0LlxuICovXG5mdW5jdGlvbiBidWlsZFF1ZXJ5U3RyaW5nKHF1ZXJ5OiBSZWNvcmQ8c3RyaW5nLCBRdWVyeVZhbHVlPiB8IHVuZGVmaW5lZCk6IHN0cmluZyB7XG4gIGlmICghcXVlcnkpIHJldHVybiAnJztcbiAgY29uc3Qgc3AgPSBuZXcgVVJMU2VhcmNoUGFyYW1zKCk7XG4gIGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKHF1ZXJ5KSkge1xuICAgIGlmICh2YWx1ZSA9PT0gdW5kZWZpbmVkKSBjb250aW51ZTtcbiAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgIGZvciAoY29uc3QgdiBvZiB2YWx1ZSkgc3AuYXBwZW5kKGtleSwgU3RyaW5nKHYpKTtcbiAgICB9IGVsc2Uge1xuICAgICAgc3AuYXBwZW5kKGtleSwgU3RyaW5nKHZhbHVlKSk7XG4gICAgfVxuICB9XG4gIGNvbnN0IHMgPSBzcC50b1N0cmluZygpO1xuICByZXR1cm4gcyA/IGA/JHtzfWAgOiAnJztcbn1cblxuLyoqIFByb21pc2UtYmFzZWQgc2xlZXAgdXNlZCBmb3IgcmV0cnkgYmFja29mZi4gKi9cbmZ1bmN0aW9uIHNsZWVwKG1zOiBudW1iZXIpOiBQcm9taXNlPHZvaWQ+IHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiBzZXRUaW1lb3V0KHJlc29sdmUsIG1zKSk7XG59XG4iLCAiLyoqXG4gKiBTaGFyZWQgZGVwZW5kZW5jeSBidW5kbGUgaGFuZGVkIHRvIGV2ZXJ5IHRvb2wgaGFuZGxlciBmYWN0b3J5LCBwbHVzIHRoZVxuICogc3ViamVjdC1yZXNvbHV0aW9uIHJ1bGUgdXNlZCBhY3Jvc3MgYWxsIHN1cmZhY2VzLlxuICpcbiAqIEltcGVyc29uYXRpb24gc3ViamVjdCBwcmVjZWRlbmNlOlxuICogICAxLiB0aGUgZXhwbGljaXQgYHVzZXJgIGFyZ3VtZW50IG9uIHRoZSB0b29sIGNhbGwgKGFuIGVtYWlsKSwgaWYgZ2l2ZW47XG4gKiAgIDIuIHRoZSBhZG1pbiBzdWJqZWN0IGZvciBkaXJlY3RvcnkvYWRtaW4gcmVhZHMgKGBhZG1pbjogdHJ1ZWApO1xuICogICAzLiB0aGUgZGVmYXVsdCBzdWJqZWN0IGZyb20gY29uZmlnLlxuICovXG5cbmltcG9ydCB0eXBlIHsgR29vZ2xlV29ya3NwYWNlQ2xpZW50IH0gZnJvbSAnLi9nb29nbGVDbGllbnQuanMnO1xuaW1wb3J0IHR5cGUgeyBSZXNwb25zZUNhY2hlIH0gZnJvbSAnLi9yZXNwb25zZUNhY2hlLmpzJztcbmltcG9ydCB7IEdvb2dsZUlucHV0RXJyb3IgfSBmcm9tICcuL2Vycm9ycy5qcyc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgVG9vbERlcHMge1xuICByZWFkb25seSBjbGllbnQ6IEdvb2dsZVdvcmtzcGFjZUNsaWVudDtcbiAgcmVhZG9ubHkgY2FjaGU6IFJlc3BvbnNlQ2FjaGU7XG4gIC8qKiBEZWZhdWx0IHVzZXIgdGhlIGludGVncmF0aW9uIGFjdHMgYXMgd2hlbiBhIHRvb2wgb21pdHMgYHVzZXJgLiAqL1xuICByZWFkb25seSBkZWZhdWx0U3ViamVjdDogc3RyaW5nO1xuICAvKiogQWRtaW4gdXNlciBpbXBlcnNvbmF0ZWQgZm9yIERpcmVjdG9yeS9BZG1pbiBTREsgcmVhZHMuICovXG4gIHJlYWRvbmx5IGFkbWluU3ViamVjdDogc3RyaW5nO1xufVxuXG4vKiogUmVzb2x2ZSB0aGUgaW1wZXJzb25hdGlvbiBzdWJqZWN0IGZvciBhIHRvb2wgY2FsbC4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlU3ViamVjdChcbiAgZGVwczogVG9vbERlcHMsXG4gIHVzZXI6IHVua25vd24sXG4gIG9wdHM6IHsgYWRtaW4/OiBib29sZWFuIH0gPSB7fSxcbik6IHN0cmluZyB7XG4gIGNvbnN0IHUgPSB0eXBlb2YgdXNlciA9PT0gJ3N0cmluZycgPyB1c2VyLnRyaW0oKSA6ICcnO1xuICBpZiAodSkge1xuICAgIGlmICghdS5pbmNsdWRlcygnQCcpKSB7XG4gICAgICB0aHJvdyBuZXcgR29vZ2xlSW5wdXRFcnJvcihgXCJ1c2VyXCIgbXVzdCBiZSBhIGZ1bGwgZW1haWwgYWRkcmVzcywgZ290OiAnJHt1fSdgKTtcbiAgICB9XG4gICAgcmV0dXJuIHU7XG4gIH1cbiAgY29uc3QgZmFsbGJhY2sgPSBvcHRzLmFkbWluID8gZGVwcy5hZG1pblN1YmplY3QgOiBkZXBzLmRlZmF1bHRTdWJqZWN0O1xuICBpZiAoIWZhbGxiYWNrKSB7XG4gICAgdGhyb3cgbmV3IEdvb2dsZUlucHV0RXJyb3IoXG4gICAgICBvcHRzLmFkbWluXG4gICAgICAgID8gJ25vIGFkbWluIHVzZXIgY29uZmlndXJlZCBcdTIwMTQgc2V0IGd3X2FkbWluX3N1YmplY3QgKG9yIGd3X3N1YmplY3RfZGVmYXVsdCkgb3IgcGFzcyBcInVzZXJcIi4nXG4gICAgICAgIDogJ25vIGRlZmF1bHQgdXNlciBjb25maWd1cmVkIFx1MjAxNCBzZXQgZ3dfc3ViamVjdF9kZWZhdWx0IG9yIHBhc3MgXCJ1c2VyXCIuJyxcbiAgICApO1xuICB9XG4gIHJldHVybiBmYWxsYmFjaztcbn1cbiIsICIvKipcbiAqIEdvb2dsZSBEcml2ZSAvIERvY3MgLyBTaGVldHMgdG9vbHMgKGFsbCBSRUFELU9OTFkgaW4gdjEpLlxuICpcbiAqICAgLSBgZ3dfZHJpdmVfc2VhcmNoYCAgIFx1MjAxNCBmaW5kIGZpbGVzL2ZvbGRlcnMgd2l0aCBEcml2ZSBxdWVyeSBzeW50YXguXG4gKiAgIC0gYGd3X2RyaXZlX2dldF9maWxlYCBcdTIwMTQgZmlsZSBtZXRhZGF0YSBieSBpZC5cbiAqICAgLSBgZ3dfZG9jX3JlYWRgICAgICAgIFx1MjAxNCBhIEdvb2dsZSBEb2MncyB0ZXh0IGNvbnRlbnQgKGZsYXR0ZW5lZCkuXG4gKiAgIC0gYGd3X3NoZWV0X3JlYWRgICAgICBcdTIwMTQgdmFsdWVzIGZyb20gYSBTaGVldHMgcmFuZ2UuXG4gKlxuICogQWxsIHJlYWRzIGdvIHRocm91Z2ggdGhlIHNob3J0LVRUTCBjYWNoZSBrZXllZCBieSB0aGUgaW1wZXJzb25hdGVkIHN1YmplY3QuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBOYXRpdmVUb29sSGFuZGxlciwgTmF0aXZlVG9vbFNwZWMgfSBmcm9tICdAb21hZGlhL3BsdWdpbi1hcGknO1xuXG5pbXBvcnQgeyBmb3JtYXRUb29sRXJyb3IsIEdvb2dsZUlucHV0RXJyb3IgfSBmcm9tICcuL2Vycm9ycy5qcyc7XG5pbXBvcnQgeyByZXNvbHZlU3ViamVjdCwgdHlwZSBUb29sRGVwcyB9IGZyb20gJy4vdG9vbERlcHMuanMnO1xuXG5jb25zdCBNQVhfUkVTVUxUUyA9IDUwO1xuY29uc3QgREVGQVVMVF9SRVNVTFRTID0gMjA7XG5cbmZ1bmN0aW9uIGNsYW1wKHZhbHVlOiB1bmtub3duLCBkZWY6IG51bWJlciwgbWF4OiBudW1iZXIpOiBudW1iZXIge1xuICBjb25zdCBuID0gdHlwZW9mIHZhbHVlID09PSAnbnVtYmVyJyA/IHZhbHVlIDogTnVtYmVyKHZhbHVlKTtcbiAgaWYgKCFOdW1iZXIuaXNGaW5pdGUobikgfHwgbiA8PSAwKSByZXR1cm4gZGVmO1xuICByZXR1cm4gTWF0aC5taW4oTWF0aC5mbG9vcihuKSwgbWF4KTtcbn1cbmZ1bmN0aW9uIHN0cih2YWx1ZTogdW5rbm93bik6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIHJldHVybiB0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnICYmIHZhbHVlLnRyaW0oKSA/IHZhbHVlLnRyaW0oKSA6IHVuZGVmaW5lZDtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBnd19kcml2ZV9zZWFyY2hcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuZXhwb3J0IGNvbnN0IGRyaXZlU2VhcmNoU3BlYzogTmF0aXZlVG9vbFNwZWMgPSB7XG4gIG5hbWU6ICdnd19kcml2ZV9zZWFyY2gnLFxuICBkZXNjcmlwdGlvbjpcbiAgICAnU2VhcmNoIEdvb2dsZSBEcml2ZSB1c2luZyBEcml2ZSBxdWVyeSBzeW50YXguIFJFQUQtT05MWS4gRXhhbXBsZXM6IFwibmFtZSBjb250YWlucyBcXCdidWRnZXRcXCdcIiwgXCJtaW1lVHlwZT1cXCdhcHBsaWNhdGlvbi92bmQuZ29vZ2xlLWFwcHMuZG9jdW1lbnRcXCdcIiwgXCJcXCdtZVxcJyBpbiBvd25lcnMgYW5kIG1vZGlmaWVkVGltZSA+IFxcJzIwMjYtMDEtMDFUMDA6MDA6MDBcXCdcIi4gUmV0dXJucyBmaWxlIG1ldGFkYXRhIChpZCwgbmFtZSwgbWltZVR5cGUsIG1vZGlmaWVkVGltZSwgb3duZXIsIGxpbmspLicsXG4gIGlucHV0X3NjaGVtYToge1xuICAgIHR5cGU6ICdvYmplY3QnLFxuICAgIHByb3BlcnRpZXM6IHtcbiAgICAgIHVzZXI6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAnRHJpdmUgb3duZXIgdG8gaW1wZXJzb25hdGUgKGVtYWlsKS4gT21pdCBmb3IgZGVmYXVsdC4nIH0sXG4gICAgICBxOiB7XG4gICAgICAgIHR5cGU6ICdzdHJpbmcnLFxuICAgICAgICBkZXNjcmlwdGlvbjpcbiAgICAgICAgICBcIkRyaXZlIHF1ZXJ5LiBlLmcuIFxcXCJuYW1lIGNvbnRhaW5zICdyZXBvcnQnIGFuZCB0cmFzaGVkPWZhbHNlXFxcIi4gT21pdCB0byBsaXN0IHJlY2VudCBmaWxlcy5cIixcbiAgICAgIH0sXG4gICAgICBvcmRlckJ5OiB7XG4gICAgICAgIHR5cGU6ICdzdHJpbmcnLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ1NvcnQsIGUuZy4gXCJtb2RpZmllZFRpbWUgZGVzY1wiLCBcIm5hbWVcIi4gRGVmYXVsdCBcIm1vZGlmaWVkVGltZSBkZXNjXCIuJyxcbiAgICAgIH0sXG4gICAgICBwYWdlU2l6ZTogeyB0eXBlOiAnbnVtYmVyJywgZGVzY3JpcHRpb246IGBNYXggZmlsZXMgcGVyIHBhZ2UgKDFcdTIwMTMke01BWF9SRVNVTFRTfSwgZGVmYXVsdCAke0RFRkFVTFRfUkVTVUxUU30pLmAgfSxcbiAgICAgIHBhZ2VUb2tlbjoge1xuICAgICAgICB0eXBlOiAnc3RyaW5nJyxcbiAgICAgICAgZGVzY3JpcHRpb246ICdQYWdlIGN1cnNvciBmcm9tIGEgcHJldmlvdXMgY2FsbFxcJ3MgXCJuZXh0UGFnZVRva2VuXCIgdG8gZmV0Y2ggdGhlIG5leHQgcGFnZS4nLFxuICAgICAgfSxcbiAgICB9LFxuICAgIHJlcXVpcmVkOiBbXSxcbiAgfSxcbn07XG5cbmV4cG9ydCBjb25zdCBEUklWRV9TRUFSQ0hfUFJPTVBUX0RPQyA9XG4gICdcXG4tIGBnd19kcml2ZV9zZWFyY2hgOiBSRUFELU9OTFkgR29vZ2xlIERyaXZlIHNlYXJjaCAoRHJpdmUgcXVlcnkgc3ludGF4OiBgbmFtZSBjb250YWlucyBcXCd4XFwnYCwgYG1pbWVUeXBlPVxcJ1x1MjAyNlxcJ2AsIGBtb2RpZmllZFRpbWUgPiBcXCdcdTIwMjZcXCdgKS4gUmV0dXJucyBmaWxlIG1ldGFkYXRhICsgaWRzOyB1c2UgdGhlIGlkIHdpdGggYGd3X2RyaXZlX2dldF9maWxlYCwgYGd3X2RvY19yZWFkYCBvciBgZ3dfc2hlZXRfcmVhZGAuXFxuJztcblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZURyaXZlU2VhcmNoSGFuZGxlcihkZXBzOiBUb29sRGVwcyk6IE5hdGl2ZVRvb2xIYW5kbGVyIHtcbiAgcmV0dXJuIGFzeW5jIChyYXc6IHVua25vd24pOiBQcm9taXNlPHN0cmluZz4gPT4ge1xuICAgIGNvbnN0IGlucHV0ID0gKHJhdyA/PyB7fSkgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHN1YmplY3QgPSByZXNvbHZlU3ViamVjdChkZXBzLCBpbnB1dC51c2VyKTtcbiAgICAgIGNvbnN0IHBhcmFtcyA9IHtcbiAgICAgICAgcTogc3RyKGlucHV0LnEpLFxuICAgICAgICBvcmRlckJ5OiBzdHIoaW5wdXQub3JkZXJCeSkgPz8gJ21vZGlmaWVkVGltZSBkZXNjJyxcbiAgICAgICAgcGFnZVNpemU6IGNsYW1wKGlucHV0LnBhZ2VTaXplLCBERUZBVUxUX1JFU1VMVFMsIE1BWF9SRVNVTFRTKSxcbiAgICAgICAgcGFnZVRva2VuOiBzdHIoaW5wdXQucGFnZVRva2VuKSxcbiAgICAgIH07XG4gICAgICBjb25zdCBrZXkgPSBgZHJpdmU6c2VhcmNoOiR7c3ViamVjdH06JHtKU09OLnN0cmluZ2lmeShwYXJhbXMpfWA7XG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBkZXBzLmNhY2hlLmdldE9yU2V0KGtleSwgKCkgPT4gZGVwcy5jbGllbnQuc2VhcmNoRmlsZXMoc3ViamVjdCwgcGFyYW1zKSk7XG4gICAgICBjb25zdCBmaWxlcyA9IChyZXN1bHQuZmlsZXMgYXMgdW5rbm93bltdKSA/PyBbXTtcbiAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeShcbiAgICAgICAgeyBzdWJqZWN0LCBjb3VudDogZmlsZXMubGVuZ3RoLCBuZXh0UGFnZVRva2VuOiByZXN1bHQubmV4dFBhZ2VUb2tlbiwgZmlsZXMgfSxcbiAgICAgICAgbnVsbCxcbiAgICAgICAgMixcbiAgICAgICk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICByZXR1cm4gZm9ybWF0VG9vbEVycm9yKGVycik7XG4gICAgfVxuICB9O1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIGd3X2RyaXZlX2dldF9maWxlXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbmV4cG9ydCBjb25zdCBkcml2ZUdldEZpbGVTcGVjOiBOYXRpdmVUb29sU3BlYyA9IHtcbiAgbmFtZTogJ2d3X2RyaXZlX2dldF9maWxlJyxcbiAgZGVzY3JpcHRpb246XG4gICAgJ0dldCBtZXRhZGF0YSBmb3Igb25lIEdvb2dsZSBEcml2ZSBmaWxlIGJ5IGlkIChuYW1lLCBtaW1lVHlwZSwgb3duZXJzLCB0aW1lc3RhbXBzLCBsaW5rLCBzaXplKS4gUkVBRC1PTkxZLiBGb3IgZG9jdW1lbnQgdGV4dCB1c2UgZ3dfZG9jX3JlYWQ7IGZvciBzcHJlYWRzaGVldCB2YWx1ZXMgdXNlIGd3X3NoZWV0X3JlYWQuJyxcbiAgaW5wdXRfc2NoZW1hOiB7XG4gICAgdHlwZTogJ29iamVjdCcsXG4gICAgcHJvcGVydGllczoge1xuICAgICAgdXNlcjogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICdEcml2ZSBvd25lciB0byBpbXBlcnNvbmF0ZSAoZW1haWwpLiBPbWl0IGZvciBkZWZhdWx0LicgfSxcbiAgICAgIGZpbGVJZDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICdEcml2ZSBmaWxlIGlkIChyZXF1aXJlZCkuJyB9LFxuICAgIH0sXG4gICAgcmVxdWlyZWQ6IFsnZmlsZUlkJ10sXG4gIH0sXG59O1xuXG5leHBvcnQgY29uc3QgRFJJVkVfR0VUX0ZJTEVfUFJPTVBUX0RPQyA9XG4gICdcXG4tIGBnd19kcml2ZV9nZXRfZmlsZWA6IFJFQUQtT05MWSBcdTIwMTQgbWV0YWRhdGEgZm9yIG9uZSBEcml2ZSBmaWxlIGJ5IGBmaWxlSWRgLiBGb3IgRG9jIHRleHQgdXNlIGBnd19kb2NfcmVhZGA7IGZvciBTaGVldCB2YWx1ZXMgdXNlIGBnd19zaGVldF9yZWFkYC5cXG4nO1xuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlRHJpdmVHZXRGaWxlSGFuZGxlcihkZXBzOiBUb29sRGVwcyk6IE5hdGl2ZVRvb2xIYW5kbGVyIHtcbiAgcmV0dXJuIGFzeW5jIChyYXc6IHVua25vd24pOiBQcm9taXNlPHN0cmluZz4gPT4ge1xuICAgIGNvbnN0IGlucHV0ID0gKHJhdyA/PyB7fSkgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHN1YmplY3QgPSByZXNvbHZlU3ViamVjdChkZXBzLCBpbnB1dC51c2VyKTtcbiAgICAgIGNvbnN0IGZpbGVJZCA9IHN0cihpbnB1dC5maWxlSWQpO1xuICAgICAgaWYgKCFmaWxlSWQpIHRocm93IG5ldyBHb29nbGVJbnB1dEVycm9yKCdcImZpbGVJZFwiIGlzIHJlcXVpcmVkLicpO1xuICAgICAgY29uc3Qga2V5ID0gYGRyaXZlOmZpbGU6JHtzdWJqZWN0fToke2ZpbGVJZH1gO1xuICAgICAgY29uc3QgZmlsZSA9IGF3YWl0IGRlcHMuY2FjaGUuZ2V0T3JTZXQoa2V5LCAoKSA9PiBkZXBzLmNsaWVudC5nZXRGaWxlKHN1YmplY3QsIGZpbGVJZCkpO1xuICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHsgc3ViamVjdCwgZmlsZSB9LCBudWxsLCAyKTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIHJldHVybiBmb3JtYXRUb29sRXJyb3IoZXJyKTtcbiAgICB9XG4gIH07XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gZ3dfZG9jX3JlYWRcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuZXhwb3J0IGNvbnN0IGRvY1JlYWRTcGVjOiBOYXRpdmVUb29sU3BlYyA9IHtcbiAgbmFtZTogJ2d3X2RvY19yZWFkJyxcbiAgZGVzY3JpcHRpb246XG4gICAgXCJSZWFkIGEgR29vZ2xlIERvYydzIHRleHQgY29udGVudCBieSBkb2N1bWVudCBpZC4gUkVBRC1PTkxZLiBSZXR1cm5zIHRoZSB0aXRsZSBhbmQgdGhlIGZsYXR0ZW5lZCBwbGFpbiB0ZXh0IG9mIHRoZSBib2R5IChjYXBwZWQpLiBVc2UgZ3dfZHJpdmVfc2VhcmNoIHRvIGZpbmQgdGhlIGRvY3VtZW50IGlkLlwiLFxuICBpbnB1dF9zY2hlbWE6IHtcbiAgICB0eXBlOiAnb2JqZWN0JyxcbiAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICB1c2VyOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ093bmVyIHRvIGltcGVyc29uYXRlIChlbWFpbCkuIE9taXQgZm9yIGRlZmF1bHQuJyB9LFxuICAgICAgZG9jdW1lbnRJZDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICdHb29nbGUgRG9jIGlkIChyZXF1aXJlZCkuJyB9LFxuICAgIH0sXG4gICAgcmVxdWlyZWQ6IFsnZG9jdW1lbnRJZCddLFxuICB9LFxufTtcblxuZXhwb3J0IGNvbnN0IERPQ19SRUFEX1BST01QVF9ET0MgPVxuICAnXFxuLSBgZ3dfZG9jX3JlYWRgOiBSRUFELU9OTFkgXHUyMDE0IGZsYXR0ZW4gYSBHb29nbGUgRG9jIHRvIHBsYWluIHRleHQgYnkgYGRvY3VtZW50SWRgIChmaW5kIGl0IHZpYSBgZ3dfZHJpdmVfc2VhcmNoYCkuXFxuJztcblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZURvY1JlYWRIYW5kbGVyKGRlcHM6IFRvb2xEZXBzKTogTmF0aXZlVG9vbEhhbmRsZXIge1xuICByZXR1cm4gYXN5bmMgKHJhdzogdW5rbm93bik6IFByb21pc2U8c3RyaW5nPiA9PiB7XG4gICAgY29uc3QgaW5wdXQgPSAocmF3ID8/IHt9KSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICB0cnkge1xuICAgICAgY29uc3Qgc3ViamVjdCA9IHJlc29sdmVTdWJqZWN0KGRlcHMsIGlucHV0LnVzZXIpO1xuICAgICAgY29uc3QgZG9jdW1lbnRJZCA9IHN0cihpbnB1dC5kb2N1bWVudElkKTtcbiAgICAgIGlmICghZG9jdW1lbnRJZCkgdGhyb3cgbmV3IEdvb2dsZUlucHV0RXJyb3IoJ1wiZG9jdW1lbnRJZFwiIGlzIHJlcXVpcmVkLicpO1xuICAgICAgY29uc3Qga2V5ID0gYGRvY3M6cmVhZDoke3N1YmplY3R9OiR7ZG9jdW1lbnRJZH1gO1xuICAgICAgY29uc3QgZG9jID0gYXdhaXQgZGVwcy5jYWNoZS5nZXRPclNldChrZXksICgpID0+IGRlcHMuY2xpZW50LmdldERvY3VtZW50KHN1YmplY3QsIGRvY3VtZW50SWQpKTtcbiAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeShcbiAgICAgICAge1xuICAgICAgICAgIHN1YmplY3QsXG4gICAgICAgICAgZG9jdW1lbnRJZCxcbiAgICAgICAgICB0aXRsZTogZG9jLnRpdGxlLFxuICAgICAgICAgIHRleHQ6IGZsYXR0ZW5Eb2NUZXh0KGRvYykuc2xpY2UoMCwgNDBfMDAwKSxcbiAgICAgICAgfSxcbiAgICAgICAgbnVsbCxcbiAgICAgICAgMixcbiAgICAgICk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICByZXR1cm4gZm9ybWF0VG9vbEVycm9yKGVycik7XG4gICAgfVxuICB9O1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIGd3X3NoZWV0X3JlYWRcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuZXhwb3J0IGNvbnN0IHNoZWV0UmVhZFNwZWM6IE5hdGl2ZVRvb2xTcGVjID0ge1xuICBuYW1lOiAnZ3dfc2hlZXRfcmVhZCcsXG4gIGRlc2NyaXB0aW9uOlxuICAgICdSZWFkIGNlbGwgdmFsdWVzIGZyb20gYSBHb29nbGUgU2hlZXRzIHJhbmdlIChBMSBub3RhdGlvbiwgZS5nLiBcIlNoZWV0MSFBMTpENTBcIikuIFJFQUQtT05MWS4gUmV0dXJucyBhIDJEIGFycmF5IG9mIHZhbHVlcy4nLFxuICBpbnB1dF9zY2hlbWE6IHtcbiAgICB0eXBlOiAnb2JqZWN0JyxcbiAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICB1c2VyOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ093bmVyIHRvIGltcGVyc29uYXRlIChlbWFpbCkuIE9taXQgZm9yIGRlZmF1bHQuJyB9LFxuICAgICAgc3ByZWFkc2hlZXRJZDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICdHb29nbGUgU2hlZXRzIGlkIChyZXF1aXJlZCkuJyB9LFxuICAgICAgcmFuZ2U6IHtcbiAgICAgICAgdHlwZTogJ3N0cmluZycsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAnQTEgcmFuZ2UsIGUuZy4gXCJTaGVldDEhQTE6RDUwXCIgb3IgXCJBOkNcIi4gUmVxdWlyZWQuJyxcbiAgICAgIH0sXG4gICAgfSxcbiAgICByZXF1aXJlZDogWydzcHJlYWRzaGVldElkJywgJ3JhbmdlJ10sXG4gIH0sXG59O1xuXG5leHBvcnQgY29uc3QgU0hFRVRfUkVBRF9QUk9NUFRfRE9DID1cbiAgJ1xcbi0gYGd3X3NoZWV0X3JlYWRgOiBSRUFELU9OTFkgXHUyMDE0IHJlYWQgYSBHb29nbGUgU2hlZXRzIHJhbmdlIGluIEExIG5vdGF0aW9uIChlLmcuIGBTaGVldDEhQTE6RDUwYCkgaW50byBhIDJEIGFycmF5Llxcbic7XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVTaGVldFJlYWRIYW5kbGVyKGRlcHM6IFRvb2xEZXBzKTogTmF0aXZlVG9vbEhhbmRsZXIge1xuICByZXR1cm4gYXN5bmMgKHJhdzogdW5rbm93bik6IFByb21pc2U8c3RyaW5nPiA9PiB7XG4gICAgY29uc3QgaW5wdXQgPSAocmF3ID8/IHt9KSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICB0cnkge1xuICAgICAgY29uc3Qgc3ViamVjdCA9IHJlc29sdmVTdWJqZWN0KGRlcHMsIGlucHV0LnVzZXIpO1xuICAgICAgY29uc3Qgc3ByZWFkc2hlZXRJZCA9IHN0cihpbnB1dC5zcHJlYWRzaGVldElkKTtcbiAgICAgIGNvbnN0IHJhbmdlID0gc3RyKGlucHV0LnJhbmdlKTtcbiAgICAgIGlmICghc3ByZWFkc2hlZXRJZCkgdGhyb3cgbmV3IEdvb2dsZUlucHV0RXJyb3IoJ1wic3ByZWFkc2hlZXRJZFwiIGlzIHJlcXVpcmVkLicpO1xuICAgICAgaWYgKCFyYW5nZSkgdGhyb3cgbmV3IEdvb2dsZUlucHV0RXJyb3IoJ1wicmFuZ2VcIiAoQTEgbm90YXRpb24pIGlzIHJlcXVpcmVkLicpO1xuICAgICAgY29uc3Qga2V5ID0gYHNoZWV0czpyZWFkOiR7c3ViamVjdH06JHtzcHJlYWRzaGVldElkfToke3JhbmdlfWA7XG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBkZXBzLmNhY2hlLmdldE9yU2V0KGtleSwgKCkgPT5cbiAgICAgICAgZGVwcy5jbGllbnQuZ2V0U2hlZXRWYWx1ZXMoc3ViamVjdCwgc3ByZWFkc2hlZXRJZCwgcmFuZ2UpLFxuICAgICAgKTtcbiAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeShcbiAgICAgICAgeyBzdWJqZWN0LCBzcHJlYWRzaGVldElkLCByYW5nZTogcmVzdWx0LnJhbmdlLCB2YWx1ZXM6IHJlc3VsdC52YWx1ZXMgPz8gW10gfSxcbiAgICAgICAgbnVsbCxcbiAgICAgICAgMixcbiAgICAgICk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICByZXR1cm4gZm9ybWF0VG9vbEVycm9yKGVycik7XG4gICAgfVxuICB9O1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIGd3X3NoZWV0X3dyaXRlICh3cml0ZSlcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuZXhwb3J0IGNvbnN0IHNoZWV0V3JpdGVTcGVjOiBOYXRpdmVUb29sU3BlYyA9IHtcbiAgbmFtZTogJ2d3X3NoZWV0X3dyaXRlJyxcbiAgZGVzY3JpcHRpb246XG4gICAgJ1dyaXRlIGNlbGwgdmFsdWVzIGludG8gYSBHb29nbGUgU2hlZXRzIHJhbmdlIChBMSBub3RhdGlvbikuIFdSSVRFIFx1MjAxNCBvbmx5IGNhbGwgYWZ0ZXIgdGhlIHVzZXIgY29uZmlybXMgdGhlIHRhcmdldCBzaGVldCwgcmFuZ2UgYW5kIGRhdGEuIG1vZGUgXCJvdmVyd3JpdGVcIiAoZGVmYXVsdCkgcmVwbGFjZXMgdGhlIHJhbmdlOyBtb2RlIFwiYXBwZW5kXCIgYWRkcyByb3dzIGFmdGVyIHRoZSBleGlzdGluZyB0YWJsZS4gVmFsdWVzIGFyZSBhIDJEIGFycmF5IChyb3dzIG9mIGNlbGxzKS4nLFxuICBpbnB1dF9zY2hlbWE6IHtcbiAgICB0eXBlOiAnb2JqZWN0JyxcbiAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICB1c2VyOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ093bmVyIHRvIGltcGVyc29uYXRlIChlbWFpbCkuIE9taXQgZm9yIGRlZmF1bHQuJyB9LFxuICAgICAgc3ByZWFkc2hlZXRJZDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICdHb29nbGUgU2hlZXRzIGlkIChyZXF1aXJlZCkuJyB9LFxuICAgICAgcmFuZ2U6IHtcbiAgICAgICAgdHlwZTogJ3N0cmluZycsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAnQTEgcmFuZ2UsIGUuZy4gXCJTaGVldDEhQTE6QzNcIiAob3ZlcndyaXRlKSBvciBcIlNoZWV0MSFBMVwiIChhcHBlbmQgYW5jaG9yKS4gUmVxdWlyZWQuJyxcbiAgICAgIH0sXG4gICAgICB2YWx1ZXM6IHtcbiAgICAgICAgdHlwZTogJ2FycmF5JyxcbiAgICAgICAgaXRlbXM6IHsgdHlwZTogJ2FycmF5JywgaXRlbXM6IHt9IH0sXG4gICAgICAgIGRlc2NyaXB0aW9uOiAnUm93cyBvZiBjZWxsIHZhbHVlcywgZS5nLiBbW1wiTmFtZVwiLFwiVG90YWxcIl0sW1wiQWNtZVwiLDQyXV0uIFJlcXVpcmVkLicsXG4gICAgICB9LFxuICAgICAgbW9kZToge1xuICAgICAgICB0eXBlOiAnc3RyaW5nJyxcbiAgICAgICAgZGVzY3JpcHRpb246ICdcIm92ZXJ3cml0ZVwiIChkZWZhdWx0LCByZXBsYWNlcyB0aGUgcmFuZ2UpIG9yIFwiYXBwZW5kXCIgKGFkZHMgcm93cyBhZnRlciB0aGUgdGFibGUpLicsXG4gICAgICB9LFxuICAgICAgdmFsdWVJbnB1dE9wdGlvbjoge1xuICAgICAgICB0eXBlOiAnc3RyaW5nJyxcbiAgICAgICAgZGVzY3JpcHRpb246ICdcIlVTRVJfRU5URVJFRFwiIChkZWZhdWx0LCBwYXJzZXMgZm9ybXVsYXMvZGF0ZXMpIG9yIFwiUkFXXCIgKHN0b3JlIGxpdGVyYWxseSkuJyxcbiAgICAgIH0sXG4gICAgfSxcbiAgICByZXF1aXJlZDogWydzcHJlYWRzaGVldElkJywgJ3JhbmdlJywgJ3ZhbHVlcyddLFxuICB9LFxufTtcblxuZXhwb3J0IGNvbnN0IFNIRUVUX1dSSVRFX1BST01QVF9ET0MgPVxuICAnXFxuLSBgZ3dfc2hlZXRfd3JpdGVgOiBXUklURSBcdTIwMTQgd3JpdGUgYSAyRCBgdmFsdWVzYCBhcnJheSBpbnRvIGEgR29vZ2xlIFNoZWV0cyBgcmFuZ2VgIChBMSkuIGBtb2RlOlwib3ZlcndyaXRlXCJgIHJlcGxhY2VzIHRoZSByYW5nZSwgYG1vZGU6XCJhcHBlbmRcImAgYWRkcyByb3dzIGFmdGVyIHRoZSB0YWJsZS4gQ29uZmlybSB0aGUgdGFyZ2V0IHdpdGggdGhlIHVzZXIgZmlyc3QuXFxuJztcblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVNoZWV0V3JpdGVIYW5kbGVyKGRlcHM6IFRvb2xEZXBzKTogTmF0aXZlVG9vbEhhbmRsZXIge1xuICByZXR1cm4gYXN5bmMgKHJhdzogdW5rbm93bik6IFByb21pc2U8c3RyaW5nPiA9PiB7XG4gICAgY29uc3QgaW5wdXQgPSAocmF3ID8/IHt9KSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICB0cnkge1xuICAgICAgY29uc3Qgc3ViamVjdCA9IHJlc29sdmVTdWJqZWN0KGRlcHMsIGlucHV0LnVzZXIpO1xuICAgICAgY29uc3Qgc3ByZWFkc2hlZXRJZCA9IHN0cihpbnB1dC5zcHJlYWRzaGVldElkKTtcbiAgICAgIGNvbnN0IHJhbmdlID0gc3RyKGlucHV0LnJhbmdlKTtcbiAgICAgIGlmICghc3ByZWFkc2hlZXRJZCkgdGhyb3cgbmV3IEdvb2dsZUlucHV0RXJyb3IoJ1wic3ByZWFkc2hlZXRJZFwiIGlzIHJlcXVpcmVkLicpO1xuICAgICAgaWYgKCFyYW5nZSkgdGhyb3cgbmV3IEdvb2dsZUlucHV0RXJyb3IoJ1wicmFuZ2VcIiAoQTEgbm90YXRpb24pIGlzIHJlcXVpcmVkLicpO1xuICAgICAgaWYgKCFBcnJheS5pc0FycmF5KGlucHV0LnZhbHVlcykgfHwgIWlucHV0LnZhbHVlcy5ldmVyeSgocikgPT4gQXJyYXkuaXNBcnJheShyKSkpIHtcbiAgICAgICAgdGhyb3cgbmV3IEdvb2dsZUlucHV0RXJyb3IoJ1widmFsdWVzXCIgbXVzdCBiZSBhIDJEIGFycmF5IChyb3dzIG9mIGNlbGxzKS4nKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IG1vZGUgPSBzdHIoaW5wdXQubW9kZSkgPT09ICdhcHBlbmQnID8gJ2FwcGVuZCcgOiAnb3ZlcndyaXRlJztcbiAgICAgIGNvbnN0IHZhbHVlSW5wdXRPcHRpb24gPSBzdHIoaW5wdXQudmFsdWVJbnB1dE9wdGlvbikgPT09ICdSQVcnID8gJ1JBVycgOiAnVVNFUl9FTlRFUkVEJztcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRlcHMuY2xpZW50LndyaXRlU2hlZXRWYWx1ZXMoXG4gICAgICAgIHN1YmplY3QsXG4gICAgICAgIHNwcmVhZHNoZWV0SWQsXG4gICAgICAgIHJhbmdlLFxuICAgICAgICBpbnB1dC52YWx1ZXMgYXMgdW5rbm93bltdW10sXG4gICAgICAgIHsgbW9kZSwgdmFsdWVJbnB1dE9wdGlvbiB9LFxuICAgICAgKTtcbiAgICAgIGRlcHMuY2FjaGUuY2xlYXIoKTtcbiAgICAgIC8vIGB1cGRhdGVgIHJldHVybnMgdXBkYXRlZCogYXQgdGhlIHRvcCBsZXZlbDsgYGFwcGVuZGAgbmVzdHMgdGhlbSB1bmRlciBgdXBkYXRlc2AuXG4gICAgICBjb25zdCB1cGRhdGVzID0gKHJlc3VsdC51cGRhdGVzIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA/PyByZXN1bHQ7XG4gICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoXG4gICAgICAgIHtcbiAgICAgICAgICB3cml0dGVuOiB0cnVlLFxuICAgICAgICAgIG1vZGUsXG4gICAgICAgICAgc3ByZWFkc2hlZXRJZCxcbiAgICAgICAgICB1cGRhdGVkUmFuZ2U6IHVwZGF0ZXMudXBkYXRlZFJhbmdlLFxuICAgICAgICAgIHVwZGF0ZWRSb3dzOiB1cGRhdGVzLnVwZGF0ZWRSb3dzLFxuICAgICAgICAgIHVwZGF0ZWRDZWxsczogdXBkYXRlcy51cGRhdGVkQ2VsbHMsXG4gICAgICAgIH0sXG4gICAgICAgIG51bGwsXG4gICAgICAgIDIsXG4gICAgICApO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgcmV0dXJuIGZvcm1hdFRvb2xFcnJvcihlcnIpO1xuICAgIH1cbiAgfTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBnd19kcml2ZV9jcmVhdGUgKHdyaXRlKVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5jb25zdCBEUklWRV9UWVBFX01JTUU6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gIGZvbGRlcjogJ2FwcGxpY2F0aW9uL3ZuZC5nb29nbGUtYXBwcy5mb2xkZXInLFxuICBkb2N1bWVudDogJ2FwcGxpY2F0aW9uL3ZuZC5nb29nbGUtYXBwcy5kb2N1bWVudCcsXG4gIHNwcmVhZHNoZWV0OiAnYXBwbGljYXRpb24vdm5kLmdvb2dsZS1hcHBzLnNwcmVhZHNoZWV0JyxcbiAgcHJlc2VudGF0aW9uOiAnYXBwbGljYXRpb24vdm5kLmdvb2dsZS1hcHBzLnByZXNlbnRhdGlvbicsXG4gIGZpbGU6ICd0ZXh0L3BsYWluJyxcbn07XG5cbmV4cG9ydCBjb25zdCBkcml2ZUNyZWF0ZVNwZWM6IE5hdGl2ZVRvb2xTcGVjID0ge1xuICBuYW1lOiAnZ3dfZHJpdmVfY3JlYXRlJyxcbiAgZGVzY3JpcHRpb246XG4gICAgJ0NyZWF0ZSBhIEdvb2dsZSBEcml2ZSBpdGVtLiBXUklURSBcdTIwMTQgb25seSBjYWxsIGFmdGVyIHRoZSB1c2VyIGNvbmZpcm1zLiBcInR5cGVcIjogZm9sZGVyIHwgZG9jdW1lbnQgfCBzcHJlYWRzaGVldCB8IHByZXNlbnRhdGlvbiB8IGZpbGUgKGRlZmF1bHQgZm9sZGVyKS4gT3B0aW9uYWwgXCJwYXJlbnRJZFwiIHBsYWNlcyBpdCBpbiBhIGZvbGRlciwgXCJjb250ZW50XCIgZmlsbHMgYSB0ZXh0L2RvY3VtZW50IGJvZHksIFwibWltZVR5cGVcIiBvdmVycmlkZXMgdGhlIHR5cGUuIFJldHVybnMgdGhlIG5ldyBpdGVtIGlkICsgbGluay4nLFxuICBpbnB1dF9zY2hlbWE6IHtcbiAgICB0eXBlOiAnb2JqZWN0JyxcbiAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICB1c2VyOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ093bmVyIHRvIGltcGVyc29uYXRlIChlbWFpbCkuIE9taXQgZm9yIGRlZmF1bHQuJyB9LFxuICAgICAgbmFtZTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICdOYW1lL3RpdGxlIG9mIHRoZSBuZXcgaXRlbSAocmVxdWlyZWQpLicgfSxcbiAgICAgIHR5cGU6IHtcbiAgICAgICAgdHlwZTogJ3N0cmluZycsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAnZm9sZGVyIHwgZG9jdW1lbnQgfCBzcHJlYWRzaGVldCB8IHByZXNlbnRhdGlvbiB8IGZpbGUuIERlZmF1bHQgZm9sZGVyLicsXG4gICAgICB9LFxuICAgICAgcGFyZW50SWQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAnSWQgb2YgdGhlIHBhcmVudCBmb2xkZXIuIE9taXQgZm9yIHRoZSBkcml2ZSByb290LicgfSxcbiAgICAgIGNvbnRlbnQ6IHtcbiAgICAgICAgdHlwZTogJ3N0cmluZycsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAnT3B0aW9uYWwgdGV4dCBjb250ZW50LiBGb3IgXCJmaWxlXCIgaXQgYmVjb21lcyB0aGUgYm9keTsgZm9yIFwiZG9jdW1lbnRcIiBpdCBpcyBpbXBvcnRlZCBhcyB0aGUgZG9jIHRleHQuJyxcbiAgICAgIH0sXG4gICAgICBtaW1lVHlwZTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICdBZHZhbmNlZDogZXhwbGljaXQgTUlNRSB0eXBlLCBvdmVycmlkZXMgXCJ0eXBlXCIuJyB9LFxuICAgIH0sXG4gICAgcmVxdWlyZWQ6IFsnbmFtZSddLFxuICB9LFxufTtcblxuZXhwb3J0IGNvbnN0IERSSVZFX0NSRUFURV9QUk9NUFRfRE9DID1cbiAgJ1xcbi0gYGd3X2RyaXZlX2NyZWF0ZWA6IFdSSVRFIFx1MjAxNCBjcmVhdGUgYSBEcml2ZSBpdGVtIGJ5IGBuYW1lYCBhbmQgYHR5cGVgIChmb2xkZXIgfCBkb2N1bWVudCB8IHNwcmVhZHNoZWV0IHwgcHJlc2VudGF0aW9uIHwgZmlsZSkuIE9wdGlvbmFsIGBwYXJlbnRJZGAgKGZvbGRlcikgYW5kIGBjb250ZW50YCAodGV4dCBib2R5IC8gZG9jIGltcG9ydCkuIENvbmZpcm0gd2l0aCB0aGUgdXNlciBmaXJzdC5cXG4nO1xuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlRHJpdmVDcmVhdGVIYW5kbGVyKGRlcHM6IFRvb2xEZXBzKTogTmF0aXZlVG9vbEhhbmRsZXIge1xuICByZXR1cm4gYXN5bmMgKHJhdzogdW5rbm93bik6IFByb21pc2U8c3RyaW5nPiA9PiB7XG4gICAgY29uc3QgaW5wdXQgPSAocmF3ID8/IHt9KSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICB0cnkge1xuICAgICAgY29uc3Qgc3ViamVjdCA9IHJlc29sdmVTdWJqZWN0KGRlcHMsIGlucHV0LnVzZXIpO1xuICAgICAgY29uc3QgbmFtZSA9IHN0cihpbnB1dC5uYW1lKTtcbiAgICAgIGlmICghbmFtZSkgdGhyb3cgbmV3IEdvb2dsZUlucHV0RXJyb3IoJ1wibmFtZVwiIGlzIHJlcXVpcmVkLicpO1xuICAgICAgY29uc3QgdHlwZSA9IChzdHIoaW5wdXQudHlwZSkgPz8gJ2ZvbGRlcicpLnRvTG93ZXJDYXNlKCk7XG4gICAgICBjb25zdCBtaW1lVHlwZSA9IHN0cihpbnB1dC5taW1lVHlwZSkgPz8gRFJJVkVfVFlQRV9NSU1FW3R5cGVdO1xuICAgICAgaWYgKCFtaW1lVHlwZSkge1xuICAgICAgICB0aHJvdyBuZXcgR29vZ2xlSW5wdXRFcnJvcihcbiAgICAgICAgICBgdW5rbm93biBcInR5cGVcIjogJHt0eXBlfS4gVXNlIGZvbGRlciB8IGRvY3VtZW50IHwgc3ByZWFkc2hlZXQgfCBwcmVzZW50YXRpb24gfCBmaWxlLCBvciBwYXNzIFwibWltZVR5cGVcIi5gLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgY29uc3QgY29udGVudCA9IHR5cGVvZiBpbnB1dC5jb250ZW50ID09PSAnc3RyaW5nJyA/IGlucHV0LmNvbnRlbnQgOiB1bmRlZmluZWQ7XG4gICAgICBpZiAoY29udGVudCAhPT0gdW5kZWZpbmVkICYmIHR5cGUgPT09ICdmb2xkZXInKSB7XG4gICAgICAgIHRocm93IG5ldyBHb29nbGVJbnB1dEVycm9yKCdhIGZvbGRlciBjYW5ub3QgaGF2ZSBcImNvbnRlbnRcIi4nKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHBhcmVudHMgPSBzdHIoaW5wdXQucGFyZW50SWQpID8gW3N0cihpbnB1dC5wYXJlbnRJZCkgYXMgc3RyaW5nXSA6IHVuZGVmaW5lZDtcbiAgICAgIGNvbnN0IGZpbGUgPSBhd2FpdCBkZXBzLmNsaWVudC5jcmVhdGVEcml2ZUZpbGUoc3ViamVjdCwgeyBuYW1lLCBtaW1lVHlwZSwgcGFyZW50cywgY29udGVudCB9KTtcbiAgICAgIGRlcHMuY2FjaGUuY2xlYXIoKTtcbiAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeShcbiAgICAgICAgeyBjcmVhdGVkOiB0cnVlLCBpZDogZmlsZS5pZCwgbmFtZTogZmlsZS5uYW1lLCBtaW1lVHlwZTogZmlsZS5taW1lVHlwZSwgd2ViVmlld0xpbms6IGZpbGUud2ViVmlld0xpbmsgfSxcbiAgICAgICAgbnVsbCxcbiAgICAgICAgMixcbiAgICAgICk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICByZXR1cm4gZm9ybWF0VG9vbEVycm9yKGVycik7XG4gICAgfVxuICB9O1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIGd3X3NoZWV0X2xpc3RfdGFicyAocmVhZClcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuZXhwb3J0IGNvbnN0IHNoZWV0TGlzdFRhYnNTcGVjOiBOYXRpdmVUb29sU3BlYyA9IHtcbiAgbmFtZTogJ2d3X3NoZWV0X2xpc3RfdGFicycsXG4gIGRlc2NyaXB0aW9uOlxuICAgICdMaXN0IHRoZSB0YWJzIChzaGVldHMpIG9mIGEgR29vZ2xlIFNwcmVhZHNoZWV0OiB0aXRsZSwgc2hlZXRJZCwgaW5kZXggYW5kIHNpemUuIFJFQUQtT05MWS4gVXNlIHRoaXMgdG8gY2hlY2sgd2hldGhlciBhIHRhYiBhbHJlYWR5IGV4aXN0cywgb3IgdG8gZ2V0IGEgdGFiXFwncyBzaGVldElkIGJlZm9yZSBkdXBsaWNhdGluZyBpdC4nLFxuICBpbnB1dF9zY2hlbWE6IHtcbiAgICB0eXBlOiAnb2JqZWN0JyxcbiAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICB1c2VyOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ093bmVyIHRvIGltcGVyc29uYXRlIChlbWFpbCkuIE9taXQgZm9yIGRlZmF1bHQuJyB9LFxuICAgICAgc3ByZWFkc2hlZXRJZDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICdHb29nbGUgU2hlZXRzIGlkIChyZXF1aXJlZCkuJyB9LFxuICAgIH0sXG4gICAgcmVxdWlyZWQ6IFsnc3ByZWFkc2hlZXRJZCddLFxuICB9LFxufTtcblxuZXhwb3J0IGNvbnN0IFNIRUVUX0xJU1RfVEFCU19QUk9NUFRfRE9DID1cbiAgJ1xcbi0gYGd3X3NoZWV0X2xpc3RfdGFic2A6IFJFQUQtT05MWSBcdTIwMTQgbGlzdCBhIHNwcmVhZHNoZWV0XFwncyB0YWJzICh0aXRsZSwgc2hlZXRJZCwgaW5kZXgpLiBVc2UgaXQgdG8gY2hlY2sgaWYgYSB0YWIgZXhpc3RzIGFuZCB0byBnZXQgdGhlIGBzaGVldElkYCBuZWVkZWQgYnkgYGd3X3NoZWV0X2R1cGxpY2F0ZV90YWJgLlxcbic7XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVTaGVldExpc3RUYWJzSGFuZGxlcihkZXBzOiBUb29sRGVwcyk6IE5hdGl2ZVRvb2xIYW5kbGVyIHtcbiAgcmV0dXJuIGFzeW5jIChyYXc6IHVua25vd24pOiBQcm9taXNlPHN0cmluZz4gPT4ge1xuICAgIGNvbnN0IGlucHV0ID0gKHJhdyA/PyB7fSkgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHN1YmplY3QgPSByZXNvbHZlU3ViamVjdChkZXBzLCBpbnB1dC51c2VyKTtcbiAgICAgIGNvbnN0IHNwcmVhZHNoZWV0SWQgPSBzdHIoaW5wdXQuc3ByZWFkc2hlZXRJZCk7XG4gICAgICBpZiAoIXNwcmVhZHNoZWV0SWQpIHRocm93IG5ldyBHb29nbGVJbnB1dEVycm9yKCdcInNwcmVhZHNoZWV0SWRcIiBpcyByZXF1aXJlZC4nKTtcbiAgICAgIGNvbnN0IGtleSA9IGBzaGVldHM6dGFiczoke3N1YmplY3R9OiR7c3ByZWFkc2hlZXRJZH1gO1xuICAgICAgY29uc3QgbWV0YSA9IGF3YWl0IGRlcHMuY2FjaGUuZ2V0T3JTZXQoa2V5LCAoKSA9PlxuICAgICAgICBkZXBzLmNsaWVudC5nZXRTcHJlYWRzaGVldE1ldGEoc3ViamVjdCwgc3ByZWFkc2hlZXRJZCksXG4gICAgICApO1xuICAgICAgY29uc3QgcHJvcHMgPSAobWV0YS5wcm9wZXJ0aWVzIGFzIHsgdGl0bGU/OiBzdHJpbmcgfSkgPz8ge307XG4gICAgICBjb25zdCB0YWJzID0gKChtZXRhLnNoZWV0cyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPltdKSA/PyBbXSkubWFwKChzKSA9PiB7XG4gICAgICAgIGNvbnN0IHAgPSAocy5wcm9wZXJ0aWVzIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA/PyB7fTtcbiAgICAgICAgY29uc3QgZ3JpZCA9IChwLmdyaWRQcm9wZXJ0aWVzIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA/PyB7fTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBzaGVldElkOiBwLnNoZWV0SWQsXG4gICAgICAgICAgdGl0bGU6IHAudGl0bGUsXG4gICAgICAgICAgaW5kZXg6IHAuaW5kZXgsXG4gICAgICAgICAgcm93czogZ3JpZC5yb3dDb3VudCxcbiAgICAgICAgICBjb2x1bW5zOiBncmlkLmNvbHVtbkNvdW50LFxuICAgICAgICB9O1xuICAgICAgfSk7XG4gICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoeyBzcHJlYWRzaGVldElkLCB0aXRsZTogcHJvcHMudGl0bGUsIHRhYnMgfSwgbnVsbCwgMik7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICByZXR1cm4gZm9ybWF0VG9vbEVycm9yKGVycik7XG4gICAgfVxuICB9O1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIGd3X3NoZWV0X2FkZF90YWIgKHdyaXRlKVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5leHBvcnQgY29uc3Qgc2hlZXRBZGRUYWJTcGVjOiBOYXRpdmVUb29sU3BlYyA9IHtcbiAgbmFtZTogJ2d3X3NoZWV0X2FkZF90YWInLFxuICBkZXNjcmlwdGlvbjpcbiAgICAnQWRkIGEgbmV3LCBFTVBUWSB0YWIgKHNoZWV0KSB0byBhIEdvb2dsZSBTcHJlYWRzaGVldC4gV1JJVEUgXHUyMDE0IGNvbmZpcm0gd2l0aCB0aGUgdXNlciBmaXJzdC4gQ3JlYXRlcyBhIGJsYW5rIHRhYiB3aXRoIG5vIGZvcm1hdHRpbmc7IHRvIGtlZXAgYW4gZXhpc3RpbmcgdGFiXFwncyBmb3JtYXR0aW5nL2Zvcm11bGFzIHVzZSBnd19zaGVldF9kdXBsaWNhdGVfdGFiIGluc3RlYWQuIFJldHVybnMgdGhlIG5ldyBzaGVldElkLicsXG4gIGlucHV0X3NjaGVtYToge1xuICAgIHR5cGU6ICdvYmplY3QnLFxuICAgIHByb3BlcnRpZXM6IHtcbiAgICAgIHVzZXI6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAnT3duZXIgdG8gaW1wZXJzb25hdGUgKGVtYWlsKS4gT21pdCBmb3IgZGVmYXVsdC4nIH0sXG4gICAgICBzcHJlYWRzaGVldElkOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ0dvb2dsZSBTaGVldHMgaWQgKHJlcXVpcmVkKS4nIH0sXG4gICAgICB0aXRsZTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICdUaXRsZSBvZiB0aGUgbmV3IHRhYiAocmVxdWlyZWQpLicgfSxcbiAgICAgIGluZGV4OiB7IHR5cGU6ICdudW1iZXInLCBkZXNjcmlwdGlvbjogJ09wdGlvbmFsIDAtYmFzZWQgcG9zaXRpb24gYW1vbmcgdGhlIHRhYnMuJyB9LFxuICAgIH0sXG4gICAgcmVxdWlyZWQ6IFsnc3ByZWFkc2hlZXRJZCcsICd0aXRsZSddLFxuICB9LFxufTtcblxuZXhwb3J0IGNvbnN0IFNIRUVUX0FERF9UQUJfUFJPTVBUX0RPQyA9XG4gICdcXG4tIGBnd19zaGVldF9hZGRfdGFiYDogV1JJVEUgXHUyMDE0IGFkZCBhIG5ldyBFTVBUWSB0YWIgdG8gYSBzcHJlYWRzaGVldCAobm8gZm9ybWF0dGluZykuIEZvciBhIGZvcm1hdHRlZCBjb3B5IG9mIGFuIGV4aXN0aW5nIHRhYiB1c2UgYGd3X3NoZWV0X2R1cGxpY2F0ZV90YWJgLiBDb25maXJtIHdpdGggdGhlIHVzZXIgZmlyc3QuXFxuJztcblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVNoZWV0QWRkVGFiSGFuZGxlcihkZXBzOiBUb29sRGVwcyk6IE5hdGl2ZVRvb2xIYW5kbGVyIHtcbiAgcmV0dXJuIGFzeW5jIChyYXc6IHVua25vd24pOiBQcm9taXNlPHN0cmluZz4gPT4ge1xuICAgIGNvbnN0IGlucHV0ID0gKHJhdyA/PyB7fSkgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHN1YmplY3QgPSByZXNvbHZlU3ViamVjdChkZXBzLCBpbnB1dC51c2VyKTtcbiAgICAgIGNvbnN0IHNwcmVhZHNoZWV0SWQgPSBzdHIoaW5wdXQuc3ByZWFkc2hlZXRJZCk7XG4gICAgICBjb25zdCB0aXRsZSA9IHN0cihpbnB1dC50aXRsZSk7XG4gICAgICBpZiAoIXNwcmVhZHNoZWV0SWQpIHRocm93IG5ldyBHb29nbGVJbnB1dEVycm9yKCdcInNwcmVhZHNoZWV0SWRcIiBpcyByZXF1aXJlZC4nKTtcbiAgICAgIGlmICghdGl0bGUpIHRocm93IG5ldyBHb29nbGVJbnB1dEVycm9yKCdcInRpdGxlXCIgaXMgcmVxdWlyZWQuJyk7XG4gICAgICBjb25zdCBwcm9wZXJ0aWVzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHsgdGl0bGUgfTtcbiAgICAgIGlmICh0eXBlb2YgaW5wdXQuaW5kZXggPT09ICdudW1iZXInKSBwcm9wZXJ0aWVzLmluZGV4ID0gaW5wdXQuaW5kZXg7XG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBkZXBzLmNsaWVudC5iYXRjaFVwZGF0ZVNwcmVhZHNoZWV0KHN1YmplY3QsIHNwcmVhZHNoZWV0SWQsIFtcbiAgICAgICAgeyBhZGRTaGVldDogeyBwcm9wZXJ0aWVzIH0gfSxcbiAgICAgIF0pO1xuICAgICAgZGVwcy5jYWNoZS5jbGVhcigpO1xuICAgICAgY29uc3QgcmVwbGllcyA9IChyZXN1bHQucmVwbGllcyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPltdKSA/PyBbXTtcbiAgICAgIGNvbnN0IGFkZGVkID0gKHJlcGxpZXNbMF0/LmFkZFNoZWV0IGFzIHsgcHJvcGVydGllcz86IFJlY29yZDxzdHJpbmcsIHVua25vd24+IH0pPy5wcm9wZXJ0aWVzO1xuICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KFxuICAgICAgICB7IGFkZGVkOiB0cnVlLCB0aXRsZSwgc2hlZXRJZDogYWRkZWQ/LnNoZWV0SWQsIGluZGV4OiBhZGRlZD8uaW5kZXggfSxcbiAgICAgICAgbnVsbCxcbiAgICAgICAgMixcbiAgICAgICk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICByZXR1cm4gZm9ybWF0VG9vbEVycm9yKGVycik7XG4gICAgfVxuICB9O1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIGd3X3NoZWV0X2R1cGxpY2F0ZV90YWIgKHdyaXRlKVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5leHBvcnQgY29uc3Qgc2hlZXREdXBsaWNhdGVUYWJTcGVjOiBOYXRpdmVUb29sU3BlYyA9IHtcbiAgbmFtZTogJ2d3X3NoZWV0X2R1cGxpY2F0ZV90YWInLFxuICBkZXNjcmlwdGlvbjpcbiAgICAnRHVwbGljYXRlIGFuIGV4aXN0aW5nIHRhYiB3aXRoaW4gYSBHb29nbGUgU3ByZWFkc2hlZXQsIGtlZXBpbmcgQUxMIGZvcm1hdHRpbmcsIGZvcm11bGFzLCBudW1iZXIgZm9ybWF0cyBhbmQgY29uZGl0aW9uYWwgZm9ybWF0dGluZy4gV1JJVEUgXHUyMDE0IGNvbmZpcm0gZmlyc3QuIElkZW50aWZ5IHRoZSBzb3VyY2UgYnkgc291cmNlVGl0bGUgb3Igc291cmNlU2hlZXRJZDsgdGhlIGNvcHkgZ2V0cyBuZXdOYW1lLiBUaGVuIHVzZSBnd19zaGVldF93cml0ZSB0byBvdmVyd3JpdGUganVzdCB0aGUgdmFsdWVzLiBSZXR1cm5zIHRoZSBuZXcgc2hlZXRJZC4nLFxuICBpbnB1dF9zY2hlbWE6IHtcbiAgICB0eXBlOiAnb2JqZWN0JyxcbiAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICB1c2VyOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ093bmVyIHRvIGltcGVyc29uYXRlIChlbWFpbCkuIE9taXQgZm9yIGRlZmF1bHQuJyB9LFxuICAgICAgc3ByZWFkc2hlZXRJZDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICdHb29nbGUgU2hlZXRzIGlkIChyZXF1aXJlZCkuJyB9LFxuICAgICAgc291cmNlVGl0bGU6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAnVGl0bGUgb2YgdGhlIHRhYiB0byBjb3B5IChvciB1c2Ugc291cmNlU2hlZXRJZCkuJyB9LFxuICAgICAgc291cmNlU2hlZXRJZDogeyB0eXBlOiAnbnVtYmVyJywgZGVzY3JpcHRpb246ICdzaGVldElkIG9mIHRoZSB0YWIgdG8gY29weSAoZnJvbSBnd19zaGVldF9saXN0X3RhYnMpLicgfSxcbiAgICAgIG5ld05hbWU6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAnTmFtZSBvZiB0aGUgZHVwbGljYXRlZCB0YWIgKHJlcXVpcmVkKS4nIH0sXG4gICAgICBpbmRleDogeyB0eXBlOiAnbnVtYmVyJywgZGVzY3JpcHRpb246ICdPcHRpb25hbCAwLWJhc2VkIGluc2VydCBwb3NpdGlvbiBmb3IgdGhlIGNvcHkuJyB9LFxuICAgIH0sXG4gICAgcmVxdWlyZWQ6IFsnc3ByZWFkc2hlZXRJZCcsICduZXdOYW1lJ10sXG4gIH0sXG59O1xuXG5leHBvcnQgY29uc3QgU0hFRVRfRFVQTElDQVRFX1RBQl9QUk9NUFRfRE9DID1cbiAgJ1xcbi0gYGd3X3NoZWV0X2R1cGxpY2F0ZV90YWJgOiBXUklURSBcdTIwMTQgZHVwbGljYXRlIGEgdGFiIFdJVEggYWxsIGZvcm1hdHRpbmcgKyBmb3JtdWxhcyAodGhlIHJpZ2h0IHdheSB0byBtYWtlIGUuZy4gYSBuZXcgeWVhclxcJ3Mgc2hlZXQgZnJvbSBhIHRlbXBsYXRlKS4gR2l2ZSBgc291cmNlVGl0bGVgIG9yIGBzb3VyY2VTaGVldElkYCArIGBuZXdOYW1lYCwgdGhlbiBvdmVyd3JpdGUgdmFsdWVzIHdpdGggYGd3X3NoZWV0X3dyaXRlYC4gQ29uZmlybSBmaXJzdC5cXG4nO1xuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlU2hlZXREdXBsaWNhdGVUYWJIYW5kbGVyKGRlcHM6IFRvb2xEZXBzKTogTmF0aXZlVG9vbEhhbmRsZXIge1xuICByZXR1cm4gYXN5bmMgKHJhdzogdW5rbm93bik6IFByb21pc2U8c3RyaW5nPiA9PiB7XG4gICAgY29uc3QgaW5wdXQgPSAocmF3ID8/IHt9KSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICB0cnkge1xuICAgICAgY29uc3Qgc3ViamVjdCA9IHJlc29sdmVTdWJqZWN0KGRlcHMsIGlucHV0LnVzZXIpO1xuICAgICAgY29uc3Qgc3ByZWFkc2hlZXRJZCA9IHN0cihpbnB1dC5zcHJlYWRzaGVldElkKTtcbiAgICAgIGNvbnN0IG5ld05hbWUgPSBzdHIoaW5wdXQubmV3TmFtZSk7XG4gICAgICBpZiAoIXNwcmVhZHNoZWV0SWQpIHRocm93IG5ldyBHb29nbGVJbnB1dEVycm9yKCdcInNwcmVhZHNoZWV0SWRcIiBpcyByZXF1aXJlZC4nKTtcbiAgICAgIGlmICghbmV3TmFtZSkgdGhyb3cgbmV3IEdvb2dsZUlucHV0RXJyb3IoJ1wibmV3TmFtZVwiIGlzIHJlcXVpcmVkLicpO1xuXG4gICAgICBsZXQgc291cmNlU2hlZXRJZCA9XG4gICAgICAgIHR5cGVvZiBpbnB1dC5zb3VyY2VTaGVldElkID09PSAnbnVtYmVyJyA/IGlucHV0LnNvdXJjZVNoZWV0SWQgOiB1bmRlZmluZWQ7XG4gICAgICBjb25zdCBzb3VyY2VUaXRsZSA9IHN0cihpbnB1dC5zb3VyY2VUaXRsZSk7XG4gICAgICBpZiAoc291cmNlU2hlZXRJZCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGlmICghc291cmNlVGl0bGUpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgR29vZ2xlSW5wdXRFcnJvcigncHJvdmlkZSBcInNvdXJjZVRpdGxlXCIgb3IgXCJzb3VyY2VTaGVldElkXCIgb2YgdGhlIHRhYiB0byBjb3B5LicpO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IG1ldGEgPSBhd2FpdCBkZXBzLmNsaWVudC5nZXRTcHJlYWRzaGVldE1ldGEoc3ViamVjdCwgc3ByZWFkc2hlZXRJZCk7XG4gICAgICAgIGNvbnN0IG1hdGNoID0gKChtZXRhLnNoZWV0cyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPltdKSA/PyBbXSkuZmluZCgocykgPT4ge1xuICAgICAgICAgIGNvbnN0IHAgPSAocy5wcm9wZXJ0aWVzIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA/PyB7fTtcbiAgICAgICAgICByZXR1cm4gcC50aXRsZSA9PT0gc291cmNlVGl0bGU7XG4gICAgICAgIH0pO1xuICAgICAgICBjb25zdCBwcm9wcyA9IChtYXRjaD8ucHJvcGVydGllcyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPz8ge307XG4gICAgICAgIGlmICh0eXBlb2YgcHJvcHMuc2hlZXRJZCAhPT0gJ251bWJlcicpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgR29vZ2xlSW5wdXRFcnJvcihgbm8gdGFiIG5hbWVkIFwiJHtzb3VyY2VUaXRsZX1cIiBmb3VuZCBpbiB0aGlzIHNwcmVhZHNoZWV0LmApO1xuICAgICAgICB9XG4gICAgICAgIHNvdXJjZVNoZWV0SWQgPSBwcm9wcy5zaGVldElkO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBkdXA6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0geyBzb3VyY2VTaGVldElkLCBuZXdTaGVldE5hbWU6IG5ld05hbWUgfTtcbiAgICAgIGlmICh0eXBlb2YgaW5wdXQuaW5kZXggPT09ICdudW1iZXInKSBkdXAuaW5zZXJ0U2hlZXRJbmRleCA9IGlucHV0LmluZGV4O1xuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZGVwcy5jbGllbnQuYmF0Y2hVcGRhdGVTcHJlYWRzaGVldChzdWJqZWN0LCBzcHJlYWRzaGVldElkLCBbXG4gICAgICAgIHsgZHVwbGljYXRlU2hlZXQ6IGR1cCB9LFxuICAgICAgXSk7XG4gICAgICBkZXBzLmNhY2hlLmNsZWFyKCk7XG4gICAgICBjb25zdCByZXBsaWVzID0gKHJlc3VsdC5yZXBsaWVzIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+W10pID8/IFtdO1xuICAgICAgY29uc3QgYWRkZWQgPSAocmVwbGllc1swXT8uZHVwbGljYXRlU2hlZXQgYXMgeyBwcm9wZXJ0aWVzPzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfSlcbiAgICAgICAgPy5wcm9wZXJ0aWVzO1xuICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KFxuICAgICAgICB7IGR1cGxpY2F0ZWQ6IHRydWUsIHNvdXJjZVNoZWV0SWQsIG5ld05hbWUsIG5ld1NoZWV0SWQ6IGFkZGVkPy5zaGVldElkIH0sXG4gICAgICAgIG51bGwsXG4gICAgICAgIDIsXG4gICAgICApO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgcmV0dXJuIGZvcm1hdFRvb2xFcnJvcihlcnIpO1xuICAgIH1cbiAgfTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBnd19zaGVldF9iYXRjaF91cGRhdGUgKHdyaXRlKSBcdTIwMTQgZnVsbCBmb3JtYXR0aW5nL2Zvcm11bGEvc3RydWN0dXJhbCBzdXJmYWNlXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbmV4cG9ydCBjb25zdCBzaGVldEJhdGNoVXBkYXRlU3BlYzogTmF0aXZlVG9vbFNwZWMgPSB7XG4gIG5hbWU6ICdnd19zaGVldF9iYXRjaF91cGRhdGUnLFxuICBkZXNjcmlwdGlvbjpcbiAgICAnQWR2YW5jZWQgcmF3IEdvb2dsZSBTaGVldHMgc3ByZWFkc2hlZXRzLmJhdGNoVXBkYXRlLiBXUklURSBcdTIwMTQgY29uZmlybSBmaXJzdC4gVGhpcyBpcyB0aGUgQ09NUExFVEUgU2hlZXRzIHdyaXRlIHN1cmZhY2UgZm9yIGZvcm1hdHRpbmcgYW5kIHN0cnVjdHVyZSB0aGF0IGd3X3NoZWV0X3dyaXRlICh2YWx1ZXMgb25seSkgY2Fubm90IGRvOiBudW1iZXIvY3VycmVuY3kvcGVyY2VudCBmb3JtYXRzLCBib2xkL2l0YWxpYy9jb2xvcnMvYm9yZGVycyAocmVwZWF0Q2VsbCwgdXBkYXRlQ2VsbHMpLCBjb25kaXRpb25hbCBmb3JtYXR0aW5nIChhZGRDb25kaXRpb25hbEZvcm1hdFJ1bGUpLCBjb2x1bW4gd2lkdGhzICh1cGRhdGVEaW1lbnNpb25Qcm9wZXJ0aWVzKSwgbWVyZ2VzIChtZXJnZUNlbGxzKSwgYW5kIGZvcm11bGFzICh1c2VyRW50ZXJlZFZhbHVlLmZvcm11bGFWYWx1ZSkuIFBhc3MgdGhlIHJhdyBcInJlcXVlc3RzXCIgYXJyYXkgZXhhY3RseSBhcyB0aGUgU2hlZXRzIEFQSSBleHBlY3RzLiBQb3dlcmZ1bDogaXQgY2FuIGFsc28gZGVsZXRlIG9yIHJlc3RydWN0dXJlLCBzbyB1c2UgZGVsaWJlcmF0ZWx5LiBHZXQgYSB0YWJcXCdzIHNoZWV0SWQgZnJvbSBnd19zaGVldF9saXN0X3RhYnMgZm9yIHRoZSBHcmlkUmFuZ2UuJyxcbiAgaW5wdXRfc2NoZW1hOiB7XG4gICAgdHlwZTogJ29iamVjdCcsXG4gICAgcHJvcGVydGllczoge1xuICAgICAgdXNlcjogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICdPd25lciB0byBpbXBlcnNvbmF0ZSAoZW1haWwpLiBPbWl0IGZvciBkZWZhdWx0LicgfSxcbiAgICAgIHNwcmVhZHNoZWV0SWQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAnR29vZ2xlIFNoZWV0cyBpZCAocmVxdWlyZWQpLicgfSxcbiAgICAgIHJlcXVlc3RzOiB7XG4gICAgICAgIHR5cGU6ICdhcnJheScsXG4gICAgICAgIGl0ZW1zOiB7IHR5cGU6ICdvYmplY3QnIH0sXG4gICAgICAgIGRlc2NyaXB0aW9uOlxuICAgICAgICAgICdSYXcgU2hlZXRzIEFQSSBiYXRjaFVwZGF0ZSByZXF1ZXN0IG9iamVjdHMuIEV4YW1wbGVzOiBib2xkK1x1MjBBQy1mb3JtYXQgYSByYW5nZSBcdTIxOTIgW3tcInJlcGVhdENlbGxcIjp7XCJyYW5nZVwiOntcInNoZWV0SWRcIjowLFwic3RhcnRSb3dJbmRleFwiOjAsXCJlbmRSb3dJbmRleFwiOjF9LFwiY2VsbFwiOntcInVzZXJFbnRlcmVkRm9ybWF0XCI6e1widGV4dEZvcm1hdFwiOntcImJvbGRcIjp0cnVlfSxcIm51bWJlckZvcm1hdFwiOntcInR5cGVcIjpcIkNVUlJFTkNZXCIsXCJwYXR0ZXJuXCI6XCIjLCMjMC4wMCBcdTIwQUNcIn19fSxcImZpZWxkc1wiOlwidXNlckVudGVyZWRGb3JtYXQodGV4dEZvcm1hdCxudW1iZXJGb3JtYXQpXCJ9fV07IHNldCBhIGNvbHVtbiB3aWR0aCBcdTIxOTIgW3tcInVwZGF0ZURpbWVuc2lvblByb3BlcnRpZXNcIjp7XCJyYW5nZVwiOntcInNoZWV0SWRcIjowLFwiZGltZW5zaW9uXCI6XCJDT0xVTU5TXCIsXCJzdGFydEluZGV4XCI6MCxcImVuZEluZGV4XCI6MX0sXCJwcm9wZXJ0aWVzXCI6e1wicGl4ZWxTaXplXCI6MTYwfSxcImZpZWxkc1wiOlwicGl4ZWxTaXplXCJ9fV0uIFJlcXVpcmVkLCBub24tZW1wdHkuJyxcbiAgICAgIH0sXG4gICAgfSxcbiAgICByZXF1aXJlZDogWydzcHJlYWRzaGVldElkJywgJ3JlcXVlc3RzJ10sXG4gIH0sXG59O1xuXG5leHBvcnQgY29uc3QgU0hFRVRfQkFUQ0hfVVBEQVRFX1BST01QVF9ET0MgPVxuICAnXFxuLSBgZ3dfc2hlZXRfYmF0Y2hfdXBkYXRlYDogV1JJVEUgXHUyMDE0IHJhdyBHb29nbGUgU2hlZXRzIGBiYXRjaFVwZGF0ZWAgZm9yIHRoZSBGVUxMIGZvcm1hdHRpbmcvc3RydWN0dXJlIHN1cmZhY2UgKG51bWJlciBmb3JtYXRzLCBib2xkL2NvbG9ycy9ib3JkZXJzIHZpYSBgcmVwZWF0Q2VsbGAsIGNvbmRpdGlvbmFsIGZvcm1hdHRpbmcsIGNvbHVtbiB3aWR0aHMsIG1lcmdlcywgZm9ybXVsYXMpLiBVc2UgZm9yIGFueXRoaW5nIGBnd19zaGVldF93cml0ZWAgKHZhbHVlcyBvbmx5KSBjYW5ub3QgZG8uIEdldCBgc2hlZXRJZGAgZnJvbSBgZ3dfc2hlZXRfbGlzdF90YWJzYC4gQ29uZmlybSB3aXRoIHRoZSB1c2VyOyBpdCBjYW4gYWxzbyBkZWxldGUvcmVzdHJ1Y3R1cmUuXFxuJztcblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVNoZWV0QmF0Y2hVcGRhdGVIYW5kbGVyKGRlcHM6IFRvb2xEZXBzKTogTmF0aXZlVG9vbEhhbmRsZXIge1xuICByZXR1cm4gYXN5bmMgKHJhdzogdW5rbm93bik6IFByb21pc2U8c3RyaW5nPiA9PiB7XG4gICAgY29uc3QgaW5wdXQgPSAocmF3ID8/IHt9KSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICB0cnkge1xuICAgICAgY29uc3Qgc3ViamVjdCA9IHJlc29sdmVTdWJqZWN0KGRlcHMsIGlucHV0LnVzZXIpO1xuICAgICAgY29uc3Qgc3ByZWFkc2hlZXRJZCA9IHN0cihpbnB1dC5zcHJlYWRzaGVldElkKTtcbiAgICAgIGlmICghc3ByZWFkc2hlZXRJZCkgdGhyb3cgbmV3IEdvb2dsZUlucHV0RXJyb3IoJ1wic3ByZWFkc2hlZXRJZFwiIGlzIHJlcXVpcmVkLicpO1xuICAgICAgaWYgKCFBcnJheS5pc0FycmF5KGlucHV0LnJlcXVlc3RzKSB8fCBpbnB1dC5yZXF1ZXN0cy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgdGhyb3cgbmV3IEdvb2dsZUlucHV0RXJyb3IoJ1wicmVxdWVzdHNcIiBtdXN0IGJlIGEgbm9uLWVtcHR5IGFycmF5IG9mIFNoZWV0cyBBUEkgcmVxdWVzdHMuJyk7XG4gICAgICB9XG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBkZXBzLmNsaWVudC5iYXRjaFVwZGF0ZVNwcmVhZHNoZWV0KFxuICAgICAgICBzdWJqZWN0LFxuICAgICAgICBzcHJlYWRzaGVldElkLFxuICAgICAgICBpbnB1dC5yZXF1ZXN0cyBhcyB1bmtub3duW10sXG4gICAgICApO1xuICAgICAgZGVwcy5jYWNoZS5jbGVhcigpO1xuICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KFxuICAgICAgICB7XG4gICAgICAgICAgYXBwbGllZDogdHJ1ZSxcbiAgICAgICAgICBzcHJlYWRzaGVldElkLFxuICAgICAgICAgIHJlcXVlc3RDb3VudDogKGlucHV0LnJlcXVlc3RzIGFzIHVua25vd25bXSkubGVuZ3RoLFxuICAgICAgICAgIHJlcGxpZXM6IHJlc3VsdC5yZXBsaWVzID8/IFtdLFxuICAgICAgICB9LFxuICAgICAgICBudWxsLFxuICAgICAgICAyLFxuICAgICAgKTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIHJldHVybiBmb3JtYXRUb29sRXJyb3IoZXJyKTtcbiAgICB9XG4gIH07XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gSGVscGVycyBcdTIwMTQgZmxhdHRlbiBhIERvY3MgZG9jdW1lbnQgaW50byBwbGFpbiB0ZXh0LlxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5pbnRlcmZhY2UgRG9jc1RleHRSdW4ge1xuICBjb250ZW50Pzogc3RyaW5nO1xufVxuaW50ZXJmYWNlIERvY3NQYXJhZ3JhcGhFbGVtZW50IHtcbiAgdGV4dFJ1bj86IERvY3NUZXh0UnVuO1xufVxuaW50ZXJmYWNlIERvY3NQYXJhZ3JhcGgge1xuICBlbGVtZW50cz86IERvY3NQYXJhZ3JhcGhFbGVtZW50W107XG59XG5pbnRlcmZhY2UgRG9jc1N0cnVjdHVyYWxFbGVtZW50IHtcbiAgcGFyYWdyYXBoPzogRG9jc1BhcmFncmFwaDtcbiAgdGFibGU/OiB7IHRhYmxlUm93cz86IHsgdGFibGVDZWxscz86IHsgY29udGVudD86IERvY3NTdHJ1Y3R1cmFsRWxlbWVudFtdIH1bXSB9W10gfTtcbn1cblxuZnVuY3Rpb24gZmxhdHRlbkRvY1RleHQoZG9jOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IHN0cmluZyB7XG4gIGNvbnN0IGJvZHkgPSBkb2MuYm9keSBhcyB7IGNvbnRlbnQ/OiBEb2NzU3RydWN0dXJhbEVsZW1lbnRbXSB9IHwgdW5kZWZpbmVkO1xuICBpZiAoIWJvZHk/LmNvbnRlbnQpIHJldHVybiAnJztcbiAgY29uc3Qgb3V0OiBzdHJpbmdbXSA9IFtdO1xuICBjb2xsZWN0RG9jVGV4dChib2R5LmNvbnRlbnQsIG91dCk7XG4gIHJldHVybiBvdXQuam9pbignJykucmVwbGFjZSgvXFxuezMsfS9nLCAnXFxuXFxuJykudHJpbSgpO1xufVxuXG5mdW5jdGlvbiBjb2xsZWN0RG9jVGV4dChjb250ZW50OiBEb2NzU3RydWN0dXJhbEVsZW1lbnRbXSwgb3V0OiBzdHJpbmdbXSk6IHZvaWQge1xuICBmb3IgKGNvbnN0IGVsIG9mIGNvbnRlbnQpIHtcbiAgICBpZiAoZWwucGFyYWdyYXBoPy5lbGVtZW50cykge1xuICAgICAgZm9yIChjb25zdCBwZSBvZiBlbC5wYXJhZ3JhcGguZWxlbWVudHMpIHtcbiAgICAgICAgaWYgKHBlLnRleHRSdW4/LmNvbnRlbnQpIG91dC5wdXNoKHBlLnRleHRSdW4uY29udGVudCk7XG4gICAgICB9XG4gICAgfVxuICAgIGlmIChlbC50YWJsZT8udGFibGVSb3dzKSB7XG4gICAgICBmb3IgKGNvbnN0IHJvdyBvZiBlbC50YWJsZS50YWJsZVJvd3MpIHtcbiAgICAgICAgZm9yIChjb25zdCBjZWxsIG9mIHJvdy50YWJsZUNlbGxzID8/IFtdKSB7XG4gICAgICAgICAgaWYgKGNlbGwuY29udGVudCkgY29sbGVjdERvY1RleHQoY2VsbC5jb250ZW50LCBvdXQpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG59XG4iLCAiLyoqXG4gKiBUZXN0IGhlbHBlcnMgXHUyMDE0IGZha2UgYXV0aCwgYSBzY3JpcHRlZCBmZXRjaCwgYW5kIGEgSlNPTiBSZXNwb25zZSBidWlsZGVyLlxuICogTm8gbmV0d29yaywgbm8gcmVhbCBjcmVkZW50aWFscy5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IEdvb2dsZVNlcnZpY2VBY2NvdW50QXV0aCB9IGZyb20gJy4uL3NyYy9nb29nbGVBdXRoLmpzJztcblxuZXhwb3J0IGZ1bmN0aW9uIGZha2VBdXRoKCk6IHtcbiAgYXV0aDogR29vZ2xlU2VydmljZUFjY291bnRBdXRoO1xuICBzdGF0czogKCkgPT4geyB0b2tlbkNhbGxzOiBudW1iZXI7IGludmFsaWRhdGlvbnM6IG51bWJlciB9O1xufSB7XG4gIGxldCB0b2tlbkNhbGxzID0gMDtcbiAgbGV0IGludmFsaWRhdGlvbnMgPSAwO1xuICBjb25zdCBhdXRoID0ge1xuICAgIGdldFRva2VuOiBhc3luYyAoKSA9PiB7XG4gICAgICB0b2tlbkNhbGxzICs9IDE7XG4gICAgICByZXR1cm4gYHRvay0ke3Rva2VuQ2FsbHN9YDtcbiAgICB9LFxuICAgIGludmFsaWRhdGU6ICgpID0+IHtcbiAgICAgIGludmFsaWRhdGlvbnMgKz0gMTtcbiAgICB9LFxuICB9O1xuICByZXR1cm4ge1xuICAgIGF1dGg6IGF1dGggYXMgdW5rbm93biBhcyBHb29nbGVTZXJ2aWNlQWNjb3VudEF1dGgsXG4gICAgc3RhdHM6ICgpID0+ICh7IHRva2VuQ2FsbHMsIGludmFsaWRhdGlvbnMgfSksXG4gIH07XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQ2FwdHVyZWQge1xuICB1cmw6IHN0cmluZztcbiAgaW5pdDogeyBtZXRob2Q/OiBzdHJpbmc7IGhlYWRlcnM/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+OyBib2R5Pzogc3RyaW5nIH07XG59XG5cbi8qKlxuICogQSBmZXRjaCBzdHViIGRyaXZlbiBieSBhbiBhcnJheSBvZiBzdGVwIGZ1bmN0aW9ucy4gQ2FsbCBOIHVzZXMgc3RlcCBOICh0aGVcbiAqIGxhc3Qgc3RlcCByZXBlYXRzIGZvciBhbnkgZnVydGhlciBjYWxscykuIFJlY29yZHMgZXZlcnkgY2FsbC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNjcmlwdGVkRmV0Y2goc3RlcHM6IEFycmF5PChjOiBDYXB0dXJlZCkgPT4gUmVzcG9uc2U+KToge1xuICBmZXRjaEltcGw6IHR5cGVvZiBmZXRjaDtcbiAgY2FsbHM6IENhcHR1cmVkW107XG59IHtcbiAgY29uc3QgY2FsbHM6IENhcHR1cmVkW10gPSBbXTtcbiAgbGV0IGkgPSAwO1xuICBjb25zdCBmZXRjaEltcGwgPSAoYXN5bmMgKHVybDogc3RyaW5nLCBpbml0OiBDYXB0dXJlZFsnaW5pdCddKSA9PiB7XG4gICAgY29uc3QgYzogQ2FwdHVyZWQgPSB7IHVybCwgaW5pdDogaW5pdCA/PyB7fSB9O1xuICAgIGNhbGxzLnB1c2goYyk7XG4gICAgY29uc3Qgc3RlcCA9IHN0ZXBzW01hdGgubWluKGksIHN0ZXBzLmxlbmd0aCAtIDEpXTtcbiAgICBpICs9IDE7XG4gICAgcmV0dXJuIHN0ZXAoYyk7XG4gIH0pIGFzIHVua25vd24gYXMgdHlwZW9mIGZldGNoO1xuICByZXR1cm4geyBmZXRjaEltcGwsIGNhbGxzIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBqc29uKG9iajogdW5rbm93biwgc3RhdHVzID0gMjAwKTogUmVzcG9uc2Uge1xuICByZXR1cm4gbmV3IFJlc3BvbnNlKEpTT04uc3RyaW5naWZ5KG9iaiksIHtcbiAgICBzdGF0dXMsXG4gICAgaGVhZGVyczogeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nIH0sXG4gIH0pO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIjtB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SCxRQUFNLFNBQVM7QUFBQSxJQUNiLGtCQUFrQixPQUFPLElBQVksS0FBYSxJQUFZLElBQWlCLE1BQXlCO0FBQ3RHLFlBQU07QUFDTixhQUFPLEVBQUUsY0FBYyxXQUFXLGFBQWEsR0FBRyxjQUFjLEVBQUU7QUFBQSxJQUNwRTtBQUFBLEVBQ0Y7QUFDQSxRQUFNLElBQUksRUFBRSxRQUFRLE9BQU8sWUFBWSxnQkFBZ0IsWUFBWSxjQUFjLFVBQVU7QUFDM0YsUUFBTSxNQUFNLEtBQUs7QUFBQSxJQUNmLE1BQU0sd0JBQXdCLENBQUMsRUFBRSxFQUFFLGVBQWUsS0FBSyxPQUFPLFdBQVcsUUFBUSxDQUFDLENBQUMsS0FBSyxHQUFHLEdBQUcsQ0FBQyxHQUFHLENBQUMsQ0FBQyxHQUFHLE1BQU0sU0FBUyxDQUFDO0FBQUEsRUFDekg7QUFDQSxTQUFPLE1BQU0sSUFBSSxTQUFTLElBQUk7QUFDOUIsU0FBTyxNQUFNLElBQUksTUFBTSxRQUFRO0FBQy9CLFNBQU8sTUFBTSxJQUFLLE1BQU0sUUFBUTtBQUNoQyxTQUFPLE1BQU0sSUFBSSxjQUFjLENBQUM7QUFDaEMsU0FBTyxNQUFNLFNBQVMsSUFBSTtBQUM1QixDQUFDO0FBRUQsS0FBSyxpRUFBaUUsWUFBWTtBQUNoRixRQUFNLElBQUkseUJBQXlCLEtBQUssQ0FBQyxDQUFDLENBQUM7QUFDM0MsU0FBTyxNQUFNLE1BQU0sRUFBRSxDQUFDLENBQUMsR0FBRyxnQkFBZ0I7QUFDMUMsU0FBTyxNQUFNLE1BQU0sRUFBRSxFQUFFLE1BQU0sS0FBSyxNQUFNLFVBQVUsU0FBUyxLQUFLLENBQUMsR0FBRyw0QkFBNEI7QUFDbEcsQ0FBQztBQUVELEtBQUssa0VBQTZELFlBQVk7QUFDNUUsTUFBSTtBQUNKLFFBQU0sU0FBUztBQUFBLElBQ2IsaUJBQWlCLE9BQU8sSUFBWSxNQUFpRDtBQUNuRixZQUFNO0FBQ04sYUFBTyxFQUFFLElBQUksTUFBTSxNQUFNLE1BQU0sVUFBVSxFQUFFLFVBQVUsYUFBYSxXQUFXO0FBQUEsSUFDL0U7QUFBQSxFQUNGO0FBQ0EsUUFBTSxNQUFNLEtBQUs7QUFBQSxJQUNmLE1BQU0seUJBQXlCLEtBQUssTUFBTSxDQUFDLEVBQUUsRUFBRSxNQUFNLE1BQU0sTUFBTSxlQUFlLFVBQVUsS0FBSyxDQUFDO0FBQUEsRUFDbEc7QUFDQSxTQUFPLE1BQU0sSUFBSyxVQUFVLHlDQUF5QztBQUNyRSxTQUFPLFVBQVUsSUFBSyxTQUFTLENBQUMsSUFBSSxDQUFDO0FBQ3JDLFNBQU8sTUFBTSxJQUFJLFNBQVMsSUFBSTtBQUM5QixTQUFPLE1BQU0sSUFBSSxJQUFJLElBQUk7QUFDM0IsQ0FBQzsiLAogICJuYW1lcyI6IFsiZGVwcyIsICJkZXBzIiwgImRlcHMiXQp9Cg==
