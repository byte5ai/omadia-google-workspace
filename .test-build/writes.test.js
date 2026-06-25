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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vdGVzdHMvd3JpdGVzLnRlc3QudHMiLCAiLi4vc3JjL2Vycm9ycy50cyIsICIuLi9zcmMvZ29vZ2xlQ2xpZW50LnRzIiwgIi4uL3NyYy90b29sRGVwcy50cyIsICIuLi9zcmMvZHJpdmVUb29scy50cyIsICIuLi90ZXN0cy9faGVscGVycy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHRlc3QgZnJvbSAnbm9kZTp0ZXN0JztcbmltcG9ydCBhc3NlcnQgZnJvbSAnbm9kZTphc3NlcnQvc3RyaWN0JztcblxuaW1wb3J0IHsgR29vZ2xlV29ya3NwYWNlQ2xpZW50IH0gZnJvbSAnLi4vc3JjL2dvb2dsZUNsaWVudC5qcyc7XG5pbXBvcnQge1xuICBjcmVhdGVTaGVldFdyaXRlSGFuZGxlcixcbiAgY3JlYXRlRHJpdmVDcmVhdGVIYW5kbGVyLFxufSBmcm9tICcuLi9zcmMvZHJpdmVUb29scy5qcyc7XG5pbXBvcnQgdHlwZSB7IFRvb2xEZXBzIH0gZnJvbSAnLi4vc3JjL3Rvb2xEZXBzLmpzJztcbmltcG9ydCB7IGZha2VBdXRoLCBzY3JpcHRlZEZldGNoLCBqc29uIH0gZnJvbSAnLi9faGVscGVycy5qcyc7XG5cbmNvbnN0IGNhY2hlID0ge1xuICBnZXRPclNldDogYXN5bmMgKF9rOiBzdHJpbmcsIGZuOiAoKSA9PiBQcm9taXNlPHVua25vd24+KSA9PiBmbigpLFxuICBjbGVhcigpIHt9LFxufSBhcyB1bmtub3duIGFzIFRvb2xEZXBzWydjYWNoZSddO1xuXG5mdW5jdGlvbiBkZXBzKGNsaWVudDogdW5rbm93bik6IFRvb2xEZXBzIHtcbiAgcmV0dXJuIHtcbiAgICBjbGllbnQ6IGNsaWVudCBhcyBUb29sRGVwc1snY2xpZW50J10sXG4gICAgY2FjaGUsXG4gICAgZGVmYXVsdFN1YmplY3Q6ICdtZUB4LmNvbScsXG4gICAgYWRtaW5TdWJqZWN0OiAnYWRtaW5AeC5jb20nLFxuICB9O1xufVxuXG4vLyAtLS0gY2xpZW50OiB3cml0ZVNoZWV0VmFsdWVzIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxudGVzdCgnd3JpdGVTaGVldFZhbHVlcyBvdmVyd3JpdGUgXHUyMTkyIFBVVCB2YWx1ZXMudXBkYXRlIHdpdGggYm9keSArIHZhbHVlSW5wdXRPcHRpb24nLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHsgYXV0aCB9ID0gZmFrZUF1dGgoKTtcbiAgY29uc3QgeyBmZXRjaEltcGwsIGNhbGxzIH0gPSBzY3JpcHRlZEZldGNoKFsoKSA9PiBqc29uKHsgdXBkYXRlZENlbGxzOiA0LCB1cGRhdGVkUmFuZ2U6ICdTIUExOkIyJyB9KV0pO1xuICBjb25zdCBjbGllbnQgPSBuZXcgR29vZ2xlV29ya3NwYWNlQ2xpZW50KHsgYXV0aCwgc2NvcGVzOiBbJ3MnXSwgZmV0Y2g6IGZldGNoSW1wbCB9KTtcbiAgY29uc3QgciA9IGF3YWl0IGNsaWVudC53cml0ZVNoZWV0VmFsdWVzKCd1QHguY29tJywgJ3NoZWV0MScsICdTIUExOkIyJywgW1snYScsICdiJ10sIFsxLCAyXV0pO1xuICBhc3NlcnQuZXF1YWwoY2FsbHNbMF0uaW5pdC5tZXRob2QsICdQVVQnKTtcbiAgYXNzZXJ0Lm1hdGNoKGNhbGxzWzBdLnVybCwgL1xcL3NwcmVhZHNoZWV0c1xcL3NoZWV0MVxcL3ZhbHVlc1xcL1MhQTElM0FCMlxcPy8pO1xuICBhc3NlcnQubWF0Y2goY2FsbHNbMF0udXJsLCAvdmFsdWVJbnB1dE9wdGlvbj1VU0VSX0VOVEVSRUQvKTtcbiAgY29uc3QgYm9keSA9IEpTT04ucGFyc2UoY2FsbHNbMF0uaW5pdC5ib2R5IGFzIHN0cmluZyk7XG4gIGFzc2VydC5kZWVwRXF1YWwoYm9keS52YWx1ZXMsIFtbJ2EnLCAnYiddLCBbMSwgMl1dKTtcbiAgYXNzZXJ0LmVxdWFsKGJvZHkubWFqb3JEaW1lbnNpb24sICdST1dTJyk7XG4gIGFzc2VydC5lcXVhbChyLnVwZGF0ZWRDZWxscywgNCk7XG59KTtcblxudGVzdCgnd3JpdGVTaGVldFZhbHVlcyBhcHBlbmQgXHUyMTkyIFBPU1QgOmFwcGVuZCB3aXRoIElOU0VSVF9ST1dTJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB7IGF1dGggfSA9IGZha2VBdXRoKCk7XG4gIGNvbnN0IHsgZmV0Y2hJbXBsLCBjYWxscyB9ID0gc2NyaXB0ZWRGZXRjaChbKCkgPT4ganNvbih7IHVwZGF0ZXM6IHsgdXBkYXRlZENlbGxzOiAyIH0gfSldKTtcbiAgY29uc3QgY2xpZW50ID0gbmV3IEdvb2dsZVdvcmtzcGFjZUNsaWVudCh7IGF1dGgsIHNjb3BlczogWydzJ10sIGZldGNoOiBmZXRjaEltcGwgfSk7XG4gIGF3YWl0IGNsaWVudC53cml0ZVNoZWV0VmFsdWVzKCd1QHguY29tJywgJ3NoZWV0MScsICdTIUExJywgW1sneCcsICd5J11dLCB7IG1vZGU6ICdhcHBlbmQnIH0pO1xuICBhc3NlcnQuZXF1YWwoY2FsbHNbMF0uaW5pdC5tZXRob2QsICdQT1NUJyk7XG4gIGFzc2VydC5tYXRjaChjYWxsc1swXS51cmwsIC9cXC92YWx1ZXNcXC9TIUExOmFwcGVuZFxcPy8pO1xuICBhc3NlcnQubWF0Y2goY2FsbHNbMF0udXJsLCAvaW5zZXJ0RGF0YU9wdGlvbj1JTlNFUlRfUk9XUy8pO1xufSk7XG5cbi8vIC0tLSBjbGllbnQ6IGNyZWF0ZURyaXZlRmlsZSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG50ZXN0KCdjcmVhdGVEcml2ZUZpbGUgbWV0YWRhdGEtb25seSBcdTIxOTIgUE9TVCAvZmlsZXMgd2l0aCBtZXRhZGF0YSBib2R5JywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB7IGF1dGggfSA9IGZha2VBdXRoKCk7XG4gIGNvbnN0IHsgZmV0Y2hJbXBsLCBjYWxscyB9ID0gc2NyaXB0ZWRGZXRjaChbKCkgPT4ganNvbih7IGlkOiAnZjEnLCBuYW1lOiAnUmVwb3J0cycsIG1pbWVUeXBlOiAnYXBwbGljYXRpb24vdm5kLmdvb2dsZS1hcHBzLmZvbGRlcicgfSldKTtcbiAgY29uc3QgY2xpZW50ID0gbmV3IEdvb2dsZVdvcmtzcGFjZUNsaWVudCh7IGF1dGgsIHNjb3BlczogWydzJ10sIGZldGNoOiBmZXRjaEltcGwgfSk7XG4gIGNvbnN0IHIgPSBhd2FpdCBjbGllbnQuY3JlYXRlRHJpdmVGaWxlKCd1QHguY29tJywge1xuICAgIG5hbWU6ICdSZXBvcnRzJyxcbiAgICBtaW1lVHlwZTogJ2FwcGxpY2F0aW9uL3ZuZC5nb29nbGUtYXBwcy5mb2xkZXInLFxuICAgIHBhcmVudHM6IFsncGFyZW50MSddLFxuICB9KTtcbiAgYXNzZXJ0LmVxdWFsKGNhbGxzWzBdLmluaXQubWV0aG9kLCAnUE9TVCcpO1xuICBhc3NlcnQubWF0Y2goY2FsbHNbMF0udXJsLCAvXFwvZHJpdmVcXC92M1xcL2ZpbGVzXFw/Lyk7XG4gIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKGNhbGxzWzBdLmluaXQuYm9keSBhcyBzdHJpbmcpO1xuICBhc3NlcnQuZXF1YWwoYm9keS5uYW1lLCAnUmVwb3J0cycpO1xuICBhc3NlcnQuZGVlcEVxdWFsKGJvZHkucGFyZW50cywgWydwYXJlbnQxJ10pO1xuICBhc3NlcnQuZXF1YWwoci5pZCwgJ2YxJyk7XG59KTtcblxudGVzdCgnY3JlYXRlRHJpdmVGaWxlIHdpdGggY29udGVudCBcdTIxOTIgbXVsdGlwYXJ0IHVwbG9hZCB0byB0aGUgdXBsb2FkIGhvc3QnLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHsgYXV0aCB9ID0gZmFrZUF1dGgoKTtcbiAgY29uc3QgeyBmZXRjaEltcGwsIGNhbGxzIH0gPSBzY3JpcHRlZEZldGNoKFsoKSA9PiBqc29uKHsgaWQ6ICdmMicsIG5hbWU6ICdub3Rlcy50eHQnIH0pXSk7XG4gIGNvbnN0IGNsaWVudCA9IG5ldyBHb29nbGVXb3Jrc3BhY2VDbGllbnQoeyBhdXRoLCBzY29wZXM6IFsncyddLCBmZXRjaDogZmV0Y2hJbXBsIH0pO1xuICBhd2FpdCBjbGllbnQuY3JlYXRlRHJpdmVGaWxlKCd1QHguY29tJywge1xuICAgIG5hbWU6ICdub3Rlcy50eHQnLFxuICAgIG1pbWVUeXBlOiAndGV4dC9wbGFpbicsXG4gICAgY29udGVudDogJ2hlbGxvIGJvZHknLFxuICB9KTtcbiAgYXNzZXJ0Lm1hdGNoKGNhbGxzWzBdLnVybCwgL15odHRwczpcXC9cXC93d3dcXC5nb29nbGVhcGlzXFwuY29tXFwvdXBsb2FkXFwvZHJpdmVcXC92M1xcL2ZpbGVzXFw/Lyk7XG4gIGFzc2VydC5tYXRjaChjYWxsc1swXS51cmwsIC91cGxvYWRUeXBlPW11bHRpcGFydC8pO1xuICBhc3NlcnQubWF0Y2goY2FsbHNbMF0uaW5pdC5oZWFkZXJzIVsnQ29udGVudC1UeXBlJ10sIC9ebXVsdGlwYXJ0XFwvcmVsYXRlZDsgYm91bmRhcnk9Lyk7XG4gIGNvbnN0IHJhdyA9IGNhbGxzWzBdLmluaXQuYm9keSBhcyBzdHJpbmc7XG4gIGFzc2VydC5tYXRjaChyYXcsIC9cIm5hbWVcIjpcIm5vdGVzLnR4dFwiLyk7XG4gIGFzc2VydC5tYXRjaChyYXcsIC9oZWxsbyBib2R5Lyk7XG59KTtcblxuLy8gLS0tIGhhbmRsZXJzIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbnRlc3QoJ2d3X3NoZWV0X3dyaXRlIHJlcXVpcmVzIGEgMkQgdmFsdWVzIGFycmF5JywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBoID0gY3JlYXRlU2hlZXRXcml0ZUhhbmRsZXIoZGVwcyh7fSkpO1xuICBhc3NlcnQubWF0Y2goYXdhaXQgaCh7IHNwcmVhZHNoZWV0SWQ6ICdzJywgcmFuZ2U6ICdBMScsIHZhbHVlczogJ25vcGUnIH0pLCAvRXJyb3I6LioyRCBhcnJheS8pO1xuICBhc3NlcnQubWF0Y2goYXdhaXQgaCh7IHNwcmVhZHNoZWV0SWQ6ICdzJywgcmFuZ2U6ICdBMScsIHZhbHVlczogWzEsIDJdIH0pLCAvRXJyb3I6LioyRCBhcnJheS8pO1xufSk7XG5cbnRlc3QoJ2d3X3NoZWV0X3dyaXRlIGhhcHB5IHBhdGggcmV0dXJucyB3cml0dGVuICsgbW9kZSArIGNsZWFycyBjYWNoZScsIGFzeW5jICgpID0+IHtcbiAgbGV0IGNsZWFyZWQgPSBmYWxzZTtcbiAgbGV0IGdvdDogeyBtb2RlPzogc3RyaW5nIH0gfCB1bmRlZmluZWQ7XG4gIGNvbnN0IGxvY2FsQ2FjaGUgPSB7IGdldE9yU2V0OiBhc3luYyAoX2s6IHN0cmluZywgZm46ICgpID0+IFByb21pc2U8dW5rbm93bj4pID0+IGZuKCksIGNsZWFyKCkgeyBjbGVhcmVkID0gdHJ1ZTsgfSB9O1xuICBjb25zdCBjbGllbnQgPSB7XG4gICAgd3JpdGVTaGVldFZhbHVlczogYXN5bmMgKF9zOiBzdHJpbmcsIF9pZDogc3RyaW5nLCBfcjogc3RyaW5nLCBfdjogdW5rbm93bltdW10sIHA6IHsgbW9kZT86IHN0cmluZyB9KSA9PiB7XG4gICAgICBnb3QgPSBwO1xuICAgICAgcmV0dXJuIHsgdXBkYXRlZFJhbmdlOiAnUyFBMTpCMicsIHVwZGF0ZWRSb3dzOiAyLCB1cGRhdGVkQ2VsbHM6IDQgfTtcbiAgICB9LFxuICB9O1xuICBjb25zdCBkID0geyBjbGllbnQsIGNhY2hlOiBsb2NhbENhY2hlLCBkZWZhdWx0U3ViamVjdDogJ21lQHguY29tJywgYWRtaW5TdWJqZWN0OiAnYUB4LmNvbScgfSBhcyB1bmtub3duIGFzIFRvb2xEZXBzO1xuICBjb25zdCBvdXQgPSBKU09OLnBhcnNlKFxuICAgIGF3YWl0IGNyZWF0ZVNoZWV0V3JpdGVIYW5kbGVyKGQpKHsgc3ByZWFkc2hlZXRJZDogJ3MnLCByYW5nZTogJ1MhQTE6QjInLCB2YWx1ZXM6IFtbJ2EnLCAnYiddLCBbMSwgMl1dLCBtb2RlOiAnYXBwZW5kJyB9KSxcbiAgKTtcbiAgYXNzZXJ0LmVxdWFsKG91dC53cml0dGVuLCB0cnVlKTtcbiAgYXNzZXJ0LmVxdWFsKG91dC5tb2RlLCAnYXBwZW5kJyk7XG4gIGFzc2VydC5lcXVhbChnb3QhLm1vZGUsICdhcHBlbmQnKTtcbiAgYXNzZXJ0LmVxdWFsKG91dC51cGRhdGVkQ2VsbHMsIDQpO1xuICBhc3NlcnQuZXF1YWwoY2xlYXJlZCwgdHJ1ZSk7XG59KTtcblxudGVzdCgnZ3dfZHJpdmVfY3JlYXRlIHJlcXVpcmVzIGEgbmFtZTsgZm9sZGVyICsgY29udGVudCBpcyByZWplY3RlZCcsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgaCA9IGNyZWF0ZURyaXZlQ3JlYXRlSGFuZGxlcihkZXBzKHt9KSk7XG4gIGFzc2VydC5tYXRjaChhd2FpdCBoKHt9KSwgL0Vycm9yOi4qXCJuYW1lXCIvKTtcbiAgYXNzZXJ0Lm1hdGNoKGF3YWl0IGgoeyBuYW1lOiAnWCcsIHR5cGU6ICdmb2xkZXInLCBjb250ZW50OiAnbm8nIH0pLCAvRXJyb3I6Lipmb2xkZXIgY2Fubm90IGhhdmUvKTtcbn0pO1xuXG50ZXN0KCdnd19kcml2ZV9jcmVhdGUgbWFwcyB0eXBlXHUyMTkybWltZVR5cGUgYW5kIHJldHVybnMgdGhlIG5ldyBpZCcsIGFzeW5jICgpID0+IHtcbiAgbGV0IGdvdDogeyBtaW1lVHlwZT86IHN0cmluZzsgcGFyZW50cz86IHN0cmluZ1tdIH0gfCB1bmRlZmluZWQ7XG4gIGNvbnN0IGNsaWVudCA9IHtcbiAgICBjcmVhdGVEcml2ZUZpbGU6IGFzeW5jIChfczogc3RyaW5nLCBwOiB7IG1pbWVUeXBlPzogc3RyaW5nOyBwYXJlbnRzPzogc3RyaW5nW10gfSkgPT4ge1xuICAgICAgZ290ID0gcDtcbiAgICAgIHJldHVybiB7IGlkOiAnZDEnLCBuYW1lOiAnUTMnLCBtaW1lVHlwZTogcC5taW1lVHlwZSwgd2ViVmlld0xpbms6ICdodHRwOi8veCcgfTtcbiAgICB9LFxuICB9O1xuICBjb25zdCBvdXQgPSBKU09OLnBhcnNlKFxuICAgIGF3YWl0IGNyZWF0ZURyaXZlQ3JlYXRlSGFuZGxlcihkZXBzKGNsaWVudCkpKHsgbmFtZTogJ1EzJywgdHlwZTogJ3NwcmVhZHNoZWV0JywgcGFyZW50SWQ6ICdwMScgfSksXG4gICk7XG4gIGFzc2VydC5lcXVhbChnb3QhLm1pbWVUeXBlLCAnYXBwbGljYXRpb24vdm5kLmdvb2dsZS1hcHBzLnNwcmVhZHNoZWV0Jyk7XG4gIGFzc2VydC5kZWVwRXF1YWwoZ290IS5wYXJlbnRzLCBbJ3AxJ10pO1xuICBhc3NlcnQuZXF1YWwob3V0LmNyZWF0ZWQsIHRydWUpO1xuICBhc3NlcnQuZXF1YWwob3V0LmlkLCAnZDEnKTtcbn0pO1xuIiwgIi8qKlxuICogRXJyb3IgdHlwZXMgc2hhcmVkIGFjcm9zcyB0aGUgR29vZ2xlIFdvcmtzcGFjZSBpbnRlZ3JhdGlvbiwgcGx1cyBhIHNpbmdsZVxuICogYGZvcm1hdFRvb2xFcnJvcmAgdGhhdCB0dXJucyBhbnkgdGhyb3duIGVycm9yIGludG8gYSBzaG9ydCwgbW9kZWwtcmVhZGFibGVcbiAqIHN0cmluZyB3aXRoIG5vIHN0YWNrIHRyYWNlcyBvciBzZWNyZXRzLlxuICovXG5cbi8qKiBSYWlzZWQgd2hlbiB0aGUgc2VydmljZS1hY2NvdW50IEpXVC1iZWFyZXIgdG9rZW4gZXhjaGFuZ2UgZmFpbHMuICovXG5leHBvcnQgY2xhc3MgR29vZ2xlQXV0aEVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICBjb25zdHJ1Y3RvcihtZXNzYWdlOiBzdHJpbmcpIHtcbiAgICBzdXBlcihtZXNzYWdlKTtcbiAgICB0aGlzLm5hbWUgPSAnR29vZ2xlQXV0aEVycm9yJztcbiAgfVxufVxuXG4vKiogUmFpc2VkIHdoZW4gYSBHb29nbGUgQVBJIHJlc3BvbmRzIHdpdGggYSBub24tMnh4IHN0YXR1cy4gKi9cbmV4cG9ydCBjbGFzcyBHb29nbGVBcGlFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgY29uc3RydWN0b3IoXG4gICAgcHVibGljIHJlYWRvbmx5IHN0YXR1czogbnVtYmVyLFxuICAgIHB1YmxpYyByZWFkb25seSByZWFzb246IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgICBtZXNzYWdlOiBzdHJpbmcsXG4gICkge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICAgIHRoaXMubmFtZSA9ICdHb29nbGVBcGlFcnJvcic7XG4gIH1cbn1cblxuLyoqIFJhaXNlZCBieSBjbGllbnQtc2lkZSBhcmd1bWVudCB2YWxpZGF0aW9uIGJlZm9yZSBhbnkgbmV0d29yayBjYWxsLiAqL1xuZXhwb3J0IGNsYXNzIEdvb2dsZUlucHV0RXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIGNvbnN0cnVjdG9yKG1lc3NhZ2U6IHN0cmluZykge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICAgIHRoaXMubmFtZSA9ICdHb29nbGVJbnB1dEVycm9yJztcbiAgfVxufVxuXG4vKipcbiAqIFR1cm4gY2xpZW50IGVycm9ycyBpbnRvIGEgc2hvcnQsIG1vZGVsLXJlYWRhYmxlIG1lc3NhZ2UuIE5ldmVyIGxlYWtzIHRoZVxuICogcHJpdmF0ZSBrZXksIGFjY2VzcyB0b2tlbiwgb3IgYSBzdGFjayB0cmFjZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdFRvb2xFcnJvcihlcnI6IHVua25vd24pOiBzdHJpbmcge1xuICBpZiAoZXJyIGluc3RhbmNlb2YgR29vZ2xlQXV0aEVycm9yKSB7XG4gICAgcmV0dXJuIGBFcnJvcjogR29vZ2xlIFdvcmtzcGFjZSBhdXRoZW50aWNhdGlvbiBmYWlsZWQgXHUyMDE0ICR7ZXJyLm1lc3NhZ2V9LiBDaGVjayB0aGUgc2VydmljZS1hY2NvdW50IGNsaWVudCBlbWFpbCArIHByaXZhdGUga2V5LCB0aGF0IGRvbWFpbi13aWRlIGRlbGVnYXRpb24gaXMgY29uZmlndXJlZCBpbiB0aGUgQWRtaW4gY29uc29sZSBmb3IgdGhlIHJlcXVpcmVkIHNjb3BlcywgYW5kIHRoYXQgdGhlIGltcGVyc29uYXRlZCB1c2VyIGV4aXN0cy5gO1xuICB9XG4gIGlmIChlcnIgaW5zdGFuY2VvZiBHb29nbGVBcGlFcnJvcikge1xuICAgIGNvbnN0IHJlYXNvbiA9IGVyci5yZWFzb24gPyBgIFske2Vyci5yZWFzb259XWAgOiAnJztcbiAgICByZXR1cm4gYEVycm9yOiBHb29nbGUgQVBJIHJldHVybmVkIEhUVFAgJHtlcnIuc3RhdHVzfSR7cmVhc29ufTogJHtlcnIubWVzc2FnZX1gO1xuICB9XG4gIGlmIChlcnIgaW5zdGFuY2VvZiBHb29nbGVJbnB1dEVycm9yKSB7XG4gICAgcmV0dXJuIGBFcnJvcjogJHtlcnIubWVzc2FnZX1gO1xuICB9XG4gIHJldHVybiBgRXJyb3I6ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWA7XG59XG4iLCAiLyoqXG4gKiBHb29nbGVXb3Jrc3BhY2VDbGllbnQgXHUyMDE0IGEgdGhpbiwgcmVhZC1tb3N0bHkgd3JhcHBlciBvdmVyIHRoZSBHb29nbGUgV29ya3NwYWNlXG4gKiBSRVNUIEFQSXMgKENhbGVuZGFyLCBHbWFpbCwgRHJpdmUsIERvY3MsIFNoZWV0cywgQWRtaW4gRGlyZWN0b3J5LCBQZW9wbGUpLlxuICpcbiAqIEF1dGggaXMgc2VydmljZS1hY2NvdW50ICoqZG9tYWluLXdpZGUgZGVsZWdhdGlvbioqOiBldmVyeSBjYWxsIGltcGVyc29uYXRlcyBhXG4gKiBgc3ViamVjdGAgKGEgV29ya3NwYWNlIHVzZXIncyBlbWFpbCkgdmlhIHtAbGluayBHb29nbGVTZXJ2aWNlQWNjb3VudEF1dGh9LlxuICogQWxsIGVncmVzcyBnb2VzIHRocm91Z2ggdGhlIGluamVjdGVkIGBmZXRjaGAgXHUyMDE0IGluIHRoZSBwbHVnaW4gdGhpcyBpc1xuICogYGN0eC5odHRwLmZldGNoYCwgYWxsb3ctbGlzdGVkICsgcmF0ZS1saW1pdGVkIGJ5IHRoZSBob3N0LiBUaGUgY2xpZW50IG5ldmVyXG4gKiB0b3VjaGVzIGdsb2JhbCBgZmV0Y2hgLCBzbyBpdCBzdGF5cyBpbnNpZGUgdGhlIGtlcm5lbCdzIGF1ZGl0YWJsZSBib3VuZGFyeS5cbiAqXG4gKiBSZXNwb25zZXMgYXJlIHNpemUtY2FwcGVkIChgbWF4Qnl0ZXNgKSBiZWZvcmUgYEpTT04ucGFyc2VgIHNvIGEgcGF0aG9sb2dpY2FsXG4gKiB1bmJvdW5kZWQgbGlzdCBjYW4ndCBibG93IHVwIHRoZSBob3N0J3MgbWVtb3J5LiBFYWNoIHB1YmxpYyBtZXRob2QgbmFtZXMgdGhlXG4gKiBzdXJmYWNlIGl0IHRhbGtzIHRvOyB0aGUgcHJpdmF0ZSBgcmVxdWVzdCgpYCByZXNvbHZlcyB0aGUgY29ycmVjdCBBUEkgaG9zdC5cbiAqL1xuXG5pbXBvcnQgeyBHb29nbGVBcGlFcnJvciB9IGZyb20gJy4vZXJyb3JzLmpzJztcbmltcG9ydCB0eXBlIHsgR29vZ2xlU2VydmljZUFjY291bnRBdXRoIH0gZnJvbSAnLi9nb29nbGVBdXRoLmpzJztcblxuZXhwb3J0IHR5cGUgR29vZ2xlQXBpID1cbiAgfCAnY2FsZW5kYXInXG4gIHwgJ2dtYWlsJ1xuICB8ICdkcml2ZSdcbiAgfCAnZG9jcydcbiAgfCAnc2hlZXRzJ1xuICB8ICdkaXJlY3RvcnknXG4gIHwgJ3Blb3BsZSc7XG5cbi8qKiBCYXNlIFVSTCBwZXIgQVBJIChob3N0ICsgdmVyc2lvbiBwcmVmaXgpLiBIb3N0cyBhcmUgbWFuaWZlc3QtYWxsb3ctbGlzdGVkLiAqL1xuY29uc3QgQVBJX0JBU0U6IFJlY29yZDxHb29nbGVBcGksIHN0cmluZz4gPSB7XG4gIGNhbGVuZGFyOiAnaHR0cHM6Ly93d3cuZ29vZ2xlYXBpcy5jb20vY2FsZW5kYXIvdjMnLFxuICBnbWFpbDogJ2h0dHBzOi8vZ21haWwuZ29vZ2xlYXBpcy5jb20vZ21haWwvdjEnLFxuICBkcml2ZTogJ2h0dHBzOi8vd3d3Lmdvb2dsZWFwaXMuY29tL2RyaXZlL3YzJyxcbiAgZG9jczogJ2h0dHBzOi8vZG9jcy5nb29nbGVhcGlzLmNvbS92MScsXG4gIHNoZWV0czogJ2h0dHBzOi8vc2hlZXRzLmdvb2dsZWFwaXMuY29tL3Y0JyxcbiAgZGlyZWN0b3J5OiAnaHR0cHM6Ly9hZG1pbi5nb29nbGVhcGlzLmNvbS9hZG1pbi9kaXJlY3RvcnkvdjEnLFxuICBwZW9wbGU6ICdodHRwczovL3Blb3BsZS5nb29nbGVhcGlzLmNvbS92MScsXG59O1xuXG5jb25zdCBERUZBVUxUX01BWF9CWVRFUyA9IDEwMjQgKiAxMDI0OyAvLyAxIE1pQlxuY29uc3QgREVGQVVMVF9SRVRSWV9CQVNFX01TID0gNTAwO1xuY29uc3QgREVGQVVMVF9NQVhfUkVUUklFUyA9IDM7XG4vKiogVHJhbnNpZW50IHN0YXR1c2VzIHdvcnRoIHJldHJ5aW5nIHdpdGggZXhwb25lbnRpYWwgYmFja29mZi4gKi9cbmNvbnN0IFJFVFJZQUJMRV9TVEFUVVMgPSBuZXcgU2V0KFs0MjksIDUwMCwgNTAyLCA1MDMsIDUwNF0pO1xuXG4vKiogR29vZ2xlIEpTT04gZXJyb3IgZW52ZWxvcGUgKFJFU1QpOiBgeyBlcnJvcjogeyBjb2RlLCBtZXNzYWdlLCBzdGF0dXMsIGVycm9ycyB9IH1gLiAqL1xuaW50ZXJmYWNlIEdvb2dsZUVycm9yRW52ZWxvcGUge1xuICByZWFkb25seSBlcnJvcj86IHtcbiAgICByZWFkb25seSBjb2RlPzogbnVtYmVyO1xuICAgIHJlYWRvbmx5IG1lc3NhZ2U/OiBzdHJpbmc7XG4gICAgcmVhZG9ubHkgc3RhdHVzPzogc3RyaW5nO1xuICAgIHJlYWRvbmx5IGVycm9ycz86IFJlYWRvbmx5QXJyYXk8eyByZWFkb25seSByZWFzb24/OiBzdHJpbmc7IHJlYWRvbmx5IG1lc3NhZ2U/OiBzdHJpbmcgfT47XG4gIH07XG59XG5cbnR5cGUgUXVlcnlWYWx1ZSA9IHN0cmluZyB8IG51bWJlciB8IGJvb2xlYW4gfCByZWFkb25seSBzdHJpbmdbXSB8IHVuZGVmaW5lZDtcblxuZXhwb3J0IGludGVyZmFjZSBHb29nbGVXb3Jrc3BhY2VDbGllbnRPcHRpb25zIHtcbiAgcmVhZG9ubHkgYXV0aDogR29vZ2xlU2VydmljZUFjY291bnRBdXRoO1xuICAvKiogVGhlIHVuaW9uIHNjb3BlIHNldCB0aGUgYWNjZXNzIHRva2VuIGlzIHJlcXVlc3RlZCB3aXRoLiAqL1xuICByZWFkb25seSBzY29wZXM6IHJlYWRvbmx5IHN0cmluZ1tdO1xuICAvKiogSGFyZCBjYXAgb24gYSBzaW5nbGUgcmVzcG9uc2UgYm9keSBpbiBieXRlcy4gRGVmYXVsdHMgdG8gMSBNaUIuICovXG4gIHJlYWRvbmx5IG1heEJ5dGVzPzogbnVtYmVyO1xuICAvKiogQmFzZSBkZWxheSBmb3IgZXhwb25lbnRpYWwgYmFja29mZiBvbiB0cmFuc2llbnQgZXJyb3JzIChtcykuIERlZmF1bHQgNTAwLiAqL1xuICByZWFkb25seSByZXRyeUJhc2VNcz86IG51bWJlcjtcbiAgLyoqIE1heCByZXRyaWVzIG9uIHRyYW5zaWVudCAoNDI5LzV4eCkgZXJyb3JzLiBEZWZhdWx0IDMuICovXG4gIHJlYWRvbmx5IG1heFJldHJpZXM/OiBudW1iZXI7XG4gIC8qKiBJbmplY3RlZCBmZXRjaCAocHJvZHVjdGlvbjogYGN0eC5odHRwLmZldGNoYCkuICovXG4gIHJlYWRvbmx5IGZldGNoOiB0eXBlb2YgZmV0Y2g7XG4gIC8qKiBPcHRpb25hbCBzdHJ1Y3R1cmVkIGxvZ2dlci4gKi9cbiAgcmVhZG9ubHkgbG9nPzogKG1lc3NhZ2U6IHN0cmluZykgPT4gdm9pZDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBSZXF1ZXN0T3B0aW9ucyB7XG4gIC8qKiBXb3Jrc3BhY2UgdXNlciB0byBpbXBlcnNvbmF0ZSAoRFdEIGBzdWJgKS4gKi9cbiAgcmVhZG9ubHkgc3ViamVjdDogc3RyaW5nO1xuICByZWFkb25seSBxdWVyeT86IFJlY29yZDxzdHJpbmcsIFF1ZXJ5VmFsdWU+O1xuICAvKiogSlNPTiByZXF1ZXN0IGJvZHkgKHNlcmlhbGl6ZWQgKyBzZW50IGFzIGFwcGxpY2F0aW9uL2pzb24pLiAqL1xuICByZWFkb25seSBib2R5PzogdW5rbm93bjtcbiAgLyoqXG4gICAqIFByZS1zZXJpYWxpemVkIGJvZHkgc2VudCB2ZXJiYXRpbSB3aXRoIGBjb250ZW50VHlwZWAgKGUuZy4gYSBtdWx0aXBhcnRcbiAgICogdXBsb2FkKS4gVGFrZXMgcHJlY2VkZW5jZSBvdmVyIGBib2R5YC4gVXNlZCBieSB0aGUgRHJpdmUgbWVkaWEgdXBsb2FkLlxuICAgKi9cbiAgcmVhZG9ubHkgcmF3Qm9keT86IHN0cmluZztcbiAgcmVhZG9ubHkgY29udGVudFR5cGU/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjbGFzcyBHb29nbGVXb3Jrc3BhY2VDbGllbnQge1xuICBwcml2YXRlIHJlYWRvbmx5IGF1dGg6IEdvb2dsZVNlcnZpY2VBY2NvdW50QXV0aDtcbiAgcHJpdmF0ZSByZWFkb25seSBzY29wZXM6IHJlYWRvbmx5IHN0cmluZ1tdO1xuICBwcml2YXRlIHJlYWRvbmx5IG1heEJ5dGVzOiBudW1iZXI7XG4gIHByaXZhdGUgcmVhZG9ubHkgcmV0cnlCYXNlTXM6IG51bWJlcjtcbiAgcHJpdmF0ZSByZWFkb25seSBtYXhSZXRyaWVzOiBudW1iZXI7XG4gIHByaXZhdGUgcmVhZG9ubHkgZmV0Y2hJbXBsOiB0eXBlb2YgZmV0Y2g7XG4gIHByaXZhdGUgcmVhZG9ubHkgbG9nOiAobWVzc2FnZTogc3RyaW5nKSA9PiB2b2lkO1xuICAvKiogU3ViamVjdHMgd2hvc2UgUGVvcGxlIGNvbnRhY3RzIGNhY2hlIGhhcyBiZWVuIHdhcm1lZCB0aGlzIHByb2Nlc3MuICovXG4gIHByaXZhdGUgcmVhZG9ubHkgd2FybWVkQ29udGFjdHMgPSBuZXcgU2V0PHN0cmluZz4oKTtcblxuICBjb25zdHJ1Y3RvcihvcHRzOiBHb29nbGVXb3Jrc3BhY2VDbGllbnRPcHRpb25zKSB7XG4gICAgdGhpcy5hdXRoID0gb3B0cy5hdXRoO1xuICAgIHRoaXMuc2NvcGVzID0gb3B0cy5zY29wZXM7XG4gICAgdGhpcy5tYXhCeXRlcyA9IG9wdHMubWF4Qnl0ZXMgJiYgb3B0cy5tYXhCeXRlcyA+IDAgPyBvcHRzLm1heEJ5dGVzIDogREVGQVVMVF9NQVhfQllURVM7XG4gICAgdGhpcy5yZXRyeUJhc2VNcyA9XG4gICAgICB0eXBlb2Ygb3B0cy5yZXRyeUJhc2VNcyA9PT0gJ251bWJlcicgJiYgb3B0cy5yZXRyeUJhc2VNcyA+PSAwXG4gICAgICAgID8gb3B0cy5yZXRyeUJhc2VNc1xuICAgICAgICA6IERFRkFVTFRfUkVUUllfQkFTRV9NUztcbiAgICB0aGlzLm1heFJldHJpZXMgPVxuICAgICAgdHlwZW9mIG9wdHMubWF4UmV0cmllcyA9PT0gJ251bWJlcicgJiYgb3B0cy5tYXhSZXRyaWVzID49IDBcbiAgICAgICAgPyBvcHRzLm1heFJldHJpZXNcbiAgICAgICAgOiBERUZBVUxUX01BWF9SRVRSSUVTO1xuICAgIHRoaXMuZmV0Y2hJbXBsID0gb3B0cy5mZXRjaDtcbiAgICB0aGlzLmxvZyA9IG9wdHMubG9nID8/ICgoKSA9PiB7fSk7XG4gIH1cblxuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIC8vIENvcmUgcmVxdWVzdCBcdTIwMTQgb25lIHJldHJ5IG9uIDQwMSAoZXhwaXJlZC9yb3RhdGVkIHRva2VuKS5cbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBwcml2YXRlIGFzeW5jIHJlcXVlc3Q8VCA9IFJlY29yZDxzdHJpbmcsIHVua25vd24+PihcbiAgICBhcGk6IEdvb2dsZUFwaSxcbiAgICBtZXRob2Q6IHN0cmluZyxcbiAgICBwYXRoOiBzdHJpbmcsXG4gICAgb3B0czogUmVxdWVzdE9wdGlvbnMsXG4gICk6IFByb21pc2U8VD4ge1xuICAgIC8vIEFuIGFic29sdXRlIGBwYXRoYCAoZS5nLiB0aGUgRHJpdmUgbWVkaWEtdXBsb2FkIGhvc3QpIGlzIHVzZWQgdmVyYmF0aW07XG4gICAgLy8gb3RoZXJ3aXNlIGl0IGlzIHJlc29sdmVkIGFnYWluc3QgdGhlIHBlci1BUEkgYmFzZS5cbiAgICBjb25zdCBiYXNlID0gcGF0aC5zdGFydHNXaXRoKCdodHRwJykgPyBwYXRoIDogYCR7QVBJX0JBU0VbYXBpXX0ke3BhdGh9YDtcbiAgICBjb25zdCB1cmwgPSBgJHtiYXNlfSR7YnVpbGRRdWVyeVN0cmluZyhvcHRzLnF1ZXJ5KX1gO1xuICAgIGNvbnN0IHNlbmQgPSBhc3luYyAoKTogUHJvbWlzZTxSZXNwb25zZT4gPT4ge1xuICAgICAgY29uc3QgdG9rZW4gPSBhd2FpdCB0aGlzLmF1dGguZ2V0VG9rZW4ob3B0cy5zdWJqZWN0LCB0aGlzLnNjb3Blcyk7XG4gICAgICBjb25zdCBoZWFkZXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICAgICAgICBBdXRob3JpemF0aW9uOiBgQmVhcmVyICR7dG9rZW59YCxcbiAgICAgICAgQWNjZXB0OiAnYXBwbGljYXRpb24vanNvbicsXG4gICAgICB9O1xuICAgICAgbGV0IHNlcmlhbGl6ZWQ6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICAgIGlmIChvcHRzLnJhd0JvZHkgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICBpZiAob3B0cy5jb250ZW50VHlwZSkgaGVhZGVyc1snQ29udGVudC1UeXBlJ10gPSBvcHRzLmNvbnRlbnRUeXBlO1xuICAgICAgICBzZXJpYWxpemVkID0gb3B0cy5yYXdCb2R5O1xuICAgICAgfSBlbHNlIGlmIChvcHRzLmJvZHkgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICBoZWFkZXJzWydDb250ZW50LVR5cGUnXSA9ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JztcbiAgICAgICAgc2VyaWFsaXplZCA9IEpTT04uc3RyaW5naWZ5KG9wdHMuYm9keSk7XG4gICAgICB9XG4gICAgICByZXR1cm4gdGhpcy5mZXRjaEltcGwodXJsLCB7IG1ldGhvZCwgaGVhZGVycywgYm9keTogc2VyaWFsaXplZCB9KTtcbiAgICB9O1xuXG4gICAgbGV0IHRva2VuUmV0cmllZCA9IGZhbHNlO1xuICAgIGZvciAobGV0IGF0dGVtcHQgPSAwOyA7IGF0dGVtcHQrKykge1xuICAgICAgY29uc3QgcmVzID0gYXdhaXQgc2VuZCgpO1xuXG4gICAgICAvLyBFeHBpcmVkL3JvdGF0ZWQgdG9rZW4gXHUyMDE0IHJlLW1pbnQgb25jZSwgbm90IGNvdW50ZWQgYWdhaW5zdCBiYWNrb2ZmLlxuICAgICAgaWYgKHJlcy5zdGF0dXMgPT09IDQwMSAmJiAhdG9rZW5SZXRyaWVkKSB7XG4gICAgICAgIHRoaXMubG9nKCdbZ29vZ2xld29ya3NwYWNlXSA0MDEgXHUyMDE0IHJlZnJlc2hpbmcgdG9rZW4gYW5kIHJldHJ5aW5nIG9uY2UnKTtcbiAgICAgICAgdG9rZW5SZXRyaWVkID0gdHJ1ZTtcbiAgICAgICAgdGhpcy5hdXRoLmludmFsaWRhdGUob3B0cy5zdWJqZWN0LCB0aGlzLnNjb3Blcyk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICAvLyBUcmFuc2llbnQgZXJyb3JzIFx1MjAxNCBleHBvbmVudGlhbCBiYWNrb2ZmIHVwIHRvIG1heFJldHJpZXMuXG4gICAgICBpZiAoUkVUUllBQkxFX1NUQVRVUy5oYXMocmVzLnN0YXR1cykgJiYgYXR0ZW1wdCA8IHRoaXMubWF4UmV0cmllcykge1xuICAgICAgICBjb25zdCBkZWxheSA9IHRoaXMuYmFja29mZkRlbGF5KGF0dGVtcHQsIHJlcyk7XG4gICAgICAgIHRoaXMubG9nKFxuICAgICAgICAgIGBbZ29vZ2xld29ya3NwYWNlXSBIVFRQICR7cmVzLnN0YXR1c30gb24gJHthcGl9IFx1MjAxNCByZXRyeSAke2F0dGVtcHQgKyAxfS8ke3RoaXMubWF4UmV0cmllc30gaW4gJHtkZWxheX1tc2AsXG4gICAgICAgICk7XG4gICAgICAgIGF3YWl0IHNsZWVwKGRlbGF5KTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIGlmICghcmVzLm9rKSB0aHJvdyBhd2FpdCB0aGlzLnRvQXBpRXJyb3IocmVzKTtcbiAgICAgIGNvbnN0IHRleHQgPSBhd2FpdCB0aGlzLnJlYWRDYXBwZWQocmVzKTtcbiAgICAgIHJldHVybiAodGV4dCA/IEpTT04ucGFyc2UodGV4dCkgOiB7fSkgYXMgVDtcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogQmFja29mZiBkZWxheSBmb3IgcmV0cnkgYGF0dGVtcHRgICgwLWJhc2VkKS4gSG9ub3VycyBhIGBSZXRyeS1BZnRlcmBcbiAgICogaGVhZGVyIChzZWNvbmRzKSB3aGVuIHRoZSBzZXJ2ZXIgc2VuZHMgb25lLCBvdGhlcndpc2UgZXhwb25lbnRpYWxcbiAgICogKGBiYXNlICogMl5hdHRlbXB0YCkgd2l0aCBhIGxpdHRsZSBqaXR0ZXIuXG4gICAqL1xuICBwcml2YXRlIGJhY2tvZmZEZWxheShhdHRlbXB0OiBudW1iZXIsIHJlczogUmVzcG9uc2UpOiBudW1iZXIge1xuICAgIGNvbnN0IHJldHJ5QWZ0ZXIgPSBOdW1iZXIocmVzLmhlYWRlcnMuZ2V0KCdyZXRyeS1hZnRlcicpID8/ICcnKTtcbiAgICBpZiAoTnVtYmVyLmlzRmluaXRlKHJldHJ5QWZ0ZXIpICYmIHJldHJ5QWZ0ZXIgPiAwKSB7XG4gICAgICByZXR1cm4gTWF0aC5taW4ocmV0cnlBZnRlciAqIDEwMDAsIDMwXzAwMCk7XG4gICAgfVxuICAgIGNvbnN0IGJhc2UgPSB0aGlzLnJldHJ5QmFzZU1zICogMiAqKiBhdHRlbXB0O1xuICAgIGNvbnN0IGppdHRlciA9IE1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSAqIE1hdGgubWluKHRoaXMucmV0cnlCYXNlTXMsIDI1MCkpO1xuICAgIHJldHVybiBNYXRoLm1pbihiYXNlICsgaml0dGVyLCAzMF8wMDApO1xuICB9XG5cbiAgLyoqIFJlYWQgYSByZXNwb25zZSBib2R5LCByZWZ1c2luZyBwYXlsb2FkcyBsYXJnZXIgdGhhbiBgbWF4Qnl0ZXNgLiAqL1xuICBwcml2YXRlIGFzeW5jIHJlYWRDYXBwZWQocmVzOiBSZXNwb25zZSk6IFByb21pc2U8c3RyaW5nPiB7XG4gICAgY29uc3QgZGVjbGFyZWQgPSBOdW1iZXIocmVzLmhlYWRlcnMuZ2V0KCdjb250ZW50LWxlbmd0aCcpID8/ICcnKTtcbiAgICBpZiAoTnVtYmVyLmlzRmluaXRlKGRlY2xhcmVkKSAmJiBkZWNsYXJlZCA+IHRoaXMubWF4Qnl0ZXMpIHtcbiAgICAgIHRocm93IG5ldyBHb29nbGVBcGlFcnJvcihcbiAgICAgICAgcmVzLnN0YXR1cyxcbiAgICAgICAgJ1Jlc3BvbnNlVG9vTGFyZ2UnLFxuICAgICAgICBgcmVzcG9uc2Ugb2YgJHtkZWNsYXJlZH0gYnl0ZXMgZXhjZWVkcyBtYXhCeXRlcz0ke3RoaXMubWF4Qnl0ZXN9YCxcbiAgICAgICk7XG4gICAgfVxuICAgIGNvbnN0IHRleHQgPSBhd2FpdCByZXMudGV4dCgpO1xuICAgIGlmICh0ZXh0Lmxlbmd0aCA+IHRoaXMubWF4Qnl0ZXMpIHtcbiAgICAgIHRocm93IG5ldyBHb29nbGVBcGlFcnJvcihcbiAgICAgICAgcmVzLnN0YXR1cyxcbiAgICAgICAgJ1Jlc3BvbnNlVG9vTGFyZ2UnLFxuICAgICAgICBgcmVzcG9uc2Ugb2YgJHt0ZXh0Lmxlbmd0aH0gYnl0ZXMgZXhjZWVkcyBtYXhCeXRlcz0ke3RoaXMubWF4Qnl0ZXN9YCxcbiAgICAgICk7XG4gICAgfVxuICAgIHJldHVybiB0ZXh0O1xuICB9XG5cbiAgLyoqIFBhcnNlIGEgbm9uLTJ4eCBib2R5IGludG8gYSB7QGxpbmsgR29vZ2xlQXBpRXJyb3J9LiAqL1xuICBwcml2YXRlIGFzeW5jIHRvQXBpRXJyb3IocmVzOiBSZXNwb25zZSk6IFByb21pc2U8R29vZ2xlQXBpRXJyb3I+IHtcbiAgICBsZXQgcmF3ID0gJyc7XG4gICAgdHJ5IHtcbiAgICAgIHJhdyA9IGF3YWl0IHRoaXMucmVhZENhcHBlZChyZXMpO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgaWYgKGVyciBpbnN0YW5jZW9mIEdvb2dsZUFwaUVycm9yKSByZXR1cm4gZXJyO1xuICAgIH1cbiAgICBsZXQgcmVhc29uOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gICAgbGV0IG1lc3NhZ2UgPSByYXcgfHwgcmVzLnN0YXR1c1RleHQ7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGVudiA9IEpTT04ucGFyc2UocmF3KSBhcyBHb29nbGVFcnJvckVudmVsb3BlO1xuICAgICAgaWYgKGVudi5lcnJvcikge1xuICAgICAgICByZWFzb24gPSBlbnYuZXJyb3Iuc3RhdHVzID8/IGVudi5lcnJvci5lcnJvcnM/LlswXT8ucmVhc29uO1xuICAgICAgICBtZXNzYWdlID0gZW52LmVycm9yLm1lc3NhZ2UgPz8gbWVzc2FnZTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIG5vbi1KU09OIGVycm9yIGJvZHkgXHUyMDE0IGtlZXAgcmF3ICovXG4gICAgfVxuICAgIHJldHVybiBuZXcgR29vZ2xlQXBpRXJyb3IocmVzLnN0YXR1cywgcmVhc29uLCBtZXNzYWdlKTtcbiAgfVxuXG4gIC8qKiBBY3F1aXJlIGEgdG9rZW4gZm9yIGBzdWJqZWN0YCB0byB2ZXJpZnkgY29ubmVjdGl2aXR5ICsgZGVsZWdhdGlvbi4gKi9cbiAgYXN5bmMgcHJvYmUoc3ViamVjdDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgYXdhaXQgdGhpcy5hdXRoLmdldFRva2VuKHN1YmplY3QsIHRoaXMuc2NvcGVzKTtcbiAgfVxuXG4gIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgLy8gQ2FsZW5kYXIgQVBJIHYzXG4gIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAvKiogTGlzdCBldmVudHMgb24gYSBjYWxlbmRhciAoZGVmYXVsdCBgcHJpbWFyeWApLiAqL1xuICBhc3luYyBsaXN0RXZlbnRzKFxuICAgIHN1YmplY3Q6IHN0cmluZyxcbiAgICBwOiB7XG4gICAgICBjYWxlbmRhcklkPzogc3RyaW5nO1xuICAgICAgdGltZU1pbj86IHN0cmluZztcbiAgICAgIHRpbWVNYXg/OiBzdHJpbmc7XG4gICAgICBxPzogc3RyaW5nO1xuICAgICAgbWF4UmVzdWx0cz86IG51bWJlcjtcbiAgICAgIHNpbmdsZUV2ZW50cz86IGJvb2xlYW47XG4gICAgICBvcmRlckJ5Pzogc3RyaW5nO1xuICAgICAgcGFnZVRva2VuPzogc3RyaW5nO1xuICAgIH0sXG4gICk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcbiAgICBjb25zdCBjYWxlbmRhcklkID0gcC5jYWxlbmRhcklkIHx8ICdwcmltYXJ5JztcbiAgICByZXR1cm4gdGhpcy5yZXF1ZXN0KCdjYWxlbmRhcicsICdHRVQnLCBgL2NhbGVuZGFycy8ke2VuY29kZVVSSUNvbXBvbmVudChjYWxlbmRhcklkKX0vZXZlbnRzYCwge1xuICAgICAgc3ViamVjdCxcbiAgICAgIHF1ZXJ5OiB7XG4gICAgICAgIHRpbWVNaW46IHAudGltZU1pbixcbiAgICAgICAgdGltZU1heDogcC50aW1lTWF4LFxuICAgICAgICBxOiBwLnEsXG4gICAgICAgIG1heFJlc3VsdHM6IHAubWF4UmVzdWx0cyxcbiAgICAgICAgc2luZ2xlRXZlbnRzOiBwLnNpbmdsZUV2ZW50cyA/PyB0cnVlLFxuICAgICAgICBvcmRlckJ5OiBwLm9yZGVyQnkgPz8gKHAuc2luZ2xlRXZlbnRzID09PSBmYWxzZSA/IHVuZGVmaW5lZCA6ICdzdGFydFRpbWUnKSxcbiAgICAgICAgcGFnZVRva2VuOiBwLnBhZ2VUb2tlbixcbiAgICAgIH0sXG4gICAgfSk7XG4gIH1cblxuICAvKiogUXVlcnkgZnJlZS9idXN5IHdpbmRvd3MgYWNyb3NzIG9uZSBvciBtb3JlIGNhbGVuZGFycy4gKi9cbiAgYXN5bmMgZnJlZUJ1c3koXG4gICAgc3ViamVjdDogc3RyaW5nLFxuICAgIHA6IHsgdGltZU1pbjogc3RyaW5nOyB0aW1lTWF4OiBzdHJpbmc7IGNhbGVuZGFySWRzOiByZWFkb25seSBzdHJpbmdbXSB9LFxuICApOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB7XG4gICAgcmV0dXJuIHRoaXMucmVxdWVzdCgnY2FsZW5kYXInLCAnUE9TVCcsICcvZnJlZUJ1c3knLCB7XG4gICAgICBzdWJqZWN0LFxuICAgICAgYm9keToge1xuICAgICAgICB0aW1lTWluOiBwLnRpbWVNaW4sXG4gICAgICAgIHRpbWVNYXg6IHAudGltZU1heCxcbiAgICAgICAgaXRlbXM6IHAuY2FsZW5kYXJJZHMubWFwKChpZCkgPT4gKHsgaWQgfSkpLFxuICAgICAgfSxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKiBDcmVhdGUgYSBjYWxlbmRhciBldmVudC4gKi9cbiAgYXN5bmMgY3JlYXRlRXZlbnQoXG4gICAgc3ViamVjdDogc3RyaW5nLFxuICAgIGNhbGVuZGFySWQ6IHN0cmluZyxcbiAgICBldmVudDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG4gICAgcDogeyBzZW5kVXBkYXRlcz86IHN0cmluZyB9ID0ge30sXG4gICk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcbiAgICByZXR1cm4gdGhpcy5yZXF1ZXN0KCdjYWxlbmRhcicsICdQT1NUJywgYC9jYWxlbmRhcnMvJHtlbmNvZGVVUklDb21wb25lbnQoY2FsZW5kYXJJZCl9L2V2ZW50c2AsIHtcbiAgICAgIHN1YmplY3QsXG4gICAgICBxdWVyeTogeyBzZW5kVXBkYXRlczogcC5zZW5kVXBkYXRlcyB9LFxuICAgICAgYm9keTogZXZlbnQsXG4gICAgfSk7XG4gIH1cblxuICAvKiogUGF0Y2ggKHBhcnRpYWwgdXBkYXRlKSBhbiBleGlzdGluZyBldmVudC4gKi9cbiAgYXN5bmMgcGF0Y2hFdmVudChcbiAgICBzdWJqZWN0OiBzdHJpbmcsXG4gICAgY2FsZW5kYXJJZDogc3RyaW5nLFxuICAgIGV2ZW50SWQ6IHN0cmluZyxcbiAgICBwYXRjaDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG4gICAgcDogeyBzZW5kVXBkYXRlcz86IHN0cmluZyB9ID0ge30sXG4gICk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcbiAgICByZXR1cm4gdGhpcy5yZXF1ZXN0KFxuICAgICAgJ2NhbGVuZGFyJyxcbiAgICAgICdQQVRDSCcsXG4gICAgICBgL2NhbGVuZGFycy8ke2VuY29kZVVSSUNvbXBvbmVudChjYWxlbmRhcklkKX0vZXZlbnRzLyR7ZW5jb2RlVVJJQ29tcG9uZW50KGV2ZW50SWQpfWAsXG4gICAgICB7IHN1YmplY3QsIHF1ZXJ5OiB7IHNlbmRVcGRhdGVzOiBwLnNlbmRVcGRhdGVzIH0sIGJvZHk6IHBhdGNoIH0sXG4gICAgKTtcbiAgfVxuXG4gIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgLy8gR21haWwgQVBJIHYxICh1c2VySWQgJ21lJyByZXNvbHZlcyB0byB0aGUgaW1wZXJzb25hdGVkIHN1YmplY3QpXG4gIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICBhc3luYyBzZWFyY2hNZXNzYWdlcyhcbiAgICBzdWJqZWN0OiBzdHJpbmcsXG4gICAgcDogeyBxPzogc3RyaW5nOyBtYXhSZXN1bHRzPzogbnVtYmVyOyBsYWJlbElkcz86IHJlYWRvbmx5IHN0cmluZ1tdOyBwYWdlVG9rZW4/OiBzdHJpbmcgfSxcbiAgKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4ge1xuICAgIHJldHVybiB0aGlzLnJlcXVlc3QoJ2dtYWlsJywgJ0dFVCcsICcvdXNlcnMvbWUvbWVzc2FnZXMnLCB7XG4gICAgICBzdWJqZWN0LFxuICAgICAgcXVlcnk6IHtcbiAgICAgICAgcTogcC5xLFxuICAgICAgICBtYXhSZXN1bHRzOiBwLm1heFJlc3VsdHMsXG4gICAgICAgIGxhYmVsSWRzOiBwLmxhYmVsSWRzLFxuICAgICAgICBwYWdlVG9rZW46IHAucGFnZVRva2VuLFxuICAgICAgfSxcbiAgICB9KTtcbiAgfVxuXG4gIGFzeW5jIGdldE1lc3NhZ2UoXG4gICAgc3ViamVjdDogc3RyaW5nLFxuICAgIGlkOiBzdHJpbmcsXG4gICAgcDogeyBmb3JtYXQ/OiBzdHJpbmcgfSA9IHt9LFxuICApOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB7XG4gICAgcmV0dXJuIHRoaXMucmVxdWVzdCgnZ21haWwnLCAnR0VUJywgYC91c2Vycy9tZS9tZXNzYWdlcy8ke2VuY29kZVVSSUNvbXBvbmVudChpZCl9YCwge1xuICAgICAgc3ViamVjdCxcbiAgICAgIHF1ZXJ5OiB7IGZvcm1hdDogcC5mb3JtYXQgPz8gJ2Z1bGwnIH0sXG4gICAgfSk7XG4gIH1cblxuICAvKiogU2VuZCBhIG1lc3NhZ2UuIGByYXdgIGlzIGEgYmFzZTY0dXJsLWVuY29kZWQgUkZDIDI4MjIgbWVzc2FnZS4gKi9cbiAgYXN5bmMgc2VuZE1lc3NhZ2Uoc3ViamVjdDogc3RyaW5nLCByYXc6IHN0cmluZyk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcbiAgICByZXR1cm4gdGhpcy5yZXF1ZXN0KCdnbWFpbCcsICdQT1NUJywgJy91c2Vycy9tZS9tZXNzYWdlcy9zZW5kJywge1xuICAgICAgc3ViamVjdCxcbiAgICAgIGJvZHk6IHsgcmF3IH0sXG4gICAgfSk7XG4gIH1cblxuICAvKiogQ3JlYXRlIGEgZHJhZnQuIGByYXdgIGlzIGEgYmFzZTY0dXJsLWVuY29kZWQgUkZDIDI4MjIgbWVzc2FnZS4gKi9cbiAgYXN5bmMgY3JlYXRlRHJhZnQoc3ViamVjdDogc3RyaW5nLCByYXc6IHN0cmluZyk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcbiAgICByZXR1cm4gdGhpcy5yZXF1ZXN0KCdnbWFpbCcsICdQT1NUJywgJy91c2Vycy9tZS9kcmFmdHMnLCB7XG4gICAgICBzdWJqZWN0LFxuICAgICAgYm9keTogeyBtZXNzYWdlOiB7IHJhdyB9IH0sXG4gICAgfSk7XG4gIH1cblxuICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gIC8vIERyaXZlIEFQSSB2MyAvIERvY3MgdjEgLyBTaGVldHMgdjRcbiAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gIGFzeW5jIHNlYXJjaEZpbGVzKFxuICAgIHN1YmplY3Q6IHN0cmluZyxcbiAgICBwOiB7IHE/OiBzdHJpbmc7IHBhZ2VTaXplPzogbnVtYmVyOyBvcmRlckJ5Pzogc3RyaW5nOyBmaWVsZHM/OiBzdHJpbmc7IHBhZ2VUb2tlbj86IHN0cmluZyB9LFxuICApOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB7XG4gICAgcmV0dXJuIHRoaXMucmVxdWVzdCgnZHJpdmUnLCAnR0VUJywgJy9maWxlcycsIHtcbiAgICAgIHN1YmplY3QsXG4gICAgICBxdWVyeToge1xuICAgICAgICBxOiBwLnEsXG4gICAgICAgIHBhZ2VTaXplOiBwLnBhZ2VTaXplLFxuICAgICAgICBvcmRlckJ5OiBwLm9yZGVyQnksXG4gICAgICAgIGZpZWxkczpcbiAgICAgICAgICBwLmZpZWxkcyA/P1xuICAgICAgICAgICdmaWxlcyhpZCxuYW1lLG1pbWVUeXBlLG1vZGlmaWVkVGltZSxvd25lcnMoZW1haWxBZGRyZXNzKSx3ZWJWaWV3TGluayxzaXplKSxuZXh0UGFnZVRva2VuJyxcbiAgICAgICAgcGFnZVRva2VuOiBwLnBhZ2VUb2tlbixcbiAgICAgICAgc3VwcG9ydHNBbGxEcml2ZXM6IHRydWUsXG4gICAgICAgIGluY2x1ZGVJdGVtc0Zyb21BbGxEcml2ZXM6IHRydWUsXG4gICAgICB9LFxuICAgIH0pO1xuICB9XG5cbiAgYXN5bmMgZ2V0RmlsZShcbiAgICBzdWJqZWN0OiBzdHJpbmcsXG4gICAgZmlsZUlkOiBzdHJpbmcsXG4gICAgcDogeyBmaWVsZHM/OiBzdHJpbmcgfSA9IHt9LFxuICApOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB7XG4gICAgcmV0dXJuIHRoaXMucmVxdWVzdCgnZHJpdmUnLCAnR0VUJywgYC9maWxlcy8ke2VuY29kZVVSSUNvbXBvbmVudChmaWxlSWQpfWAsIHtcbiAgICAgIHN1YmplY3QsXG4gICAgICBxdWVyeToge1xuICAgICAgICBmaWVsZHM6XG4gICAgICAgICAgcC5maWVsZHMgPz9cbiAgICAgICAgICAnaWQsbmFtZSxtaW1lVHlwZSxtb2RpZmllZFRpbWUsY3JlYXRlZFRpbWUsb3duZXJzKGVtYWlsQWRkcmVzcyxkaXNwbGF5TmFtZSksd2ViVmlld0xpbmssc2l6ZSxkZXNjcmlwdGlvbicsXG4gICAgICAgIHN1cHBvcnRzQWxsRHJpdmVzOiB0cnVlLFxuICAgICAgfSxcbiAgICB9KTtcbiAgfVxuXG4gIGFzeW5jIGdldERvY3VtZW50KHN1YmplY3Q6IHN0cmluZywgZG9jdW1lbnRJZDogc3RyaW5nKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4ge1xuICAgIHJldHVybiB0aGlzLnJlcXVlc3QoJ2RvY3MnLCAnR0VUJywgYC9kb2N1bWVudHMvJHtlbmNvZGVVUklDb21wb25lbnQoZG9jdW1lbnRJZCl9YCwgeyBzdWJqZWN0IH0pO1xuICB9XG5cbiAgYXN5bmMgZ2V0U2hlZXRWYWx1ZXMoXG4gICAgc3ViamVjdDogc3RyaW5nLFxuICAgIHNwcmVhZHNoZWV0SWQ6IHN0cmluZyxcbiAgICByYW5nZTogc3RyaW5nLFxuICApOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB7XG4gICAgcmV0dXJuIHRoaXMucmVxdWVzdChcbiAgICAgICdzaGVldHMnLFxuICAgICAgJ0dFVCcsXG4gICAgICBgL3NwcmVhZHNoZWV0cy8ke2VuY29kZVVSSUNvbXBvbmVudChzcHJlYWRzaGVldElkKX0vdmFsdWVzLyR7ZW5jb2RlVVJJQ29tcG9uZW50KHJhbmdlKX1gLFxuICAgICAgeyBzdWJqZWN0IH0sXG4gICAgKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBXcml0ZSB2YWx1ZXMgaW50byBhIFNoZWV0cyByYW5nZS4gYG1vZGU6ICdvdmVyd3JpdGUnYCAoZGVmYXVsdCkgUFVUcyB0aGVcbiAgICogcmFuZ2UgKGB2YWx1ZXMudXBkYXRlYCk7IGBtb2RlOiAnYXBwZW5kJ2AgYXBwZW5kcyByb3dzIGFmdGVyIHRoZSB0YWJsZVxuICAgKiAoYHZhbHVlcy5hcHBlbmRgIHdpdGggYElOU0VSVF9ST1dTYCkuIGB2YWx1ZUlucHV0T3B0aW9uYCBjb250cm9scyB3aGV0aGVyXG4gICAqIGlucHV0cyBhcmUgcGFyc2VkIChgVVNFUl9FTlRFUkVEYCkgb3Igc3RvcmVkIGFzLWlzIChgUkFXYCkuXG4gICAqL1xuICBhc3luYyB3cml0ZVNoZWV0VmFsdWVzKFxuICAgIHN1YmplY3Q6IHN0cmluZyxcbiAgICBzcHJlYWRzaGVldElkOiBzdHJpbmcsXG4gICAgcmFuZ2U6IHN0cmluZyxcbiAgICB2YWx1ZXM6IHVua25vd25bXVtdLFxuICAgIHA6IHsgbW9kZT86ICdvdmVyd3JpdGUnIHwgJ2FwcGVuZCc7IHZhbHVlSW5wdXRPcHRpb24/OiBzdHJpbmcgfSA9IHt9LFxuICApOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB7XG4gICAgY29uc3QgdmFsdWVJbnB1dE9wdGlvbiA9IHAudmFsdWVJbnB1dE9wdGlvbiA/PyAnVVNFUl9FTlRFUkVEJztcbiAgICBjb25zdCBlbmNvZGVkID0gYC9zcHJlYWRzaGVldHMvJHtlbmNvZGVVUklDb21wb25lbnQoc3ByZWFkc2hlZXRJZCl9L3ZhbHVlcy8ke2VuY29kZVVSSUNvbXBvbmVudChyYW5nZSl9YDtcbiAgICBjb25zdCBib2R5ID0geyByYW5nZSwgbWFqb3JEaW1lbnNpb246ICdST1dTJywgdmFsdWVzIH07XG4gICAgaWYgKHAubW9kZSA9PT0gJ2FwcGVuZCcpIHtcbiAgICAgIHJldHVybiB0aGlzLnJlcXVlc3QoJ3NoZWV0cycsICdQT1NUJywgYCR7ZW5jb2RlZH06YXBwZW5kYCwge1xuICAgICAgICBzdWJqZWN0LFxuICAgICAgICBxdWVyeTogeyB2YWx1ZUlucHV0T3B0aW9uLCBpbnNlcnREYXRhT3B0aW9uOiAnSU5TRVJUX1JPV1MnIH0sXG4gICAgICAgIGJvZHksXG4gICAgICB9KTtcbiAgICB9XG4gICAgcmV0dXJuIHRoaXMucmVxdWVzdCgnc2hlZXRzJywgJ1BVVCcsIGVuY29kZWQsIHtcbiAgICAgIHN1YmplY3QsXG4gICAgICBxdWVyeTogeyB2YWx1ZUlucHV0T3B0aW9uIH0sXG4gICAgICBib2R5LFxuICAgIH0pO1xuICB9XG5cbiAgLyoqXG4gICAqIENyZWF0ZSBhIERyaXZlIGZpbGUgb3IgZm9sZGVyLiBNZXRhZGF0YS1vbmx5IChubyBgY29udGVudGApIGlzIGEgcGxhaW5cbiAgICogYGZpbGVzLmNyZWF0ZWAgKGZvbGRlcnMsIGVtcHR5IG5hdGl2ZSBHb29nbGUgZmlsZXMpLiBXaXRoIGBjb250ZW50YCwgYVxuICAgKiBtdWx0aXBhcnQgbWVkaWEgdXBsb2FkIGlzIHVzZWQgc28gdGhlIGJ5dGVzIGxhbmQgaW4gdGhlIG5ldyBmaWxlICh0ZXh0XG4gICAqIGNvbnRlbnQ7IG5hdGl2ZSBHb29nbGUgdHlwZXMgYXJlIGNvbnZlcnRlZCBmcm9tIGl0KS5cbiAgICovXG4gIGFzeW5jIGNyZWF0ZURyaXZlRmlsZShcbiAgICBzdWJqZWN0OiBzdHJpbmcsXG4gICAgcDoge1xuICAgICAgbmFtZTogc3RyaW5nO1xuICAgICAgbWltZVR5cGU6IHN0cmluZztcbiAgICAgIHBhcmVudHM/OiByZWFkb25seSBzdHJpbmdbXTtcbiAgICAgIGNvbnRlbnQ/OiBzdHJpbmc7XG4gICAgICBjb250ZW50TWltZVR5cGU/OiBzdHJpbmc7XG4gICAgfSxcbiAgKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4ge1xuICAgIGNvbnN0IG1ldGFkYXRhOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHsgbmFtZTogcC5uYW1lLCBtaW1lVHlwZTogcC5taW1lVHlwZSB9O1xuICAgIGlmIChwLnBhcmVudHMgJiYgcC5wYXJlbnRzLmxlbmd0aCA+IDApIG1ldGFkYXRhLnBhcmVudHMgPSBwLnBhcmVudHM7XG4gICAgY29uc3QgZmllbGRzID0gJ2lkLG5hbWUsbWltZVR5cGUsd2ViVmlld0xpbmsscGFyZW50cyc7XG5cbiAgICBpZiAocC5jb250ZW50ID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHJldHVybiB0aGlzLnJlcXVlc3QoJ2RyaXZlJywgJ1BPU1QnLCAnL2ZpbGVzJywge1xuICAgICAgICBzdWJqZWN0LFxuICAgICAgICBxdWVyeTogeyBzdXBwb3J0c0FsbERyaXZlczogdHJ1ZSwgZmllbGRzIH0sXG4gICAgICAgIGJvZHk6IG1ldGFkYXRhLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgLy8gTXVsdGlwYXJ0IG1lZGlhIHVwbG9hZDogbWV0YWRhdGEgcGFydCArIG1lZGlhIHBhcnQuXG4gICAgY29uc3QgYm91bmRhcnkgPSBgb21hZGlhLWd3LSR7TWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMil9YDtcbiAgICBjb25zdCByYXdCb2R5ID0gW1xuICAgICAgYC0tJHtib3VuZGFyeX1gLFxuICAgICAgJ0NvbnRlbnQtVHlwZTogYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD1VVEYtOCcsXG4gICAgICAnJyxcbiAgICAgIEpTT04uc3RyaW5naWZ5KG1ldGFkYXRhKSxcbiAgICAgIGAtLSR7Ym91bmRhcnl9YCxcbiAgICAgIGBDb250ZW50LVR5cGU6ICR7cC5jb250ZW50TWltZVR5cGUgPz8gJ3RleHQvcGxhaW4nfTsgY2hhcnNldD1VVEYtOGAsXG4gICAgICAnJyxcbiAgICAgIHAuY29udGVudCxcbiAgICAgIGAtLSR7Ym91bmRhcnl9LS1gLFxuICAgICAgJycsXG4gICAgXS5qb2luKCdcXHJcXG4nKTtcbiAgICByZXR1cm4gdGhpcy5yZXF1ZXN0KCdkcml2ZScsICdQT1NUJywgJ2h0dHBzOi8vd3d3Lmdvb2dsZWFwaXMuY29tL3VwbG9hZC9kcml2ZS92My9maWxlcycsIHtcbiAgICAgIHN1YmplY3QsXG4gICAgICBxdWVyeTogeyB1cGxvYWRUeXBlOiAnbXVsdGlwYXJ0Jywgc3VwcG9ydHNBbGxEcml2ZXM6IHRydWUsIGZpZWxkcyB9LFxuICAgICAgcmF3Qm9keSxcbiAgICAgIGNvbnRlbnRUeXBlOiBgbXVsdGlwYXJ0L3JlbGF0ZWQ7IGJvdW5kYXJ5PSR7Ym91bmRhcnl9YCxcbiAgICB9KTtcbiAgfVxuXG4gIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgLy8gQWRtaW4gRGlyZWN0b3J5IHYxIC8gUGVvcGxlIHYxXG4gIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICBhc3luYyBsaXN0RGlyZWN0b3J5VXNlcnMoXG4gICAgc3ViamVjdDogc3RyaW5nLFxuICAgIHA6IHtcbiAgICAgIGN1c3RvbWVyPzogc3RyaW5nO1xuICAgICAgZG9tYWluPzogc3RyaW5nO1xuICAgICAgcXVlcnk/OiBzdHJpbmc7XG4gICAgICBtYXhSZXN1bHRzPzogbnVtYmVyO1xuICAgICAgb3JkZXJCeT86IHN0cmluZztcbiAgICAgIHBhZ2VUb2tlbj86IHN0cmluZztcbiAgICB9LFxuICApOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB7XG4gICAgLy8gYGN1c3RvbWVyYCBhbmQgYGRvbWFpbmAgYXJlIG11dHVhbGx5IGV4Y2x1c2l2ZTsgZGVmYXVsdCB0byBteV9jdXN0b21lci5cbiAgICBjb25zdCB1c2VEb21haW4gPSBCb29sZWFuKHAuZG9tYWluKTtcbiAgICByZXR1cm4gdGhpcy5yZXF1ZXN0KCdkaXJlY3RvcnknLCAnR0VUJywgJy91c2VycycsIHtcbiAgICAgIHN1YmplY3QsXG4gICAgICBxdWVyeToge1xuICAgICAgICBjdXN0b21lcjogdXNlRG9tYWluID8gdW5kZWZpbmVkIDogcC5jdXN0b21lciB8fCAnbXlfY3VzdG9tZXInLFxuICAgICAgICBkb21haW46IHAuZG9tYWluLFxuICAgICAgICBxdWVyeTogcC5xdWVyeSxcbiAgICAgICAgbWF4UmVzdWx0czogcC5tYXhSZXN1bHRzLFxuICAgICAgICBvcmRlckJ5OiBwLm9yZGVyQnksXG4gICAgICAgIHBhZ2VUb2tlbjogcC5wYWdlVG9rZW4sXG4gICAgICAgIHByb2plY3Rpb246ICdiYXNpYycsXG4gICAgICAgIHZpZXdUeXBlOiAnYWRtaW5fdmlldycsXG4gICAgICB9LFxuICAgIH0pO1xuICB9XG5cbiAgYXN5bmMgc2VhcmNoQ29udGFjdHMoXG4gICAgc3ViamVjdDogc3RyaW5nLFxuICAgIHA6IHsgcXVlcnk6IHN0cmluZzsgcGFnZVNpemU/OiBudW1iZXI7IHJlYWRNYXNrPzogc3RyaW5nIH0sXG4gICk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcbiAgICBjb25zdCByZWFkTWFzayA9IHAucmVhZE1hc2sgPz8gJ25hbWVzLGVtYWlsQWRkcmVzc2VzLHBob25lTnVtYmVycyxvcmdhbml6YXRpb25zJztcbiAgICAvLyBQZW9wbGUgYHNlYXJjaENvbnRhY3RzYCByZXF1aXJlcyBhIHdhcm11cCAoZW1wdHktcXVlcnkpIHJlcXVlc3QgdG8gcHJpbWVcbiAgICAvLyB0aGUgc2VydmVyLXNpZGUgY2FjaGUgYmVmb3JlIHRoZSBmaXJzdCByZWFsIHNlYXJjaCwgb3RoZXJ3aXNlIHJlc3VsdHNcbiAgICAvLyBjb21lIGJhY2sgZW1wdHkuIEJlc3QtZWZmb3J0LCBvbmNlIHBlciBzdWJqZWN0IHBlciBwcm9jZXNzLlxuICAgIGlmICghdGhpcy53YXJtZWRDb250YWN0cy5oYXMoc3ViamVjdCkpIHtcbiAgICAgIHRoaXMud2FybWVkQ29udGFjdHMuYWRkKHN1YmplY3QpO1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgdGhpcy5yZXF1ZXN0KCdwZW9wbGUnLCAnR0VUJywgJy9wZW9wbGU6c2VhcmNoQ29udGFjdHMnLCB7XG4gICAgICAgICAgc3ViamVjdCxcbiAgICAgICAgICBxdWVyeTogeyBxdWVyeTogJycsIHJlYWRNYXNrIH0sXG4gICAgICAgIH0pO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8vIFdhcm11cCBpcyBiZXN0LWVmZm9ydDsgdGhlIHJlYWwgcXVlcnkgYmVsb3cgc3VyZmFjZXMgYW55IHJlYWwgZXJyb3IuXG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiB0aGlzLnJlcXVlc3QoJ3Blb3BsZScsICdHRVQnLCAnL3Blb3BsZTpzZWFyY2hDb250YWN0cycsIHtcbiAgICAgIHN1YmplY3QsXG4gICAgICBxdWVyeTogeyBxdWVyeTogcC5xdWVyeSwgcGFnZVNpemU6IHAucGFnZVNpemUsIHJlYWRNYXNrIH0sXG4gICAgfSk7XG4gIH1cbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBIZWxwZXJzXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqXG4gKiBCdWlsZCBhIHF1ZXJ5IHN0cmluZyBmcm9tIGEgZmxhdCByZWNvcmQuIGB1bmRlZmluZWRgIHZhbHVlcyBhcmUgc2tpcHBlZDtcbiAqIGFycmF5cyBleHBhbmQgaW50byByZXBlYXRlZCBwYXJhbXMgKGUuZy4gYGxhYmVsSWRzPUEmbGFiZWxJZHM9QmApLiBSZXR1cm5zXG4gKiBgJydgIHdoZW4gbm90aGluZyBpcyBzZXQuXG4gKi9cbmZ1bmN0aW9uIGJ1aWxkUXVlcnlTdHJpbmcocXVlcnk6IFJlY29yZDxzdHJpbmcsIFF1ZXJ5VmFsdWU+IHwgdW5kZWZpbmVkKTogc3RyaW5nIHtcbiAgaWYgKCFxdWVyeSkgcmV0dXJuICcnO1xuICBjb25zdCBzcCA9IG5ldyBVUkxTZWFyY2hQYXJhbXMoKTtcbiAgZm9yIChjb25zdCBba2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMocXVlcnkpKSB7XG4gICAgaWYgKHZhbHVlID09PSB1bmRlZmluZWQpIGNvbnRpbnVlO1xuICAgIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgZm9yIChjb25zdCB2IG9mIHZhbHVlKSBzcC5hcHBlbmQoa2V5LCBTdHJpbmcodikpO1xuICAgIH0gZWxzZSB7XG4gICAgICBzcC5hcHBlbmQoa2V5LCBTdHJpbmcodmFsdWUpKTtcbiAgICB9XG4gIH1cbiAgY29uc3QgcyA9IHNwLnRvU3RyaW5nKCk7XG4gIHJldHVybiBzID8gYD8ke3N9YCA6ICcnO1xufVxuXG4vKiogUHJvbWlzZS1iYXNlZCBzbGVlcCB1c2VkIGZvciByZXRyeSBiYWNrb2ZmLiAqL1xuZnVuY3Rpb24gc2xlZXAobXM6IG51bWJlcik6IFByb21pc2U8dm9pZD4ge1xuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHNldFRpbWVvdXQocmVzb2x2ZSwgbXMpKTtcbn1cbiIsICIvKipcbiAqIFNoYXJlZCBkZXBlbmRlbmN5IGJ1bmRsZSBoYW5kZWQgdG8gZXZlcnkgdG9vbCBoYW5kbGVyIGZhY3RvcnksIHBsdXMgdGhlXG4gKiBzdWJqZWN0LXJlc29sdXRpb24gcnVsZSB1c2VkIGFjcm9zcyBhbGwgc3VyZmFjZXMuXG4gKlxuICogSW1wZXJzb25hdGlvbiBzdWJqZWN0IHByZWNlZGVuY2U6XG4gKiAgIDEuIHRoZSBleHBsaWNpdCBgdXNlcmAgYXJndW1lbnQgb24gdGhlIHRvb2wgY2FsbCAoYW4gZW1haWwpLCBpZiBnaXZlbjtcbiAqICAgMi4gdGhlIGFkbWluIHN1YmplY3QgZm9yIGRpcmVjdG9yeS9hZG1pbiByZWFkcyAoYGFkbWluOiB0cnVlYCk7XG4gKiAgIDMuIHRoZSBkZWZhdWx0IHN1YmplY3QgZnJvbSBjb25maWcuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBHb29nbGVXb3Jrc3BhY2VDbGllbnQgfSBmcm9tICcuL2dvb2dsZUNsaWVudC5qcyc7XG5pbXBvcnQgdHlwZSB7IFJlc3BvbnNlQ2FjaGUgfSBmcm9tICcuL3Jlc3BvbnNlQ2FjaGUuanMnO1xuaW1wb3J0IHsgR29vZ2xlSW5wdXRFcnJvciB9IGZyb20gJy4vZXJyb3JzLmpzJztcblxuZXhwb3J0IGludGVyZmFjZSBUb29sRGVwcyB7XG4gIHJlYWRvbmx5IGNsaWVudDogR29vZ2xlV29ya3NwYWNlQ2xpZW50O1xuICByZWFkb25seSBjYWNoZTogUmVzcG9uc2VDYWNoZTtcbiAgLyoqIERlZmF1bHQgdXNlciB0aGUgaW50ZWdyYXRpb24gYWN0cyBhcyB3aGVuIGEgdG9vbCBvbWl0cyBgdXNlcmAuICovXG4gIHJlYWRvbmx5IGRlZmF1bHRTdWJqZWN0OiBzdHJpbmc7XG4gIC8qKiBBZG1pbiB1c2VyIGltcGVyc29uYXRlZCBmb3IgRGlyZWN0b3J5L0FkbWluIFNESyByZWFkcy4gKi9cbiAgcmVhZG9ubHkgYWRtaW5TdWJqZWN0OiBzdHJpbmc7XG59XG5cbi8qKiBSZXNvbHZlIHRoZSBpbXBlcnNvbmF0aW9uIHN1YmplY3QgZm9yIGEgdG9vbCBjYWxsLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVTdWJqZWN0KFxuICBkZXBzOiBUb29sRGVwcyxcbiAgdXNlcjogdW5rbm93bixcbiAgb3B0czogeyBhZG1pbj86IGJvb2xlYW4gfSA9IHt9LFxuKTogc3RyaW5nIHtcbiAgY29uc3QgdSA9IHR5cGVvZiB1c2VyID09PSAnc3RyaW5nJyA/IHVzZXIudHJpbSgpIDogJyc7XG4gIGlmICh1KSB7XG4gICAgaWYgKCF1LmluY2x1ZGVzKCdAJykpIHtcbiAgICAgIHRocm93IG5ldyBHb29nbGVJbnB1dEVycm9yKGBcInVzZXJcIiBtdXN0IGJlIGEgZnVsbCBlbWFpbCBhZGRyZXNzLCBnb3Q6ICcke3V9J2ApO1xuICAgIH1cbiAgICByZXR1cm4gdTtcbiAgfVxuICBjb25zdCBmYWxsYmFjayA9IG9wdHMuYWRtaW4gPyBkZXBzLmFkbWluU3ViamVjdCA6IGRlcHMuZGVmYXVsdFN1YmplY3Q7XG4gIGlmICghZmFsbGJhY2spIHtcbiAgICB0aHJvdyBuZXcgR29vZ2xlSW5wdXRFcnJvcihcbiAgICAgIG9wdHMuYWRtaW5cbiAgICAgICAgPyAnbm8gYWRtaW4gdXNlciBjb25maWd1cmVkIFx1MjAxNCBzZXQgZ3dfYWRtaW5fc3ViamVjdCAob3IgZ3dfc3ViamVjdF9kZWZhdWx0KSBvciBwYXNzIFwidXNlclwiLidcbiAgICAgICAgOiAnbm8gZGVmYXVsdCB1c2VyIGNvbmZpZ3VyZWQgXHUyMDE0IHNldCBnd19zdWJqZWN0X2RlZmF1bHQgb3IgcGFzcyBcInVzZXJcIi4nLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIGZhbGxiYWNrO1xufVxuIiwgIi8qKlxuICogR29vZ2xlIERyaXZlIC8gRG9jcyAvIFNoZWV0cyB0b29scyAoYWxsIFJFQUQtT05MWSBpbiB2MSkuXG4gKlxuICogICAtIGBnd19kcml2ZV9zZWFyY2hgICAgXHUyMDE0IGZpbmQgZmlsZXMvZm9sZGVycyB3aXRoIERyaXZlIHF1ZXJ5IHN5bnRheC5cbiAqICAgLSBgZ3dfZHJpdmVfZ2V0X2ZpbGVgIFx1MjAxNCBmaWxlIG1ldGFkYXRhIGJ5IGlkLlxuICogICAtIGBnd19kb2NfcmVhZGAgICAgICAgXHUyMDE0IGEgR29vZ2xlIERvYydzIHRleHQgY29udGVudCAoZmxhdHRlbmVkKS5cbiAqICAgLSBgZ3dfc2hlZXRfcmVhZGAgICAgIFx1MjAxNCB2YWx1ZXMgZnJvbSBhIFNoZWV0cyByYW5nZS5cbiAqXG4gKiBBbGwgcmVhZHMgZ28gdGhyb3VnaCB0aGUgc2hvcnQtVFRMIGNhY2hlIGtleWVkIGJ5IHRoZSBpbXBlcnNvbmF0ZWQgc3ViamVjdC5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IE5hdGl2ZVRvb2xIYW5kbGVyLCBOYXRpdmVUb29sU3BlYyB9IGZyb20gJ0BvbWFkaWEvcGx1Z2luLWFwaSc7XG5cbmltcG9ydCB7IGZvcm1hdFRvb2xFcnJvciwgR29vZ2xlSW5wdXRFcnJvciB9IGZyb20gJy4vZXJyb3JzLmpzJztcbmltcG9ydCB7IHJlc29sdmVTdWJqZWN0LCB0eXBlIFRvb2xEZXBzIH0gZnJvbSAnLi90b29sRGVwcy5qcyc7XG5cbmNvbnN0IE1BWF9SRVNVTFRTID0gNTA7XG5jb25zdCBERUZBVUxUX1JFU1VMVFMgPSAyMDtcblxuZnVuY3Rpb24gY2xhbXAodmFsdWU6IHVua25vd24sIGRlZjogbnVtYmVyLCBtYXg6IG51bWJlcik6IG51bWJlciB7XG4gIGNvbnN0IG4gPSB0eXBlb2YgdmFsdWUgPT09ICdudW1iZXInID8gdmFsdWUgOiBOdW1iZXIodmFsdWUpO1xuICBpZiAoIU51bWJlci5pc0Zpbml0ZShuKSB8fCBuIDw9IDApIHJldHVybiBkZWY7XG4gIHJldHVybiBNYXRoLm1pbihNYXRoLmZsb29yKG4pLCBtYXgpO1xufVxuZnVuY3Rpb24gc3RyKHZhbHVlOiB1bmtub3duKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycgJiYgdmFsdWUudHJpbSgpID8gdmFsdWUudHJpbSgpIDogdW5kZWZpbmVkO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIGd3X2RyaXZlX3NlYXJjaFxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5leHBvcnQgY29uc3QgZHJpdmVTZWFyY2hTcGVjOiBOYXRpdmVUb29sU3BlYyA9IHtcbiAgbmFtZTogJ2d3X2RyaXZlX3NlYXJjaCcsXG4gIGRlc2NyaXB0aW9uOlxuICAgICdTZWFyY2ggR29vZ2xlIERyaXZlIHVzaW5nIERyaXZlIHF1ZXJ5IHN5bnRheC4gUkVBRC1PTkxZLiBFeGFtcGxlczogXCJuYW1lIGNvbnRhaW5zIFxcJ2J1ZGdldFxcJ1wiLCBcIm1pbWVUeXBlPVxcJ2FwcGxpY2F0aW9uL3ZuZC5nb29nbGUtYXBwcy5kb2N1bWVudFxcJ1wiLCBcIlxcJ21lXFwnIGluIG93bmVycyBhbmQgbW9kaWZpZWRUaW1lID4gXFwnMjAyNi0wMS0wMVQwMDowMDowMFxcJ1wiLiBSZXR1cm5zIGZpbGUgbWV0YWRhdGEgKGlkLCBuYW1lLCBtaW1lVHlwZSwgbW9kaWZpZWRUaW1lLCBvd25lciwgbGluaykuJyxcbiAgaW5wdXRfc2NoZW1hOiB7XG4gICAgdHlwZTogJ29iamVjdCcsXG4gICAgcHJvcGVydGllczoge1xuICAgICAgdXNlcjogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICdEcml2ZSBvd25lciB0byBpbXBlcnNvbmF0ZSAoZW1haWwpLiBPbWl0IGZvciBkZWZhdWx0LicgfSxcbiAgICAgIHE6IHtcbiAgICAgICAgdHlwZTogJ3N0cmluZycsXG4gICAgICAgIGRlc2NyaXB0aW9uOlxuICAgICAgICAgIFwiRHJpdmUgcXVlcnkuIGUuZy4gXFxcIm5hbWUgY29udGFpbnMgJ3JlcG9ydCcgYW5kIHRyYXNoZWQ9ZmFsc2VcXFwiLiBPbWl0IHRvIGxpc3QgcmVjZW50IGZpbGVzLlwiLFxuICAgICAgfSxcbiAgICAgIG9yZGVyQnk6IHtcbiAgICAgICAgdHlwZTogJ3N0cmluZycsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAnU29ydCwgZS5nLiBcIm1vZGlmaWVkVGltZSBkZXNjXCIsIFwibmFtZVwiLiBEZWZhdWx0IFwibW9kaWZpZWRUaW1lIGRlc2NcIi4nLFxuICAgICAgfSxcbiAgICAgIHBhZ2VTaXplOiB7IHR5cGU6ICdudW1iZXInLCBkZXNjcmlwdGlvbjogYE1heCBmaWxlcyBwZXIgcGFnZSAoMVx1MjAxMyR7TUFYX1JFU1VMVFN9LCBkZWZhdWx0ICR7REVGQVVMVF9SRVNVTFRTfSkuYCB9LFxuICAgICAgcGFnZVRva2VuOiB7XG4gICAgICAgIHR5cGU6ICdzdHJpbmcnLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ1BhZ2UgY3Vyc29yIGZyb20gYSBwcmV2aW91cyBjYWxsXFwncyBcIm5leHRQYWdlVG9rZW5cIiB0byBmZXRjaCB0aGUgbmV4dCBwYWdlLicsXG4gICAgICB9LFxuICAgIH0sXG4gICAgcmVxdWlyZWQ6IFtdLFxuICB9LFxufTtcblxuZXhwb3J0IGNvbnN0IERSSVZFX1NFQVJDSF9QUk9NUFRfRE9DID1cbiAgJ1xcbi0gYGd3X2RyaXZlX3NlYXJjaGA6IFJFQUQtT05MWSBHb29nbGUgRHJpdmUgc2VhcmNoIChEcml2ZSBxdWVyeSBzeW50YXg6IGBuYW1lIGNvbnRhaW5zIFxcJ3hcXCdgLCBgbWltZVR5cGU9XFwnXHUyMDI2XFwnYCwgYG1vZGlmaWVkVGltZSA+IFxcJ1x1MjAyNlxcJ2ApLiBSZXR1cm5zIGZpbGUgbWV0YWRhdGEgKyBpZHM7IHVzZSB0aGUgaWQgd2l0aCBgZ3dfZHJpdmVfZ2V0X2ZpbGVgLCBgZ3dfZG9jX3JlYWRgIG9yIGBnd19zaGVldF9yZWFkYC5cXG4nO1xuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlRHJpdmVTZWFyY2hIYW5kbGVyKGRlcHM6IFRvb2xEZXBzKTogTmF0aXZlVG9vbEhhbmRsZXIge1xuICByZXR1cm4gYXN5bmMgKHJhdzogdW5rbm93bik6IFByb21pc2U8c3RyaW5nPiA9PiB7XG4gICAgY29uc3QgaW5wdXQgPSAocmF3ID8/IHt9KSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICB0cnkge1xuICAgICAgY29uc3Qgc3ViamVjdCA9IHJlc29sdmVTdWJqZWN0KGRlcHMsIGlucHV0LnVzZXIpO1xuICAgICAgY29uc3QgcGFyYW1zID0ge1xuICAgICAgICBxOiBzdHIoaW5wdXQucSksXG4gICAgICAgIG9yZGVyQnk6IHN0cihpbnB1dC5vcmRlckJ5KSA/PyAnbW9kaWZpZWRUaW1lIGRlc2MnLFxuICAgICAgICBwYWdlU2l6ZTogY2xhbXAoaW5wdXQucGFnZVNpemUsIERFRkFVTFRfUkVTVUxUUywgTUFYX1JFU1VMVFMpLFxuICAgICAgICBwYWdlVG9rZW46IHN0cihpbnB1dC5wYWdlVG9rZW4pLFxuICAgICAgfTtcbiAgICAgIGNvbnN0IGtleSA9IGBkcml2ZTpzZWFyY2g6JHtzdWJqZWN0fToke0pTT04uc3RyaW5naWZ5KHBhcmFtcyl9YDtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRlcHMuY2FjaGUuZ2V0T3JTZXQoa2V5LCAoKSA9PiBkZXBzLmNsaWVudC5zZWFyY2hGaWxlcyhzdWJqZWN0LCBwYXJhbXMpKTtcbiAgICAgIGNvbnN0IGZpbGVzID0gKHJlc3VsdC5maWxlcyBhcyB1bmtub3duW10pID8/IFtdO1xuICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KFxuICAgICAgICB7IHN1YmplY3QsIGNvdW50OiBmaWxlcy5sZW5ndGgsIG5leHRQYWdlVG9rZW46IHJlc3VsdC5uZXh0UGFnZVRva2VuLCBmaWxlcyB9LFxuICAgICAgICBudWxsLFxuICAgICAgICAyLFxuICAgICAgKTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIHJldHVybiBmb3JtYXRUb29sRXJyb3IoZXJyKTtcbiAgICB9XG4gIH07XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gZ3dfZHJpdmVfZ2V0X2ZpbGVcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuZXhwb3J0IGNvbnN0IGRyaXZlR2V0RmlsZVNwZWM6IE5hdGl2ZVRvb2xTcGVjID0ge1xuICBuYW1lOiAnZ3dfZHJpdmVfZ2V0X2ZpbGUnLFxuICBkZXNjcmlwdGlvbjpcbiAgICAnR2V0IG1ldGFkYXRhIGZvciBvbmUgR29vZ2xlIERyaXZlIGZpbGUgYnkgaWQgKG5hbWUsIG1pbWVUeXBlLCBvd25lcnMsIHRpbWVzdGFtcHMsIGxpbmssIHNpemUpLiBSRUFELU9OTFkuIEZvciBkb2N1bWVudCB0ZXh0IHVzZSBnd19kb2NfcmVhZDsgZm9yIHNwcmVhZHNoZWV0IHZhbHVlcyB1c2UgZ3dfc2hlZXRfcmVhZC4nLFxuICBpbnB1dF9zY2hlbWE6IHtcbiAgICB0eXBlOiAnb2JqZWN0JyxcbiAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICB1c2VyOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ0RyaXZlIG93bmVyIHRvIGltcGVyc29uYXRlIChlbWFpbCkuIE9taXQgZm9yIGRlZmF1bHQuJyB9LFxuICAgICAgZmlsZUlkOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ0RyaXZlIGZpbGUgaWQgKHJlcXVpcmVkKS4nIH0sXG4gICAgfSxcbiAgICByZXF1aXJlZDogWydmaWxlSWQnXSxcbiAgfSxcbn07XG5cbmV4cG9ydCBjb25zdCBEUklWRV9HRVRfRklMRV9QUk9NUFRfRE9DID1cbiAgJ1xcbi0gYGd3X2RyaXZlX2dldF9maWxlYDogUkVBRC1PTkxZIFx1MjAxNCBtZXRhZGF0YSBmb3Igb25lIERyaXZlIGZpbGUgYnkgYGZpbGVJZGAuIEZvciBEb2MgdGV4dCB1c2UgYGd3X2RvY19yZWFkYDsgZm9yIFNoZWV0IHZhbHVlcyB1c2UgYGd3X3NoZWV0X3JlYWRgLlxcbic7XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVEcml2ZUdldEZpbGVIYW5kbGVyKGRlcHM6IFRvb2xEZXBzKTogTmF0aXZlVG9vbEhhbmRsZXIge1xuICByZXR1cm4gYXN5bmMgKHJhdzogdW5rbm93bik6IFByb21pc2U8c3RyaW5nPiA9PiB7XG4gICAgY29uc3QgaW5wdXQgPSAocmF3ID8/IHt9KSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICB0cnkge1xuICAgICAgY29uc3Qgc3ViamVjdCA9IHJlc29sdmVTdWJqZWN0KGRlcHMsIGlucHV0LnVzZXIpO1xuICAgICAgY29uc3QgZmlsZUlkID0gc3RyKGlucHV0LmZpbGVJZCk7XG4gICAgICBpZiAoIWZpbGVJZCkgdGhyb3cgbmV3IEdvb2dsZUlucHV0RXJyb3IoJ1wiZmlsZUlkXCIgaXMgcmVxdWlyZWQuJyk7XG4gICAgICBjb25zdCBrZXkgPSBgZHJpdmU6ZmlsZToke3N1YmplY3R9OiR7ZmlsZUlkfWA7XG4gICAgICBjb25zdCBmaWxlID0gYXdhaXQgZGVwcy5jYWNoZS5nZXRPclNldChrZXksICgpID0+IGRlcHMuY2xpZW50LmdldEZpbGUoc3ViamVjdCwgZmlsZUlkKSk7XG4gICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoeyBzdWJqZWN0LCBmaWxlIH0sIG51bGwsIDIpO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgcmV0dXJuIGZvcm1hdFRvb2xFcnJvcihlcnIpO1xuICAgIH1cbiAgfTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBnd19kb2NfcmVhZFxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5leHBvcnQgY29uc3QgZG9jUmVhZFNwZWM6IE5hdGl2ZVRvb2xTcGVjID0ge1xuICBuYW1lOiAnZ3dfZG9jX3JlYWQnLFxuICBkZXNjcmlwdGlvbjpcbiAgICBcIlJlYWQgYSBHb29nbGUgRG9jJ3MgdGV4dCBjb250ZW50IGJ5IGRvY3VtZW50IGlkLiBSRUFELU9OTFkuIFJldHVybnMgdGhlIHRpdGxlIGFuZCB0aGUgZmxhdHRlbmVkIHBsYWluIHRleHQgb2YgdGhlIGJvZHkgKGNhcHBlZCkuIFVzZSBnd19kcml2ZV9zZWFyY2ggdG8gZmluZCB0aGUgZG9jdW1lbnQgaWQuXCIsXG4gIGlucHV0X3NjaGVtYToge1xuICAgIHR5cGU6ICdvYmplY3QnLFxuICAgIHByb3BlcnRpZXM6IHtcbiAgICAgIHVzZXI6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAnT3duZXIgdG8gaW1wZXJzb25hdGUgKGVtYWlsKS4gT21pdCBmb3IgZGVmYXVsdC4nIH0sXG4gICAgICBkb2N1bWVudElkOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ0dvb2dsZSBEb2MgaWQgKHJlcXVpcmVkKS4nIH0sXG4gICAgfSxcbiAgICByZXF1aXJlZDogWydkb2N1bWVudElkJ10sXG4gIH0sXG59O1xuXG5leHBvcnQgY29uc3QgRE9DX1JFQURfUFJPTVBUX0RPQyA9XG4gICdcXG4tIGBnd19kb2NfcmVhZGA6IFJFQUQtT05MWSBcdTIwMTQgZmxhdHRlbiBhIEdvb2dsZSBEb2MgdG8gcGxhaW4gdGV4dCBieSBgZG9jdW1lbnRJZGAgKGZpbmQgaXQgdmlhIGBnd19kcml2ZV9zZWFyY2hgKS5cXG4nO1xuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlRG9jUmVhZEhhbmRsZXIoZGVwczogVG9vbERlcHMpOiBOYXRpdmVUb29sSGFuZGxlciB7XG4gIHJldHVybiBhc3luYyAocmF3OiB1bmtub3duKTogUHJvbWlzZTxzdHJpbmc+ID0+IHtcbiAgICBjb25zdCBpbnB1dCA9IChyYXcgPz8ge30pIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBzdWJqZWN0ID0gcmVzb2x2ZVN1YmplY3QoZGVwcywgaW5wdXQudXNlcik7XG4gICAgICBjb25zdCBkb2N1bWVudElkID0gc3RyKGlucHV0LmRvY3VtZW50SWQpO1xuICAgICAgaWYgKCFkb2N1bWVudElkKSB0aHJvdyBuZXcgR29vZ2xlSW5wdXRFcnJvcignXCJkb2N1bWVudElkXCIgaXMgcmVxdWlyZWQuJyk7XG4gICAgICBjb25zdCBrZXkgPSBgZG9jczpyZWFkOiR7c3ViamVjdH06JHtkb2N1bWVudElkfWA7XG4gICAgICBjb25zdCBkb2MgPSBhd2FpdCBkZXBzLmNhY2hlLmdldE9yU2V0KGtleSwgKCkgPT4gZGVwcy5jbGllbnQuZ2V0RG9jdW1lbnQoc3ViamVjdCwgZG9jdW1lbnRJZCkpO1xuICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KFxuICAgICAgICB7XG4gICAgICAgICAgc3ViamVjdCxcbiAgICAgICAgICBkb2N1bWVudElkLFxuICAgICAgICAgIHRpdGxlOiBkb2MudGl0bGUsXG4gICAgICAgICAgdGV4dDogZmxhdHRlbkRvY1RleHQoZG9jKS5zbGljZSgwLCA0MF8wMDApLFxuICAgICAgICB9LFxuICAgICAgICBudWxsLFxuICAgICAgICAyLFxuICAgICAgKTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIHJldHVybiBmb3JtYXRUb29sRXJyb3IoZXJyKTtcbiAgICB9XG4gIH07XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gZ3dfc2hlZXRfcmVhZFxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5leHBvcnQgY29uc3Qgc2hlZXRSZWFkU3BlYzogTmF0aXZlVG9vbFNwZWMgPSB7XG4gIG5hbWU6ICdnd19zaGVldF9yZWFkJyxcbiAgZGVzY3JpcHRpb246XG4gICAgJ1JlYWQgY2VsbCB2YWx1ZXMgZnJvbSBhIEdvb2dsZSBTaGVldHMgcmFuZ2UgKEExIG5vdGF0aW9uLCBlLmcuIFwiU2hlZXQxIUExOkQ1MFwiKS4gUkVBRC1PTkxZLiBSZXR1cm5zIGEgMkQgYXJyYXkgb2YgdmFsdWVzLicsXG4gIGlucHV0X3NjaGVtYToge1xuICAgIHR5cGU6ICdvYmplY3QnLFxuICAgIHByb3BlcnRpZXM6IHtcbiAgICAgIHVzZXI6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAnT3duZXIgdG8gaW1wZXJzb25hdGUgKGVtYWlsKS4gT21pdCBmb3IgZGVmYXVsdC4nIH0sXG4gICAgICBzcHJlYWRzaGVldElkOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ0dvb2dsZSBTaGVldHMgaWQgKHJlcXVpcmVkKS4nIH0sXG4gICAgICByYW5nZToge1xuICAgICAgICB0eXBlOiAnc3RyaW5nJyxcbiAgICAgICAgZGVzY3JpcHRpb246ICdBMSByYW5nZSwgZS5nLiBcIlNoZWV0MSFBMTpENTBcIiBvciBcIkE6Q1wiLiBSZXF1aXJlZC4nLFxuICAgICAgfSxcbiAgICB9LFxuICAgIHJlcXVpcmVkOiBbJ3NwcmVhZHNoZWV0SWQnLCAncmFuZ2UnXSxcbiAgfSxcbn07XG5cbmV4cG9ydCBjb25zdCBTSEVFVF9SRUFEX1BST01QVF9ET0MgPVxuICAnXFxuLSBgZ3dfc2hlZXRfcmVhZGA6IFJFQUQtT05MWSBcdTIwMTQgcmVhZCBhIEdvb2dsZSBTaGVldHMgcmFuZ2UgaW4gQTEgbm90YXRpb24gKGUuZy4gYFNoZWV0MSFBMTpENTBgKSBpbnRvIGEgMkQgYXJyYXkuXFxuJztcblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVNoZWV0UmVhZEhhbmRsZXIoZGVwczogVG9vbERlcHMpOiBOYXRpdmVUb29sSGFuZGxlciB7XG4gIHJldHVybiBhc3luYyAocmF3OiB1bmtub3duKTogUHJvbWlzZTxzdHJpbmc+ID0+IHtcbiAgICBjb25zdCBpbnB1dCA9IChyYXcgPz8ge30pIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBzdWJqZWN0ID0gcmVzb2x2ZVN1YmplY3QoZGVwcywgaW5wdXQudXNlcik7XG4gICAgICBjb25zdCBzcHJlYWRzaGVldElkID0gc3RyKGlucHV0LnNwcmVhZHNoZWV0SWQpO1xuICAgICAgY29uc3QgcmFuZ2UgPSBzdHIoaW5wdXQucmFuZ2UpO1xuICAgICAgaWYgKCFzcHJlYWRzaGVldElkKSB0aHJvdyBuZXcgR29vZ2xlSW5wdXRFcnJvcignXCJzcHJlYWRzaGVldElkXCIgaXMgcmVxdWlyZWQuJyk7XG4gICAgICBpZiAoIXJhbmdlKSB0aHJvdyBuZXcgR29vZ2xlSW5wdXRFcnJvcignXCJyYW5nZVwiIChBMSBub3RhdGlvbikgaXMgcmVxdWlyZWQuJyk7XG4gICAgICBjb25zdCBrZXkgPSBgc2hlZXRzOnJlYWQ6JHtzdWJqZWN0fToke3NwcmVhZHNoZWV0SWR9OiR7cmFuZ2V9YDtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRlcHMuY2FjaGUuZ2V0T3JTZXQoa2V5LCAoKSA9PlxuICAgICAgICBkZXBzLmNsaWVudC5nZXRTaGVldFZhbHVlcyhzdWJqZWN0LCBzcHJlYWRzaGVldElkLCByYW5nZSksXG4gICAgICApO1xuICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KFxuICAgICAgICB7IHN1YmplY3QsIHNwcmVhZHNoZWV0SWQsIHJhbmdlOiByZXN1bHQucmFuZ2UsIHZhbHVlczogcmVzdWx0LnZhbHVlcyA/PyBbXSB9LFxuICAgICAgICBudWxsLFxuICAgICAgICAyLFxuICAgICAgKTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIHJldHVybiBmb3JtYXRUb29sRXJyb3IoZXJyKTtcbiAgICB9XG4gIH07XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gZ3dfc2hlZXRfd3JpdGUgKHdyaXRlKVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5leHBvcnQgY29uc3Qgc2hlZXRXcml0ZVNwZWM6IE5hdGl2ZVRvb2xTcGVjID0ge1xuICBuYW1lOiAnZ3dfc2hlZXRfd3JpdGUnLFxuICBkZXNjcmlwdGlvbjpcbiAgICAnV3JpdGUgY2VsbCB2YWx1ZXMgaW50byBhIEdvb2dsZSBTaGVldHMgcmFuZ2UgKEExIG5vdGF0aW9uKS4gV1JJVEUgXHUyMDE0IG9ubHkgY2FsbCBhZnRlciB0aGUgdXNlciBjb25maXJtcyB0aGUgdGFyZ2V0IHNoZWV0LCByYW5nZSBhbmQgZGF0YS4gbW9kZSBcIm92ZXJ3cml0ZVwiIChkZWZhdWx0KSByZXBsYWNlcyB0aGUgcmFuZ2U7IG1vZGUgXCJhcHBlbmRcIiBhZGRzIHJvd3MgYWZ0ZXIgdGhlIGV4aXN0aW5nIHRhYmxlLiBWYWx1ZXMgYXJlIGEgMkQgYXJyYXkgKHJvd3Mgb2YgY2VsbHMpLicsXG4gIGlucHV0X3NjaGVtYToge1xuICAgIHR5cGU6ICdvYmplY3QnLFxuICAgIHByb3BlcnRpZXM6IHtcbiAgICAgIHVzZXI6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAnT3duZXIgdG8gaW1wZXJzb25hdGUgKGVtYWlsKS4gT21pdCBmb3IgZGVmYXVsdC4nIH0sXG4gICAgICBzcHJlYWRzaGVldElkOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ0dvb2dsZSBTaGVldHMgaWQgKHJlcXVpcmVkKS4nIH0sXG4gICAgICByYW5nZToge1xuICAgICAgICB0eXBlOiAnc3RyaW5nJyxcbiAgICAgICAgZGVzY3JpcHRpb246ICdBMSByYW5nZSwgZS5nLiBcIlNoZWV0MSFBMTpDM1wiIChvdmVyd3JpdGUpIG9yIFwiU2hlZXQxIUExXCIgKGFwcGVuZCBhbmNob3IpLiBSZXF1aXJlZC4nLFxuICAgICAgfSxcbiAgICAgIHZhbHVlczoge1xuICAgICAgICB0eXBlOiAnYXJyYXknLFxuICAgICAgICBpdGVtczogeyB0eXBlOiAnYXJyYXknLCBpdGVtczoge30gfSxcbiAgICAgICAgZGVzY3JpcHRpb246ICdSb3dzIG9mIGNlbGwgdmFsdWVzLCBlLmcuIFtbXCJOYW1lXCIsXCJUb3RhbFwiXSxbXCJBY21lXCIsNDJdXS4gUmVxdWlyZWQuJyxcbiAgICAgIH0sXG4gICAgICBtb2RlOiB7XG4gICAgICAgIHR5cGU6ICdzdHJpbmcnLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ1wib3ZlcndyaXRlXCIgKGRlZmF1bHQsIHJlcGxhY2VzIHRoZSByYW5nZSkgb3IgXCJhcHBlbmRcIiAoYWRkcyByb3dzIGFmdGVyIHRoZSB0YWJsZSkuJyxcbiAgICAgIH0sXG4gICAgICB2YWx1ZUlucHV0T3B0aW9uOiB7XG4gICAgICAgIHR5cGU6ICdzdHJpbmcnLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ1wiVVNFUl9FTlRFUkVEXCIgKGRlZmF1bHQsIHBhcnNlcyBmb3JtdWxhcy9kYXRlcykgb3IgXCJSQVdcIiAoc3RvcmUgbGl0ZXJhbGx5KS4nLFxuICAgICAgfSxcbiAgICB9LFxuICAgIHJlcXVpcmVkOiBbJ3NwcmVhZHNoZWV0SWQnLCAncmFuZ2UnLCAndmFsdWVzJ10sXG4gIH0sXG59O1xuXG5leHBvcnQgY29uc3QgU0hFRVRfV1JJVEVfUFJPTVBUX0RPQyA9XG4gICdcXG4tIGBnd19zaGVldF93cml0ZWA6IFdSSVRFIFx1MjAxNCB3cml0ZSBhIDJEIGB2YWx1ZXNgIGFycmF5IGludG8gYSBHb29nbGUgU2hlZXRzIGByYW5nZWAgKEExKS4gYG1vZGU6XCJvdmVyd3JpdGVcImAgcmVwbGFjZXMgdGhlIHJhbmdlLCBgbW9kZTpcImFwcGVuZFwiYCBhZGRzIHJvd3MgYWZ0ZXIgdGhlIHRhYmxlLiBDb25maXJtIHRoZSB0YXJnZXQgd2l0aCB0aGUgdXNlciBmaXJzdC5cXG4nO1xuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlU2hlZXRXcml0ZUhhbmRsZXIoZGVwczogVG9vbERlcHMpOiBOYXRpdmVUb29sSGFuZGxlciB7XG4gIHJldHVybiBhc3luYyAocmF3OiB1bmtub3duKTogUHJvbWlzZTxzdHJpbmc+ID0+IHtcbiAgICBjb25zdCBpbnB1dCA9IChyYXcgPz8ge30pIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBzdWJqZWN0ID0gcmVzb2x2ZVN1YmplY3QoZGVwcywgaW5wdXQudXNlcik7XG4gICAgICBjb25zdCBzcHJlYWRzaGVldElkID0gc3RyKGlucHV0LnNwcmVhZHNoZWV0SWQpO1xuICAgICAgY29uc3QgcmFuZ2UgPSBzdHIoaW5wdXQucmFuZ2UpO1xuICAgICAgaWYgKCFzcHJlYWRzaGVldElkKSB0aHJvdyBuZXcgR29vZ2xlSW5wdXRFcnJvcignXCJzcHJlYWRzaGVldElkXCIgaXMgcmVxdWlyZWQuJyk7XG4gICAgICBpZiAoIXJhbmdlKSB0aHJvdyBuZXcgR29vZ2xlSW5wdXRFcnJvcignXCJyYW5nZVwiIChBMSBub3RhdGlvbikgaXMgcmVxdWlyZWQuJyk7XG4gICAgICBpZiAoIUFycmF5LmlzQXJyYXkoaW5wdXQudmFsdWVzKSB8fCAhaW5wdXQudmFsdWVzLmV2ZXJ5KChyKSA9PiBBcnJheS5pc0FycmF5KHIpKSkge1xuICAgICAgICB0aHJvdyBuZXcgR29vZ2xlSW5wdXRFcnJvcignXCJ2YWx1ZXNcIiBtdXN0IGJlIGEgMkQgYXJyYXkgKHJvd3Mgb2YgY2VsbHMpLicpO1xuICAgICAgfVxuICAgICAgY29uc3QgbW9kZSA9IHN0cihpbnB1dC5tb2RlKSA9PT0gJ2FwcGVuZCcgPyAnYXBwZW5kJyA6ICdvdmVyd3JpdGUnO1xuICAgICAgY29uc3QgdmFsdWVJbnB1dE9wdGlvbiA9IHN0cihpbnB1dC52YWx1ZUlucHV0T3B0aW9uKSA9PT0gJ1JBVycgPyAnUkFXJyA6ICdVU0VSX0VOVEVSRUQnO1xuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZGVwcy5jbGllbnQud3JpdGVTaGVldFZhbHVlcyhcbiAgICAgICAgc3ViamVjdCxcbiAgICAgICAgc3ByZWFkc2hlZXRJZCxcbiAgICAgICAgcmFuZ2UsXG4gICAgICAgIGlucHV0LnZhbHVlcyBhcyB1bmtub3duW11bXSxcbiAgICAgICAgeyBtb2RlLCB2YWx1ZUlucHV0T3B0aW9uIH0sXG4gICAgICApO1xuICAgICAgZGVwcy5jYWNoZS5jbGVhcigpO1xuICAgICAgLy8gYHVwZGF0ZWAgcmV0dXJucyB1cGRhdGVkKiBhdCB0aGUgdG9wIGxldmVsOyBgYXBwZW5kYCBuZXN0cyB0aGVtIHVuZGVyIGB1cGRhdGVzYC5cbiAgICAgIGNvbnN0IHVwZGF0ZXMgPSAocmVzdWx0LnVwZGF0ZXMgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID8/IHJlc3VsdDtcbiAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeShcbiAgICAgICAge1xuICAgICAgICAgIHdyaXR0ZW46IHRydWUsXG4gICAgICAgICAgbW9kZSxcbiAgICAgICAgICBzcHJlYWRzaGVldElkLFxuICAgICAgICAgIHVwZGF0ZWRSYW5nZTogdXBkYXRlcy51cGRhdGVkUmFuZ2UsXG4gICAgICAgICAgdXBkYXRlZFJvd3M6IHVwZGF0ZXMudXBkYXRlZFJvd3MsXG4gICAgICAgICAgdXBkYXRlZENlbGxzOiB1cGRhdGVzLnVwZGF0ZWRDZWxscyxcbiAgICAgICAgfSxcbiAgICAgICAgbnVsbCxcbiAgICAgICAgMixcbiAgICAgICk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICByZXR1cm4gZm9ybWF0VG9vbEVycm9yKGVycik7XG4gICAgfVxuICB9O1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIGd3X2RyaXZlX2NyZWF0ZSAod3JpdGUpXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbmNvbnN0IERSSVZFX1RZUEVfTUlNRTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgZm9sZGVyOiAnYXBwbGljYXRpb24vdm5kLmdvb2dsZS1hcHBzLmZvbGRlcicsXG4gIGRvY3VtZW50OiAnYXBwbGljYXRpb24vdm5kLmdvb2dsZS1hcHBzLmRvY3VtZW50JyxcbiAgc3ByZWFkc2hlZXQ6ICdhcHBsaWNhdGlvbi92bmQuZ29vZ2xlLWFwcHMuc3ByZWFkc2hlZXQnLFxuICBwcmVzZW50YXRpb246ICdhcHBsaWNhdGlvbi92bmQuZ29vZ2xlLWFwcHMucHJlc2VudGF0aW9uJyxcbiAgZmlsZTogJ3RleHQvcGxhaW4nLFxufTtcblxuZXhwb3J0IGNvbnN0IGRyaXZlQ3JlYXRlU3BlYzogTmF0aXZlVG9vbFNwZWMgPSB7XG4gIG5hbWU6ICdnd19kcml2ZV9jcmVhdGUnLFxuICBkZXNjcmlwdGlvbjpcbiAgICAnQ3JlYXRlIGEgR29vZ2xlIERyaXZlIGl0ZW0uIFdSSVRFIFx1MjAxNCBvbmx5IGNhbGwgYWZ0ZXIgdGhlIHVzZXIgY29uZmlybXMuIFwidHlwZVwiOiBmb2xkZXIgfCBkb2N1bWVudCB8IHNwcmVhZHNoZWV0IHwgcHJlc2VudGF0aW9uIHwgZmlsZSAoZGVmYXVsdCBmb2xkZXIpLiBPcHRpb25hbCBcInBhcmVudElkXCIgcGxhY2VzIGl0IGluIGEgZm9sZGVyLCBcImNvbnRlbnRcIiBmaWxscyBhIHRleHQvZG9jdW1lbnQgYm9keSwgXCJtaW1lVHlwZVwiIG92ZXJyaWRlcyB0aGUgdHlwZS4gUmV0dXJucyB0aGUgbmV3IGl0ZW0gaWQgKyBsaW5rLicsXG4gIGlucHV0X3NjaGVtYToge1xuICAgIHR5cGU6ICdvYmplY3QnLFxuICAgIHByb3BlcnRpZXM6IHtcbiAgICAgIHVzZXI6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAnT3duZXIgdG8gaW1wZXJzb25hdGUgKGVtYWlsKS4gT21pdCBmb3IgZGVmYXVsdC4nIH0sXG4gICAgICBuYW1lOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ05hbWUvdGl0bGUgb2YgdGhlIG5ldyBpdGVtIChyZXF1aXJlZCkuJyB9LFxuICAgICAgdHlwZToge1xuICAgICAgICB0eXBlOiAnc3RyaW5nJyxcbiAgICAgICAgZGVzY3JpcHRpb246ICdmb2xkZXIgfCBkb2N1bWVudCB8IHNwcmVhZHNoZWV0IHwgcHJlc2VudGF0aW9uIHwgZmlsZS4gRGVmYXVsdCBmb2xkZXIuJyxcbiAgICAgIH0sXG4gICAgICBwYXJlbnRJZDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICdJZCBvZiB0aGUgcGFyZW50IGZvbGRlci4gT21pdCBmb3IgdGhlIGRyaXZlIHJvb3QuJyB9LFxuICAgICAgY29udGVudDoge1xuICAgICAgICB0eXBlOiAnc3RyaW5nJyxcbiAgICAgICAgZGVzY3JpcHRpb246ICdPcHRpb25hbCB0ZXh0IGNvbnRlbnQuIEZvciBcImZpbGVcIiBpdCBiZWNvbWVzIHRoZSBib2R5OyBmb3IgXCJkb2N1bWVudFwiIGl0IGlzIGltcG9ydGVkIGFzIHRoZSBkb2MgdGV4dC4nLFxuICAgICAgfSxcbiAgICAgIG1pbWVUeXBlOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ0FkdmFuY2VkOiBleHBsaWNpdCBNSU1FIHR5cGUsIG92ZXJyaWRlcyBcInR5cGVcIi4nIH0sXG4gICAgfSxcbiAgICByZXF1aXJlZDogWyduYW1lJ10sXG4gIH0sXG59O1xuXG5leHBvcnQgY29uc3QgRFJJVkVfQ1JFQVRFX1BST01QVF9ET0MgPVxuICAnXFxuLSBgZ3dfZHJpdmVfY3JlYXRlYDogV1JJVEUgXHUyMDE0IGNyZWF0ZSBhIERyaXZlIGl0ZW0gYnkgYG5hbWVgIGFuZCBgdHlwZWAgKGZvbGRlciB8IGRvY3VtZW50IHwgc3ByZWFkc2hlZXQgfCBwcmVzZW50YXRpb24gfCBmaWxlKS4gT3B0aW9uYWwgYHBhcmVudElkYCAoZm9sZGVyKSBhbmQgYGNvbnRlbnRgICh0ZXh0IGJvZHkgLyBkb2MgaW1wb3J0KS4gQ29uZmlybSB3aXRoIHRoZSB1c2VyIGZpcnN0Llxcbic7XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVEcml2ZUNyZWF0ZUhhbmRsZXIoZGVwczogVG9vbERlcHMpOiBOYXRpdmVUb29sSGFuZGxlciB7XG4gIHJldHVybiBhc3luYyAocmF3OiB1bmtub3duKTogUHJvbWlzZTxzdHJpbmc+ID0+IHtcbiAgICBjb25zdCBpbnB1dCA9IChyYXcgPz8ge30pIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBzdWJqZWN0ID0gcmVzb2x2ZVN1YmplY3QoZGVwcywgaW5wdXQudXNlcik7XG4gICAgICBjb25zdCBuYW1lID0gc3RyKGlucHV0Lm5hbWUpO1xuICAgICAgaWYgKCFuYW1lKSB0aHJvdyBuZXcgR29vZ2xlSW5wdXRFcnJvcignXCJuYW1lXCIgaXMgcmVxdWlyZWQuJyk7XG4gICAgICBjb25zdCB0eXBlID0gKHN0cihpbnB1dC50eXBlKSA/PyAnZm9sZGVyJykudG9Mb3dlckNhc2UoKTtcbiAgICAgIGNvbnN0IG1pbWVUeXBlID0gc3RyKGlucHV0Lm1pbWVUeXBlKSA/PyBEUklWRV9UWVBFX01JTUVbdHlwZV07XG4gICAgICBpZiAoIW1pbWVUeXBlKSB7XG4gICAgICAgIHRocm93IG5ldyBHb29nbGVJbnB1dEVycm9yKFxuICAgICAgICAgIGB1bmtub3duIFwidHlwZVwiOiAke3R5cGV9LiBVc2UgZm9sZGVyIHwgZG9jdW1lbnQgfCBzcHJlYWRzaGVldCB8IHByZXNlbnRhdGlvbiB8IGZpbGUsIG9yIHBhc3MgXCJtaW1lVHlwZVwiLmAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBjb25zdCBjb250ZW50ID0gdHlwZW9mIGlucHV0LmNvbnRlbnQgPT09ICdzdHJpbmcnID8gaW5wdXQuY29udGVudCA6IHVuZGVmaW5lZDtcbiAgICAgIGlmIChjb250ZW50ICE9PSB1bmRlZmluZWQgJiYgdHlwZSA9PT0gJ2ZvbGRlcicpIHtcbiAgICAgICAgdGhyb3cgbmV3IEdvb2dsZUlucHV0RXJyb3IoJ2EgZm9sZGVyIGNhbm5vdCBoYXZlIFwiY29udGVudFwiLicpO1xuICAgICAgfVxuICAgICAgY29uc3QgcGFyZW50cyA9IHN0cihpbnB1dC5wYXJlbnRJZCkgPyBbc3RyKGlucHV0LnBhcmVudElkKSBhcyBzdHJpbmddIDogdW5kZWZpbmVkO1xuICAgICAgY29uc3QgZmlsZSA9IGF3YWl0IGRlcHMuY2xpZW50LmNyZWF0ZURyaXZlRmlsZShzdWJqZWN0LCB7IG5hbWUsIG1pbWVUeXBlLCBwYXJlbnRzLCBjb250ZW50IH0pO1xuICAgICAgZGVwcy5jYWNoZS5jbGVhcigpO1xuICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KFxuICAgICAgICB7IGNyZWF0ZWQ6IHRydWUsIGlkOiBmaWxlLmlkLCBuYW1lOiBmaWxlLm5hbWUsIG1pbWVUeXBlOiBmaWxlLm1pbWVUeXBlLCB3ZWJWaWV3TGluazogZmlsZS53ZWJWaWV3TGluayB9LFxuICAgICAgICBudWxsLFxuICAgICAgICAyLFxuICAgICAgKTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIHJldHVybiBmb3JtYXRUb29sRXJyb3IoZXJyKTtcbiAgICB9XG4gIH07XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gSGVscGVycyBcdTIwMTQgZmxhdHRlbiBhIERvY3MgZG9jdW1lbnQgaW50byBwbGFpbiB0ZXh0LlxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5pbnRlcmZhY2UgRG9jc1RleHRSdW4ge1xuICBjb250ZW50Pzogc3RyaW5nO1xufVxuaW50ZXJmYWNlIERvY3NQYXJhZ3JhcGhFbGVtZW50IHtcbiAgdGV4dFJ1bj86IERvY3NUZXh0UnVuO1xufVxuaW50ZXJmYWNlIERvY3NQYXJhZ3JhcGgge1xuICBlbGVtZW50cz86IERvY3NQYXJhZ3JhcGhFbGVtZW50W107XG59XG5pbnRlcmZhY2UgRG9jc1N0cnVjdHVyYWxFbGVtZW50IHtcbiAgcGFyYWdyYXBoPzogRG9jc1BhcmFncmFwaDtcbiAgdGFibGU/OiB7IHRhYmxlUm93cz86IHsgdGFibGVDZWxscz86IHsgY29udGVudD86IERvY3NTdHJ1Y3R1cmFsRWxlbWVudFtdIH1bXSB9W10gfTtcbn1cblxuZnVuY3Rpb24gZmxhdHRlbkRvY1RleHQoZG9jOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IHN0cmluZyB7XG4gIGNvbnN0IGJvZHkgPSBkb2MuYm9keSBhcyB7IGNvbnRlbnQ/OiBEb2NzU3RydWN0dXJhbEVsZW1lbnRbXSB9IHwgdW5kZWZpbmVkO1xuICBpZiAoIWJvZHk/LmNvbnRlbnQpIHJldHVybiAnJztcbiAgY29uc3Qgb3V0OiBzdHJpbmdbXSA9IFtdO1xuICBjb2xsZWN0RG9jVGV4dChib2R5LmNvbnRlbnQsIG91dCk7XG4gIHJldHVybiBvdXQuam9pbignJykucmVwbGFjZSgvXFxuezMsfS9nLCAnXFxuXFxuJykudHJpbSgpO1xufVxuXG5mdW5jdGlvbiBjb2xsZWN0RG9jVGV4dChjb250ZW50OiBEb2NzU3RydWN0dXJhbEVsZW1lbnRbXSwgb3V0OiBzdHJpbmdbXSk6IHZvaWQge1xuICBmb3IgKGNvbnN0IGVsIG9mIGNvbnRlbnQpIHtcbiAgICBpZiAoZWwucGFyYWdyYXBoPy5lbGVtZW50cykge1xuICAgICAgZm9yIChjb25zdCBwZSBvZiBlbC5wYXJhZ3JhcGguZWxlbWVudHMpIHtcbiAgICAgICAgaWYgKHBlLnRleHRSdW4/LmNvbnRlbnQpIG91dC5wdXNoKHBlLnRleHRSdW4uY29udGVudCk7XG4gICAgICB9XG4gICAgfVxuICAgIGlmIChlbC50YWJsZT8udGFibGVSb3dzKSB7XG4gICAgICBmb3IgKGNvbnN0IHJvdyBvZiBlbC50YWJsZS50YWJsZVJvd3MpIHtcbiAgICAgICAgZm9yIChjb25zdCBjZWxsIG9mIHJvdy50YWJsZUNlbGxzID8/IFtdKSB7XG4gICAgICAgICAgaWYgKGNlbGwuY29udGVudCkgY29sbGVjdERvY1RleHQoY2VsbC5jb250ZW50LCBvdXQpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG59XG4iLCAiLyoqXG4gKiBUZXN0IGhlbHBlcnMgXHUyMDE0IGZha2UgYXV0aCwgYSBzY3JpcHRlZCBmZXRjaCwgYW5kIGEgSlNPTiBSZXNwb25zZSBidWlsZGVyLlxuICogTm8gbmV0d29yaywgbm8gcmVhbCBjcmVkZW50aWFscy5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IEdvb2dsZVNlcnZpY2VBY2NvdW50QXV0aCB9IGZyb20gJy4uL3NyYy9nb29nbGVBdXRoLmpzJztcblxuZXhwb3J0IGZ1bmN0aW9uIGZha2VBdXRoKCk6IHtcbiAgYXV0aDogR29vZ2xlU2VydmljZUFjY291bnRBdXRoO1xuICBzdGF0czogKCkgPT4geyB0b2tlbkNhbGxzOiBudW1iZXI7IGludmFsaWRhdGlvbnM6IG51bWJlciB9O1xufSB7XG4gIGxldCB0b2tlbkNhbGxzID0gMDtcbiAgbGV0IGludmFsaWRhdGlvbnMgPSAwO1xuICBjb25zdCBhdXRoID0ge1xuICAgIGdldFRva2VuOiBhc3luYyAoKSA9PiB7XG4gICAgICB0b2tlbkNhbGxzICs9IDE7XG4gICAgICByZXR1cm4gYHRvay0ke3Rva2VuQ2FsbHN9YDtcbiAgICB9LFxuICAgIGludmFsaWRhdGU6ICgpID0+IHtcbiAgICAgIGludmFsaWRhdGlvbnMgKz0gMTtcbiAgICB9LFxuICB9O1xuICByZXR1cm4ge1xuICAgIGF1dGg6IGF1dGggYXMgdW5rbm93biBhcyBHb29nbGVTZXJ2aWNlQWNjb3VudEF1dGgsXG4gICAgc3RhdHM6ICgpID0+ICh7IHRva2VuQ2FsbHMsIGludmFsaWRhdGlvbnMgfSksXG4gIH07XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQ2FwdHVyZWQge1xuICB1cmw6IHN0cmluZztcbiAgaW5pdDogeyBtZXRob2Q/OiBzdHJpbmc7IGhlYWRlcnM/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+OyBib2R5Pzogc3RyaW5nIH07XG59XG5cbi8qKlxuICogQSBmZXRjaCBzdHViIGRyaXZlbiBieSBhbiBhcnJheSBvZiBzdGVwIGZ1bmN0aW9ucy4gQ2FsbCBOIHVzZXMgc3RlcCBOICh0aGVcbiAqIGxhc3Qgc3RlcCByZXBlYXRzIGZvciBhbnkgZnVydGhlciBjYWxscykuIFJlY29yZHMgZXZlcnkgY2FsbC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNjcmlwdGVkRmV0Y2goc3RlcHM6IEFycmF5PChjOiBDYXB0dXJlZCkgPT4gUmVzcG9uc2U+KToge1xuICBmZXRjaEltcGw6IHR5cGVvZiBmZXRjaDtcbiAgY2FsbHM6IENhcHR1cmVkW107XG59IHtcbiAgY29uc3QgY2FsbHM6IENhcHR1cmVkW10gPSBbXTtcbiAgbGV0IGkgPSAwO1xuICBjb25zdCBmZXRjaEltcGwgPSAoYXN5bmMgKHVybDogc3RyaW5nLCBpbml0OiBDYXB0dXJlZFsnaW5pdCddKSA9PiB7XG4gICAgY29uc3QgYzogQ2FwdHVyZWQgPSB7IHVybCwgaW5pdDogaW5pdCA/PyB7fSB9O1xuICAgIGNhbGxzLnB1c2goYyk7XG4gICAgY29uc3Qgc3RlcCA9IHN0ZXBzW01hdGgubWluKGksIHN0ZXBzLmxlbmd0aCAtIDEpXTtcbiAgICBpICs9IDE7XG4gICAgcmV0dXJuIHN0ZXAoYyk7XG4gIH0pIGFzIHVua25vd24gYXMgdHlwZW9mIGZldGNoO1xuICByZXR1cm4geyBmZXRjaEltcGwsIGNhbGxzIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBqc29uKG9iajogdW5rbm93biwgc3RhdHVzID0gMjAwKTogUmVzcG9uc2Uge1xuICByZXR1cm4gbmV3IFJlc3BvbnNlKEpTT04uc3RyaW5naWZ5KG9iaiksIHtcbiAgICBzdGF0dXMsXG4gICAgaGVhZGVyczogeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nIH0sXG4gIH0pO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIjtBQUFBLE9BQU8sVUFBVTtBQUNqQixPQUFPLFlBQVk7OztBQ01aLElBQU0sa0JBQU4sY0FBOEIsTUFBTTtBQUFBLEVBQ3pDLFlBQVksU0FBaUI7QUFDM0IsVUFBTSxPQUFPO0FBQ2IsU0FBSyxPQUFPO0FBQUEsRUFDZDtBQUNGO0FBR08sSUFBTSxpQkFBTixjQUE2QixNQUFNO0FBQUEsRUFDeEMsWUFDa0IsUUFDQSxRQUNoQixTQUNBO0FBQ0EsVUFBTSxPQUFPO0FBSkc7QUFDQTtBQUloQixTQUFLLE9BQU87QUFBQSxFQUNkO0FBQ0Y7QUFHTyxJQUFNLG1CQUFOLGNBQStCLE1BQU07QUFBQSxFQUMxQyxZQUFZLFNBQWlCO0FBQzNCLFVBQU0sT0FBTztBQUNiLFNBQUssT0FBTztBQUFBLEVBQ2Q7QUFDRjtBQU1PLFNBQVMsZ0JBQWdCLEtBQXNCO0FBQ3BELE1BQUksZUFBZSxpQkFBaUI7QUFDbEMsV0FBTyx3REFBbUQsSUFBSSxPQUFPO0FBQUEsRUFDdkU7QUFDQSxNQUFJLGVBQWUsZ0JBQWdCO0FBQ2pDLFVBQU0sU0FBUyxJQUFJLFNBQVMsS0FBSyxJQUFJLE1BQU0sTUFBTTtBQUNqRCxXQUFPLG1DQUFtQyxJQUFJLE1BQU0sR0FBRyxNQUFNLEtBQUssSUFBSSxPQUFPO0FBQUEsRUFDL0U7QUFDQSxNQUFJLGVBQWUsa0JBQWtCO0FBQ25DLFdBQU8sVUFBVSxJQUFJLE9BQU87QUFBQSxFQUM5QjtB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YUFBTyxFQUFFLGNBQWMsV0FBVyxhQUFhLEdBQUcsY0FBYyxFQUFFO0FBQUEsSUFDcEU7QUFBQSxFQUNGO0FBQ0EsUUFBTSxJQUFJLEVBQUUsUUFBUSxPQUFPLFlBQVksZ0JBQWdCLFlBQVksY0FBYyxVQUFVO0FBQzNGLFFBQU0sTUFBTSxLQUFLO0FBQUEsSUFDZixNQUFNLHdCQUF3QixDQUFDLEVBQUUsRUFBRSxlQUFlLEtBQUssT0FBTyxXQUFXLFFBQVEsQ0FBQyxDQUFDLEtBQUssR0FBRyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUMsR0FBRyxNQUFNLFNBQVMsQ0FBQztBQUFBLEVBQ3pIO0FBQ0EsU0FBTyxNQUFNLElBQUksU0FBUyxJQUFJO0FBQzlCLFNBQU8sTUFBTSxJQUFJLE1BQU0sUUFBUTtBQUMvQixTQUFPLE1BQU0sSUFBSyxNQUFNLFFBQVE7QUFDaEMsU0FBTyxNQUFNLElBQUksY0FBYyxDQUFDO0FBQ2hDLFNBQU8sTUFBTSxTQUFTLElBQUk7QUFDNUIsQ0FBQztBQUVELEtBQUssaUVBQWlFLFlBQVk7QUFDaEYsUUFBTSxJQUFJLHlCQUF5QixLQUFLLENBQUMsQ0FBQyxDQUFDO0FBQzNDLFNBQU8sTUFBTSxNQUFNLEVBQUUsQ0FBQyxDQUFDLEdBQUcsZ0JBQWdCO0FBQzFDLFNBQU8sTUFBTSxNQUFNLEVBQUUsRUFBRSxNQUFNLEtBQUssTUFBTSxVQUFVLFNBQVMsS0FBSyxDQUFDLEdBQUcsNEJBQTRCO0FBQ2xHLENBQUM7QUFFRCxLQUFLLGtFQUE2RCxZQUFZO0FBQzVFLE1BQUk7QUFDSixRQUFNLFNBQVM7QUFBQSxJQUNiLGlCQUFpQixPQUFPLElBQVksTUFBaUQ7QUFDbkYsWUFBTTtBQUNOLGFBQU8sRUFBRSxJQUFJLE1BQU0sTUFBTSxNQUFNLFVBQVUsRUFBRSxVQUFVLGFBQWEsV0FBVztBQUFBLElBQy9FO0FBQUEsRUFDRjtBQUNBLFFBQU0sTUFBTSxLQUFLO0FBQUEsSUFDZixNQUFNLHlCQUF5QixLQUFLLE1BQU0sQ0FBQyxFQUFFLEVBQUUsTUFBTSxNQUFNLE1BQU0sZUFBZSxVQUFVLEtBQUssQ0FBQztBQUFBLEVBQ2xHO0FBQ0EsU0FBTyxNQUFNLElBQUssVUFBVSx5Q0FBeUM7QUFDckUsU0FBTyxVQUFVLElBQUssU0FBUyxDQUFDLElBQUksQ0FBQztBQUNyQyxTQUFPLE1BQU0sSUFBSSxTQUFTLElBQUk7QUFDOUIsU0FBTyxNQUFNLElBQUksSUFBSSxJQUFJO0FBQzNCLENBQUM7IiwKICAibmFtZXMiOiBbImRlcHMiLCAiZGVwcyIsICJkZXBzIl0KfQo=
