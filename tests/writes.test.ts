import test from 'node:test';
import assert from 'node:assert/strict';

import { GoogleWorkspaceClient } from '../src/googleClient.js';
import {
  createSheetWriteHandler,
  createDriveCreateHandler,
} from '../src/driveTools.js';
import type { ToolDeps } from '../src/toolDeps.js';
import { fakeAuth, scriptedFetch, json } from './_helpers.js';

const cache = {
  getOrSet: async (_k: string, fn: () => Promise<unknown>) => fn(),
  clear() {},
} as unknown as ToolDeps['cache'];

function deps(client: unknown): ToolDeps {
  return {
    client: client as ToolDeps['client'],
    cache,
    defaultSubject: 'me@x.com',
    adminSubject: 'admin@x.com',
  };
}

// --- client: writeSheetValues -------------------------------------------------

test('writeSheetValues overwrite → PUT values.update with body + valueInputOption', async () => {
  const { auth } = fakeAuth();
  const { fetchImpl, calls } = scriptedFetch([() => json({ updatedCells: 4, updatedRange: 'S!A1:B2' })]);
  const client = new GoogleWorkspaceClient({ auth, scopes: ['s'], fetch: fetchImpl });
  const r = await client.writeSheetValues('u@x.com', 'sheet1', 'S!A1:B2', [['a', 'b'], [1, 2]]);
  assert.equal(calls[0].init.method, 'PUT');
  assert.match(calls[0].url, /\/spreadsheets\/sheet1\/values\/S!A1%3AB2\?/);
  assert.match(calls[0].url, /valueInputOption=USER_ENTERED/);
  const body = JSON.parse(calls[0].init.body as string);
  assert.deepEqual(body.values, [['a', 'b'], [1, 2]]);
  assert.equal(body.majorDimension, 'ROWS');
  assert.equal(r.updatedCells, 4);
});

test('writeSheetValues append → POST :append with INSERT_ROWS', async () => {
  const { auth } = fakeAuth();
  const { fetchImpl, calls } = scriptedFetch([() => json({ updates: { updatedCells: 2 } })]);
  const client = new GoogleWorkspaceClient({ auth, scopes: ['s'], fetch: fetchImpl });
  await client.writeSheetValues('u@x.com', 'sheet1', 'S!A1', [['x', 'y']], { mode: 'append' });
  assert.equal(calls[0].init.method, 'POST');
  assert.match(calls[0].url, /\/values\/S!A1:append\?/);
  assert.match(calls[0].url, /insertDataOption=INSERT_ROWS/);
});

// --- client: createDriveFile --------------------------------------------------

test('createDriveFile metadata-only → POST /files with metadata body', async () => {
  const { auth } = fakeAuth();
  const { fetchImpl, calls } = scriptedFetch([() => json({ id: 'f1', name: 'Reports', mimeType: 'application/vnd.google-apps.folder' })]);
  const client = new GoogleWorkspaceClient({ auth, scopes: ['s'], fetch: fetchImpl });
  const r = await client.createDriveFile('u@x.com', {
    name: 'Reports',
    mimeType: 'application/vnd.google-apps.folder',
    parents: ['parent1'],
  });
  assert.equal(calls[0].init.method, 'POST');
  assert.match(calls[0].url, /\/drive\/v3\/files\?/);
  const body = JSON.parse(calls[0].init.body as string);
  assert.equal(body.name, 'Reports');
  assert.deepEqual(body.parents, ['parent1']);
  assert.equal(r.id, 'f1');
});

test('createDriveFile with content → multipart upload to the upload host', async () => {
  const { auth } = fakeAuth();
  const { fetchImpl, calls } = scriptedFetch([() => json({ id: 'f2', name: 'notes.txt' })]);
  const client = new GoogleWorkspaceClient({ auth, scopes: ['s'], fetch: fetchImpl });
  await client.createDriveFile('u@x.com', {
    name: 'notes.txt',
    mimeType: 'text/plain',
    content: 'hello body',
  });
  assert.match(calls[0].url, /^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\?/);
  assert.match(calls[0].url, /uploadType=multipart/);
  assert.match(calls[0].init.headers!['Content-Type'], /^multipart\/related; boundary=/);
  const raw = calls[0].init.body as string;
  assert.match(raw, /"name":"notes.txt"/);
  assert.match(raw, /hello body/);
});

// --- handlers -----------------------------------------------------------------

test('gw_sheet_write requires a 2D values array', async () => {
  const h = createSheetWriteHandler(deps({}));
  assert.match(await h({ spreadsheetId: 's', range: 'A1', values: 'nope' }), /Error:.*2D array/);
  assert.match(await h({ spreadsheetId: 's', range: 'A1', values: [1, 2] }), /Error:.*2D array/);
});

test('gw_sheet_write happy path returns written + mode + clears cache', async () => {
  let cleared = false;
  let got: { mode?: string } | undefined;
  const localCache = { getOrSet: async (_k: string, fn: () => Promise<unknown>) => fn(), clear() { cleared = true; } };
  const client = {
    writeSheetValues: async (_s: string, _id: string, _r: string, _v: unknown[][], p: { mode?: string }) => {
      got = p;
      return { updatedRange: 'S!A1:B2', updatedRows: 2, updatedCells: 4 };
    },
  };
  const d = { client, cache: localCache, defaultSubject: 'me@x.com', adminSubject: 'a@x.com' } as unknown as ToolDeps;
  const out = JSON.parse(
    await createSheetWriteHandler(d)({ spreadsheetId: 's', range: 'S!A1:B2', values: [['a', 'b'], [1, 2]], mode: 'append' }),
  );
  assert.equal(out.written, true);
  assert.equal(out.mode, 'append');
  assert.equal(got!.mode, 'append');
  assert.equal(out.updatedCells, 4);
  assert.equal(cleared, true);
});

test('gw_drive_create requires a name; folder + content is rejected', async () => {
  const h = createDriveCreateHandler(deps({}));
  assert.match(await h({}), /Error:.*"name"/);
  assert.match(await h({ name: 'X', type: 'folder', content: 'no' }), /Error:.*folder cannot have/);
});

test('gw_drive_create maps type→mimeType and returns the new id', async () => {
  let got: { mimeType?: string; parents?: string[] } | undefined;
  const client = {
    createDriveFile: async (_s: string, p: { mimeType?: string; parents?: string[] }) => {
      got = p;
      return { id: 'd1', name: 'Q3', mimeType: p.mimeType, webViewLink: 'http://x' };
    },
  };
  const out = JSON.parse(
    await createDriveCreateHandler(deps(client))({ name: 'Q3', type: 'spreadsheet', parentId: 'p1' }),
  );
  assert.equal(got!.mimeType, 'application/vnd.google-apps.spreadsheet');
  assert.deepEqual(got!.parents, ['p1']);
  assert.equal(out.created, true);
  assert.equal(out.id, 'd1');
});
