/**
 * Gmail tools.
 *
 * Read-only (always on):
 *   - `gw_gmail_search`      — search messages with Gmail query syntax.
 *   - `gw_gmail_get_message` — fetch one message, trimmed to headers + body text.
 * Writes (opt-in via `enable_writes`):
 *   - `gw_gmail_send`  — send a plain-text email.
 *   - `gw_gmail_draft` — create a draft.
 *
 * All reads go through the short-TTL cache keyed by the impersonated subject.
 */

import type { NativeToolHandler, NativeToolSpec } from '@omadia/plugin-api';

import { formatToolError, GoogleInputError } from './errors.js';
import { resolveSubject, type ToolDeps } from './toolDeps.js';

const MAX_RESULTS = 50;
const DEFAULT_RESULTS = 15;

function clamp(value: unknown, def: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function strList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string' && v.includes('@'));
  }
  const s = str(value);
  return s ? s.split(/[,;\s]+/).filter((x) => x.includes('@')) : [];
}

// ---------------------------------------------------------------------------
// gw_gmail_search
// ---------------------------------------------------------------------------
export const gmailSearchSpec: NativeToolSpec = {
  name: 'gw_gmail_search',
  description:
    'Search a Gmail mailbox using Gmail query syntax (e.g. "from:alice@x.com newer_than:7d has:attachment", "subject:invoice"). READ-ONLY. Returns matching message ids + thread ids; call gw_gmail_get_message for content. Use "user" to search a specific mailbox.',
  input_schema: {
    type: 'object',
    properties: {
      user: { type: 'string', description: 'Mailbox to search (email). Omit for the default user.' },
      q: {
        type: 'string',
        description: 'Gmail search query, e.g. "from:boss@corp.com newer_than:3d", "is:unread label:invoices".',
      },
      maxResults: {
        type: 'number',
        description: `Max messages per page (1–${MAX_RESULTS}, default ${DEFAULT_RESULTS}).`,
      },
      pageToken: {
        type: 'string',
        description: 'Page cursor from a previous call\'s "nextPageToken" to fetch the next page.',
      },
    },
    required: ['q'],
  },
};

export const GMAIL_SEARCH_PROMPT_DOC =
  '\n- `gw_gmail_search`: READ-ONLY Gmail search using Gmail query syntax (`from:`, `subject:`, `newer_than:7d`, `is:unread`, `has:attachment`, `label:`). Returns message ids; follow up with `gw_gmail_get_message` for content. Pass `user` to search another mailbox.\n';

export function createGmailSearchHandler(deps: ToolDeps): NativeToolHandler {
  return async (raw: unknown): Promise<string> => {
    const input = (raw ?? {}) as Record<string, unknown>;
    try {
      const subject = resolveSubject(deps, input.user);
      const q = str(input.q);
      if (!q) throw new GoogleInputError('"q" (a Gmail search query) is required.');
      const maxResults = clamp(input.maxResults, DEFAULT_RESULTS, MAX_RESULTS);
      const pageToken = str(input.pageToken);
      const key = `gmail:search:${subject}:${q}:${maxResults}:${pageToken ?? ''}`;
      const result = await deps.cache.getOrSet(key, () =>
        deps.client.searchMessages(subject, { q, maxResults, pageToken }),
      );
      const messages = (result.messages as unknown[]) ?? [];
      return JSON.stringify(
        {
          subject,
          query: q,
          count: messages.length,
          resultSizeEstimate: result.resultSizeEstimate,
          nextPageToken: result.nextPageToken,
          messages,
        },
        null,
        2,
      );
    } catch (err) {
      return formatToolError(err);
    }
  };
}

