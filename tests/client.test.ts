import test from 'node:test';
import assert from 'node:assert/strict';

import { GoogleWorkspaceClient } from '../src/googleClient.js';
import { GoogleApiError } from '../src/errors.js';
import { fakeAuth, scriptedFetch, json } from './_helpers.js';

test('listEvents builds the calendar URL and returns the parsed body + nextPageToken', async () => {
  const { auth } = fakeAuth();
  const { fetchImpl, calls } = scriptedFetch([
    () => json({ items: [{ id: 'e1' }], nextPageToken: 'np' }),
  ]);
  const client = new GoogleWorkspaceClient({ auth, scopes: ['s'], fetch: fetchImpl });
  const r = await client.listEvents('u@x.com', {
    timeMin: '2026-01-01T00:00:00Z',
    maxResults: 10,
    singleEvents: true,
  });
  assert.match(calls[0].url, /^https:\/\/www\.googleapis\.com\/calendar\/v3\/calendars\/primary\/events\?/);
  assert.match(calls[0].url, /timeMin=2026/);
  assert.equal((r.items as unknown[]).length, 1);
  assert.equal(r.nextPageToken, 'np');
});

test('401 re-mints the token and retries once', async () => {
  const { auth, stats } = fakeAuth();
  const { fetchImpl, calls } = scriptedFetch([
    () => new Response('', { status: 401 }),
    () => json({ ok: true }),
  ]);
  const client = new GoogleWorkspaceClient({ auth, scopes: ['s'], fetch: fetchImpl, retryBaseMs: 0 });
  const r = await client.getMessage('u@x.com', 'id1');
  assert.equal(calls.length, 2);
  assert.equal(stats().invalidations, 1);
  assert.equal(r.ok, true);
});

test('429 backs off and retries, then succeeds', async () => {
  const { auth } = fakeAuth();
  const { fetchImpl, calls } = scriptedFetch([
    () => new Response('', { status: 429 }),
    () => new Response('', { status: 429 }),
    () => json({ done: true }),
  ]);
  const client = new GoogleWorkspaceClient({
    auth,
    scopes: ['s'],
    fetch: fetchImpl,
    retryBaseMs: 0,
    maxRetries: 3,
  });
  const r = await client.listEvents('u@x.com', {});
  assert.equal(calls.length, 3);
  assert.equal(r.done, true);
});

test('429 that never clears exhausts retries and throws GoogleApiError', async () => {
  const { auth } = fakeAuth();
  const { fetchImpl, calls } = scriptedFetch([
    () => json({ error: { code: 429, message: 'rate', status: 'RESOURCE_EXHAUSTED' } }, 429),
  ]);
  const client = new GoogleWorkspaceClient({
    auth,
    scopes: ['s'],
    fetch: fetchImpl,
    retryBaseMs: 0,
    maxRetries: 2,
  });
  await assert.rejects(
    () => client.listEvents('u@x.com', {}),
    (e) => e instanceof GoogleApiError && e.status === 429,
  );
  assert.equal(calls.length, 3); // initial + 2 retries
});

test('4xx parses the Google error envelope (status → reason)', async () => {
  const { auth } = fakeAuth();
  const { fetchImpl } = scriptedFetch([
    () => json({ error: { code: 404, message: 'Not Found', status: 'NOT_FOUND' } }, 404),
  ]);
  const client = new GoogleWorkspaceClient({ auth, scopes: ['s'], fetch: fetchImpl });
  await assert.rejects(
    () => client.getFile('u@x.com', 'f1'),
    (e) => e instanceof GoogleApiError && e.status === 404 && e.reason === 'NOT_FOUND',
  );
});

test('a response larger than maxBytes throws ResponseTooLarge', async () => {
  const { auth } = fakeAuth();
  const big = 'x'.repeat(2000);
  const { fetchImpl } = scriptedFetch([() => new Response(big, { status: 200 })]);
  const client = new GoogleWorkspaceClient({ auth, scopes: ['s'], fetch: fetchImpl, maxBytes: 100 });
  await assert.rejects(
    () => client.getDocument('u@x.com', 'd1'),
    (e) => e instanceof GoogleApiError && /exceeds maxBytes/.test(e.message),
  );
});

test('searchContacts warms up once per subject, then queries', async () => {
  const { auth } = fakeAuth();
  const { fetchImpl, calls } = scriptedFetch([() => json({ results: [] })]);
  const client = new GoogleWorkspaceClient({ auth, scopes: ['s'], fetch: fetchImpl });

  await client.searchContacts('u@x.com', { query: 'anna' });
  assert.equal(calls.length, 2); // warmup (empty query) + real
  assert.match(calls[0].url, /[?&]query=&/);
  assert.match(calls[1].url, /[?&]query=anna/);

  await client.searchContacts('u@x.com', { query: 'bob' });
  assert.equal(calls.length, 3); // no second warmup for same subject
});

test('searchFiles requests default fields + passes pageToken', async () => {
  const { auth } = fakeAuth();
  const { fetchImpl, calls } = scriptedFetch([() => json({ files: [], nextPageToken: 'n2' })]);
  const client = new GoogleWorkspaceClient({ auth, scopes: ['s'], fetch: fetchImpl });
  const r = await client.searchFiles('u@x.com', { q: "name contains 'x'", pageToken: 'tok2' });
  assert.match(calls[0].url, /nextPageToken/);
  assert.match(calls[0].url, /pageToken=tok2/);
  assert.equal(r.nextPageToken, 'n2');
});
