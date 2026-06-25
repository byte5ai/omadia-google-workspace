import test from 'node:test';
import assert from 'node:assert/strict';

import { GoogleWorkspaceClient } from '../src/googleClient.js';
import {
  createSheetListTabsHandler,
  createSheetAddTabHandler,
  createSheetDuplicateTabHandler,
  createSheetBatchUpdateHandler,
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

// --- client -------------------------------------------------------------------

test('getSpreadsheetMeta GETs the spreadsheet with a tab-properties field mask', async () => {
  const { auth } = fakeAuth();
  const { fetchImpl, calls } = scriptedFetch([
    () => json({ properties: { title: 'Finanzen 2023' }, sheets: [{ properties: { sheetId: 0, title: '2025' } }] }),
  ]);
  const client = new GoogleWorkspaceClient({ auth, scopes: ['s'], fetch: fetchImpl });
  const r = await client.getSpreadsheetMeta('u@x.com', 'sheet1');
  assert.equal(calls[0].init.method ?? 'GET', 'GET');
  assert.match(calls[0].url, /\/spreadsheets\/sheet1\?/);
  assert.match(calls[0].url, /fields=.*sheets/);
  assert.equal((r.properties as { title?: string }).title, 'Finanzen 2023');
});

test('batchUpdateSpreadsheet POSTs to :batchUpdate with the requests body', async () => {
  const { auth } = fakeAuth();
  const { fetchImpl, calls } = scriptedFetch([() => json({ replies: [{}] })]);
  const client = new GoogleWorkspaceClient({ auth, scopes: ['s'], fetch: fetchImpl });
  await client.batchUpdateSpreadsheet('u@x.com', 'sheet1', [{ addSheet: { properties: { title: 'X' } } }]);
  assert.equal(calls[0].init.method, 'POST');
  assert.match(calls[0].url, /\/spreadsheets\/sheet1:batchUpdate/);
  const body = JSON.parse(calls[0].init.body as string);
  assert.equal(body.requests[0].addSheet.properties.title, 'X');
});

// --- handlers -----------------------------------------------------------------

test('gw_sheet_list_tabs returns trimmed tabs + title', async () => {
  const client = {
    getSpreadsheetMeta: async () => ({
      properties: { title: 'Finanzen 2023' },
      sheets: [
        { properties: { sheetId: 0, title: '2024', index: 0, gridProperties: { rowCount: 100, columnCount: 12 } } },
        { properties: { sheetId: 7, title: '2025', index: 1 } },
      ],
    }),
  };
  const out = JSON.parse(await createSheetListTabsHandler(deps(client))({ spreadsheetId: 's' }));
  assert.equal(out.title, 'Finanzen 2023');
  assert.equal(out.tabs.length, 2);
  assert.deepEqual(out.tabs[0], { sheetId: 0, title: '2024', index: 0, rows: 100, columns: 12 });
  assert.equal(out.tabs[1].sheetId, 7);
});

test('gw_sheet_add_tab requires a title and returns the new sheetId', async () => {
  assert.match(await createSheetAddTabHandler(deps({}))({ spreadsheetId: 's' }), /Error:.*"title"/);
  const client = {
    batchUpdateSpreadsheet: async (_s: string, _id: string, reqs: { addSheet: { properties: { title: string } } }[]) => {
      assert.equal(reqs[0].addSheet.properties.title, '2026');
      return { replies: [{ addSheet: { properties: { sheetId: 99, index: 2 } } }] };
    },
  };
  const out = JSON.parse(await createSheetAddTabHandler(deps(client))({ spreadsheetId: 's', title: '2026' }));
  assert.equal(out.added, true);
  assert.equal(out.sheetId, 99);
});

test('gw_sheet_duplicate_tab resolves sourceTitle→sheetId then duplicates', async () => {
  let dupReq: { sourceSheetId?: number; newSheetName?: string } | undefined;
  const client = {
    getSpreadsheetMeta: async () => ({ sheets: [{ properties: { sheetId: 42, title: '2025' } }] }),
    batchUpdateSpreadsheet: async (_s: string, _id: string, reqs: { duplicateSheet: typeof dupReq }[]) => {
      dupReq = reqs[0].duplicateSheet;
      return { replies: [{ duplicateSheet: { properties: { sheetId: 123 } } }] };
    },
  };
  const out = JSON.parse(
    await createSheetDuplicateTabHandler(deps(client))({ spreadsheetId: 's', sourceTitle: '2025', newName: '2026' }),
  );
  assert.equal(dupReq!.sourceSheetId, 42);
  assert.equal(dupReq!.newSheetName, '2026');
  assert.equal(out.duplicated, true);
  assert.equal(out.newSheetId, 123);
});

test('gw_sheet_duplicate_tab errors when sourceTitle is not found', async () => {
  const client = { getSpreadsheetMeta: async () => ({ sheets: [{ properties: { sheetId: 1, title: 'Other' } }] }) };
  assert.match(
    await createSheetDuplicateTabHandler(deps(client))({ spreadsheetId: 's', sourceTitle: 'Nope', newName: 'X' }),
    /Error:.*no tab named/,
  );
});

test('gw_sheet_batch_update requires a non-empty requests array and passes it through', async () => {
  assert.match(await createSheetBatchUpdateHandler(deps({}))({ spreadsheetId: 's', requests: [] }), /Error:.*non-empty/);
  let got: unknown[] | undefined;
  const client = {
    batchUpdateSpreadsheet: async (_s: string, _id: string, reqs: unknown[]) => {
      got = reqs;
      return { replies: [{}] };
    },
  };
  const reqs = [{ repeatCell: { range: { sheetId: 0 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } }];
  const out = JSON.parse(await createSheetBatchUpdateHandler(deps(client))({ spreadsheetId: 's', requests: reqs }));
  assert.equal(out.applied, true);
  assert.equal(out.requestCount, 1);
  assert.deepEqual(got, reqs);
});