// ---------------------------------------------------------------------------
// gw_gmail_get_message
// ---------------------------------------------------------------------------
export const gmailGetMessageSpec: NativeToolSpec = {
  name: 'gw_gmail_get_message',
  description:
    'Fetch one Gmail message by id, trimmed to its key headers (From/To/Subject/Date), labels, snippet and decoded plain-text body. READ-ONLY. Get the id from gw_gmail_search.',
  input_schema: {
    type: 'object',
    properties: {
      user: { type: 'string', description: 'Mailbox (email). Omit for the default user.' },
      id: { type: 'string', description: 'Gmail message id (from gw_gmail_search).' },
    },
    required: ['id'],
  },
};

export const GMAIL_GET_MESSAGE_PROMPT_DOC =
  '\n- `gw_gmail_get_message`: READ-ONLY — fetch one Gmail message by `id` (from `gw_gmail_search`), returned as headers + snippet + decoded plain-text body.\n';

export function createGmailGetMessageHandler(deps: ToolDeps): NativeToolHandler {
  return async (raw: unknown): Promise<string> => {
    const input = (raw ?? {}) as Record<string, unknown>;
    try {
      const subject = resolveSubject(deps, input.user);
      const id = str(input.id);
      if (!id) throw new GoogleInputError('"id" (a Gmail message id) is required.');
      const key = `gmail:msg:${subject}:${id}`;
      const msg = await deps.cache.getOrSet(key, () => deps.client.getMessage(subject, id));
      return JSON.stringify(trimMessage(subject, msg), null, 2);
    } catch (err) {
      return formatToolError(err);
    }
  };
}

// ---------------------------------------------------------------------------
// gw_gmail_send (write)
// ---------------------------------------------------------------------------
export const gmailSendSpec: NativeToolSpec = {
  name: 'gw_gmail_send',
  description:
    'Send a plain-text email from the user\'s Gmail. WRITE — only call after the user confirms recipients, subject and body. The From address is the impersonated user.',
  input_schema: {
    type: 'object',
    properties: {
      user: { type: 'string', description: 'Sender mailbox (email). Omit for the default user.' },
      to: { type: 'array', items: { type: 'string' }, description: 'Recipient email(s).' },
      cc: { type: 'array', items: { type: 'string' }, description: 'CC email(s).' },
      subject: { type: 'string', description: 'Subject line.' },
      body: { type: 'string', description: 'Plain-text body.' },
    },
    required: ['to', 'subject', 'body'],
  },
};

export const GMAIL_SEND_PROMPT_DOC =
  '\n- `gw_gmail_send`: WRITE — send a plain-text email as the user. Confirm recipients, subject and body with the user first. From = the impersonated user.\n';

export function createGmailSendHandler(deps: ToolDeps): NativeToolHandler {
  return async (raw: unknown): Promise<string> => {
    const input = (raw ?? {}) as Record<string, unknown>;
    try {
      const subject = resolveSubject(deps, input.user);
      const to = strList(input.to);
      const subjectLine = str(input.subject);
      const body = typeof input.body === 'string' ? input.body : '';
      if (to.length === 0) throw new GoogleInputError('"to" must contain at least one email.');
      if (!subjectLine) throw new GoogleInputError('"subject" is required.');
      const rawMessage = buildRawMessage({
        from: subject,
        to,
        cc: strList(input.cc),
        subject: subjectLine,
        body,
      });
      const sent = await deps.client.sendMessage(subject, rawMessage);
      return JSON.stringify({ sent: true, id: sent.id, threadId: sent.threadId }, null, 2);
    } catch (err) {
      return formatToolError(err);
    }
  };
}

// ---------------------------------------------------------------------------
// gw_gmail_draft (write)
// ---------------------------------------------------------------------------
export const gmailDraftSpec: NativeToolSpec = {
  name: 'gw_gmail_draft',
  description:
    'Create a Gmail draft (does NOT send). WRITE. Useful to prepare a message for the user to review and send themselves.',
  input_schema: {
    type: 'object',
    properties: {
      user: { type: 'string', description: 'Mailbox (email). Omit for the default user.' },
      to: { type: 'array', items: { type: 'string' }, description: 'Recipient email(s).' },
      cc: { type: 'array', items: { type: 'string' }, description: 'CC email(s).' },
      subject: { type: 'string', description: 'Subject line.' },
      body: { type: 'string', description: 'Plain-text body.' },
    },
    required: ['to', 'subject', 'body'],
  },
};

