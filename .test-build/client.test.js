// tests/client.test.ts
import test from "node:test";
import assert from "node:assert/strict";

// src/errors.ts
var GoogleApiError = class extends Error {
  constructor(status, reason, message) {
    super(message);
    this.status = status;
    this.reason = reason;
    this.name = "GoogleApiError";
  }
};

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

// tests/client.test.ts
test("listEvents builds the calendar URL and returns the parsed body + nextPageToken", async () => {
  const { auth } = fakeAuth();
  const { fetchImpl, calls } = scriptedFetch([
    () => json({ items: [{ id: "e1" }], nextPageToken: "np" })
  ]);
  const client = new GoogleWorkspaceClient({ auth, scopes: ["s"], fetch: fetchImpl });
  const r = await client.listEvents("u@x.com", {
    timeMin: "2026-01-01T00:00:00Z",
    maxResults: 10,
    singleEvents: true
  });
  assert.match(calls[0].url, /^https:\/\/www\.googleapis\.com\/calendar\/v3\/calendars\/primary\/events\?/);
  assert.match(calls[0].url, /timeMin=2026/);
  assert.equal(r.items.length, 1);
  assert.equal(r.nextPageToken, "np");
});
test("401 re-mints the token and retries once", async () => {
  const { auth, stats } = fakeAuth();
  const { fetchImpl, calls } = scriptedFetch([
    () => new Response("", { status: 401 }),
    () => json({ ok: true })
  ]);
  const client = new GoogleWorkspaceClient({ auth, scopes: ["s"], fetch: fetchImpl, retryBaseMs: 0 });
  const r = await client.getMessage("u@x.com", "id1");
  assert.equal(calls.length, 2);
  assert.equal(stats().invalidations, 1);
  assert.equal(r.ok, true);
});
test("429 backs off and retries, then succeeds", async () => {
  const { auth } = fakeAuth();
  const { fetchImpl, calls } = scriptedFetch([
    () => new Response("", { status: 429 }),
    () => new Response("", { status: 429 }),
    () => json({ done: true })
  ]);
  const client = new GoogleWorkspaceClient({
    auth,
    scopes: ["s"],
    fetch: fetchImpl,
    retryBaseMs: 0,
    maxRetries: 3
  });
  const r = await client.listEvents("u@x.com", {});
  assert.equal(calls.length, 3);
  assert.equal(r.done, true);
});
test("429 that never clears exhausts retries and throws GoogleApiError", async () => {
  const { auth } = fakeAuth();
  const { fetchImpl, calls } = scriptedFetch([
    () => json({ error: { code: 429, message: "rate", status: "RESOURCE_EXHAUSTED" } }, 429)
  ]);
  const client = new GoogleWorkspaceClient({
    auth,
    scopes: ["s"],
    fetch: fetchImpl,
    retryBaseMs: 0,
    maxRetries: 2
  });
  await assert.rejects(
    () => client.listEvents("u@x.com", {}),
    (e) => e instanceof GoogleApiError && e.status === 429
  );
  assert.equal(calls.length, 3);
});
test("4xx parses the Google error envelope (status \u2192 reason)", async () => {
  const { auth } = fakeAuth();
  const { fetchImpl } = scriptedFetch([
    () => json({ error: { code: 404, message: "Not Found", status: "NOT_FOUND" } }, 404)
  ]);
  const client = new GoogleWorkspaceClient({ auth, scopes: ["s"], fetch: fetchImpl });
  await assert.rejects(
    () => client.getFile("u@x.com", "f1"),
    (e) => e instanceof GoogleApiError && e.status === 404 && e.reason === "NOT_FOUND"
  );
});
test("a response larger than maxBytes throws ResponseTooLarge", async () => {
  const { auth } = fakeAuth();
  const big = "x".repeat(2e3);
  const { fetchImpl } = scriptedFetch([() => new Response(big, { status: 200 })]);
  const client = new GoogleWorkspaceClient({ auth, scopes: ["s"], fetch: fetchImpl, maxBytes: 100 });
  await assert.rejects(
    () => client.getDocument("u@x.com", "d1"),
    (e) => e instanceof GoogleApiError && /exceeds maxBytes/.test(e.message)
  );
});
test("searchContacts warms up once per subject, then queries", async () => {
  const { auth } = fakeAuth();
  const { fetchImpl, calls } = scriptedFetch([() => json({ results: [] })]);
  const client = new GoogleWorkspaceClient({ auth, scopes: ["s"], fetch: fetchImpl });
  await client.searchContacts("u@x.com", { query: "anna" });
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /[?&]query=&/);
  assert.match(calls[1].url, /[?&]query=anna/);
  await client.searchContacts("u@x.com", { query: "bob" });
  assert.equal(calls.length, 3);
});
test("searchFiles requests default fields + passes pageToken", async () => {
  const { auth } = fakeAuth();
  const { fetchImpl, calls } = scriptedFetch([() => json({ files: [], nextPageToken: "n2" })]);
  const client = new GoogleWorkspaceClient({ auth, scopes: ["s"], fetch: fetchImpl });
  const r = await client.searchFiles("u@x.com", { q: "name contains 'x'", pageToken: "tok2" });
  assert.match(calls[0].url, /nextPageToken/);
  assert.match(calls[0].url, /pageToken=tok2/);
  assert.equal(r.nextPageToken, "n2");
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vdGVzdHMvY2xpZW50LnRlc3QudHMiLCAiLi4vc3JjL2Vycm9ycy50cyIsICIuLi9zcmMvZ29vZ2xlQ2xpZW50LnRzIiwgIi4uL3Rlc3RzL19oZWxwZXJzLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdGVzdCBmcm9tICdub2RlOnRlc3QnO1xuaW1wb3J0IGFzc2VydCBmcm9tICdub2RlOmFzc2VydC9zdHJpY3QnO1xuXG5pbXBvcnQgeyBHb29nbGVXb3Jrc3BhY2VDbGllbnQgfSBmcm9tICcuLi9zcmMvZ29vZ2xlQ2xpZW50LmpzJztcbmltcG9ydCB7IEdvb2dsZUFwaUVycm9yIH0gZnJvbSAnLi4vc3JjL2Vycm9ycy5qcyc7XG5pbXBvcnQgeyBmYWtlQXV0aCwgc2NyaXB0ZWRGZXRjaCwganNvbiB9IGZyb20gJy4vX2hlbHBlcnMuanMnO1xuXG50ZXN0KCdsaXN0RXZlbnRzIGJ1aWxkcyB0aGUgY2FsZW5kYXIgVVJMIGFuZCByZXR1cm5zIHRoZSBwYXJzZWQgYm9keSArIG5leHRQYWdlVG9rZW4nLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHsgYXV0aCB9ID0gZmFrZUF1dGgoKTtcbiAgY29uc3QgeyBmZXRjaEltcGwsIGNhbGxzIH0gPSBzY3JpcHRlZEZldGNoKFtcbiAgICAoKSA9PiBqc29uKHsgaXRlbXM6IFt7IGlkOiAnZTEnIH1dLCBuZXh0UGFnZVRva2VuOiAnbnAnIH0pLFxuICBdKTtcbiAgY29uc3QgY2xpZW50ID0gbmV3IEdvb2dsZVdvcmtzcGFjZUNsaWVudCh7IGF1dGgsIHNjb3BlczogWydzJ10sIGZldGNoOiBmZXRjaEltcGwgfSk7XG4gIGNvbnN0IHIgPSBhd2FpdCBjbGllbnQubGlzdEV2ZW50cygndUB4LmNvbScsIHtcbiAgICB0aW1lTWluOiAnMjAyNi0wMS0wMVQwMDowMDowMFonLFxuICAgIG1heFJlc3VsdHM6IDEwLFxuICAgIHNpbmdsZUV2ZW50czogdHJ1ZSxcbiAgfSk7XG4gIGFzc2VydC5tYXRjaChjYWxsc1swXS51cmwsIC9eaHR0cHM6XFwvXFwvd3d3XFwuZ29vZ2xlYXBpc1xcLmNvbVxcL2NhbGVuZGFyXFwvdjNcXC9jYWxlbmRhcnNcXC9wcmltYXJ5XFwvZXZlbnRzXFw/Lyk7XG4gIGFzc2VydC5tYXRjaChjYWxsc1swXS51cmwsIC90aW1lTWluPTIwMjYvKTtcbiAgYXNzZXJ0LmVxdWFsKChyLml0ZW1zIGFzIHVua25vd25bXSkubGVuZ3RoLCAxKTtcbiAgYXNzZXJ0LmVxdWFsKHIubmV4dFBhZ2VUb2tlbiwgJ25wJyk7XG59KTtcblxudGVzdCgnNDAxIHJlLW1pbnRzIHRoZSB0b2tlbiBhbmQgcmV0cmllcyBvbmNlJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB7IGF1dGgsIHN0YXRzIH0gPSBmYWtlQXV0aCgpO1xuICBjb25zdCB7IGZldGNoSW1wbCwgY2FsbHMgfSA9IHNjcmlwdGVkRmV0Y2goW1xuICAgICgpID0+IG5ldyBSZXNwb25zZSgnJywgeyBzdGF0dXM6IDQwMSB9KSxcbiAgICAoKSA9PiBqc29uKHsgb2s6IHRydWUgfSksXG4gIF0pO1xuICBjb25zdCBjbGllbnQgPSBuZXcgR29vZ2xlV29ya3NwYWNlQ2xpZW50KHsgYXV0aCwgc2NvcGVzOiBbJ3MnXSwgZmV0Y2g6IGZldGNoSW1wbCwgcmV0cnlCYXNlTXM6IDAgfSk7XG4gIGNvbnN0IHIgPSBhd2FpdCBjbGllbnQuZ2V0TWVzc2FnZSgndUB4LmNvbScsICdpZDEnKTtcbiAgYXNzZXJ0LmVxdWFsKGNhbGxzLmxlbmd0aCwgMik7XG4gIGFzc2VydC5lcXVhbChzdGF0cygpLmludmFsaWRhdGlvbnMsIDEpO1xuICBhc3NlcnQuZXF1YWwoci5vaywgdHJ1ZSk7XG59KTtcblxudGVzdCgnNDI5IGJhY2tzIG9mZiBhbmQgcmV0cmllcywgdGhlbiBzdWNjZWVkcycsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgeyBhdXRoIH0gPSBmYWtlQXV0aCgpO1xuICBjb25zdCB7IGZldGNoSW1wbCwgY2FsbHMgfSA9IHNjcmlwdGVkRmV0Y2goW1xuICAgICgpID0+IG5ldyBSZXNwb25zZSgnJywgeyBzdGF0dXM6IDQyOSB9KSxcbiAgICAoKSA9PiBuZXcgUmVzcG9uc2UoJycsIHsgc3RhdHVzOiA0MjkgfSksXG4gICAgKCkgPT4ganNvbih7IGRvbmU6IHRydWUgfSksXG4gIF0pO1xuICBjb25zdCBjbGllbnQgPSBuZXcgR29vZ2xlV29ya3NwYWNlQ2xpZW50KHtcbiAgICBhdXRoLFxuICAgIHNjb3BlczogWydzJ10sXG4gICAgZmV0Y2g6IGZldGNoSW1wbCxcbiAgICByZXRyeUJhc2VNczogMCxcbiAgICBtYXhSZXRyaWVzOiAzLFxuICB9KTtcbiAgY29uc3QgciA9IGF3YWl0IGNsaWVudC5saXN0RXZlbnRzKCd1QHguY29tJywge30pO1xuICBhc3NlcnQuZXF1YWwoY2FsbHMubGVuZ3RoLCAzKTtcbiAgYXNzZXJ0LmVxdWFsKHIuZG9uZSwgdHJ1ZSk7XG59KTtcblxudGVzdCgnNDI5IHRoYXQgbmV2ZXIgY2xlYXJzIGV4aGF1c3RzIHJldHJpZXMgYW5kIHRocm93cyBHb29nbGVBcGlFcnJvcicsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgeyBhdXRoIH0gPSBmYWtlQXV0aCgpO1xuICBjb25zdCB7IGZldGNoSW1wbCwgY2FsbHMgfSA9IHNjcmlwdGVkRmV0Y2goW1xuICAgICgpID0+IGpzb24oeyBlcnJvcjogeyBjb2RlOiA0MjksIG1lc3NhZ2U6ICdyYXRlJywgc3RhdHVzOiAnUkVTT1VSQ0VfRVhIQVVTVEVEJyB9IH0sIDQyOSksXG4gIF0pO1xuICBjb25zdCBjbGllbnQgPSBuZXcgR29vZ2xlV29ya3NwYWNlQ2xpZW50KHtcbiAgICBhdXRoLFxuICAgIHNjb3BlczogWydzJ10sXG4gICAgZmV0Y2g6IGZldGNoSW1wbCxcbiAgICByZXRyeUJhc2VNczogMCxcbiAgICBtYXhSZXRyaWVzOiAyLFxuICB9KTtcbiAgYXdhaXQgYXNzZXJ0LnJlamVjdHMoXG4gICAgKCkgPT4gY2xpZW50Lmxpc3RFdmVudHMoJ3VAeC5jb20nLCB7fSksXG4gICAgKGUpID0+IGUgaW5zdGFuY2VvZiBHb29nbGVBcGlFcnJvciAmJiBlLnN0YXR1cyA9PT0gNDI5LFxuICApO1xuICBhc3NlcnQuZXF1YWwoY2FsbHMubGVuZ3RoLCAzKTsgLy8gaW5pdGlhbCArIDIgcmV0cmllc1xufSk7XG5cbnRlc3QoJzR4eCBwYXJzZXMgdGhlIEdvb2dsZSBlcnJvciBlbnZlbG9wZSAoc3RhdHVzIFx1MjE5MiByZWFzb24pJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB7IGF1dGggfSA9IGZha2VBdXRoKCk7XG4gIGNvbnN0IHsgZmV0Y2hJbXBsIH0gPSBzY3JpcHRlZEZldGNoKFtcbiAgICAoKSA9PiBqc29uKHsgZXJyb3I6IHsgY29kZTogNDA0LCBtZXNzYWdlOiAnTm90IEZvdW5kJywgc3RhdHVzOiAnTk9UX0ZPVU5EJyB9IH0sIDQwNCksXG4gIF0pO1xuICBjb25zdCBjbGllbnQgPSBuZXcgR29vZ2xlV29ya3NwYWNlQ2xpZW50KHsgYXV0aCwgc2NvcGVzOiBbJ3MnXSwgZmV0Y2g6IGZldGNoSW1wbCB9KTtcbiAgYXdhaXQgYXNzZXJ0LnJlamVjdHMoXG4gICAgKCkgPT4gY2xpZW50LmdldEZpbGUoJ3VAeC5jb20nLCAnZjEnKSxcbiAgICAoZSkgPT4gZSBpbnN0YW5jZW9mIEdvb2dsZUFwaUVycm9yICYmIGUuc3RhdHVzID09PSA0MDQgJiYgZS5yZWFzb24gPT09ICdOT1RfRk9VTkQnLFxuICApO1xufSk7XG5cbnRlc3QoJ2EgcmVzcG9uc2UgbGFyZ2VyIHRoYW4gbWF4Qnl0ZXMgdGhyb3dzIFJlc3BvbnNlVG9vTGFyZ2UnLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHsgYXV0aCB9ID0gZmFrZUF1dGgoKTtcbiAgY29uc3QgYmlnID0gJ3gnLnJlcGVhdCgyMDAwKTtcbiAgY29uc3QgeyBmZXRjaEltcGwgfSA9IHNjcmlwdGVkRmV0Y2goWygpID0+IG5ldyBSZXNwb25zZShiaWcsIHsgc3RhdHVzOiAyMDAgfSldKTtcbiAgY29uc3QgY2xpZW50ID0gbmV3IEdvb2dsZVdvcmtzcGFjZUNsaWVudCh7IGF1dGgsIHNjb3BlczogWydzJ10sIGZldGNoOiBmZXRjaEltcGwsIG1heEJ5dGVzOiAxMDAgfSk7XG4gIGF3YWl0IGFzc2VydC5yZWplY3RzKFxuICAgICgpID0+IGNsaWVudC5nZXREb2N1bWVudCgndUB4LmNvbScsICdkMScpLFxuICAgIChlKSA9PiBlIGluc3RhbmNlb2YgR29vZ2xlQXBpRXJyb3IgJiYgL2V4Y2VlZHMgbWF4Qnl0ZXMvLnRlc3QoZS5tZXNzYWdlKSxcbiAgKTtcbn0pO1xuXG50ZXN0KCdzZWFyY2hDb250YWN0cyB3YXJtcyB1cCBvbmNlIHBlciBzdWJqZWN0LCB0aGVuIHF1ZXJpZXMnLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHsgYXV0aCB9ID0gZmFrZUF1dGgoKTtcbiAgY29uc3QgeyBmZXRjaEltcGwsIGNhbGxzIH0gPSBzY3JpcHRlZEZldGNoKFsoKSA9PiBqc29uKHsgcmVzdWx0czogW10gfSldKTtcbiAgY29uc3QgY2xpZW50ID0gbmV3IEdvb2dsZVdvcmtzcGFjZUNsaWVudCh7IGF1dGgsIHNjb3BlczogWydzJ10sIGZldGNoOiBmZXRjaEltcGwgfSk7XG5cbiAgYXdhaXQgY2xpZW50LnNlYXJjaENvbnRhY3RzKCd1QHguY29tJywgeyBxdWVyeTogJ2FubmEnIH0pO1xuICBhc3NlcnQuZXF1YWwoY2FsbHMubGVuZ3RoLCAyKTsgLy8gd2FybXVwIChlbXB0eSBxdWVyeSkgKyByZWFsXG4gIGFzc2VydC5tYXRjaChjYWxsc1swXS51cmwsIC9bPyZdcXVlcnk9Ji8pO1xuICBhc3NlcnQubWF0Y2goY2FsbHNbMV0udXJsLCAvWz8mXXF1ZXJ5PWFubmEvKTtcblxuICBhd2FpdCBjbGllbnQuc2VhcmNoQ29udGFjdHMoJ3VAeC5jb20nLCB7IHF1ZXJ5OiAnYm9iJyB9KTtcbiAgYXNzZXJ0LmVxdWFsKGNhbGxzLmxlbmd0aCwgMyk7IC8vIG5vIHNlY29uZCB3YXJtdXAgZm9yIHNhbWUgc3ViamVjdFxufSk7XG5cbnRlc3QoJ3NlYXJjaEZpbGVzIHJlcXVlc3RzIGRlZmF1bHQgZmllbGRzICsgcGFzc2VzIHBhZ2VUb2tlbicsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgeyBhdXRoIH0gPSBmYWtlQXV0aCgpO1xuICBjb25zdCB7IGZldGNoSW1wbCwgY2FsbHMgfSA9IHNjcmlwdGVkRmV0Y2goWygpID0+IGpzb24oeyBmaWxlczogW10sIG5leHRQYWdlVG9rZW46ICduMicgfSldKTtcbiAgY29uc3QgY2xpZW50ID0gbmV3IEdvb2dsZVdvcmtzcGFjZUNsaWVudCh7IGF1dGgsIHNjb3BlczogWydzJ10sIGZldGNoOiBmZXRjaEltcGwgfSk7XG4gIGNvbnN0IHIgPSBhd2FpdCBjbGllbnQuc2VhcmNoRmlsZXMoJ3VAeC5jb20nLCB7IHE6IFwibmFtZSBjb250YWlucyAneCdcIiwgcGFnZVRva2VuOiAndG9rMicgfSk7XG4gIGFzc2VydC5tYXRjaChjYWxsc1swXS51cmwsIC9uZXh0UGFnZVRva2VuLyk7XG4gIGFzc2VydC5tYXRjaChjYWxsc1swXS51cmwsIC9wYWdlVG9rZW49dG9rMi8pO1xuICBhc3NlcnQuZXF1YWwoci5uZXh0UGFnZVRva2VuLCAnbjInKTtcbn0pO1xuIiwgIi8qKlxuICogRXJyb3IgdHlwZXMgc2hhcmVkIGFjcm9zcyB0aGUgR29vZ2xlIFdvcmtzcGFjZSBpbnRlZ3JhdGlvbiwgcGx1cyBhIHNpbmdsZVxuICogYGZvcm1hdFRvb2xFcnJvcmAgdGhhdCB0dXJucyBhbnkgdGhyb3duIGVycm9yIGludG8gYSBzaG9ydCwgbW9kZWwtcmVhZGFibGVcbiAqIHN0cmluZyB3aXRoIG5vIHN0YWNrIHRyYWNlcyBvciBzZWNyZXRzLlxuICovXG5cbi8qKiBSYWlzZWQgd2hlbiB0aGUgc2VydmljZS1hY2NvdW50IEpXVC1iZWFyZXIgdG9rZW4gZXhjaGFuZ2UgZmFpbHMuICovXG5leHBvcnQgY2xhc3MgR29vZ2xlQXV0aEVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICBjb25zdHJ1Y3RvcihtZXNzYWdlOiBzdHJpbmcpIHtcbiAgICBzdXBlcihtZXNzYWdlKTtcbiAgICB0aGlzLm5hbWUgPSAnR29vZ2xlQXV0aEVycm9yJztcbiAgfVxufVxuXG4vKiogUmFpc2VkIHdoZW4gYSBHb29nbGUgQVBJIHJlc3BvbmRzIHdpdGggYSBub24tMnh4IHN0YXR1cy4gKi9cbmV4cG9ydCBjbGFzcyBHb29nbGVBcGlFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgY29uc3RydWN0b3IoXG4gICAgcHVibGljIHJlYWRvbmx5IHN0YXR1czogbnVtYmVyLFxuICAgIHB1YmxpYyByZWFkb25seSByZWFzb246IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgICBtZXNzYWdlOiBzdHJpbmcsXG4gICkge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICAgIHRoaXMubmFtZSA9ICdHb29nbGVBcGlFcnJvcic7XG4gIH1cbn1cblxuLyoqIFJhaXNlZCBieSBjbGllbnQtc2lkZSBhcmd1bWVudCB2YWxpZGF0aW9uIGJlZm9yZSBhbnkgbmV0d29yayBjYWxsLiAqL1xuZXhwb3J0IGNsYXNzIEdvb2dsZUlucHV0RXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIGNvbnN0cnVjdG9yKG1lc3NhZ2U6IHN0cmluZykge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICAgIHRoaXMubmFtZSA9ICdHb29nbGVJbnB1dEVycm9yJztcbiAgfVxufVxuXG4vKipcbiAqIFR1cm4gY2xpZW50IGVycm9ycyBpbnRvIGEgc2hvcnQsIG1vZGVsLXJlYWRhYmxlIG1lc3NhZ2UuIE5ldmVyIGxlYWtzIHRoZVxuICogcHJpdmF0ZSBrZXksIGFjY2VzcyB0b2tlbiwgb3IgYSBzdGFjayB0cmFjZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdFRvb2xFcnJvcihlcnI6IHVua25vd24pOiBzdHJpbmcge1xuICBpZiAoZXJyIGluc3RhbmNlb2YgR29vZ2xlQXV0aEVycm9yKSB7XG4gICAgcmV0dXJuIGBFcnJvcjogR29vZ2xlIFdvcmtzcGFjZSBhdXRoZW50aWNhdGlvbiBmYWlsZWQgXHUyMDE0ICR7ZXJyLm1lc3NhZ2V9LiBDaGVjayB0aGUgc2VydmljZS1hY2NvdW50IGNsaWVudCBlbWFpbCArIHByaXZhdGUga2V5LCB0aGF0IGRvbWFpbi13aWRlIGRlbGVnYXRpb24gaXMgY29uZmlndXJlZCBpbiB0aGUgQWRtaW4gY29uc29sZSBmb3IgdGhlIHJlcXVpcmVkIHNjb3BlcywgYW5kIHRoYXQgdGhlIGltcGVyc29uYXRlZCB1c2VyIGV4aXN0cy5gO1xuICB9XG4gIGlmIChlcnIgaW5zdGFuY2VvZiBHb29nbGVBcGlFcnJvcikge1xuICAgIGNvbnN0IHJlYXNvbiA9IGVyci5yZWFzb24gPyBgIFske2Vyci5yZWFzb259XWAgOiAnJztcbiAgICByZXR1cm4gYEVycm9yOiBHb29nbGUgQVBJIHJldHVybmVkIEhUVFAgJHtlcnIuc3RhdHVzfSR7cmVhc29ufTogJHtlcnIubWVzc2FnZX1gO1xuICB9XG4gIGlmIChlcnIgaW5zdGFuY2VvZiBHb29nbGVJbnB1dEVycm9yKSB7XG4gICAgcmV0dXJuIGBFcnJvcjogJHtlcnIubWVzc2FnZX1gO1xuICB9XG4gIHJldHVybiBgRXJyb3I6ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWA7XG59XG4iLCAiLyoqXG4gKiBHb29nbGVXb3Jrc3BhY2VDbGllbnQgXHUyMDE0IGEgdGhpbiwgcmVhZC1tb3N0bHkgd3JhcHBlciBvdmVyIHRoZSBHb29nbGUgV29ya3NwYWNlXG4gKiBSRVNUIEFQSXMgKENhbGVuZGFyLCBHbWFpbCwgRHJpdmUsIERvY3MsIFNoZWV0cywgQWRtaW4gRGlyZWN0b3J5LCBQZW9wbGUpLlxuICpcbiAqIEF1dGggaXMgc2VydmljZS1hY2NvdW50ICoqZG9tYWluLXdpZGUgZGVsZWdhdGlvbioqOiBldmVyeSBjYWxsIGltcGVyc29uYXRlcyBhXG4gKiBgc3ViamVjdGAgKGEgV29ya3NwYWNlIHVzZXIncyBlbWFpbCkgdmlhIHtAbGluayBHb29nbGVTZXJ2aWNlQWNjb3VudEF1dGh9LlxuICogQWxsIGVncmVzcyBnb2VzIHRocm91Z2ggdGhlIGluamVjdGVkIGBmZXRjaGAgXHUyMDE0IGluIHRoZSBwbHVnaW4gdGhpcyBpc1xuICogYGN0eC5odHRwLmZldGNoYCwgYWxsb3ctbGlzdGVkICsgcmF0ZS1saW1pdGVkIGJ5IHRoZSBob3N0LiBUaGUgY2xpZW50IG5ldmVyXG4gKiB0b3VjaGVzIGdsb2JhbCBgZmV0Y2hgLCBzbyBpdCBzdGF5cyBpbnNpZGUgdGhlIGtlcm5lbCdzIGF1ZGl0YWJsZSBib3VuZGFyeS5cbiAqXG4gKiBSZXNwb25zZXMgYXJlIHNpemUtY2FwcGVkIChgbWF4Qnl0ZXNgKSBiZWZvcmUgYEpTT04ucGFyc2VgIHNvIGEgcGF0aG9sb2dpY2FsXG4gKiB1bmJvdW5kZWQgbGlzdCBjYW4ndCBibG93IHVwIHRoZSBob3N0J3MgbWVtb3J5LiBFYWNoIHB1YmxpYyBtZXRob2QgbmFtZXMgdGhlXG4gKiBzdXJmYWNlIGl0IHRhbGtzIHRvOyB0aGUgcHJpdmF0ZSBgcmVxdWVzdCgpYCByZXNvbHZlcyB0aGUgY29ycmVjdCBBUEkgaG9zdC5cbiAqL1xuXG5pbXBvcnQgeyBHb29nbGVBcGlFcnJvciB9IGZyb20gJy4vZXJyb3JzLmpzJztcbmltcG9ydCB0eXBlIHsgR29vZ2xlU2VydmljZUFjY291bnRBdXRoIH0gZnJvbSAnLi9nb29nbGVBdXRoLmpzJztcblxuZXhwb3J0IHR5cGUgR29vZ2xlQXBpID1cbiAgfCAnY2FsZW5kYXInXG4gIHwgJ2dtYWlsJ1xuICB8ICdkcml2ZSdcbiAgfCAnZG9jcydcbiAgfCAnc2hlZXRzJ1xuICB8ICdkaXJlY3RvcnknXG4gIHwgJ3Blb3BsZSc7XG5cbi8qKiBCYXNlIFVSTCBwZXIgQVBJIChob3N0ICsgdmVyc2lvbiBwcmVmaXgpLiBIb3N0cyBhcmUgbWFuaWZlc3QtYWxsb3ctbGlzdGVkLiAqL1xuY29uc3QgQVBJX0JBU0U6IFJlY29yZDxHb29nbGVBcGksIHN0cmluZz4gPSB7XG4gIGNhbGVuZGFyOiAnaHR0cHM6Ly93d3cuZ29vZ2xlYXBpcy5jb20vY2FsZW5kYXIvdjMnLFxuICBnbWFpbDogJ2h0dHBzOi8vZ21haWwuZ29vZ2xlYXBpcy5jb20vZ21haWwvdjEnLFxuICBkcml2ZTogJ2h0dHBzOi8vd3d3Lmdvb2dsZWFwaXMuY29tL2RyaXZlL3YzJyxcbiAgZG9jczogJ2h0dHBzOi8vZG9jcy5nb29nbGVhcGlzLmNvbS92MScsXG4gIHNoZWV0czogJ2h0dHBzOi8vc2hlZXRzLmdvb2dsZWFwaXMuY29tL3Y0JyxcbiAgZGlyZWN0b3J5OiAnaHR0cHM6Ly9hZG1pbi5nb29nbGVhcGlzLmNvbS9hZG1pbi9kaXJlY3RvcnkvdjEnLFxuICBwZW9wbGU6ICdodHRwczovL3Blb3BsZS5nb29nbGVhcGlzLmNvbS92MScsXG59O1xuXG5jb25zdCBERUZBVUxUX01BWF9CWVRFUyA9IDEwMjQgKiAxMDI0OyAvLyAxIE1pQlxuY29uc3QgREVGQVVMVF9SRVRSWV9CQVNFX01TID0gNTAwO1xuY29uc3QgREVGQVVMVF9NQVhfUkVUUklFUyA9IDM7XG4vKiogVHJhbnNpZW50IHN0YXR1c2VzIHdvcnRoIHJldHJ5aW5nIHdpdGggZXhwb25lbnRpYWwgYmFja29mZi4gKi9cbmNvbnN0IFJFVFJZQUJMRV9TVEFUVVMgPSBuZXcgU2V0KFs0MjksIDUwMCwgNTAyLCA1MDMsIDUwNF0pO1xuXG4vKiogR29vZ2xlIEpTT04gZXJyb3IgZW52ZWxvcGUgKFJFU1QpOiBgeyBlcnJvcjogeyBjb2RlLCBtZXNzYWdlLCBzdGF0dXMsIGVycm9ycyB9IH1gLiAqL1xuaW50ZXJmYWNlIEdvb2dsZUVycm9yRW52ZWxvcGUge1xuICByZWFkb25seSBlcnJvcj86IHtcbiAgICByZWFkb25seSBjb2RlPzogbnVtYmVyO1xuICAgIHJlYWRvbmx5IG1lc3NhZ2U/OiBzdHJpbmc7XG4gICAgcmVhZG9ubHkgc3RhdHVzPzogc3RyaW5nO1xuICAgIHJlYWRvbmx5IGVycm9ycz86IFJlYWRvbmx5QXJyYXk8eyByZWFkb25seSByZWFzb24/OiBzdHJpbmc7IHJlYWRvbmx5IG1lc3NhZ2U/OiBzdHJpbmcgfT47XG4gIH07XG59XG5cbnR5cGUgUXVlcnlWYWx1ZSA9IHN0cmluZyB8IG51bWJlciB8IGJvb2xlYW4gfCByZWFkb25seSBzdHJpbmdbXSB8IHVuZGVmaW5lZDtcblxuZXhwb3J0IGludGVyZmFjZSBHb29nbGVXb3Jrc3BhY2VDbGllbnRPcHRpb25zIHtcbiAgcmVhZG9ubHkgYXV0aDogR29vZ2xlU2VydmljZUFjY291bnRBdXRoO1xuICAvKiogVGhlIHVuaW9uIHNjb3BlIHNldCB0aGUgYWNjZXNzIHRva2VuIGlzIHJlcXVlc3RlZCB3aXRoLiAqL1xuICByZWFkb25seSBzY29wZXM6IHJlYWRvbmx5IHN0cmluZ1tdO1xuICAvKiogSGFyZCBjYXAgb24gYSBzaW5nbGUgcmVzcG9uc2UgYm9keSBpbiBieXRlcy4gRGVmYXVsdHMgdG8gMSBNaUIuICovXG4gIHJlYWRvbmx5IG1heEJ5dGVzPzogbnVtYmVyO1xuICAvKiogQmFzZSBkZWxheSBmb3IgZXhwb25lbnRpYWwgYmFja29mZiBvbiB0cmFuc2llbnQgZXJyb3JzIChtcykuIERlZmF1bHQgNTAwLiAqL1xuICByZWFkb25seSByZXRyeUJhc2VNcz86IG51bWJlcjtcbiAgLyoqIE1heCByZXRyaWVzIG9uIHRyYW5zaWVudCAoNDI5LzV4eCkgZXJyb3JzLiBEZWZhdWx0IDMuICovXG4gIHJlYWRvbmx5IG1heFJldHJpZXM/OiBudW1iZXI7XG4gIC8qKiBJbmplY3RlZCBmZXRjaCAocHJvZHVjdGlvbjogYGN0eC5odHRwLmZldGNoYCkuICovXG4gIHJlYWRvbmx5IGZldGNoOiB0eXBlb2YgZmV0Y2g7XG4gIC8qKiBPcHRpb25hbCBzdHJ1Y3R1cmVkIGxvZ2dlci4gKi9cbiAgcmVhZG9ubHkgbG9nPzogKG1lc3NhZ2U6IHN0cmluZykgPT4gdm9pZDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBSZXF1ZXN0T3B0aW9ucyB7XG4gIC8qKiBXb3Jrc3BhY2UgdXNlciB0byBpbXBlcnNvbmF0ZSAoRFdEIGBzdWJgKS4gKi9cbiAgcmVhZG9ubHkgc3ViamVjdDogc3RyaW5nO1xuICByZWFkb25seSBxdWVyeT86IFJlY29yZDxzdHJpbmcsIFF1ZXJ5VmFsdWU+O1xuICAvKiogSlNPTiByZXF1ZXN0IGJvZHkgKHNlcmlhbGl6ZWQgKyBzZW50IGFzIGFwcGxpY2F0aW9uL2pzb24pLiAqL1xuICByZWFkb25seSBib2R5PzogdW5rbm93bjtcbiAgLyoqXG4gICAqIFByZS1zZXJpYWxpemVkIGJvZHkgc2VudCB2ZXJiYXRpbSB3aXRoIGBjb250ZW50VHlwZWAgKGUuZy4gYSBtdWx0aXBhcnRcbiAgICogdXBsb2FkKS4gVGFrZXMgcHJlY2VkZW5jZSBvdmVyIGBib2R5YC4gVXNlZCBieSB0aGUgRHJpdmUgbWVkaWEgdXBsb2FkLlxuICAgKi9cbiAgcmVhZG9ubHkgcmF3Qm9keT86IHN0cmluZztcbiAgcmVhZG9ubHkgY29udGVudFR5cGU/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjbGFzcyBHb29nbGVXb3Jrc3BhY2VDbGllbnQge1xuICBwcml2YXRlIHJlYWRvbmx5IGF1dGg6IEdvb2dsZVNlcnZpY2VBY2NvdW50QXV0aDtcbiAgcHJpdmF0ZSByZWFkb25seSBzY29wZXM6IHJlYWRvbmx5IHN0cmluZ1tdO1xuICBwcml2YXRlIHJlYWRvbmx5IG1heEJ5dGVzOiBudW1iZXI7XG4gIHByaXZhdGUgcmVhZG9ubHkgcmV0cnlCYXNlTXM6IG51bWJlcjtcbiAgcHJpdmF0ZSByZWFkb25seSBtYXhSZXRyaWVzOiBudW1iZXI7XG4gIHByaXZhdGUgcmVhZG9ubHkgZmV0Y2hJbXBsOiB0eXBlb2YgZmV0Y2g7XG4gIHByaXZhdGUgcmVhZG9ubHkgbG9nOiAobWVzc2FnZTogc3RyaW5nKSA9PiB2b2lkO1xuICAvKiogU3ViamVjdHMgd2hvc2UgUGVvcGxlIGNvbnRhY3RzIGNhY2hlIGhhcyBiZWVuIHdhcm1lZCB0aGlzIHByb2Nlc3MuICovXG4gIHByaXZhdGUgcmVhZG9ubHkgd2FybWVkQ29udGFjdHMgPSBuZXcgU2V0PHN0cmluZz4oKTtcblxuICBjb25zdHJ1Y3RvcihvcHRzOiBHb29nbGVXb3Jrc3BhY2VDbGllbnRPcHRpb25zKSB7XG4gICAgdGhpcy5hdXRoID0gb3B0cy5hdXRoO1xuICAgIHRoaXMuc2NvcGVzID0gb3B0cy5zY29wZXM7XG4gICAgdGhpcy5tYXhCeXRlcyA9IG9wdHMubWF4Qnl0ZXMgJiYgb3B0cy5tYXhCeXRlcyA+IDAgPyBvcHRzLm1heEJ5dGVzIDogREVGQVVMVF9NQVhfQllURVM7XG4gICAgdGhpcy5yZXRyeUJhc2VNcyA9XG4gICAgICB0eXBlb2Ygb3B0cy5yZXRyeUJhc2VNcyA9PT0gJ251bWJlcicgJiYgb3B0cy5yZXRyeUJhc2VNcyA+PSAwXG4gICAgICAgID8gb3B0cy5yZXRyeUJhc2VNc1xuICAgICAgICA6IERFRkFVTFRfUkVUUllfQkFTRV9NUztcbiAgICB0aGlzLm1heFJldHJpZXMgPVxuICAgICAgdHlwZW9mIG9wdHMubWF4UmV0cmllcyA9PT0gJ251bWJlcicgJiYgb3B0cy5tYXhSZXRyaWVzID49IDBcbiAgICAgICAgPyBvcHRzLm1heFJldHJpZXNcbiAgICAgICAgOiBERUZBVUxUX01BWF9SRVRSSUVTO1xuICAgIHRoaXMuZmV0Y2hJbXBsID0gb3B0cy5mZXRjaDtcbiAgICB0aGlzLmxvZyA9IG9wdHMubG9nID8/ICgoKSA9PiB7fSk7XG4gIH1cblxuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIC8vIENvcmUgcmVxdWVzdCBcdTIwMTQgb25lIHJldHJ5IG9uIDQwMSAoZXhwaXJlZC9yb3RhdGVkIHRva2VuKS5cbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBwcml2YXRlIGFzeW5jIHJlcXVlc3Q8VCA9IFJlY29yZDxzdHJpbmcsIHVua25vd24+PihcbiAgICBhcGk6IEdvb2dsZUFwaSxcbiAgICBtZXRob2Q6IHN0cmluZyxcbiAgICBwYXRoOiBzdHJpbmcsXG4gICAgb3B0czogUmVxdWVzdE9wdGlvbnMsXG4gICk6IFByb21pc2U8VD4ge1xuICAgIC8vIEFuIGFic29sdXRlIGBwYXRoYCAoZS5nLiB0aGUgRHJpdmUgbWVkaWEtdXBsb2FkIGhvc3QpIGlzIHVzZWQgdmVyYmF0aW07XG4gICAgLy8gb3RoZXJ3aXNlIGl0IGlzIHJlc29sdmVkIGFnYWluc3QgdGhlIHBlci1BUEkgYmFzZS5cbiAgICBjb25zdCBiYXNlID0gcGF0aC5zdGFydHNXaXRoKCdodHRwJykgPyBwYXRoIDogYCR7QVBJX0JBU0VbYXBpXX0ke3BhdGh9YDtcbiAgICBjb25zdCB1cmwgPSBgJHtiYXNlfSR7YnVpbGRRdWVyeVN0cmluZyhvcHRzLnF1ZXJ5KX1gO1xuICAgIGNvbnN0IHNlbmQgPSBhc3luYyAoKTogUHJvbWlzZTxSZXNwb25zZT4gPT4ge1xuICAgICAgY29uc3QgdG9rZW4gPSBhd2FpdCB0aGlzLmF1dGguZ2V0VG9rZW4ob3B0cy5zdWJqZWN0LCB0aGlzLnNjb3Blcyk7XG4gICAgICBjb25zdCBoZWFkZXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICAgICAgICBBdXRob3JpemF0aW9uOiBgQmVhcmVyICR7dG9rZW59YCxcbiAgICAgICAgQWNjZXB0OiAnYXBwbGljYXRpb24vanNvbicsXG4gICAgICB9O1xuICAgICAgbGV0IHNlcmlhbGl6ZWQ6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICAgIGlmIChvcHRzLnJhd0JvZHkgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICBpZiAob3B0cy5jb250ZW50VHlwZSkgaGVhZGVyc1snQ29udGVudC1UeXBlJ10gPSBvcHRzLmNvbnRlbnRUeXBlO1xuICAgICAgICBzZXJpYWxpemVkID0gb3B0cy5yYXdCb2R5O1xuICAgICAgfSBlbHNlIGlmIChvcHRzLmJvZHkgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICBoZWFkZXJzWydDb250ZW50LVR5cGUnXSA9ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JztcbiAgICAgICAgc2VyaWFsaXplZCA9IEpTT04uc3RyaW5naWZ5KG9wdHMuYm9keSk7XG4gICAgICB9XG4gICAgICByZXR1cm4gdGhpcy5mZXRjaEltcGwodXJsLCB7IG1ldGhvZCwgaGVhZGVycywgYm9keTogc2VyaWFsaXplZCB9KTtcbiAgICB9O1xuXG4gICAgbGV0IHRva2VuUmV0cmllZCA9IGZhbHNlO1xuICAgIGZvciAobGV0IGF0dGVtcHQgPSAwOyA7IGF0dGVtcHQrKykge1xuICAgICAgY29uc3QgcmVzID0gYXdhaXQgc2VuZCgpO1xuXG4gICAgICAvLyBFeHBpcmVkL3JvdGF0ZWQgdG9rZW4gXHUyMDE0IHJlLW1pbnQgb25jZSwgbm90IGNvdW50ZWQgYWdhaW5zdCBiYWNrb2ZmLlxuICAgICAgaWYgKHJlcy5zdGF0dXMgPT09IDQwMSAmJiAhdG9rZW5SZXRyaWVkKSB7XG4gICAgICAgIHRoaXMubG9nKCdbZ29vZ2xld29ya3NwYWNlXSA0MDEgXHUyMDE0IHJlZnJlc2hpbmcgdG9rZW4gYW5kIHJldHJ5aW5nIG9uY2UnKTtcbiAgICAgICAgdG9rZW5SZXRyaWVkID0gdHJ1ZTtcbiAgICAgICAgdGhpcy5hdXRoLmludmFsaWRhdGUob3B0cy5zdWJqZWN0LCB0aGlzLnNjb3Blcyk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICAvLyBUcmFuc2llbnQgZXJyb3JzIFx1MjAxNCBleHBvbmVudGlhbCBiYWNrb2ZmIHVwIHRvIG1heFJldHJpZXMuXG4gICAgICBpZiAoUkVUUllBQkxFX1NUQVRVUy5oYXMocmVzLnN0YXR1cykgJiYgYXR0ZW1wdCA8IHRoaXMubWF4UmV0cmllcykge1xuICAgICAgICBjb25zdCBkZWxheSA9IHRoaXMuYmFja29mZkRlbGF5KGF0dGVtcHQsIHJlcyk7XG4gICAgICAgIHRoaXMubG9nKFxuICAgICAgICAgIGBbZ29vZ2xld29ya3NwYWNlXSBIVFRQICR7cmVzLnN0YXR1c30gb24gJHthcGl9IFx1MjAxNCByZXRyeSAke2F0dGVtcHQgKyAxfS8ke3RoaXMubWF4UmV0cmllc30gaW4gJHtkZWxheX1tc2AsXG4gICAgICAgICk7XG4gICAgICAgIGF3YWl0IHNsZWVwKGRlbGF5KTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIGlmICghcmVzLm9rKSB0aHJvdyBhd2FpdCB0aGlzLnRvQXBpRXJyb3IocmVzKTtcbiAgICAgIGNvbnN0IHRleHQgPSBhd2FpdCB0aGlzLnJlYWRDYXBwZWQocmVzKTtcbiAgICAgIHJldHVybiAodGV4dCA/IEpTT04ucGFyc2UodGV4dCkgOiB7fSkgYXMgVDtcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogQmFja29mZiBkZWxheSBmb3IgcmV0cnkgYGF0dGVtcHRgICgwLWJhc2VkKS4gSG9ub3VycyBhIGBSZXRyeS1BZnRlcmBcbiAgICogaGVhZGVyIChzZWNvbmRzKSB3aGVuIHRoZSBzZXJ2ZXIgc2VuZHMgb25lLCBvdGhlcndpc2UgZXhwb25lbnRpYWxcbiAgICogKGBiYXNlICogMl5hdHRlbXB0YCkgd2l0aCBhIGxpdHRsZSBqaXR0ZXIuXG4gICAqL1xuICBwcml2YXRlIGJhY2tvZmZEZWxheShhdHRlbXB0OiBudW1iZXIsIHJlczogUmVzcG9uc2UpOiBudW1iZXIge1xuICAgIGNvbnN0IHJldHJ5QWZ0ZXIgPSBOdW1iZXIocmVzLmhlYWRlcnMuZ2V0KCdyZXRyeS1hZnRlcicpID8/ICcnKTtcbiAgICBpZiAoTnVtYmVyLmlzRmluaXRlKHJldHJ5QWZ0ZXIpICYmIHJldHJ5QWZ0ZXIgPiAwKSB7XG4gICAgICByZXR1cm4gTWF0aC5taW4ocmV0cnlBZnRlciAqIDEwMDAsIDMwXzAwMCk7XG4gICAgfVxuICAgIGNvbnN0IGJhc2UgPSB0aGlzLnJldHJ5QmFzZU1zICogMiAqKiBhdHRlbXB0O1xuICAgIGNvbnN0IGppdHRlciA9IE1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSAqIE1hdGgubWluKHRoaXMucmV0cnlCYXNlTXMsIDI1MCkpO1xuICAgIHJldHVybiBNYXRoLm1pbihiYXNlICsgaml0dGVyLCAzMF8wMDApO1xuICB9XG5cbiAgLyoqIFJlYWQgYSByZXNwb25zZSBib2R5LCByZWZ1c2luZyBwYXlsb2FkcyBsYXJnZXIgdGhhbiBgbWF4Qnl0ZXNgLiAqL1xuICBwcml2YXRlIGFzeW5jIHJlYWRDYXBwZWQocmVzOiBSZXNwb25zZSk6IFByb21pc2U8c3RyaW5nPiB7XG4gICAgY29uc3QgZGVjbGFyZWQgPSBOdW1iZXIocmVzLmhlYWRlcnMuZ2V0KCdjb250ZW50LWxlbmd0aCcpID8/ICcnKTtcbiAgICBpZiAoTnVtYmVyLmlzRmluaXRlKGRlY2xhcmVkKSAmJiBkZWNsYXJlZCA+IHRoaXMubWF4Qnl0ZXMpIHtcbiAgICAgIHRocm93IG5ldyBHb29nbGVBcGlFcnJvcihcbiAgICAgICAgcmVzLnN0YXR1cyxcbiAgICAgICAgJ1Jlc3BvbnNlVG9vTGFyZ2UnLFxuICAgICAgICBgcmVzcG9uc2Ugb2YgJHtkZWNsYXJlZH0gYnl0ZXMgZXhjZWVkcyBtYXhCeXRlcz0ke3RoaXMubWF4Qnl0ZXN9YCxcbiAgICAgICk7XG4gICAgfVxuICAgIGNvbnN0IHRleHQgPSBhd2FpdCByZXMudGV4dCgpO1xuICAgIGlmICh0ZXh0Lmxlbmd0aCA+IHRoaXMubWF4Qnl0ZXMpIHtcbiAgICAgIHRocm93IG5ldyBHb29nbGVBcGlFcnJvcihcbiAgICAgICAgcmVzLnN0YXR1cyxcbiAgICAgICAgJ1Jlc3BvbnNlVG9vTGFyZ2UnLFxuICAgICAgICBgcmVzcG9uc2Ugb2YgJHt0ZXh0Lmxlbmd0aH0gYnl0ZXMgZXhjZWVkcyBtYXhCeXRlcz0ke3RoaXMubWF4Qnl0ZXN9YCxcbiAgICAgICk7XG4gICAgfVxuICAgIHJldHVybiB0ZXh0O1xuICB9XG5cbiAgLyoqIFBhcnNlIGEgbm9uLTJ4eCBib2R5IGludG8gYSB7QGxpbmsgR29vZ2xlQXBpRXJyb3J9LiAqL1xuICBwcml2YXRlIGFzeW5jIHRvQXBpRXJyb3IocmVzOiBSZXNwb25zZSk6IFByb21pc2U8R29vZ2xlQXBpRXJyb3I+IHtcbiAgICBsZXQgcmF3ID0gJyc7XG4gICAgdHJ5IHtcbiAgICAgIHJhdyA9IGF3YWl0IHRoaXMucmVhZENhcHBlZChyZXMpO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgaWYgKGVyciBpbnN0YW5jZW9mIEdvb2dsZUFwaUVycm9yKSByZXR1cm4gZXJyO1xuICAgIH1cbiAgICBsZXQgcmVhc29uOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gICAgbGV0IG1lc3NhZ2UgPSByYXcgfHwgcmVzLnN0YXR1c1RleHQ7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGVudiA9IEpTT04ucGFyc2UocmF3KSBhcyBHb29nbGVFcnJvckVudmVsb3BlO1xuICAgICAgaWYgKGVudi5lcnJvcikge1xuICAgICAgICByZWFzb24gPSBlbnYuZXJyb3Iuc3RhdHVzID8/IGVudi5lcnJvci5lcnJvcnM/LlswXT8ucmVhc29uO1xuICAgICAgICBtZXNzYWdlID0gZW52LmVycm9yLm1lc3NhZ2UgPz8gbWVzc2FnZTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIG5vbi1KU09OIGVycm9yIGJvZHkgXHUyMDE0IGtlZXAgcmF3ICovXG4gICAgfVxuICAgIHJldHVybiBuZXcgR29vZ2xlQXBpRXJyb3IocmVzLnN0YXR1cywgcmVhc29uLCBtZXNzYWdlKTtcbiAgfVxuXG4gIC8qKiBBY3F1aXJlIGEgdG9rZW4gZm9yIGBzdWJqZWN0YCB0byB2ZXJpZnkgY29ubmVjdGl2aXR5ICsgZGVsZWdhdGlvbi4gKi9cbiAgYXN5bmMgcHJvYmUoc3ViamVjdDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgYXdhaXQgdGhpcy5hdXRoLmdldFRva2VuKHN1YmplY3QsIHRoaXMuc2NvcGVzKTtcbiAgfVxuXG4gIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgLy8gQ2FsZW5kYXIgQVBJIHYzXG4gIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAvKiogTGlzdCBldmVudHMgb24gYSBjYWxlbmRhciAoZGVmYXVsdCBgcHJpbWFyeWApLiAqL1xuICBhc3luYyBsaXN0RXZlbnRzKFxuICAgIHN1YmplY3Q6IHN0cmluZyxcbiAgICBwOiB7XG4gICAgICBjYWxlbmRhcklkPzogc3RyaW5nO1xuICAgICAgdGltZU1pbj86IHN0cmluZztcbiAgICAgIHRpbWVNYXg/OiBzdHJpbmc7XG4gICAgICBxPzogc3RyaW5nO1xuICAgICAgbWF4UmVzdWx0cz86IG51bWJlcjtcbiAgICAgIHNpbmdsZUV2ZW50cz86IGJvb2xlYW47XG4gICAgICBvcmRlckJ5Pzogc3RyaW5nO1xuICAgICAgcGFnZVRva2VuPzogc3RyaW5nO1xuICAgIH0sXG4gICk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcbiAgICBjb25zdCBjYWxlbmRhcklkID0gcC5jYWxlbmRhcklkIHx8ICdwcmltYXJ5JztcbiAgICByZXR1cm4gdGhpcy5yZXF1ZXN0KCdjYWxlbmRhcicsICdHRVQnLCBgL2NhbGVuZGFycy8ke2VuY29kZVVSSUNvbXBvbmVudChjYWxlbmRhcklkKX0vZXZlbnRzYCwge1xuICAgICAgc3ViamVjdCxcbiAgICAgIHF1ZXJ5OiB7XG4gICAgICAgIHRpbWVNaW46IHAudGltZU1pbixcbiAgICAgICAgdGltZU1heDogcC50aW1lTWF4LFxuICAgICAgICBxOiBwLnEsXG4gICAgICAgIG1heFJlc3VsdHM6IHAubWF4UmVzdWx0cyxcbiAgICAgICAgc2luZ2xlRXZlbnRzOiBwLnNpbmdsZUV2ZW50cyA/PyB0cnVlLFxuICAgICAgICBvcmRlckJ5OiBwLm9yZGVyQnkgPz8gKHAuc2luZ2xlRXZlbnRzID09PSBmYWxzZSA/IHVuZGVmaW5lZCA6ICdzdGFydFRpbWUnKSxcbiAgICAgICAgcGFnZVRva2VuOiBwLnBhZ2VUb2tlbixcbiAgICAgIH0sXG4gICAgfSk7XG4gIH1cblxuICAvKiogUXVlcnkgZnJlZS9idXN5IHdpbmRvd3MgYWNyb3NzIG9uZSBvciBtb3JlIGNhbGVuZGFycy4gKi9cbiAgYXN5bmMgZnJlZUJ1c3koXG4gICAgc3ViamVjdDogc3RyaW5nLFxuICAgIHA6IHsgdGltZU1pbjogc3RyaW5nOyB0aW1lTWF4OiBzdHJpbmc7IGNhbGVuZGFySWRzOiByZWFkb25seSBzdHJpbmdbXSB9LFxuICApOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB7XG4gICAgcmV0dXJuIHRoaXMucmVxdWVzdCgnY2FsZW5kYXInLCAnUE9TVCcsICcvZnJlZUJ1c3knLCB7XG4gICAgICBzdWJqZWN0LFxuICAgICAgYm9keToge1xuICAgICAgICB0aW1lTWluOiBwLnRpbWVNaW4sXG4gICAgICAgIHRpbWVNYXg6IHAudGltZU1heCxcbiAgICAgICAgaXRlbXM6IHAuY2FsZW5kYXJJZHMubWFwKChpZCkgPT4gKHsgaWQgfSkpLFxuICAgICAgfSxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKiBDcmVhdGUgYSBjYWxlbmRhciBldmVudC4gKi9cbiAgYXN5bmMgY3JlYXRlRXZlbnQoXG4gICAgc3ViamVjdDogc3RyaW5nLFxuICAgIGNhbGVuZGFySWQ6IHN0cmluZyxcbiAgICBldmVudDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG4gICAgcDogeyBzZW5kVXBkYXRlcz86IHN0cmluZyB9ID0ge30sXG4gICk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcbiAgICByZXR1cm4gdGhpcy5yZXF1ZXN0KCdjYWxlbmRhcicsICdQT1NUJywgYC9jYWxlbmRhcnMvJHtlbmNvZGVVUklDb21wb25lbnQoY2FsZW5kYXJJZCl9L2V2ZW50c2AsIHtcbiAgICAgIHN1YmplY3QsXG4gICAgICBxdWVyeTogeyBzZW5kVXBkYXRlczogcC5zZW5kVXBkYXRlcyB9LFxuICAgICAgYm9keTogZXZlbnQsXG4gICAgfSk7XG4gIH1cblxuICAvKiogUGF0Y2ggKHBhcnRpYWwgdXBkYXRlKSBhbiBleGlzdGluZyBldmVudC4gKi9cbiAgYXN5bmMgcGF0Y2hFdmVudChcbiAgICBzdWJqZWN0OiBzdHJpbmcsXG4gICAgY2FsZW5kYXJJZDogc3RyaW5nLFxuICAgIGV2ZW50SWQ6IHN0cmluZyxcbiAgICBwYXRjaDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG4gICAgcDogeyBzZW5kVXBkYXRlcz86IHN0cmluZyB9ID0ge30sXG4gICk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcbiAgICByZXR1cm4gdGhpcy5yZXF1ZXN0KFxuICAgICAgJ2NhbGVuZGFyJyxcbiAgICAgICdQQVRDSCcsXG4gICAgICBgL2NhbGVuZGFycy8ke2VuY29kZVVSSUNvbXBvbmVudChjYWxlbmRhcklkKX0vZXZlbnRzLyR7ZW5jb2RlVVJJQ29tcG9uZW50KGV2ZW50SWQpfWAsXG4gICAgICB7IHN1YmplY3QsIHF1ZXJ5OiB7IHNlbmRVcGRhdGVzOiBwLnNlbmRVcGRhdGVzIH0sIGJvZHk6IHBhdGNoIH0sXG4gICAgKTtcbiAgfVxuXG4gIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgLy8gR21haWwgQVBJIHYxICh1c2VySWQgJ21lJyByZXNvbHZlcyB0byB0aGUgaW1wZXJzb25hdGVkIHN1YmplY3QpXG4gIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICBhc3luYyBzZWFyY2hNZXNzYWdlcyhcbiAgICBzdWJqZWN0OiBzdHJpbmcsXG4gICAgcDogeyBxPzogc3RyaW5nOyBtYXhSZXN1bHRzPzogbnVtYmVyOyBsYWJlbElkcz86IHJlYWRvbmx5IHN0cmluZ1tdOyBwYWdlVG9rZW4/OiBzdHJpbmcgfSxcbiAgKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4ge1xuICAgIHJldHVybiB0aGlzLnJlcXVlc3QoJ2dtYWlsJywgJ0dFVCcsICcvdXNlcnMvbWUvbWVzc2FnZXMnLCB7XG4gICAgICBzdWJqZWN0LFxuICAgICAgcXVlcnk6IHtcbiAgICAgICAgcTogcC5xLFxuICAgICAgICBtYXhSZXN1bHRzOiBwLm1heFJlc3VsdHMsXG4gICAgICAgIGxhYmVsSWRzOiBwLmxhYmVsSWRzLFxuICAgICAgICBwYWdlVG9rZW46IHAucGFnZVRva2VuLFxuICAgICAgfSxcbiAgICB9KTtcbiAgfVxuXG4gIGFzeW5jIGdldE1lc3NhZ2UoXG4gICAgc3ViamVjdDogc3RyaW5nLFxuICAgIGlkOiBzdHJpbmcsXG4gICAgcDogeyBmb3JtYXQ/OiBzdHJpbmcgfSA9IHt9LFxuICApOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB7XG4gICAgcmV0dXJuIHRoaXMucmVxdWVzdCgnZ21haWwnLCAnR0VUJywgYC91c2Vycy9tZS9tZXNzYWdlcy8ke2VuY29kZVVSSUNvbXBvbmVudChpZCl9YCwge1xuICAgICAgc3ViamVjdCxcbiAgICAgIHF1ZXJ5OiB7IGZvcm1hdDogcC5mb3JtYXQgPz8gJ2Z1bGwnIH0sXG4gICAgfSk7XG4gIH1cblxuICAvKiogU2VuZCBhIG1lc3NhZ2UuIGByYXdgIGlzIGEgYmFzZTY0dXJsLWVuY29kZWQgUkZDIDI4MjIgbWVzc2FnZS4gKi9cbiAgYXN5bmMgc2VuZE1lc3NhZ2Uoc3ViamVjdDogc3RyaW5nLCByYXc6IHN0cmluZyk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcbiAgICByZXR1cm4gdGhpcy5yZXF1ZXN0KCdnbWFpbCcsICdQT1NUJywgJy91c2Vycy9tZS9tZXNzYWdlcy9zZW5kJywge1xuICAgICAgc3ViamVjdCxcbiAgICAgIGJvZHk6IHsgcmF3IH0sXG4gICAgfSk7XG4gIH1cblxuICAvKiogQ3JlYXRlIGEgZHJhZnQuIGByYXdgIGlzIGEgYmFzZTY0dXJsLWVuY29kZWQgUkZDIDI4MjIgbWVzc2FnZS4gKi9cbiAgYXN5bmMgY3JlYXRlRHJhZnQoc3ViamVjdDogc3RyaW5nLCByYXc6IHN0cmluZyk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcbiAgICByZXR1cm4gdGhpcy5yZXF1ZXN0KCdnbWFpbCcsICdQT1NUJywgJy91c2Vycy9tZS9kcmFmdHMnLCB7XG4gICAgICBzdWJqZWN0LFxuICAgICAgYm9keTogeyBtZXNzYWdlOiB7IHJhdyB9IH0sXG4gICAgfSk7XG4gIH1cblxuICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gIC8vIERyaXZlIEFQSSB2MyAvIERvY3MgdjEgLyBTaGVldHMgdjRcbiAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gIGFzeW5jIHNlYXJjaEZpbGVzKFxuICAgIHN1YmplY3Q6IHN0cmluZyxcbiAgICBwOiB7IHE/OiBzdHJpbmc7IHBhZ2VTaXplPzogbnVtYmVyOyBvcmRlckJ5Pzogc3RyaW5nOyBmaWVsZHM/OiBzdHJpbmc7IHBhZ2VUb2tlbj86IHN0cmluZyB9LFxuICApOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB7XG4gICAgcmV0dXJuIHRoaXMucmVxdWVzdCgnZHJpdmUnLCAnR0VUJywgJy9maWxlcycsIHtcbiAgICAgIHN1YmplY3QsXG4gICAgICBxdWVyeToge1xuICAgICAgICBxOiBwLnEsXG4gICAgICAgIHBhZ2VTaXplOiBwLnBhZ2VTaXplLFxuICAgICAgICBvcmRlckJ5OiBwLm9yZGVyQnksXG4gICAgICAgIGZpZWxkczpcbiAgICAgICAgICBwLmZpZWxkcyA/P1xuICAgICAgICAgICdmaWxlcyhpZCxuYW1lLG1pbWVUeXBlLG1vZGlmaWVkVGltZSxvd25lcnMoZW1haWxBZGRyZXNzKSx3ZWJWaWV3TGluayxzaXplKSxuZXh0UGFnZVRva2VuJyxcbiAgICAgICAgcGFnZVRva2VuOiBwLnBhZ2VUb2tlbixcbiAgICAgICAgc3VwcG9ydHNBbGxEcml2ZXM6IHRydWUsXG4gICAgICAgIGluY2x1ZGVJdGVtc0Zyb21BbGxEcml2ZXM6IHRydWUsXG4gICAgICB9LFxuICAgIH0pO1xuICB9XG5cbiAgYXN5bmMgZ2V0RmlsZShcbiAgICBzdWJqZWN0OiBzdHJpbmcsXG4gICAgZmlsZUlkOiBzdHJpbmcsXG4gICAgcDogeyBmaWVsZHM/OiBzdHJpbmcgfSA9IHt9LFxuICApOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB7XG4gICAgcmV0dXJuIHRoaXMucmVxdWVzdCgnZHJpdmUnLCAnR0VUJywgYC9maWxlcy8ke2VuY29kZVVSSUNvbXBvbmVudChmaWxlSWQpfWAsIHtcbiAgICAgIHN1YmplY3QsXG4gICAgICBxdWVyeToge1xuICAgICAgICBmaWVsZHM6XG4gICAgICAgICAgcC5maWVsZHMgPz9cbiAgICAgICAgICAnaWQsbmFtZSxtaW1lVHlwZSxtb2RpZmllZFRpbWUsY3JlYXRlZFRpbWUsb3duZXJzKGVtYWlsQWRkcmVzcyxkaXNwbGF5TmFtZSksd2ViVmlld0xpbmssc2l6ZSxkZXNjcmlwdGlvbicsXG4gICAgICAgIHN1cHBvcnRzQWxsRHJpdmVzOiB0cnVlLFxuICAgICAgfSxcbiAgICB9KTtcbiAgfVxuXG4gIGFzeW5jIGdldERvY3VtZW50KHN1YmplY3Q6IHN0cmluZywgZG9jdW1lbnRJZDogc3RyaW5nKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4ge1xuICAgIHJldHVybiB0aGlzLnJlcXVlc3QoJ2RvY3MnLCAnR0VUJywgYC9kb2N1bWVudHMvJHtlbmNvZGVVUklDb21wb25lbnQoZG9jdW1lbnRJZCl9YCwgeyBzdWJqZWN0IH0pO1xuICB9XG5cbiAgYXN5bmMgZ2V0U2hlZXRWYWx1ZXMoXG4gICAgc3ViamVjdDogc3RyaW5nLFxuICAgIHNwcmVhZHNoZWV0SWQ6IHN0cmluZyxcbiAgICByYW5nZTogc3RyaW5nLFxuICApOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB7XG4gICAgcmV0dXJuIHRoaXMucmVxdWVzdChcbiAgICAgICdzaGVldHMnLFxuICAgICAgJ0dFVCcsXG4gICAgICBgL3NwcmVhZHNoZWV0cy8ke2VuY29kZVVSSUNvbXBvbmVudChzcHJlYWRzaGVldElkKX0vdmFsdWVzLyR7ZW5jb2RlVVJJQ29tcG9uZW50KHJhbmdlKX1gLFxuICAgICAgeyBzdWJqZWN0IH0sXG4gICAgKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBXcml0ZSB2YWx1ZXMgaW50byBhIFNoZWV0cyByYW5nZS4gYG1vZGU6ICdvdmVyd3JpdGUnYCAoZGVmYXVsdCkgUFVUcyB0aGVcbiAgICogcmFuZ2UgKGB2YWx1ZXMudXBkYXRlYCk7IGBtb2RlOiAnYXBwZW5kJ2AgYXBwZW5kcyByb3dzIGFmdGVyIHRoZSB0YWJsZVxuICAgKiAoYHZhbHVlcy5hcHBlbmRgIHdpdGggYElOU0VSVF9ST1dTYCkuIGB2YWx1ZUlucHV0T3B0aW9uYCBjb250cm9scyB3aGV0aGVyXG4gICAqIGlucHV0cyBhcmUgcGFyc2VkIChgVVNFUl9FTlRFUkVEYCkgb3Igc3RvcmVkIGFzLWlzIChgUkFXYCkuXG4gICAqL1xuICBhc3luYyB3cml0ZVNoZWV0VmFsdWVzKFxuICAgIHN1YmplY3Q6IHN0cmluZyxcbiAgICBzcHJlYWRzaGVldElkOiBzdHJpbmcsXG4gICAgcmFuZ2U6IHN0cmluZyxcbiAgICB2YWx1ZXM6IHVua25vd25bXVtdLFxuICAgIHA6IHsgbW9kZT86ICdvdmVyd3JpdGUnIHwgJ2FwcGVuZCc7IHZhbHVlSW5wdXRPcHRpb24/OiBzdHJpbmcgfSA9IHt9LFxuICApOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB7XG4gICAgY29uc3QgdmFsdWVJbnB1dE9wdGlvbiA9IHAudmFsdWVJbnB1dE9wdGlvbiA/PyAnVVNFUl9FTlRFUkVEJztcbiAgICBjb25zdCBlbmNvZGVkID0gYC9zcHJlYWRzaGVldHMvJHtlbmNvZGVVUklDb21wb25lbnQoc3ByZWFkc2hlZXRJZCl9L3ZhbHVlcy8ke2VuY29kZVVSSUNvbXBvbmVudChyYW5nZSl9YDtcbiAgICBjb25zdCBib2R5ID0geyByYW5nZSwgbWFqb3JEaW1lbnNpb246ICdST1dTJywgdmFsdWVzIH07XG4gICAgaWYgKHAubW9kZSA9PT0gJ2FwcGVuZCcpIHtcbiAgICAgIHJldHVybiB0aGlzLnJlcXVlc3QoJ3NoZWV0cycsICdQT1NUJywgYCR7ZW5jb2RlZH06YXBwZW5kYCwge1xuICAgICAgICBzdWJqZWN0LFxuICAgICAgICBxdWVyeTogeyB2YWx1ZUlucHV0T3B0aW9uLCBpbnNlcnREYXRhT3B0aW9uOiAnSU5TRVJUX1JPV1MnIH0sXG4gICAgICAgIGJvZHksXG4gICAgICB9KTtcbiAgICB9XG4gICAgcmV0dXJuIHRoaXMucmVxdWVzdCgnc2hlZXRzJywgJ1BVVCcsIGVuY29kZWQsIHtcbiAgICAgIHN1YmplY3QsXG4gICAgICBxdWVyeTogeyB2YWx1ZUlucHV0T3B0aW9uIH0sXG4gICAgICBib2R5LFxuICAgIH0pO1xuICB9XG5cbiAgLyoqXG4gICAqIENyZWF0ZSBhIERyaXZlIGZpbGUgb3IgZm9sZGVyLiBNZXRhZGF0YS1vbmx5IChubyBgY29udGVudGApIGlzIGEgcGxhaW5cbiAgICogYGZpbGVzLmNyZWF0ZWAgKGZvbGRlcnMsIGVtcHR5IG5hdGl2ZSBHb29nbGUgZmlsZXMpLiBXaXRoIGBjb250ZW50YCwgYVxuICAgKiBtdWx0aXBhcnQgbWVkaWEgdXBsb2FkIGlzIHVzZWQgc28gdGhlIGJ5dGVzIGxhbmQgaW4gdGhlIG5ldyBmaWxlICh0ZXh0XG4gICAqIGNvbnRlbnQ7IG5hdGl2ZSBHb29nbGUgdHlwZXMgYXJlIGNvbnZlcnRlZCBmcm9tIGl0KS5cbiAgICovXG4gIGFzeW5jIGNyZWF0ZURyaXZlRmlsZShcbiAgICBzdWJqZWN0OiBzdHJpbmcsXG4gICAgcDoge1xuICAgICAgbmFtZTogc3RyaW5nO1xuICAgICAgbWltZVR5cGU6IHN0cmluZztcbiAgICAgIHBhcmVudHM/OiByZWFkb25seSBzdHJpbmdbXTtcbiAgICAgIGNvbnRlbnQ/OiBzdHJpbmc7XG4gICAgICBjb250ZW50TWltZVR5cGU/OiBzdHJpbmc7XG4gICAgfSxcbiAgKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4ge1xuICAgIGNvbnN0IG1ldGFkYXRhOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHsgbmFtZTogcC5uYW1lLCBtaW1lVHlwZTogcC5taW1lVHlwZSB9O1xuICAgIGlmIChwLnBhcmVudHMgJiYgcC5wYXJlbnRzLmxlbmd0aCA+IDApIG1ldGFkYXRhLnBhcmVudHMgPSBwLnBhcmVudHM7XG4gICAgY29uc3QgZmllbGRzID0gJ2lkLG5hbWUsbWltZVR5cGUsd2ViVmlld0xpbmsscGFyZW50cyc7XG5cbiAgICBpZiAocC5jb250ZW50ID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHJldHVybiB0aGlzLnJlcXVlc3QoJ2RyaXZlJywgJ1BPU1QnLCAnL2ZpbGVzJywge1xuICAgICAgICBzdWJqZWN0LFxuICAgICAgICBxdWVyeTogeyBzdXBwb3J0c0FsbERyaXZlczogdHJ1ZSwgZmllbGRzIH0sXG4gICAgICAgIGJvZHk6IG1ldGFkYXRhLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgLy8gTXVsdGlwYXJ0IG1lZGlhIHVwbG9hZDogbWV0YWRhdGEgcGFydCArIG1lZGlhIHBhcnQuXG4gICAgY29uc3QgYm91bmRhcnkgPSBgb21hZGlhLWd3LSR7TWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMil9YDtcbiAgICBjb25zdCByYXdCb2R5ID0gW1xuICAgICAgYC0tJHtib3VuZGFyeX1gLFxuICAgICAgJ0NvbnRlbnQtVHlwZTogYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD1VVEYtOCcsXG4gICAgICAnJyxcbiAgICAgIEpTT04uc3RyaW5naWZ5KG1ldGFkYXRhKSxcbiAgICAgIGAtLSR7Ym91bmRhcnl9YCxcbiAgICAgIGBDb250ZW50LVR5cGU6ICR7cC5jb250ZW50TWltZVR5cGUgPz8gJ3RleHQvcGxhaW4nfTsgY2hhcnNldD1VVEYtOGAsXG4gICAgICAnJyxcbiAgICAgIHAuY29udGVudCxcbiAgICAgIGAtLSR7Ym91bmRhcnl9LS1gLFxuICAgICAgJycsXG4gICAgXS5qb2luKCdcXHJcXG4nKTtcbiAgICByZXR1cm4gdGhpcy5yZXF1ZXN0KCdkcml2ZScsICdQT1NUJywgJ2h0dHBzOi8vd3d3Lmdvb2dsZWFwaXMuY29tL3VwbG9hZC9kcml2ZS92My9maWxlcycsIHtcbiAgICAgIHN1YmplY3QsXG4gICAgICBxdWVyeTogeyB1cGxvYWRUeXBlOiAnbXVsdGlwYXJ0Jywgc3VwcG9ydHNBbGxEcml2ZXM6IHRydWUsIGZpZWxkcyB9LFxuICAgICAgcmF3Qm9keSxcbiAgICAgIGNvbnRlbnRUeXBlOiBgbXVsdGlwYXJ0L3JlbGF0ZWQ7IGJvdW5kYXJ5PSR7Ym91bmRhcnl9YCxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKiBSZWFkIGEgc3ByZWFkc2hlZXQncyB0YWIgbWV0YWRhdGEgKHRpdGxlICsgcGVyLXRhYiBzaGVldElkL3RpdGxlL2luZGV4KS4gUkVBRC4gKi9cbiAgYXN5bmMgZ2V0U3ByZWFkc2hlZXRNZXRhKFxuICAgIHN1YmplY3Q6IHN0cmluZyxcbiAgICBzcHJlYWRzaGVldElkOiBzdHJpbmcsXG4gICk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcbiAgICByZXR1cm4gdGhpcy5yZXF1ZXN0KCdzaGVldHMnLCAnR0VUJywgYC9zcHJlYWRzaGVldHMvJHtlbmNvZGVVUklDb21wb25lbnQoc3ByZWFkc2hlZXRJZCl9YCwge1xuICAgICAgc3ViamVjdCxcbiAgICAgIHF1ZXJ5OiB7XG4gICAgICAgIGZpZWxkczpcbiAgICAgICAgICAncHJvcGVydGllcyh0aXRsZSksc2hlZXRzKHByb3BlcnRpZXMoc2hlZXRJZCx0aXRsZSxpbmRleCxncmlkUHJvcGVydGllcyhyb3dDb3VudCxjb2x1bW5Db3VudCkpKScsXG4gICAgICB9LFxuICAgIH0pO1xuICB9XG5cbiAgLyoqXG4gICAqIFJ1biBhIFNoZWV0cyBgc3ByZWFkc2hlZXRzLmJhdGNoVXBkYXRlYCAoZS5nLiBgYWRkU2hlZXRgLCBgZHVwbGljYXRlU2hlZXRgKS5cbiAgICogV1JJVEUuIFJldHVybnMgdGhlIHJhdyByZXBseSBzbyBjYWxsZXJzIGNhbiByZWFkIGJhY2sgZS5nLiB0aGUgbmV3IHNoZWV0SWQuXG4gICAqL1xuICBhc3luYyBiYXRjaFVwZGF0ZVNwcmVhZHNoZWV0KFxuICAgIHN1YmplY3Q6IHN0cmluZyxcbiAgICBzcHJlYWRzaGVldElkOiBzdHJpbmcsXG4gICAgcmVxdWVzdHM6IHVua25vd25bXSxcbiAgKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4ge1xuICAgIHJldHVybiB0aGlzLnJlcXVlc3QoXG4gICAgICAnc2hlZXRzJyxcbiAgICAgICdQT1NUJyxcbiAgICAgIGAvc3ByZWFkc2hlZXRzLyR7ZW5jb2RlVVJJQ29tcG9uZW50KHNwcmVhZHNoZWV0SWQpfTpiYXRjaFVwZGF0ZWAsXG4gICAgICB7IHN1YmplY3QsIGJvZHk6IHsgcmVxdWVzdHMgfSB9LFxuICAgICk7XG4gIH1cblxuICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gIC8vIEFkbWluIERpcmVjdG9yeSB2MSAvIFBlb3BsZSB2MVxuICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgYXN5bmMgbGlzdERpcmVjdG9yeVVzZXJzKFxuICAgIHN1YmplY3Q6IHN0cmluZyxcbiAgICBwOiB7XG4gICAgICBjdXN0b21lcj86IHN0cmluZztcbiAgICAgIGRvbWFpbj86IHN0cmluZztcbiAgICAgIHF1ZXJ5Pzogc3RyaW5nO1xuICAgICAgbWF4UmVzdWx0cz86IG51bWJlcjtcbiAgICAgIG9yZGVyQnk/OiBzdHJpbmc7XG4gICAgICBwYWdlVG9rZW4/OiBzdHJpbmc7XG4gICAgfSxcbiAgKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4ge1xuICAgIC8vIGBjdXN0b21lcmAgYW5kIGBkb21haW5gIGFyZSBtdXR1YWxseSBleGNsdXNpdmU7IGRlZmF1bHQgdG8gbXlfY3VzdG9tZXIuXG4gICAgY29uc3QgdXNlRG9tYWluID0gQm9vbGVhbihwLmRvbWFpbik7XG4gICAgcmV0dXJuIHRoaXMucmVxdWVzdCgnZGlyZWN0b3J5JywgJ0dFVCcsICcvdXNlcnMnLCB7XG4gICAgICBzdWJqZWN0LFxuICAgICAgcXVlcnk6IHtcbiAgICAgICAgY3VzdG9tZXI6IHVzZURvbWFpbiA/IHVuZGVmaW5lZCA6IHAuY3VzdG9tZXIgfHwgJ215X2N1c3RvbWVyJyxcbiAgICAgICAgZG9tYWluOiBwLmRvbWFpbixcbiAgICAgICAgcXVlcnk6IHAucXVlcnksXG4gICAgICAgIG1heFJlc3VsdHM6IHAubWF4UmVzdWx0cyxcbiAgICAgICAgb3JkZXJCeTogcC5vcmRlckJ5LFxuICAgICAgICBwYWdlVG9rZW46IHAucGFnZVRva2VuLFxuICAgICAgICBwcm9qZWN0aW9uOiAnYmFzaWMnLFxuICAgICAgICB2aWV3VHlwZTogJ2FkbWluX3ZpZXcnLFxuICAgICAgfSxcbiAgICB9KTtcbiAgfVxuXG4gIGFzeW5jIHNlYXJjaENvbnRhY3RzKFxuICAgIHN1YmplY3Q6IHN0cmluZyxcbiAgICBwOiB7IHF1ZXJ5OiBzdHJpbmc7IHBhZ2VTaXplPzogbnVtYmVyOyByZWFkTWFzaz86IHN0cmluZyB9LFxuICApOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB7XG4gICAgY29uc3QgcmVhZE1hc2sgPSBwLnJlYWRNYXNrID8/ICduYW1lcyxlbWFpbEFkZHJlc3NlcyxwaG9uZU51bWJlcnMsb3JnYW5pemF0aW9ucyc7XG4gICAgLy8gUGVvcGxlIGBzZWFyY2hDb250YWN0c2AgcmVxdWlyZXMgYSB3YXJtdXAgKGVtcHR5LXF1ZXJ5KSByZXF1ZXN0IHRvIHByaW1lXG4gICAgLy8gdGhlIHNlcnZlci1zaWRlIGNhY2hlIGJlZm9yZSB0aGUgZmlyc3QgcmVhbCBzZWFyY2gsIG90aGVyd2lzZSByZXN1bHRzXG4gICAgLy8gY29tZSBiYWNrIGVtcHR5LiBCZXN0LWVmZm9ydCwgb25jZSBwZXIgc3ViamVjdCBwZXIgcHJvY2Vzcy5cbiAgICBpZiAoIXRoaXMud2FybWVkQ29udGFjdHMuaGFzKHN1YmplY3QpKSB7XG4gICAgICB0aGlzLndhcm1lZENvbnRhY3RzLmFkZChzdWJqZWN0KTtcbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IHRoaXMucmVxdWVzdCgncGVvcGxlJywgJ0dFVCcsICcvcGVvcGxlOnNlYXJjaENvbnRhY3RzJywge1xuICAgICAgICAgIHN1YmplY3QsXG4gICAgICAgICAgcXVlcnk6IHsgcXVlcnk6ICcnLCByZWFkTWFzayB9LFxuICAgICAgICB9KTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvLyBXYXJtdXAgaXMgYmVzdC1lZmZvcnQ7IHRoZSByZWFsIHF1ZXJ5IGJlbG93IHN1cmZhY2VzIGFueSByZWFsIGVycm9yLlxuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gdGhpcy5yZXF1ZXN0KCdwZW9wbGUnLCAnR0VUJywgJy9wZW9wbGU6c2VhcmNoQ29udGFjdHMnLCB7XG4gICAgICBzdWJqZWN0LFxuICAgICAgcXVlcnk6IHsgcXVlcnk6IHAucXVlcnksIHBhZ2VTaXplOiBwLnBhZ2VTaXplLCByZWFkTWFzayB9LFxuICAgIH0pO1xuICB9XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gSGVscGVyc1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICogQnVpbGQgYSBxdWVyeSBzdHJpbmcgZnJvbSBhIGZsYXQgcmVjb3JkLiBgdW5kZWZpbmVkYCB2YWx1ZXMgYXJlIHNraXBwZWQ7XG4gKiBhcnJheXMgZXhwYW5kIGludG8gcmVwZWF0ZWQgcGFyYW1zIChlLmcuIGBsYWJlbElkcz1BJmxhYmVsSWRzPUJgKS4gUmV0dXJuc1xuICogYCcnYCB3aGVuIG5vdGhpbmcgaXMgc2V0LlxuICovXG5mdW5jdGlvbiBidWlsZFF1ZXJ5U3RyaW5nKHF1ZXJ5OiBSZWNvcmQ8c3RyaW5nLCBRdWVyeVZhbHVlPiB8IHVuZGVmaW5lZCk6IHN0cmluZyB7XG4gIGlmICghcXVlcnkpIHJldHVybiAnJztcbiAgY29uc3Qgc3AgPSBuZXcgVVJMU2VhcmNoUGFyYW1zKCk7XG4gIGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKHF1ZXJ5KSkge1xuICAgIGlmICh2YWx1ZSA9PT0gdW5kZWZpbmVkKSBjb250aW51ZTtcbiAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgIGZvciAoY29uc3QgdiBvZiB2YWx1ZSkgc3AuYXBwZW5kKGtleSwgU3RyaW5nKHYpKTtcbiAgICB9IGVsc2Uge1xuICAgICAgc3AuYXBwZW5kKGtleSwgU3RyaW5nKHZhbHVlKSk7XG4gICAgfVxuICB9XG4gIGNvbnN0IHMgPSBzcC50b1N0cmluZygpO1xuICByZXR1cm4gcyA/IGA/JHtzfWAgOiAnJztcbn1cblxuLyoqIFByb21pc2UtYmFzZWQgc2xlZXAgdXNlZCBmb3IgcmV0cnkgYmFja29mZi4gKi9cbmZ1bmN0aW9uIHNsZWVwKG1zOiBudW1iZXIpOiBQcm9taXNlPHZvaWQ+IHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiBzZXRUaW1lb3V0KHJlc29sdmUsIG1zKSk7XG59XG4iLCAiLyoqXG4gKiBUZXN0IGhlbHBlcnMgXHUyMDE0IGZha2UgYXV0aCwgYSBzY3JpcHRlZCBmZXRjaCwgYW5kIGEgSlNPTiBSZXNwb25zZSBidWlsZGVyLlxuICogTm8gbmV0d29yaywgbm8gcmVhbCBjcmVkZW50aWFscy5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IEdvb2dsZVNlcnZpY2VBY2NvdW50QXV0aCB9IGZyb20gJy4uL3NyYy9nb29nbGVBdXRoLmpzJztcblxuZXhwb3J0IGZ1bmN0aW9uIGZha2VBdXRoKCk6IHtcbiAgYXV0aDogR29vZ2xlU2VydmljZUFjY291bnRBdXRoO1xuICBzdGF0czogKCkgPT4geyB0b2tlbkNhbGxzOiBudW1iZXI7IGludmFsaWRhdGlvbnM6IG51bWJlciB9O1xufSB7XG4gIGxldCB0b2tlbkNhbGxzID0gMDtcbiAgbGV0IGludmFsaWRhdGlvbnMgPSAwO1xuICBjb25zdCBhdXRoID0ge1xuICAgIGdldFRva2VuOiBhc3luYyAoKSA9PiB7XG4gICAgICB0b2tlbkNhbGxzICs9IDE7XG4gICAgICByZXR1cm4gYHRvay0ke3Rva2VuQ2FsbHN9YDtcbiAgICB9LFxuICAgIGludmFsaWRhdGU6ICgpID0+IHtcbiAgICAgIGludmFsaWRhdGlvbnMgKz0gMTtcbiAgICB9LFxuICB9O1xuICByZXR1cm4ge1xuICAgIGF1dGg6IGF1dGggYXMgdW5rbm93biBhcyBHb29nbGVTZXJ2aWNlQWNjb3VudEF1dGgsXG4gICAgc3RhdHM6ICgpID0+ICh7IHRva2VuQ2FsbHMsIGludmFsaWRhdGlvbnMgfSksXG4gIH07XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQ2FwdHVyZWQge1xuICB1cmw6IHN0cmluZztcbiAgaW5pdDogeyBtZXRob2Q/OiBzdHJpbmc7IGhlYWRlcnM/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+OyBib2R5Pzogc3RyaW5nIH07XG59XG5cbi8qKlxuICogQSBmZXRjaCBzdHViIGRyaXZlbiBieSBhbiBhcnJheSBvZiBzdGVwIGZ1bmN0aW9ucy4gQ2FsbCBOIHVzZXMgc3RlcCBOICh0aGVcbiAqIGxhc3Qgc3RlcCByZXBlYXRzIGZvciBhbnkgZnVydGhlciBjYWxscykuIFJlY29yZHMgZXZlcnkgY2FsbC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNjcmlwdGVkRmV0Y2goc3RlcHM6IEFycmF5PChjOiBDYXB0dXJlZCkgPT4gUmVzcG9uc2U+KToge1xuICBmZXRjaEltcGw6IHR5cGVvZiBmZXRjaDtcbiAgY2FsbHM6IENhcHR1cmVkW107XG59IHtcbiAgY29uc3QgY2FsbHM6IENhcHR1cmVkW10gPSBbXTtcbiAgbGV0IGkgPSAwO1xuICBjb25zdCBmZXRjaEltcGwgPSAoYXN5bmMgKHVybDogc3RyaW5nLCBpbml0OiBDYXB0dXJlZFsnaW5pdCddKSA9PiB7XG4gICAgY29uc3QgYzogQ2FwdHVyZWQgPSB7IHVybCwgaW5pdDogaW5pdCA/PyB7fSB9O1xuICAgIGNhbGxzLnB1c2goYyk7XG4gICAgY29uc3Qgc3RlcCA9IHN0ZXBzW01hdGgubWluKGksIHN0ZXBzLmxlbmd0aCAtIDEpXTtcbiAgICBpICs9IDE7XG4gICAgcmV0dXJuIHN0ZXAoYyk7XG4gIH0pIGFzIHVua25vd24gYXMgdHlwZW9mIGZldGNoO1xuICByZXR1cm4geyBmZXRjaEltcGwsIGNhbGxzIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBqc29uKG9iajogdW5rbm93biwgc3RhdHVzID0gMjAwKTogUmVzcG9uc2Uge1xuICByZXR1cm4gbmV3IFJlc3BvbnNlKEpTT04uc3RyaW5naWZ5KG9iaiksIHtcbiAgICBzdGF0dXMsXG4gICAgaGVhZGVyczogeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nIH0sXG4gIH0pO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIjtBQUFBLE9BQU8sVUFBVTtBQUNqQixPQUFPLFlBQVk7OztBQ2NaLElBQU0saUJBQU4sY0FBNkIsTUFBTTtBQUFBLEVBQ3hDLFlBQ2tCLFFBQ0EsUUFDaEIsU0FDQTtBQUNBLFVBQU0sT0FBTztBQUpHO0FBQ0E7QUFJaEIsU0FBSyxPQUFPO0FBQUEsRUFDZDtBQUNGOzs7QUNJQSxJQUFNLFdBQXNDO0FBQUEsRUFDMUMsVUFBVTtBQUFBLEVBQ1YsT0FBTztBQUFBLEVBQ1AsT0FBTztBQUFBLEVBQ1AsTUFBTTtBQUFBLEVBQ04sUUFBUTtBQUFBLEVBQ1Is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
