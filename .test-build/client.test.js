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
    const url = `${API_BASE[api]}${path}${buildQueryString(opts.query)}`;
    const send = async () => {
      const token = await this.auth.getToken(opts.subject, this.scopes);
      const headers = {
        Authorization: `Bearer ${token}`,
        Accept: "application/json"
      };
      let serialized;
      if (opts.body !== void 0) {
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vdGVzdHMvY2xpZW50LnRlc3QudHMiLCAiLi4vc3JjL2Vycm9ycy50cyIsICIuLi9zcmMvZ29vZ2xlQ2xpZW50LnRzIiwgIi4uL3Rlc3RzL19oZWxwZXJzLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdGVzdCBmcm9tICdub2RlOnRlc3QnO1xuaW1wb3J0IGFzc2VydCBmcm9tICdub2RlOmFzc2VydC9zdHJpY3QnO1xuXG5pbXBvcnQgeyBHb29nbGVXb3Jrc3BhY2VDbGllbnQgfSBmcm9tICcuLi9zcmMvZ29vZ2xlQ2xpZW50LmpzJztcbmltcG9ydCB7IEdvb2dsZUFwaUVycm9yIH0gZnJvbSAnLi4vc3JjL2Vycm9ycy5qcyc7XG5pbXBvcnQgeyBmYWtlQXV0aCwgc2NyaXB0ZWRGZXRjaCwganNvbiB9IGZyb20gJy4vX2hlbHBlcnMuanMnO1xuXG50ZXN0KCdsaXN0RXZlbnRzIGJ1aWxkcyB0aGUgY2FsZW5kYXIgVVJMIGFuZCByZXR1cm5zIHRoZSBwYXJzZWQgYm9keSArIG5leHRQYWdlVG9rZW4nLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHsgYXV0aCB9ID0gZmFrZUF1dGgoKTtcbiAgY29uc3QgeyBmZXRjaEltcGwsIGNhbGxzIH0gPSBzY3JpcHRlZEZldGNoKFtcbiAgICAoKSA9PiBqc29uKHsgaXRlbXM6IFt7IGlkOiAnZTEnIH1dLCBuZXh0UGFnZVRva2VuOiAnbnAnIH0pLFxuICBdKTtcbiAgY29uc3QgY2xpZW50ID0gbmV3IEdvb2dsZVdvcmtzcGFjZUNsaWVudCh7IGF1dGgsIHNjb3BlczogWydzJ10sIGZldGNoOiBmZXRjaEltcGwgfSk7XG4gIGNvbnN0IHIgPSBhd2FpdCBjbGllbnQubGlzdEV2ZW50cygndUB4LmNvbScsIHtcbiAgICB0aW1lTWluOiAnMjAyNi0wMS0wMVQwMDowMDowMFonLFxuICAgIG1heFJlc3VsdHM6IDEwLFxuICAgIHNpbmdsZUV2ZW50czogdHJ1ZSxcbiAgfSk7XG4gIGFzc2VydC5tYXRjaChjYWxsc1swXS51cmwsIC9eaHR0cHM6XFwvXFwvd3d3XFwuZ29vZ2xlYXBpc1xcLmNvbVxcL2NhbGVuZGFyXFwvdjNcXC9jYWxlbmRhcnNcXC9wcmltYXJ5XFwvZXZlbnRzXFw/Lyk7XG4gIGFzc2VydC5tYXRjaChjYWxsc1swXS51cmwsIC90aW1lTWluPTIwMjYvKTtcbiAgYXNzZXJ0LmVxdWFsKChyLml0ZW1zIGFzIHVua25vd25bXSkubGVuZ3RoLCAxKTtcbiAgYXNzZXJ0LmVxdWFsKHIubmV4dFBhZ2VUb2tlbiwgJ25wJyk7XG59KTtcblxudGVzdCgnNDAxIHJlLW1pbnRzIHRoZSB0b2tlbiBhbmQgcmV0cmllcyBvbmNlJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB7IGF1dGgsIHN0YXRzIH0gPSBmYWtlQXV0aCgpO1xuICBjb25zdCB7IGZldGNoSW1wbCwgY2FsbHMgfSA9IHNjcmlwdGVkRmV0Y2goW1xuICAgICgpID0+IG5ldyBSZXNwb25zZSgnJywgeyBzdGF0dXM6IDQwMSB9KSxcbiAgICAoKSA9PiBqc29uKHsgb2s6IHRydWUgfSksXG4gIF0pO1xuICBjb25zdCBjbGllbnQgPSBuZXcgR29vZ2xlV29ya3NwYWNlQ2xpZW50KHsgYXV0aCwgc2NvcGVzOiBbJ3MnXSwgZmV0Y2g6IGZldGNoSW1wbCwgcmV0cnlCYXNlTXM6IDAgfSk7XG4gIGNvbnN0IHIgPSBhd2FpdCBjbGllbnQuZ2V0TWVzc2FnZSgndUB4LmNvbScsICdpZDEnKTtcbiAgYXNzZXJ0LmVxdWFsKGNhbGxzLmxlbmd0aCwgMik7XG4gIGFzc2VydC5lcXVhbChzdGF0cygpLmludmFsaWRhdGlvbnMsIDEpO1xuICBhc3NlcnQuZXF1YWwoci5vaywgdHJ1ZSk7XG59KTtcblxudGVzdCgnNDI5IGJhY2tzIG9mZiBhbmQgcmV0cmllcywgdGhlbiBzdWNjZWVkcycsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgeyBhdXRoIH0gPSBmYWtlQXV0aCgpO1xuICBjb25zdCB7IGZldGNoSW1wbCwgY2FsbHMgfSA9IHNjcmlwdGVkRmV0Y2goW1xuICAgICgpID0+IG5ldyBSZXNwb25zZSgnJywgeyBzdGF0dXM6IDQyOSB9KSxcbiAgICAoKSA9PiBuZXcgUmVzcG9uc2UoJycsIHsgc3RhdHVzOiA0MjkgfSksXG4gICAgKCkgPT4ganNvbih7IGRvbmU6IHRydWUgfSksXG4gIF0pO1xuICBjb25zdCBjbGllbnQgPSBuZXcgR29vZ2xlV29ya3NwYWNlQ2xpZW50KHtcbiAgICBhdXRoLFxuICAgIHNjb3BlczogWydzJ10sXG4gICAgZmV0Y2g6IGZldGNoSW1wbCxcbiAgICByZXRyeUJhc2VNczogMCxcbiAgICBtYXhSZXRyaWVzOiAzLFxuICB9KTtcbiAgY29uc3QgciA9IGF3YWl0IGNsaWVudC5saXN0RXZlbnRzKCd1QHguY29tJywge30pO1xuICBhc3NlcnQuZXF1YWwoY2FsbHMubGVuZ3RoLCAzKTtcbiAgYXNzZXJ0LmVxdWFsKHIuZG9uZSwgdHJ1ZSk7XG59KTtcblxudGVzdCgnNDI5IHRoYXQgbmV2ZXIgY2xlYXJzIGV4aGF1c3RzIHJldHJpZXMgYW5kIHRocm93cyBHb29nbGVBcGlFcnJvcicsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgeyBhdXRoIH0gPSBmYWtlQXV0aCgpO1xuICBjb25zdCB7IGZldGNoSW1wbCwgY2FsbHMgfSA9IHNjcmlwdGVkRmV0Y2goW1xuICAgICgpID0+IGpzb24oeyBlcnJvcjogeyBjb2RlOiA0MjksIG1lc3NhZ2U6ICdyYXRlJywgc3RhdHVzOiAnUkVTT1VSQ0VfRVhIQVVTVEVEJyB9IH0sIDQyOSksXG4gIF0pO1xuICBjb25zdCBjbGllbnQgPSBuZXcgR29vZ2xlV29ya3NwYWNlQ2xpZW50KHtcbiAgICBhdXRoLFxuICAgIHNjb3BlczogWydzJ10sXG4gICAgZmV0Y2g6IGZldGNoSW1wbCxcbiAgICByZXRyeUJhc2VNczogMCxcbiAgICBtYXhSZXRyaWVzOiAyLFxuICB9KTtcbiAgYXdhaXQgYXNzZXJ0LnJlamVjdHMoXG4gICAgKCkgPT4gY2xpZW50Lmxpc3RFdmVudHMoJ3VAeC5jb20nLCB7fSksXG4gICAgKGUpID0+IGUgaW5zdGFuY2VvZiBHb29nbGVBcGlFcnJvciAmJiBlLnN0YXR1cyA9PT0gNDI5LFxuICApO1xuICBhc3NlcnQuZXF1YWwoY2FsbHMubGVuZ3RoLCAzKTsgLy8gaW5pdGlhbCArIDIgcmV0cmllc1xufSk7XG5cbnRlc3QoJzR4eCBwYXJzZXMgdGhlIEdvb2dsZSBlcnJvciBlbnZlbG9wZSAoc3RhdHVzIFx1MjE5MiByZWFzb24pJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB7IGF1dGggfSA9IGZha2VBdXRoKCk7XG4gIGNvbnN0IHsgZmV0Y2hJbXBsIH0gPSBzY3JpcHRlZEZldGNoKFtcbiAgICAoKSA9PiBqc29uKHsgZXJyb3I6IHsgY29kZTogNDA0LCBtZXNzYWdlOiAnTm90IEZvdW5kJywgc3RhdHVzOiAnTk9UX0ZPVU5EJyB9IH0sIDQwNCksXG4gIF0pO1xuICBjb25zdCBjbGllbnQgPSBuZXcgR29vZ2xlV29ya3NwYWNlQ2xpZW50KHsgYXV0aCwgc2NvcGVzOiBbJ3MnXSwgZmV0Y2g6IGZldGNoSW1wbCB9KTtcbiAgYXdhaXQgYXNzZXJ0LnJlamVjdHMoXG4gICAgKCkgPT4gY2xpZW50LmdldEZpbGUoJ3VAeC5jb20nLCAnZjEnKSxcbiAgICAoZSkgPT4gZSBpbnN0YW5jZW9mIEdvb2dsZUFwaUVycm9yICYmIGUuc3RhdHVzID09PSA0MDQgJiYgZS5yZWFzb24gPT09ICdOT1RfRk9VTkQnLFxuICApO1xufSk7XG5cbnRlc3QoJ2EgcmVzcG9uc2UgbGFyZ2VyIHRoYW4gbWF4Qnl0ZXMgdGhyb3dzIFJlc3BvbnNlVG9vTGFyZ2UnLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHsgYXV0aCB9ID0gZmFrZUF1dGgoKTtcbiAgY29uc3QgYmlnID0gJ3gnLnJlcGVhdCgyMDAwKTtcbiAgY29uc3QgeyBmZXRjaEltcGwgfSA9IHNjcmlwdGVkRmV0Y2goWygpID0+IG5ldyBSZXNwb25zZShiaWcsIHsgc3RhdHVzOiAyMDAgfSldKTtcbiAgY29uc3QgY2xpZW50ID0gbmV3IEdvb2dsZVdvcmtzcGFjZUNsaWVudCh7IGF1dGgsIHNjb3BlczogWydzJ10sIGZldGNoOiBmZXRjaEltcGwsIG1heEJ5dGVzOiAxMDAgfSk7XG4gIGF3YWl0IGFzc2VydC5yZWplY3RzKFxuICAgICgpID0+IGNsaWVudC5nZXREb2N1bWVudCgndUB4LmNvbScsICdkMScpLFxuICAgIChlKSA9PiBlIGluc3RhbmNlb2YgR29vZ2xlQXBpRXJyb3IgJiYgL2V4Y2VlZHMgbWF4Qnl0ZXMvLnRlc3QoZS5tZXNzYWdlKSxcbiAgKTtcbn0pO1xuXG50ZXN0KCdzZWFyY2hDb250YWN0cyB3YXJtcyB1cCBvbmNlIHBlciBzdWJqZWN0LCB0aGVuIHF1ZXJpZXMnLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHsgYXV0aCB9ID0gZmFrZUF1dGgoKTtcbiAgY29uc3QgeyBmZXRjaEltcGwsIGNhbGxzIH0gPSBzY3JpcHRlZEZldGNoKFsoKSA9PiBqc29uKHsgcmVzdWx0czogW10gfSldKTtcbiAgY29uc3QgY2xpZW50ID0gbmV3IEdvb2dsZVdvcmtzcGFjZUNsaWVudCh7IGF1dGgsIHNjb3BlczogWydzJ10sIGZldGNoOiBmZXRjaEltcGwgfSk7XG5cbiAgYXdhaXQgY2xpZW50LnNlYXJjaENvbnRhY3RzKCd1QHguY29tJywgeyBxdWVyeTogJ2FubmEnIH0pO1xuICBhc3NlcnQuZXF1YWwoY2FsbHMubGVuZ3RoLCAyKTsgLy8gd2FybXVwIChlbXB0eSBxdWVyeSkgKyByZWFsXG4gIGFzc2VydC5tYXRjaChjYWxsc1swXS51cmwsIC9bPyZdcXVlcnk9Ji8pO1xuICBhc3NlcnQubWF0Y2goY2FsbHNbMV0udXJsLCAvWz8mXXF1ZXJ5PWFubmEvKTtcblxuICBhd2FpdCBjbGllbnQuc2VhcmNoQ29udGFjdHMoJ3VAeC5jb20nLCB7IHF1ZXJ5OiAnYm9iJyB9KTtcbiAgYXNzZXJ0LmVxdWFsKGNhbGxzLmxlbmd0aCwgMyk7IC8vIG5vIHNlY29uZCB3YXJtdXAgZm9yIHNhbWUgc3ViamVjdFxufSk7XG5cbnRlc3QoJ3NlYXJjaEZpbGVzIHJlcXVlc3RzIGRlZmF1bHQgZmllbGRzICsgcGFzc2VzIHBhZ2VUb2tlbicsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgeyBhdXRoIH0gPSBmYWtlQXV0aCgpO1xuICBjb25zdCB7IGZldGNoSW1wbCwgY2FsbHMgfSA9IHNjcmlwdGVkRmV0Y2goWygpID0+IGpzb24oeyBmaWxlczogW10sIG5leHRQYWdlVG9rZW46ICduMicgfSldKTtcbiAgY29uc3QgY2xpZW50ID0gbmV3IEdvb2dsZVdvcmtzcGFjZUNsaWVudCh7IGF1dGgsIHNjb3BlczogWydzJ10sIGZldGNoOiBmZXRjaEltcGwgfSk7XG4gIGNvbnN0IHIgPSBhd2FpdCBjbGllbnQuc2VhcmNoRmlsZXMoJ3VAeC5jb20nLCB7IHE6IFwibmFtZSBjb250YWlucyAneCdcIiwgcGFnZVRva2VuOiAndG9rMicgfSk7XG4gIGFzc2VydC5tYXRjaChjYWxsc1swXS51cmwsIC9uZXh0UGFnZVRva2VuLyk7XG4gIGFzc2VydC5tYXRjaChjYWxsc1swXS51cmwsIC9wYWdlVG9rZW49dG9rMi8pO1xuICBhc3NlcnQuZXF1YWwoci5uZXh0UGFnZVRva2VuLCAnbjInKTtcbn0pO1xuIiwgIi8qKlxuICogRXJyb3IgdHlwZXMgc2hhcmVkIGFjcm9zcyB0aGUgR29vZ2xlIFdvcmtzcGFjZSBpbnRlZ3JhdGlvbiwgcGx1cyBhIHNpbmdsZVxuICogYGZvcm1hdFRvb2xFcnJvcmAgdGhhdCB0dXJucyBhbnkgdGhyb3duIGVycm9yIGludG8gYSBzaG9ydCwgbW9kZWwtcmVhZGFibGVcbiAqIHN0cmluZyB3aXRoIG5vIHN0YWNrIHRyYWNlcyBvciBzZWNyZXRzLlxuICovXG5cbi8qKiBSYWlzZWQgd2hlbiB0aGUgc2VydmljZS1hY2NvdW50IEpXVC1iZWFyZXIgdG9rZW4gZXhjaGFuZ2UgZmFpbHMuICovXG5leHBvcnQgY2xhc3MgR29vZ2xlQXV0aEVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICBjb25zdHJ1Y3RvcihtZXNzYWdlOiBzdHJpbmcpIHtcbiAgICBzdXBlcihtZXNzYWdlKTtcbiAgICB0aGlzLm5hbWUgPSAnR29vZ2xlQXV0aEVycm9yJztcbiAgfVxufVxuXG4vKiogUmFpc2VkIHdoZW4gYSBHb29nbGUgQVBJIHJlc3BvbmRzIHdpdGggYSBub24tMnh4IHN0YXR1cy4gKi9cbmV4cG9ydCBjbGFzcyBHb29nbGVBcGlFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgY29uc3RydWN0b3IoXG4gICAgcHVibGljIHJlYWRvbmx5IHN0YXR1czogbnVtYmVyLFxuICAgIHB1YmxpYyByZWFkb25seSByZWFzb246IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgICBtZXNzYWdlOiBzdHJpbmcsXG4gICkge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICAgIHRoaXMubmFtZSA9ICdHb29nbGVBcGlFcnJvcic7XG4gIH1cbn1cblxuLyoqIFJhaXNlZCBieSBjbGllbnQtc2lkZSBhcmd1bWVudCB2YWxpZGF0aW9uIGJlZm9yZSBhbnkgbmV0d29yayBjYWxsLiAqL1xuZXhwb3J0IGNsYXNzIEdvb2dsZUlucHV0RXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIGNvbnN0cnVjdG9yKG1lc3NhZ2U6IHN0cmluZykge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICAgIHRoaXMubmFtZSA9ICdHb29nbGVJbnB1dEVycm9yJztcbiAgfVxufVxuXG4vKipcbiAqIFR1cm4gY2xpZW50IGVycm9ycyBpbnRvIGEgc2hvcnQsIG1vZGVsLXJlYWRhYmxlIG1lc3NhZ2UuIE5ldmVyIGxlYWtzIHRoZVxuICogcHJpdmF0ZSBrZXksIGFjY2VzcyB0b2tlbiwgb3IgYSBzdGFjayB0cmFjZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdFRvb2xFcnJvcihlcnI6IHVua25vd24pOiBzdHJpbmcge1xuICBpZiAoZXJyIGluc3RhbmNlb2YgR29vZ2xlQXV0aEVycm9yKSB7XG4gICAgcmV0dXJuIGBFcnJvcjogR29vZ2xlIFdvcmtzcGFjZSBhdXRoZW50aWNhdGlvbiBmYWlsZWQgXHUyMDE0ICR7ZXJyLm1lc3NhZ2V9LiBDaGVjayB0aGUgc2VydmljZS1hY2NvdW50IGNsaWVudCBlbWFpbCArIHByaXZhdGUga2V5LCB0aGF0IGRvbWFpbi13aWRlIGRlbGVnYXRpb24gaXMgY29uZmlndXJlZCBpbiB0aGUgQWRtaW4gY29uc29sZSBmb3IgdGhlIHJlcXVpcmVkIHNjb3BlcywgYW5kIHRoYXQgdGhlIGltcGVyc29uYXRlZCB1c2VyIGV4aXN0cy5gO1xuICB9XG4gIGlmIChlcnIgaW5zdGFuY2VvZiBHb29nbGVBcGlFcnJvcikge1xuICAgIGNvbnN0IHJlYXNvbiA9IGVyci5yZWFzb24gPyBgIFske2Vyci5yZWFzb259XWAgOiAnJztcbiAgICByZXR1cm4gYEVycm9yOiBHb29nbGUgQVBJIHJldHVybmVkIEhUVFAgJHtlcnIuc3RhdHVzfSR7cmVhc29ufTogJHtlcnIubWVzc2FnZX1gO1xuICB9XG4gIGlmIChlcnIgaW5zdGFuY2VvZiBHb29nbGVJbnB1dEVycm9yKSB7XG4gICAgcmV0dXJuIGBFcnJvcjogJHtlcnIubWVzc2FnZX1gO1xuICB9XG4gIHJldHVybiBgRXJyb3I6ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWA7XG59XG4iLCAiLyoqXG4gKiBHb29nbGVXb3Jrc3BhY2VDbGllbnQgXHUyMDE0IGEgdGhpbiwgcmVhZC1tb3N0bHkgd3JhcHBlciBvdmVyIHRoZSBHb29nbGUgV29ya3NwYWNlXG4gKiBSRVNUIEFQSXMgKENhbGVuZGFyLCBHbWFpbCwgRHJpdmUsIERvY3MsIFNoZWV0cywgQWRtaW4gRGlyZWN0b3J5LCBQZW9wbGUpLlxuICpcbiAqIEF1dGggaXMgc2VydmljZS1hY2NvdW50ICoqZG9tYWluLXdpZGUgZGVsZWdhdGlvbioqOiBldmVyeSBjYWxsIGltcGVyc29uYXRlcyBhXG4gKiBgc3ViamVjdGAgKGEgV29ya3NwYWNlIHVzZXIncyBlbWFpbCkgdmlhIHtAbGluayBHb29nbGVTZXJ2aWNlQWNjb3VudEF1dGh9LlxuICogQWxsIGVncmVzcyBnb2VzIHRocm91Z2ggdGhlIGluamVjdGVkIGBmZXRjaGAgXHUyMDE0IGluIHRoZSBwbHVnaW4gdGhpcyBpc1xuICogYGN0eC5odHRwLmZldGNoYCwgYWxsb3ctbGlzdGVkICsgcmF0ZS1saW1pdGVkIGJ5IHRoZSBob3N0LiBUaGUgY2xpZW50IG5ldmVyXG4gKiB0b3VjaGVzIGdsb2JhbCBgZmV0Y2hgLCBzbyBpdCBzdGF5cyBpbnNpZGUgdGhlIGtlcm5lbCdzIGF1ZGl0YWJsZSBib3VuZGFyeS5cbiAqXG4gKiBSZXNwb25zZXMgYXJlIHNpemUtY2FwcGVkIChgbWF4Qnl0ZXNgKSBiZWZvcmUgYEpTT04ucGFyc2VgIHNvIGEgcGF0aG9sb2dpY2FsXG4gKiB1bmJvdW5kZWQgbGlzdCBjYW4ndCBibG93IHVwIHRoZSBob3N0J3MgbWVtb3J5LiBFYWNoIHB1YmxpYyBtZXRob2QgbmFtZXMgdGhlXG4gKiBzdXJmYWNlIGl0IHRhbGtzIHRvOyB0aGUgcHJpdmF0ZSBgcmVxdWVzdCgpYCByZXNvbHZlcyB0aGUgY29ycmVjdCBBUEkgaG9zdC5cbiAqL1xuXG5pbXBvcnQgeyBHb29nbGVBcGlFcnJvciB9IGZyb20gJy4vZXJyb3JzLmpzJztcbmltcG9ydCB0eXBlIHsgR29vZ2xlU2VydmljZUFjY291bnRBdXRoIH0gZnJvbSAnLi9nb29nbGVBdXRoLmpzJztcblxuZXhwb3J0IHR5cGUgR29vZ2xlQXBpID1cbiAgfCAnY2FsZW5kYXInXG4gIHwgJ2dtYWlsJ1xuICB8ICdkcml2ZSdcbiAgfCAnZG9jcydcbiAgfCAnc2hlZXRzJ1xuICB8ICdkaXJlY3RvcnknXG4gIHwgJ3Blb3BsZSc7XG5cbi8qKiBCYXNlIFVSTCBwZXIgQVBJIChob3N0ICsgdmVyc2lvbiBwcmVmaXgpLiBIb3N0cyBhcmUgbWFuaWZlc3QtYWxsb3ctbGlzdGVkLiAqL1xuY29uc3QgQVBJX0JBU0U6IFJlY29yZDxHb29nbGVBcGksIHN0cmluZz4gPSB7XG4gIGNhbGVuZGFyOiAnaHR0cHM6Ly93d3cuZ29vZ2xlYXBpcy5jb20vY2FsZW5kYXIvdjMnLFxuICBnbWFpbDogJ2h0dHBzOi8vZ21haWwuZ29vZ2xlYXBpcy5jb20vZ21haWwvdjEnLFxuICBkcml2ZTogJ2h0dHBzOi8vd3d3Lmdvb2dsZWFwaXMuY29tL2RyaXZlL3YzJyxcbiAgZG9jczogJ2h0dHBzOi8vZG9jcy5nb29nbGVhcGlzLmNvbS92MScsXG4gIHNoZWV0czogJ2h0dHBzOi8vc2hlZXRzLmdvb2dsZWFwaXMuY29tL3Y0JyxcbiAgZGlyZWN0b3J5OiAnaHR0cHM6Ly9hZG1pbi5nb29nbGVhcGlzLmNvbS9hZG1pbi9kaXJlY3RvcnkvdjEnLFxuICBwZW9wbGU6ICdodHRwczovL3Blb3BsZS5nb29nbGVhcGlzLmNvbS92MScsXG59O1xuXG5jb25zdCBERUZBVUxUX01BWF9CWVRFUyA9IDEwMjQgKiAxMDI0OyAvLyAxIE1pQlxuY29uc3QgREVGQVVMVF9SRVRSWV9CQVNFX01TID0gNTAwO1xuY29uc3QgREVGQVVMVF9NQVhfUkVUUklFUyA9IDM7XG4vKiogVHJhbnNpZW50IHN0YXR1c2VzIHdvcnRoIHJldHJ5aW5nIHdpdGggZXhwb25lbnRpYWwgYmFja29mZi4gKi9cbmNvbnN0IFJFVFJZQUJMRV9TVEFUVVMgPSBuZXcgU2V0KFs0MjksIDUwMCwgNTAyLCA1MDMsIDUwNF0pO1xuXG4vKiogR29vZ2xlIEpTT04gZXJyb3IgZW52ZWxvcGUgKFJFU1QpOiBgeyBlcnJvcjogeyBjb2RlLCBtZXNzYWdlLCBzdGF0dXMsIGVycm9ycyB9IH1gLiAqL1xuaW50ZXJmYWNlIEdvb2dsZUVycm9yRW52ZWxvcGUge1xuICByZWFkb25seSBlcnJvcj86IHtcbiAgICByZWFkb25seSBjb2RlPzogbnVtYmVyO1xuICAgIHJlYWRvbmx5IG1lc3NhZ2U/OiBzdHJpbmc7XG4gICAgcmVhZG9ubHkgc3RhdHVzPzogc3RyaW5nO1xuICAgIHJlYWRvbmx5IGVycm9ycz86IFJlYWRvbmx5QXJyYXk8eyByZWFkb25seSByZWFzb24/OiBzdHJpbmc7IHJlYWRvbmx5IG1lc3NhZ2U/OiBzdHJpbmcgfT47XG4gIH07XG59XG5cbnR5cGUgUXVlcnlWYWx1ZSA9IHN0cmluZyB8IG51bWJlciB8IGJvb2xlYW4gfCByZWFkb25seSBzdHJpbmdbXSB8IHVuZGVmaW5lZDtcblxuZXhwb3J0IGludGVyZmFjZSBHb29nbGVXb3Jrc3BhY2VDbGllbnRPcHRpb25zIHtcbiAgcmVhZG9ubHkgYXV0aDogR29vZ2xlU2VydmljZUFjY291bnRBdXRoO1xuICAvKiogVGhlIHVuaW9uIHNjb3BlIHNldCB0aGUgYWNjZXNzIHRva2VuIGlzIHJlcXVlc3RlZCB3aXRoLiAqL1xuICByZWFkb25seSBzY29wZXM6IHJlYWRvbmx5IHN0cmluZ1tdO1xuICAvKiogSGFyZCBjYXAgb24gYSBzaW5nbGUgcmVzcG9uc2UgYm9keSBpbiBieXRlcy4gRGVmYXVsdHMgdG8gMSBNaUIuICovXG4gIHJlYWRvbmx5IG1heEJ5dGVzPzogbnVtYmVyO1xuICAvKiogQmFzZSBkZWxheSBmb3IgZXhwb25lbnRpYWwgYmFja29mZiBvbiB0cmFuc2llbnQgZXJyb3JzIChtcykuIERlZmF1bHQgNTAwLiAqL1xuICByZWFkb25seSByZXRyeUJhc2VNcz86IG51bWJlcjtcbiAgLyoqIE1heCByZXRyaWVzIG9uIHRyYW5zaWVudCAoNDI5LzV4eCkgZXJyb3JzLiBEZWZhdWx0IDMuICovXG4gIHJlYWRvbmx5IG1heFJldHJpZXM/OiBudW1iZXI7XG4gIC8qKiBJbmplY3RlZCBmZXRjaCAocHJvZHVjdGlvbjogYGN0eC5odHRwLmZldGNoYCkuICovXG4gIHJlYWRvbmx5IGZldGNoOiB0eXBlb2YgZmV0Y2g7XG4gIC8qKiBPcHRpb25hbCBzdHJ1Y3R1cmVkIGxvZ2dlci4gKi9cbiAgcmVhZG9ubHkgbG9nPzogKG1lc3NhZ2U6IHN0cmluZykgPT4gdm9pZDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBSZXF1ZXN0T3B0aW9ucyB7XG4gIC8qKiBXb3Jrc3BhY2UgdXNlciB0byBpbXBlcnNvbmF0ZSAoRFdEIGBzdWJgKS4gKi9cbiAgcmVhZG9ubHkgc3ViamVjdDogc3RyaW5nO1xuICByZWFkb25seSBxdWVyeT86IFJlY29yZDxzdHJpbmcsIFF1ZXJ5VmFsdWU+O1xuICByZWFkb25seSBib2R5PzogdW5rbm93bjtcbn1cblxuZXhwb3J0IGNsYXNzIEdvb2dsZVdvcmtzcGFjZUNsaWVudCB7XG4gIHByaXZhdGUgcmVhZG9ubHkgYXV0aDogR29vZ2xlU2VydmljZUFjY291bnRBdXRoO1xuICBwcml2YXRlIHJlYWRvbmx5IHNjb3BlczogcmVhZG9ubHkgc3RyaW5nW107XG4gIHByaXZhdGUgcmVhZG9ubHkgbWF4Qnl0ZXM6IG51bWJlcjtcbiAgcHJpdmF0ZSByZWFkb25seSByZXRyeUJhc2VNczogbnVtYmVyO1xuICBwcml2YXRlIHJlYWRvbmx5IG1heFJldHJpZXM6IG51bWJlcjtcbiAgcHJpdmF0ZSByZWFkb25seSBmZXRjaEltcGw6IHR5cGVvZiBmZXRjaDtcbiAgcHJpdmF0ZSByZWFkb25seSBsb2c6IChtZXNzYWdlOiBzdHJpbmcpID0+IHZvaWQ7XG4gIC8qKiBTdWJqZWN0cyB3aG9zZSBQZW9wbGUgY29udGFjdHMgY2FjaGUgaGFzIGJlZW4gd2FybWVkIHRoaXMgcHJvY2Vzcy4gKi9cbiAgcHJpdmF0ZSByZWFkb25seSB3YXJtZWRDb250YWN0cyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXG4gIGNvbnN0cnVjdG9yKG9wdHM6IEdvb2dsZVdvcmtzcGFjZUNsaWVudE9wdGlvbnMpIHtcbiAgICB0aGlzLmF1dGggPSBvcHRzLmF1dGg7XG4gICAgdGhpcy5zY29wZXMgPSBvcHRzLnNjb3BlcztcbiAgICB0aGlzLm1heEJ5dGVzID0gb3B0cy5tYXhCeXRlcyAmJiBvcHRzLm1heEJ5dGVzID4gMCA/IG9wdHMubWF4Qnl0ZXMgOiBERUZBVUxUX01BWF9CWVRFUztcbiAgICB0aGlzLnJldHJ5QmFzZU1zID1cbiAgICAgIHR5cGVvZiBvcHRzLnJldHJ5QmFzZU1zID09PSAnbnVtYmVyJyAmJiBvcHRzLnJldHJ5QmFzZU1zID49IDBcbiAgICAgICAgPyBvcHRzLnJldHJ5QmFzZU1zXG4gICAgICAgIDogREVGQVVMVF9SRVRSWV9CQVNFX01TO1xuICAgIHRoaXMubWF4UmV0cmllcyA9XG4gICAgICB0eXBlb2Ygb3B0cy5tYXhSZXRyaWVzID09PSAnbnVtYmVyJyAmJiBvcHRzLm1heFJldHJpZXMgPj0gMFxuICAgICAgICA/IG9wdHMubWF4UmV0cmllc1xuICAgICAgICA6IERFRkFVTFRfTUFYX1JFVFJJRVM7XG4gICAgdGhpcy5mZXRjaEltcGwgPSBvcHRzLmZldGNoO1xuICAgIHRoaXMubG9nID0gb3B0cy5sb2cgPz8gKCgpID0+IHt9KTtcbiAgfVxuXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgLy8gQ29yZSByZXF1ZXN0IFx1MjAxNCBvbmUgcmV0cnkgb24gNDAxIChleHBpcmVkL3JvdGF0ZWQgdG9rZW4pLlxuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIHByaXZhdGUgYXN5bmMgcmVxdWVzdDxUID0gUmVjb3JkPHN0cmluZywgdW5rbm93bj4+KFxuICAgIGFwaTogR29vZ2xlQXBpLFxuICAgIG1ldGhvZDogc3RyaW5nLFxuICAgIHBhdGg6IHN0cmluZyxcbiAgICBvcHRzOiBSZXF1ZXN0T3B0aW9ucyxcbiAgKTogUHJvbWlzZTxUPiB7XG4gICAgY29uc3QgdXJsID0gYCR7QVBJX0JBU0VbYXBpXX0ke3BhdGh9JHtidWlsZFF1ZXJ5U3RyaW5nKG9wdHMucXVlcnkpfWA7XG4gICAgY29uc3Qgc2VuZCA9IGFzeW5jICgpOiBQcm9taXNlPFJlc3BvbnNlPiA9PiB7XG4gICAgICBjb25zdCB0b2tlbiA9IGF3YWl0IHRoaXMuYXV0aC5nZXRUb2tlbihvcHRzLnN1YmplY3QsIHRoaXMuc2NvcGVzKTtcbiAgICAgIGNvbnN0IGhlYWRlcnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gICAgICAgIEF1dGhvcml6YXRpb246IGBCZWFyZXIgJHt0b2tlbn1gLFxuICAgICAgICBBY2NlcHQ6ICdhcHBsaWNhdGlvbi9qc29uJyxcbiAgICAgIH07XG4gICAgICBsZXQgc2VyaWFsaXplZDogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAgICAgaWYgKG9wdHMuYm9keSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGhlYWRlcnNbJ0NvbnRlbnQtVHlwZSddID0gJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnO1xuICAgICAgICBzZXJpYWxpemVkID0gSlNPTi5zdHJpbmdpZnkob3B0cy5ib2R5KTtcbiAgICAgIH1cbiAgICAgIHJldHVybiB0aGlzLmZldGNoSW1wbCh1cmwsIHsgbWV0aG9kLCBoZWFkZXJzLCBib2R5OiBzZXJpYWxpemVkIH0pO1xuICAgIH07XG5cbiAgICBsZXQgdG9rZW5SZXRyaWVkID0gZmFsc2U7XG4gICAgZm9yIChsZXQgYXR0ZW1wdCA9IDA7IDsgYXR0ZW1wdCsrKSB7XG4gICAgICBjb25zdCByZXMgPSBhd2FpdCBzZW5kKCk7XG5cbiAgICAgIC8vIEV4cGlyZWQvcm90YXRlZCB0b2tlbiBcdTIwMTQgcmUtbWludCBvbmNlLCBub3QgY291bnRlZCBhZ2FpbnN0IGJhY2tvZmYuXG4gICAgICBpZiAocmVzLnN0YXR1cyA9PT0gNDAxICYmICF0b2tlblJldHJpZWQpIHtcbiAgICAgICAgdGhpcy5sb2coJ1tnb29nbGV3b3Jrc3BhY2VdIDQwMSBcdTIwMTQgcmVmcmVzaGluZyB0b2tlbiBhbmQgcmV0cnlpbmcgb25jZScpO1xuICAgICAgICB0b2tlblJldHJpZWQgPSB0cnVlO1xuICAgICAgICB0aGlzLmF1dGguaW52YWxpZGF0ZShvcHRzLnN1YmplY3QsIHRoaXMuc2NvcGVzKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIC8vIFRyYW5zaWVudCBlcnJvcnMgXHUyMDE0IGV4cG9uZW50aWFsIGJhY2tvZmYgdXAgdG8gbWF4UmV0cmllcy5cbiAgICAgIGlmIChSRVRSWUFCTEVfU1RBVFVTLmhhcyhyZXMuc3RhdHVzKSAmJiBhdHRlbXB0IDwgdGhpcy5tYXhSZXRyaWVzKSB7XG4gICAgICAgIGNvbnN0IGRlbGF5ID0gdGhpcy5iYWNrb2ZmRGVsYXkoYXR0ZW1wdCwgcmVzKTtcbiAgICAgICAgdGhpcy5sb2coXG4gICAgICAgICAgYFtnb29nbGV3b3Jrc3BhY2VdIEhUVFAgJHtyZXMuc3RhdHVzfSBvbiAke2FwaX0gXHUyMDE0IHJldHJ5ICR7YXR0ZW1wdCArIDF9LyR7dGhpcy5tYXhSZXRyaWVzfSBpbiAke2RlbGF5fW1zYCxcbiAgICAgICAgKTtcbiAgICAgICAgYXdhaXQgc2xlZXAoZGVsYXkpO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgaWYgKCFyZXMub2spIHRocm93IGF3YWl0IHRoaXMudG9BcGlFcnJvcihyZXMpO1xuICAgICAgY29uc3QgdGV4dCA9IGF3YWl0IHRoaXMucmVhZENhcHBlZChyZXMpO1xuICAgICAgcmV0dXJuICh0ZXh0ID8gSlNPTi5wYXJzZSh0ZXh0KSA6IHt9KSBhcyBUO1xuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBCYWNrb2ZmIGRlbGF5IGZvciByZXRyeSBgYXR0ZW1wdGAgKDAtYmFzZWQpLiBIb25vdXJzIGEgYFJldHJ5LUFmdGVyYFxuICAgKiBoZWFkZXIgKHNlY29uZHMpIHdoZW4gdGhlIHNlcnZlciBzZW5kcyBvbmUsIG90aGVyd2lzZSBleHBvbmVudGlhbFxuICAgKiAoYGJhc2UgKiAyXmF0dGVtcHRgKSB3aXRoIGEgbGl0dGxlIGppdHRlci5cbiAgICovXG4gIHByaXZhdGUgYmFja29mZkRlbGF5KGF0dGVtcHQ6IG51bWJlciwgcmVzOiBSZXNwb25zZSk6IG51bWJlciB7XG4gICAgY29uc3QgcmV0cnlBZnRlciA9IE51bWJlcihyZXMuaGVhZGVycy5nZXQoJ3JldHJ5LWFmdGVyJykgPz8gJycpO1xuICAgIGlmIChOdW1iZXIuaXNGaW5pdGUocmV0cnlBZnRlcikgJiYgcmV0cnlBZnRlciA+IDApIHtcbiAgICAgIHJldHVybiBNYXRoLm1pbihyZXRyeUFmdGVyICogMTAwMCwgMzBfMDAwKTtcbiAgICB9XG4gICAgY29uc3QgYmFzZSA9IHRoaXMucmV0cnlCYXNlTXMgKiAyICoqIGF0dGVtcHQ7XG4gICAgY29uc3Qgaml0dGVyID0gTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpICogTWF0aC5taW4odGhpcy5yZXRyeUJhc2VNcywgMjUwKSk7XG4gICAgcmV0dXJuIE1hdGgubWluKGJhc2UgKyBqaXR0ZXIsIDMwXzAwMCk7XG4gIH1cblxuICAvKiogUmVhZCBhIHJlc3BvbnNlIGJvZHksIHJlZnVzaW5nIHBheWxvYWRzIGxhcmdlciB0aGFuIGBtYXhCeXRlc2AuICovXG4gIHByaXZhdGUgYXN5bmMgcmVhZENhcHBlZChyZXM6IFJlc3BvbnNlKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgICBjb25zdCBkZWNsYXJlZCA9IE51bWJlcihyZXMuaGVhZGVycy5nZXQoJ2NvbnRlbnQtbGVuZ3RoJykgPz8gJycpO1xuICAgIGlmIChOdW1iZXIuaXNGaW5pdGUoZGVjbGFyZWQpICYmIGRlY2xhcmVkID4gdGhpcy5tYXhCeXRlcykge1xuICAgICAgdGhyb3cgbmV3IEdvb2dsZUFwaUVycm9yKFxuICAgICAgICByZXMuc3RhdHVzLFxuICAgICAgICAnUmVzcG9uc2VUb29MYXJnZScsXG4gICAgICAgIGByZXNwb25zZSBvZiAke2RlY2xhcmVkfSBieXRlcyBleGNlZWRzIG1heEJ5dGVzPSR7dGhpcy5tYXhCeXRlc31gLFxuICAgICAgKTtcbiAgICB9XG4gICAgY29uc3QgdGV4dCA9IGF3YWl0IHJlcy50ZXh0KCk7XG4gICAgaWYgKHRleHQubGVuZ3RoID4gdGhpcy5tYXhCeXRlcykge1xuICAgICAgdGhyb3cgbmV3IEdvb2dsZUFwaUVycm9yKFxuICAgICAgICByZXMuc3RhdHVzLFxuICAgICAgICAnUmVzcG9uc2VUb29MYXJnZScsXG4gICAgICAgIGByZXNwb25zZSBvZiAke3RleHQubGVuZ3RofSBieXRlcyBleGNlZWRzIG1heEJ5dGVzPSR7dGhpcy5tYXhCeXRlc31gLFxuICAgICAgKTtcbiAgICB9XG4gICAgcmV0dXJuIHRleHQ7XG4gIH1cblxuICAvKiogUGFyc2UgYSBub24tMnh4IGJvZHkgaW50byBhIHtAbGluayBHb29nbGVBcGlFcnJvcn0uICovXG4gIHByaXZhdGUgYXN5bmMgdG9BcGlFcnJvcihyZXM6IFJlc3BvbnNlKTogUHJvbWlzZTxHb29nbGVBcGlFcnJvcj4ge1xuICAgIGxldCByYXcgPSAnJztcbiAgICB0cnkge1xuICAgICAgcmF3ID0gYXdhaXQgdGhpcy5yZWFkQ2FwcGVkKHJlcyk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBpZiAoZXJyIGluc3RhbmNlb2YgR29vZ2xlQXBpRXJyb3IpIHJldHVybiBlcnI7XG4gICAgfVxuICAgIGxldCByZWFzb246IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICBsZXQgbWVzc2FnZSA9IHJhdyB8fCByZXMuc3RhdHVzVGV4dDtcbiAgICB0cnkge1xuICAgICAgY29uc3QgZW52ID0gSlNPTi5wYXJzZShyYXcpIGFzIEdvb2dsZUVycm9yRW52ZWxvcGU7XG4gICAgICBpZiAoZW52LmVycm9yKSB7XG4gICAgICAgIHJlYXNvbiA9IGVudi5lcnJvci5zdGF0dXMgPz8gZW52LmVycm9yLmVycm9ycz8uWzBdPy5yZWFzb247XG4gICAgICAgIG1lc3NhZ2UgPSBlbnYuZXJyb3IubWVzc2FnZSA/PyBtZXNzYWdlO1xuICAgICAgfVxuICAgIH0gY2F0Y2gge1xuICAgICAgLyogbm9uLUpTT04gZXJyb3IgYm9keSBcdTIwMTQga2VlcCByYXcgKi9cbiAgICB9XG4gICAgcmV0dXJuIG5ldyBHb29nbGVBcGlFcnJvcihyZXMuc3RhdHVzLCByZWFzb24sIG1lc3NhZ2UpO1xuICB9XG5cbiAgLyoqIEFjcXVpcmUgYSB0b2tlbiBmb3IgYHN1YmplY3RgIHRvIHZlcmlmeSBjb25uZWN0aXZpdHkgKyBkZWxlZ2F0aW9uLiAqL1xuICBhc3luYyBwcm9iZShzdWJqZWN0OiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBhd2FpdCB0aGlzLmF1dGguZ2V0VG9rZW4oc3ViamVjdCwgdGhpcy5zY29wZXMpO1xuICB9XG5cbiAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAvLyBDYWxlbmRhciBBUEkgdjNcbiAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gIC8qKiBMaXN0IGV2ZW50cyBvbiBhIGNhbGVuZGFyIChkZWZhdWx0IGBwcmltYXJ5YCkuICovXG4gIGFzeW5jIGxpc3RFdmVudHMoXG4gICAgc3ViamVjdDogc3RyaW5nLFxuICAgIHA6IHtcbiAgICAgIGNhbGVuZGFySWQ/OiBzdHJpbmc7XG4gICAgICB0aW1lTWluPzogc3RyaW5nO1xuICAgICAgdGltZU1heD86IHN0cmluZztcbiAgICAgIHE/OiBzdHJpbmc7XG4gICAgICBtYXhSZXN1bHRzPzogbnVtYmVyO1xuICAgICAgc2luZ2xlRXZlbnRzPzogYm9vbGVhbjtcbiAgICAgIG9yZGVyQnk/OiBzdHJpbmc7XG4gICAgICBwYWdlVG9rZW4/OiBzdHJpbmc7XG4gICAgfSxcbiAgKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4ge1xuICAgIGNvbnN0IGNhbGVuZGFySWQgPSBwLmNhbGVuZGFySWQgfHwgJ3ByaW1hcnknO1xuICAgIHJldHVybiB0aGlzLnJlcXVlc3QoJ2NhbGVuZGFyJywgJ0dFVCcsIGAvY2FsZW5kYXJzLyR7ZW5jb2RlVVJJQ29tcG9uZW50KGNhbGVuZGFySWQpfS9ldmVudHNgLCB7XG4gICAgICBzdWJqZWN0LFxuICAgICAgcXVlcnk6IHtcbiAgICAgICAgdGltZU1pbjogcC50aW1lTWluLFxuICAgICAgICB0aW1lTWF4OiBwLnRpbWVNYXgsXG4gICAgICAgIHE6IHAucSxcbiAgICAgICAgbWF4UmVzdWx0czogcC5tYXhSZXN1bHRzLFxuICAgICAgICBzaW5nbGVFdmVudHM6IHAuc2luZ2xlRXZlbnRzID8/IHRydWUsXG4gICAgICAgIG9yZGVyQnk6IHAub3JkZXJCeSA/PyAocC5zaW5nbGVFdmVudHMgPT09IGZhbHNlID8gdW5kZWZpbmVkIDogJ3N0YXJ0VGltZScpLFxuICAgICAgICBwYWdlVG9rZW46IHAucGFnZVRva2VuLFxuICAgICAgfSxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKiBRdWVyeSBmcmVlL2J1c3kgd2luZG93cyBhY3Jvc3Mgb25lIG9yIG1vcmUgY2FsZW5kYXJzLiAqL1xuICBhc3luYyBmcmVlQnVzeShcbiAgICBzdWJqZWN0OiBzdHJpbmcsXG4gICAgcDogeyB0aW1lTWluOiBzdHJpbmc7IHRpbWVNYXg6IHN0cmluZzsgY2FsZW5kYXJJZHM6IHJlYWRvbmx5IHN0cmluZ1tdIH0sXG4gICk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcbiAgICByZXR1cm4gdGhpcy5yZXF1ZXN0KCdjYWxlbmRhcicsICdQT1NUJywgJy9mcmVlQnVzeScsIHtcbiAgICAgIHN1YmplY3QsXG4gICAgICBib2R5OiB7XG4gICAgICAgIHRpbWVNaW46IHAudGltZU1pbixcbiAgICAgICAgdGltZU1heDogcC50aW1lTWF4LFxuICAgICAgICBpdGVtczogcC5jYWxlbmRhcklkcy5tYXAoKGlkKSA9PiAoeyBpZCB9KSksXG4gICAgICB9LFxuICAgIH0pO1xuICB9XG5cbiAgLyoqIENyZWF0ZSBhIGNhbGVuZGFyIGV2ZW50LiAqL1xuICBhc3luYyBjcmVhdGVFdmVudChcbiAgICBzdWJqZWN0OiBzdHJpbmcsXG4gICAgY2FsZW5kYXJJZDogc3RyaW5nLFxuICAgIGV2ZW50OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcbiAgICBwOiB7IHNlbmRVcGRhdGVzPzogc3RyaW5nIH0gPSB7fSxcbiAgKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4ge1xuICAgIHJldHVybiB0aGlzLnJlcXVlc3QoJ2NhbGVuZGFyJywgJ1BPU1QnLCBgL2NhbGVuZGFycy8ke2VuY29kZVVSSUNvbXBvbmVudChjYWxlbmRhcklkKX0vZXZlbnRzYCwge1xuICAgICAgc3ViamVjdCxcbiAgICAgIHF1ZXJ5OiB7IHNlbmRVcGRhdGVzOiBwLnNlbmRVcGRhdGVzIH0sXG4gICAgICBib2R5OiBldmVudCxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKiBQYXRjaCAocGFydGlhbCB1cGRhdGUpIGFuIGV4aXN0aW5nIGV2ZW50LiAqL1xuICBhc3luYyBwYXRjaEV2ZW50KFxuICAgIHN1YmplY3Q6IHN0cmluZyxcbiAgICBjYWxlbmRhcklkOiBzdHJpbmcsXG4gICAgZXZlbnRJZDogc3RyaW5nLFxuICAgIHBhdGNoOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcbiAgICBwOiB7IHNlbmRVcGRhdGVzPzogc3RyaW5nIH0gPSB7fSxcbiAgKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4ge1xuICAgIHJldHVybiB0aGlzLnJlcXVlc3QoXG4gICAgICAnY2FsZW5kYXInLFxuICAgICAgJ1BBVENIJyxcbiAgICAgIGAvY2FsZW5kYXJzLyR7ZW5jb2RlVVJJQ29tcG9uZW50KGNhbGVuZGFySWQpfS9ldmVudHMvJHtlbmNvZGVVUklDb21wb25lbnQoZXZlbnRJZCl9YCxcbiAgICAgIHsgc3ViamVjdCwgcXVlcnk6IHsgc2VuZFVwZGF0ZXM6IHAuc2VuZFVwZGF0ZXMgfSwgYm9keTogcGF0Y2ggfSxcbiAgICApO1xuICB9XG5cbiAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAvLyBHbWFpbCBBUEkgdjEgKHVzZXJJZCAnbWUnIHJlc29sdmVzIHRvIHRoZSBpbXBlcnNvbmF0ZWQgc3ViamVjdClcbiAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gIGFzeW5jIHNlYXJjaE1lc3NhZ2VzKFxuICAgIHN1YmplY3Q6IHN0cmluZyxcbiAgICBwOiB7IHE/OiBzdHJpbmc7IG1heFJlc3VsdHM/OiBudW1iZXI7IGxhYmVsSWRzPzogcmVhZG9ubHkgc3RyaW5nW107IHBhZ2VUb2tlbj86IHN0cmluZyB9LFxuICApOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB7XG4gICAgcmV0dXJuIHRoaXMucmVxdWVzdCgnZ21haWwnLCAnR0VUJywgJy91c2Vycy9tZS9tZXNzYWdlcycsIHtcbiAgICAgIHN1YmplY3QsXG4gICAgICBxdWVyeToge1xuICAgICAgICBxOiBwLnEsXG4gICAgICAgIG1heFJlc3VsdHM6IHAubWF4UmVzdWx0cyxcbiAgICAgICAgbGFiZWxJZHM6IHAubGFiZWxJZHMsXG4gICAgICAgIHBhZ2VUb2tlbjogcC5wYWdlVG9rZW4sXG4gICAgICB9LFxuICAgIH0pO1xuICB9XG5cbiAgYXN5bmMgZ2V0TWVzc2FnZShcbiAgICBzdWJqZWN0OiBzdHJpbmcsXG4gICAgaWQ6IHN0cmluZyxcbiAgICBwOiB7IGZvcm1hdD86IHN0cmluZyB9ID0ge30sXG4gICk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcbiAgICByZXR1cm4gdGhpcy5yZXF1ZXN0KCdnbWFpbCcsICdHRVQnLCBgL3VzZXJzL21lL21lc3NhZ2VzLyR7ZW5jb2RlVVJJQ29tcG9uZW50KGlkKX1gLCB7XG4gICAgICBzdWJqZWN0LFxuICAgICAgcXVlcnk6IHsgZm9ybWF0OiBwLmZvcm1hdCA/PyAnZnVsbCcgfSxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKiBTZW5kIGEgbWVzc2FnZS4gYHJhd2AgaXMgYSBiYXNlNjR1cmwtZW5jb2RlZCBSRkMgMjgyMiBtZXNzYWdlLiAqL1xuICBhc3luYyBzZW5kTWVzc2FnZShzdWJqZWN0OiBzdHJpbmcsIHJhdzogc3RyaW5nKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4ge1xuICAgIHJldHVybiB0aGlzLnJlcXVlc3QoJ2dtYWlsJywgJ1BPU1QnLCAnL3VzZXJzL21lL21lc3NhZ2VzL3NlbmQnLCB7XG4gICAgICBzdWJqZWN0LFxuICAgICAgYm9keTogeyByYXcgfSxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKiBDcmVhdGUgYSBkcmFmdC4gYHJhd2AgaXMgYSBiYXNlNjR1cmwtZW5jb2RlZCBSRkMgMjgyMiBtZXNzYWdlLiAqL1xuICBhc3luYyBjcmVhdGVEcmFmdChzdWJqZWN0OiBzdHJpbmcsIHJhdzogc3RyaW5nKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4ge1xuICAgIHJldHVybiB0aGlzLnJlcXVlc3QoJ2dtYWlsJywgJ1BPU1QnLCAnL3VzZXJzL21lL2RyYWZ0cycsIHtcbiAgICAgIHN1YmplY3QsXG4gICAgICBib2R5OiB7IG1lc3NhZ2U6IHsgcmF3IH0gfSxcbiAgICB9KTtcbiAgfVxuXG4gIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgLy8gRHJpdmUgQVBJIHYzIC8gRG9jcyB2MSAvIFNoZWV0cyB2NFxuICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgYXN5bmMgc2VhcmNoRmlsZXMoXG4gICAgc3ViamVjdDogc3RyaW5nLFxuICAgIHA6IHsgcT86IHN0cmluZzsgcGFnZVNpemU/OiBudW1iZXI7IG9yZGVyQnk/OiBzdHJpbmc7IGZpZWxkcz86IHN0cmluZzsgcGFnZVRva2VuPzogc3RyaW5nIH0sXG4gICk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcbiAgICByZXR1cm4gdGhpcy5yZXF1ZXN0KCdkcml2ZScsICdHRVQnLCAnL2ZpbGVzJywge1xuICAgICAgc3ViamVjdCxcbiAgICAgIHF1ZXJ5OiB7XG4gICAgICAgIHE6IHAucSxcbiAgICAgICAgcGFnZVNpemU6IHAucGFnZVNpemUsXG4gICAgICAgIG9yZGVyQnk6IHAub3JkZXJCeSxcbiAgICAgICAgZmllbGRzOlxuICAgICAgICAgIHAuZmllbGRzID8/XG4gICAgICAgICAgJ2ZpbGVzKGlkLG5hbWUsbWltZVR5cGUsbW9kaWZpZWRUaW1lLG93bmVycyhlbWFpbEFkZHJlc3MpLHdlYlZpZXdMaW5rLHNpemUpLG5leHRQYWdlVG9rZW4nLFxuICAgICAgICBwYWdlVG9rZW46IHAucGFnZVRva2VuLFxuICAgICAgICBzdXBwb3J0c0FsbERyaXZlczogdHJ1ZSxcbiAgICAgICAgaW5jbHVkZUl0ZW1zRnJvbUFsbERyaXZlczogdHJ1ZSxcbiAgICAgIH0sXG4gICAgfSk7XG4gIH1cblxuICBhc3luYyBnZXRGaWxlKFxuICAgIHN1YmplY3Q6IHN0cmluZyxcbiAgICBmaWxlSWQ6IHN0cmluZyxcbiAgICBwOiB7IGZpZWxkcz86IHN0cmluZyB9ID0ge30sXG4gICk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcbiAgICByZXR1cm4gdGhpcy5yZXF1ZXN0KCdkcml2ZScsICdHRVQnLCBgL2ZpbGVzLyR7ZW5jb2RlVVJJQ29tcG9uZW50KGZpbGVJZCl9YCwge1xuICAgICAgc3ViamVjdCxcbiAgICAgIHF1ZXJ5OiB7XG4gICAgICAgIGZpZWxkczpcbiAgICAgICAgICBwLmZpZWxkcyA/P1xuICAgICAgICAgICdpZCxuYW1lLG1pbWVUeXBlLG1vZGlmaWVkVGltZSxjcmVhdGVkVGltZSxvd25lcnMoZW1haWxBZGRyZXNzLGRpc3BsYXlOYW1lKSx3ZWJWaWV3TGluayxzaXplLGRlc2NyaXB0aW9uJyxcbiAgICAgICAgc3VwcG9ydHNBbGxEcml2ZXM6IHRydWUsXG4gICAgICB9LFxuICAgIH0pO1xuICB9XG5cbiAgYXN5bmMgZ2V0RG9jdW1lbnQoc3ViamVjdDogc3RyaW5nLCBkb2N1bWVudElkOiBzdHJpbmcpOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB7XG4gICAgcmV0dXJuIHRoaXMucmVxdWVzdCgnZG9jcycsICdHRVQnLCBgL2RvY3VtZW50cy8ke2VuY29kZVVSSUNvbXBvbmVudChkb2N1bWVudElkKX1gLCB7IHN1YmplY3QgfSk7XG4gIH1cblxuICBhc3luYyBnZXRTaGVldFZhbHVlcyhcbiAgICBzdWJqZWN0OiBzdHJpbmcsXG4gICAgc3ByZWFkc2hlZXRJZDogc3RyaW5nLFxuICAgIHJhbmdlOiBzdHJpbmcsXG4gICk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcbiAgICByZXR1cm4gdGhpcy5yZXF1ZXN0KFxuICAgICAgJ3NoZWV0cycsXG4gICAgICAnR0VUJyxcbiAgICAgIGAvc3ByZWFkc2hlZXRzLyR7ZW5jb2RlVVJJQ29tcG9uZW50KHNwcmVhZHNoZWV0SWQpfS92YWx1ZXMvJHtlbmNvZGVVUklDb21wb25lbnQocmFuZ2UpfWAsXG4gICAgICB7IHN1YmplY3QgfSxcbiAgICApO1xuICB9XG5cbiAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAvLyBBZG1pbiBEaXJlY3RvcnkgdjEgLyBQZW9wbGUgdjFcbiAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gIGFzeW5jIGxpc3REaXJlY3RvcnlVc2VycyhcbiAgICBzdWJqZWN0OiBzdHJpbmcsXG4gICAgcDoge1xuICAgICAgY3VzdG9tZXI/OiBzdHJpbmc7XG4gICAgICBkb21haW4/OiBzdHJpbmc7XG4gICAgICBxdWVyeT86IHN0cmluZztcbiAgICAgIG1heFJlc3VsdHM/OiBudW1iZXI7XG4gICAgICBvcmRlckJ5Pzogc3RyaW5nO1xuICAgICAgcGFnZVRva2VuPzogc3RyaW5nO1xuICAgIH0sXG4gICk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcbiAgICAvLyBgY3VzdG9tZXJgIGFuZCBgZG9tYWluYCBhcmUgbXV0dWFsbHkgZXhjbHVzaXZlOyBkZWZhdWx0IHRvIG15X2N1c3RvbWVyLlxuICAgIGNvbnN0IHVzZURvbWFpbiA9IEJvb2xlYW4ocC5kb21haW4pO1xuICAgIHJldHVybiB0aGlzLnJlcXVlc3QoJ2RpcmVjdG9yeScsICdHRVQnLCAnL3VzZXJzJywge1xuICAgICAgc3ViamVjdCxcbiAgICAgIHF1ZXJ5OiB7XG4gICAgICAgIGN1c3RvbWVyOiB1c2VEb21haW4gPyB1bmRlZmluZWQgOiBwLmN1c3RvbWVyIHx8ICdteV9jdXN0b21lcicsXG4gICAgICAgIGRvbWFpbjogcC5kb21haW4sXG4gICAgICAgIHF1ZXJ5OiBwLnF1ZXJ5LFxuICAgICAgICBtYXhSZXN1bHRzOiBwLm1heFJlc3VsdHMsXG4gICAgICAgIG9yZGVyQnk6IHAub3JkZXJCeSxcbiAgICAgICAgcGFnZVRva2VuOiBwLnBhZ2VUb2tlbixcbiAgICAgICAgcHJvamVjdGlvbjogJ2Jhc2ljJyxcbiAgICAgICAgdmlld1R5cGU6ICdhZG1pbl92aWV3JyxcbiAgICAgIH0sXG4gICAgfSk7XG4gIH1cblxuICBhc3luYyBzZWFyY2hDb250YWN0cyhcbiAgICBzdWJqZWN0OiBzdHJpbmcsXG4gICAgcDogeyBxdWVyeTogc3RyaW5nOyBwYWdlU2l6ZT86IG51bWJlcjsgcmVhZE1hc2s/OiBzdHJpbmcgfSxcbiAgKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4ge1xuICAgIGNvbnN0IHJlYWRNYXNrID0gcC5yZWFkTWFzayA/PyAnbmFtZXMsZW1haWxBZGRyZXNzZXMscGhvbmVOdW1iZXJzLG9yZ2FuaXphdGlvbnMnO1xuICAgIC8vIFBlb3BsZSBgc2VhcmNoQ29udGFjdHNgIHJlcXVpcmVzIGEgd2FybXVwIChlbXB0eS1xdWVyeSkgcmVxdWVzdCB0byBwcmltZVxuICAgIC8vIHRoZSBzZXJ2ZXItc2lkZSBjYWNoZSBiZWZvcmUgdGhlIGZpcnN0IHJlYWwgc2VhcmNoLCBvdGhlcndpc2UgcmVzdWx0c1xuICAgIC8vIGNvbWUgYmFjayBlbXB0eS4gQmVzdC1lZmZvcnQsIG9uY2UgcGVyIHN1YmplY3QgcGVyIHByb2Nlc3MuXG4gICAgaWYgKCF0aGlzLndhcm1lZENvbnRhY3RzLmhhcyhzdWJqZWN0KSkge1xuICAgICAgdGhpcy53YXJtZWRDb250YWN0cy5hZGQoc3ViamVjdCk7XG4gICAgICB0cnkge1xuICAgICAgICBhd2FpdCB0aGlzLnJlcXVlc3QoJ3Blb3BsZScsICdHRVQnLCAnL3Blb3BsZTpzZWFyY2hDb250YWN0cycsIHtcbiAgICAgICAgICBzdWJqZWN0LFxuICAgICAgICAgIHF1ZXJ5OiB7IHF1ZXJ5OiAnJywgcmVhZE1hc2sgfSxcbiAgICAgICAgfSk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLy8gV2FybXVwIGlzIGJlc3QtZWZmb3J0OyB0aGUgcmVhbCBxdWVyeSBiZWxvdyBzdXJmYWNlcyBhbnkgcmVhbCBlcnJvci5cbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHRoaXMucmVxdWVzdCgncGVvcGxlJywgJ0dFVCcsICcvcGVvcGxlOnNlYXJjaENvbnRhY3RzJywge1xuICAgICAgc3ViamVjdCxcbiAgICAgIHF1ZXJ5OiB7IHF1ZXJ5OiBwLnF1ZXJ5LCBwYWdlU2l6ZTogcC5wYWdlU2l6ZSwgcmVhZE1hc2sgfSxcbiAgICB9KTtcbiAgfVxufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIEhlbHBlcnNcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKipcbiAqIEJ1aWxkIGEgcXVlcnkgc3RyaW5nIGZyb20gYSBmbGF0IHJlY29yZC4gYHVuZGVmaW5lZGAgdmFsdWVzIGFyZSBza2lwcGVkO1xuICogYXJyYXlzIGV4cGFuZCBpbnRvIHJlcGVhdGVkIHBhcmFtcyAoZS5nLiBgbGFiZWxJZHM9QSZsYWJlbElkcz1CYCkuIFJldHVybnNcbiAqIGAnJ2Agd2hlbiBub3RoaW5nIGlzIHNldC5cbiAqL1xuZnVuY3Rpb24gYnVpbGRRdWVyeVN0cmluZyhxdWVyeTogUmVjb3JkPHN0cmluZywgUXVlcnlWYWx1ZT4gfCB1bmRlZmluZWQpOiBzdHJpbmcge1xuICBpZiAoIXF1ZXJ5KSByZXR1cm4gJyc7XG4gIGNvbnN0IHNwID0gbmV3IFVSTFNlYXJjaFBhcmFtcygpO1xuICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhxdWVyeSkpIHtcbiAgICBpZiAodmFsdWUgPT09IHVuZGVmaW5lZCkgY29udGludWU7XG4gICAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgICBmb3IgKGNvbnN0IHYgb2YgdmFsdWUpIHNwLmFwcGVuZChrZXksIFN0cmluZyh2KSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHNwLmFwcGVuZChrZXksIFN0cmluZyh2YWx1ZSkpO1xuICAgIH1cbiAgfVxuICBjb25zdCBzID0gc3AudG9TdHJpbmcoKTtcbiAgcmV0dXJuIHMgPyBgPyR7c31gIDogJyc7XG59XG5cbi8qKiBQcm9taXNlLWJhc2VkIHNsZWVwIHVzZWQgZm9yIHJldHJ5IGJhY2tvZmYuICovXG5mdW5jdGlvbiBzbGVlcChtczogbnVtYmVyKTogUHJvbWlzZTx2b2lkPiB7XG4gIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4gc2V0VGltZW91dChyZXNvbHZlLCBtcykpO1xufVxuIiwgIi8qKlxuICogVGVzdCBoZWxwZXJzIFx1MjAxNCBmYWtlIGF1dGgsIGEgc2NyaXB0ZWQgZmV0Y2gsIGFuZCBhIEpTT04gUmVzcG9uc2UgYnVpbGRlci5cbiAqIE5vIG5ldHdvcmssIG5vIHJlYWwgY3JlZGVudGlhbHMuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBHb29nbGVTZXJ2aWNlQWNjb3VudEF1dGggfSBmcm9tICcuLi9zcmMvZ29vZ2xlQXV0aC5qcyc7XG5cbmV4cG9ydCBmdW5jdGlvbiBmYWtlQXV0aCgpOiB7XG4gIGF1dGg6IEdvb2dsZVNlcnZpY2VBY2NvdW50QXV0aDtcbiAgc3RhdHM6ICgpID0+IHsgdG9rZW5DYWxsczogbnVtYmVyOyBpbnZhbGlkYXRpb25zOiBudW1iZXIgfTtcbn0ge1xuICBsZXQgdG9rZW5DYWxscyA9IDA7XG4gIGxldCBpbnZhbGlkYXRpb25zID0gMDtcbiAgY29uc3QgYXV0aCA9IHtcbiAgICBnZXRUb2tlbjogYXN5bmMgKCkgPT4ge1xuICAgICAgdG9rZW5DYWxscyArPSAxO1xuICAgICAgcmV0dXJuIGB0b2stJHt0b2tlbkNhbGxzfWA7XG4gICAgfSxcbiAgICBpbnZhbGlkYXRlOiAoKSA9PiB7XG4gICAgICBpbnZhbGlkYXRpb25zICs9IDE7XG4gICAgfSxcbiAgfTtcbiAgcmV0dXJuIHtcbiAgICBhdXRoOiBhdXRoIGFzIHVua25vd24gYXMgR29vZ2xlU2VydmljZUFjY291bnRBdXRoLFxuICAgIHN0YXRzOiAoKSA9PiAoeyB0b2tlbkNhbGxzLCBpbnZhbGlkYXRpb25zIH0pLFxuICB9O1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIENhcHR1cmVkIHtcbiAgdXJsOiBzdHJpbmc7XG4gIGluaXQ6IHsgbWV0aG9kPzogc3RyaW5nOyBoZWFkZXJzPzogUmVjb3JkPHN0cmluZywgc3RyaW5nPjsgYm9keT86IHN0cmluZyB9O1xufVxuXG4vKipcbiAqIEEgZmV0Y2ggc3R1YiBkcml2ZW4gYnkgYW4gYXJyYXkgb2Ygc3RlcCBmdW5jdGlvbnMuIENhbGwgTiB1c2VzIHN0ZXAgTiAodGhlXG4gKiBsYXN0IHN0ZXAgcmVwZWF0cyBmb3IgYW55IGZ1cnRoZXIgY2FsbHMpLiBSZWNvcmRzIGV2ZXJ5IGNhbGwuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzY3JpcHRlZEZldGNoKHN0ZXBzOiBBcnJheTwoYzogQ2FwdHVyZWQpID0+IFJlc3BvbnNlPik6IHtcbiAgZmV0Y2hJbXBsOiB0eXBlb2YgZmV0Y2g7XG4gIGNhbGxzOiBDYXB0dXJlZFtdO1xufSB7XG4gIGNvbnN0IGNhbGxzOiBDYXB0dXJlZFtdID0gW107XG4gIGxldCBpID0gMDtcbiAgY29uc3QgZmV0Y2hJbXBsID0gKGFzeW5jICh1cmw6IHN0cmluZywgaW5pdDogQ2FwdHVyZWRbJ2luaXQnXSkgPT4ge1xuICAgIGNvbnN0IGM6IENhcHR1cmVkID0geyB1cmwsIGluaXQ6IGluaXQgPz8ge30gfTtcbiAgICBjYWxscy5wdXNoKGMpO1xuICAgIGNvbnN0IHN0ZXAgPSBzdGVwc1tNYXRoLm1pbihpLCBzdGVwcy5sZW5ndGggLSAxKV07XG4gICAgaSArPSAxO1xuICAgIHJldHVybiBzdGVwKGMpO1xuICB9KSBhcyB1bmtub3duIGFzIHR5cGVvZiBmZXRjaDtcbiAgcmV0dXJuIHsgZmV0Y2hJbXBsLCBjYWxscyB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24ganNvbihvYmo6IHVua25vd24sIHN0YXR1cyA9IDIwMCk6IFJlc3BvbnNlIHtcbiAgcmV0dXJuIG5ldyBSZXNwb25zZShKU09OLnN0cmluZ2lmeShvYmopLCB7XG4gICAgc3RhdHVzLFxuICAgIGhlYWRlcnM6IHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyB9LFxuICB9KTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICI7QUFBQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZOzs7QUNjWixJQUFNLGlCQUFOLGNBQTZCLE1BQU07QUFBQSxFQUN4QyxZQUNrQixRQUNBLFFBQ2hCLFNBQ0E7QUFDQSxVQUFNLE9BQU87QUFKRztBQUNBO0FBSWhCLFNBQUssT0FBTztBQUFBLEVBQ2Q7QUFDRjs7O0FDSUEsSUFBTSxXQUFzQztBQUFBLEVBQzFDLFVBQVU7QUFBQSxFQUNWLE9BQU87QUFBQSxFQUNQLE9BQU87QUFBQSxFQUNQLE1BQU07QUFBQSxFQUNOLFFBQVE7QUFBQSxFQUNSLFdBQVc7QUFBQSxFQUNYLFFBQVE7QUFDVjtBQUVBLElBQU0sb0JBQW9CLE9BQU87QUFDakMs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