export const GMAIL_DRAFT_PROMPT_DOC =
  '\n- `gw_gmail_draft`: WRITE — create a Gmail draft (does not send). Good for preparing a message the user will review and send.\n';

export function createGmailDraftHandler(deps: ToolDeps): NativeToolHandler {
  return async (raw: unknown): Promise<string> => {
    const input = (raw ?? {}) as Record<string, unknown>;
    try {
      const subject = resolveSubject(deps, input.user);
      const to = strList(input.to);
      const subjectLine = str(input.subject);
      const body = typeof input.body === 'string' ? input.body : '';
      if (to.length === 0) throw new GoogleInputError('"to" must contain at least one email.');
      if (!subjectLine) throw new GoogleInputError('"subject" is required.');
      const rawMessage = buildRawMessage({
        from: subject,
        to,
        cc: strList(input.cc),
        subject: subjectLine,
        body,
      });
      const draft = await deps.client.createDraft(subject, rawMessage);
      return JSON.stringify({ draftCreated: true, id: draft.id }, null, 2);
    } catch (err) {
      return formatToolError(err);
    }
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a base64url-encoded RFC 2822 plain-text message. */
function buildRawMessage(p: {
  from: string;
  to: readonly string[];
  cc: readonly string[];
  subject: string;
  body: string;
}): string {
  const headers = [
    `From: ${p.from}`,
    `To: ${p.to.join(', ')}`,
    ...(p.cc.length > 0 ? [`Cc: ${p.cc.join(', ')}`] : []),
    `Subject: ${encodeHeader(p.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
  ];
  const mime = `${headers.join('\r\n')}\r\n\r\n${p.body}`;
  return Buffer.from(mime, 'utf8').toString('base64url');
}

/** RFC 2047 encode a header value if it contains non-ASCII characters. */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

interface GmailPayloadHeader {
  name?: string;
  value?: string;
}
interface GmailPayload {
  mimeType?: string;
  headers?: GmailPayloadHeader[];
  body?: { data?: string; size?: number };
  parts?: GmailPayload[];
}

/** Trim a full Gmail message into a compact, model-friendly object. */
function trimMessage(subject: string, msg: Record<string, unknown>): Record<string, unknown> {
  const payload = (msg.payload as GmailPayload) ?? {};
  const wanted = new Set(['from', 'to', 'cc', 'subject', 'date']);
  const headers: Record<string, string> = {};
  for (const h of payload.headers ?? []) {
    const name = (h.name ?? '').toLowerCase();
    if (wanted.has(name) && h.value) headers[name] = h.value;
  }
  return {
    subject,
    id: msg.id,
    threadId: msg.threadId,
    labelIds: msg.labelIds,
    snippet: msg.snippet,
    headers,
    body: extractPlainText(payload).slice(0, 16_000),
  };
}

/** Walk the MIME tree, decoding the first text/plain part (falling back to html). */
function extractPlainText(payload: GmailPayload): string {
  const plain = findPart(payload, 'text/plain');
  if (plain?.body?.data) return decodeB64Url(plain.body.data);
  const html = findPart(payload, 'text/html');
  if (html?.body?.data) return stripHtml(decodeB64Url(html.body.data));
  if (payload.body?.data) return decodeB64Url(payload.body.data);
  return '';
}

function findPart(payload: GmailPayload, mimeType: string): GmailPayload | undefined {
  if (payload.mimeType === mimeType && payload.body?.data) return payload;
  for (const part of payload.parts ?? []) {
    const found = findPart(part, mimeType);
    if (found) return found;
  }
  return undefined;
}

function decodeB64Url(data: string): string {
  try {
    return Buffer.from(data, 'base64url').toString('utf8');
  } catch {
    return '';
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
