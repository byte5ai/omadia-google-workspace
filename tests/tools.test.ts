import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveSubject, type ToolDeps } from '../src/toolDeps.js';
import { GoogleInputError } from '../src/errors.js';
import {
  createCalendarListEventsHandler,
  createCalendarFreeBusyHandler,
} from '../src/calendarTools.js';
import {
  createGmailSearchHandler,
  createGmailGetMessageHandler,
  createGmailSendHandler,
} from '../src/gmailTools.js';
import { createSheetReadHandler } from '../src/driveTools.js';
import {
  createDirectoryUsersHandler,
  createPeopleSearchHandler,
} from '../src/directoryTools.js';

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

test('resolveSubject: explicit > admin/default fallbacks; invalid email throws', () => {
  const d = deps({});
  assert.equal(resolveSubject(d, 'a@x.com'), 'a@x.com');
  assert.equal(resolveSubject(d, undefined), 'me@x.com');
  assert.equal(resolveSubject(d, undefined, { admin: true }), 'admin@x.com');
  assert.throws(() => resolveSubject(d, 'notanemail'), GoogleInputError);
});

test('calendar list: passes pageToken, returns nextPageToken + resolved subject', async () => {
  let got: { s: string; p: Record<string, unknown> } | undefined;
  const client = {
    listEvents: async (s: string, p: Record<string, unknown>) => {
      got = { s, p };
      return { items: [{ id: 'e' }], nextPageToken: 'NX' };
    },
  };
  const out = JSON.parse(await createCalendarListEventsHandler(deps(client))({ pageToken: 'PT', user: 'u@x.com' }));
  assert.equal(got!.p.pageToken, 'PT');
  assert.equal(got!.s, 'u@x.com');
  assert.equal(out.nextPageToken, 'NX');
  assert.equal(out.subject, 'u@x.com');
});

test('freebusy requires timeMin/timeMax', async () => {
  const out = await createCalendarFreeBusyHandler(deps({}))({});
  assert.match(out, /Error:.*timeMin/);
});

test('gmail search without q returns a clean error', async () => {
  assert.match(await createGmailSearchHandler(deps({}))({}), /Error:.*"q"/);
});

test('gmail get trims to headers + decoded plain-text body', async () => {
  const data = Buffer.from('Hello world', 'utf8').toString('base64url');
  const client = {
    getMessage: async () => ({
      id: 'm1',
      threadId: 't1',
      labelIds: ['INBOX'],
      snippet: 'Hello',
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'From', value: 'a@x' },
          { name: 'Subject', value: 'Hi' },
        ],
        body: { data },
      },
    }),
  };
  const out = JSON.parse(await createGmailGetMessageHandler(deps(client))({ id: 'm1' }));
  assert.equal(out.headers.subject, 'Hi');
  assert.equal(out.headers.from, 'a@x');
  assert.equal(out.body, 'Hello world');
});

test('gmail send builds a base64url MIME with To/Subject/body', async () => {
  let raw = '';
  const client = {
    sendMessage: async (_s: string, r: string) => {
      raw = r;
      return { id: 'sent1', threadId: 't' };
    },
  };
  const out = JSON.parse(
    await createGmailSendHandler(deps(client))({ to: ['x@y.com'], subject: 'Subj', body: 'Body' }),
  );
  assert.equal(out.sent, true);
  const mime = Buffer.from(raw, 'base64url').toString('utf8');
  assert.match(mime, /To: x@y.com/);
  assert.match(mime, /Subject: Subj/);
  assert.match(mime, /Body/);
});

test('gmail send requires a recipient', async () => {
  assert.match(await createGmailSendHandler(deps({}))({ subject: 's', body: 'b', to: [] }), /Error:.*"to"/);
});

test('directory users impersonates the admin subject + returns nextPageToken', async () => {
  let gotSubject = '';
  const client = {
    listDirectoryUsers: async (s: string) => {
      gotSubject = s;
      return {
        users: [{ id: '1', primaryEmail: 'a@x', name: { fullName: 'A' } }],
        nextPageToken: 'D',
      };
    },
  };
  const out = JSON.parse(await createDirectoryUsersHandler(deps(client))({ query: 'name:A' }));
  assert.equal(gotSubject, 'admin@x.com');
  assert.equal(out.users[0].primaryEmail, 'a@x');
  assert.equal(out.nextPageToken, 'D');
});

test('people search requires a query', async () => {
  assert.match(await createPeopleSearchHandler(deps({}))({}), /Error:.*"query"/);
});

test('sheet read requires a range', async () => {
  assert.match(await createSheetReadHandler(deps({}))({ spreadsheetId: 's' }), /Error:.*"range"/);
});
