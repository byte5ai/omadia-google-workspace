/**
 * Google Drive / Docs / Sheets tools (all READ-ONLY in v1).
 *
 *   - `gw_drive_search`   — find files/folders with Drive query syntax.
 *   - `gw_drive_get_file` — file metadata by id.
 *   - `gw_doc_read`       — a Google Doc's text content (flattened).
 *   - `gw_sheet_read`     — values from a Sheets range.
 *
 * All reads go through the short-TTL cache keyed by the impersonated subject.
 */

import type { NativeToolHandler, NativeToolSpec } from '@omadia/plugin-api';

import { formatToolError, GoogleInputError } from './errors.js';
import { resolveSubject, type ToolDeps } from './toolDeps.js';

const MAX_RESULTS = 50;
const DEFAULT_RESULTS = 20;

function clamp(value: unknown, def: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

// ---------------------------------------------------------------------------
// gw_drive_search
// ---------------------------------------------------------------------------
export const driveSearchSpec: NativeToolSpec = {
  name: 'gw_drive_search',
  description:
    'Search Google Drive using Drive query syntax. READ-ONLY. Examples: "name contains \'budget\'", "mimeType=\'application/vnd.google-apps.document\'", "\'me\' in owners and modifiedTime > \'2026-01-01T00:00:00\'". Returns file metadata (id, name, mimeType, modifiedTime, owner, link).',
  input_schema: {
    type: 'object',
    properties: {
      user: { type: 'string', description: 'Drive owner to impersonate (email). Omit for default.' },
      q: {
        type: 'string',
        description:
          "Drive query. e.g. \"name contains 'report' and trashed=false\". Omit to list recent files.",
      },
      orderBy: {
        type: 'string',
        description: 'Sort, e.g. "modifiedTime desc", "name". Default "modifiedTime desc".',
      },
      pageSize: { type: 'number', description: `Max files per page (1–${MAX_RESULTS}, default ${DEFAULT_RESULTS}).` },
      pageToken: {
        type: 'string',
        description: 'Page cursor from a previous call\'s "nextPageToken" to fetch the next page.',
      },
    },
    required: [],
  },
};

export const DRIVE_SEARCH_PROMPT_DOC =
  '\n- `gw_drive_search`: READ-ONLY Google Drive search (Drive query syntax: `name contains \'x\'`, `mimeType=\'…\'`, `modifiedTime > \'…\'`). Returns file metadata + ids; use the id with `gw_drive_get_file`, `gw_doc_read` or `gw_sheet_read`.\n';

export function createDriveSearchHandler(deps: ToolDeps): NativeToolHandler {
  return async (raw: unknown): Promise<string> => {
    const input = (raw ?? {}) as Record<string, unknown>;
    try {
      const subject = resolveSubject(deps, input.user);
      const params = {
        q: str(input.q),
        orderBy: str(input.orderBy) ?? 'modifiedTime desc',
        pageSize: clamp(input.pageSize, DEFAULT_RESULTS, MAX_RESULTS),
        pageToken: str(input.pageToken),
      };
      const key = `drive:search:${subject}:${JSON.stringify(params)}`;
      const result = await deps.cache.getOrSet(key, () => deps.client.searchFiles(subject, params));
      const files = (result.files as unknown[]) ?? [];
      return JSON.stringify(
        { subject, count: files.length, nextPageToken: result.nextPageToken, files },
        null,
        2,
      );
    } catch (err) {
      return formatToolError(err);
    }
  };
}

// ---------------------------------------------------------------------------
// gw_drive_get_file
// ---------------------------------------------------------------------------
export const driveGetFileSpec: NativeToolSpec = {
  name: 'gw_drive_get_file',
  description:
    'Get metadata for one Google Drive file by id (name, mimeType, owners, timestamps, link, size). READ-ONLY. For document text use gw_doc_read; for spreadsheet values use gw_sheet_read.',
  input_schema: {
    type: 'object',
    properties: {
      user: { type: 'string', description: 'Drive owner to impersonate (email). Omit for default.' },
      fileId: { type: 'string', description: 'Drive file id (required).' },
    },
    required: ['fileId'],
  },
};

export const DRIVE_GET_FILE_PROMPT_DOC =
  '\n- `gw_drive_get_file`: READ-ONLY — metadata for one Drive file by `fileId`. For Doc text use `gw_doc_read`; for Sheet values use `gw_sheet_read`.\n';

export function createDriveGetFileHandler(deps: ToolDeps): NativeToolHandler {
  return async (raw: unknown): Promise<string> => {
    const input = (raw ?? {}) as Record<string, unknown>;
    try {
      const subject = resolveSubject(deps, input.user);
      const fileId = str(input.fileId);
      if (!fileId) throw new GoogleInputError('"fileId" is required.');
      const key = `drive:file:${subject}:${fileId}`;
      const file = await deps.cache.getOrSet(key, () => deps.client.getFile(subject, fileId));
      return JSON.stringify({ subject, file }, null, 2);
    } catch (err) {
      return formatToolError(err);
    }
  };
}

// ---------------------------------------------------------------------------
// gw_doc_read
// ---------------------------------------------------------------------------
export const docReadSpec: NativeToolSpec = {
  name: 'gw_doc_read',
  description:
    "Read a Google Doc's text content by document id. READ-ONLY. Returns the title and the flattened plain text of the body (capped). Use gw_drive_search to find the document id.",
  input_schema: {
    type: 'object',
    properties: {
      user: { type: 'string', description: 'Owner to impersonate (email). Omit for default.' },
      documentId: { type: 'string', description: 'Google Doc id (required).' },
    },
    required: ['documentId'],
  },
};

export const DOC_READ_PROMPT_DOC =
  '\n- `gw_doc_read`: READ-ONLY — flatten a Google Doc to plain text by `documentId` (find it via `gw_drive_search`).\n';

export function createDocReadHandler(deps: ToolDeps): NativeToolHandler {
  return async (raw: unknown): Promise<string> => {
    const input = (raw ?? {}) as Record<string, unknown>;
    try {
      const subject = resolveSubject(deps, input.user);
      const documentId = str(input.documentId);
      if (!documentId) throw new GoogleInputError('"documentId" is required.');
      const key = `docs:read:${subject}:${documentId}`;
      const doc = await deps.cache.getOrSet(key, () => deps.client.getDocument(subject, documentId));
      return JSON.stringify(
        {
          subject,
          documentId,
          title: doc.title,
          text: flattenDocText(doc).slice(0, 40_000),
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
// gw_sheet_read
// ---------------------------------------------------------------------------
export const sheetReadSpec: NativeToolSpec = {
  name: 'gw_sheet_read',
  description:
    'Read cell values from a Google Sheets range (A1 notation, e.g. "Sheet1!A1:D50"). READ-ONLY. Returns a 2D array of values.',
  input_schema: {
    type: 'object',
    properties: {
      user: { type: 'string', description: 'Owner to impersonate (email). Omit for default.' },
      spreadsheetId: { type: 'string', description: 'Google Sheets id (required).' },
      range: {
        type: 'string',
        description: 'A1 range, e.g. "Sheet1!A1:D50" or "A:C". Required.',
      },
    },
    required: ['spreadsheetId', 'range'],
  },
};

export const SHEET_READ_PROMPT_DOC =
  '\n- `gw_sheet_read`: READ-ONLY — read a Google Sheets range in A1 notation (e.g. `Sheet1!A1:D50`) into a 2D array.\n';

export function createSheetReadHandler(deps: ToolDeps): NativeToolHandler {
  return async (raw: unknown): Promise<string> => {
    const input = (raw ?? {}) as Record<string, unknown>;
    try {
      const subject = resolveSubject(deps, input.user);
      const spreadsheetId = str(input.spreadsheetId);
      const range = str(input.range);
      if (!spreadsheetId) throw new GoogleInputError('"spreadsheetId" is required.');
      if (!range) throw new GoogleInputError('"range" (A1 notation) is required.');
      const key = `sheets:read:${subject}:${spreadsheetId}:${range}`;
      const result = await deps.cache.getOrSet(key, () =>
        deps.client.getSheetValues(subject, spreadsheetId, range),
      );
      return JSON.stringify(
        { subject, spreadsheetId, range: result.range, values: result.values ?? [] },
        null,
        2,
      );
    } catch (err) {
      return formatToolError(err);
    }
  };
}

// ---------------------------------------------------------------------------
// Helpers — flatten a Docs document into plain text.
// ---------------------------------------------------------------------------
interface DocsTextRun {
  content?: string;
}
interface DocsParagraphElement {
  textRun?: DocsTextRun;
}
interface DocsParagraph {
  elements?: DocsParagraphElement[];
}
interface DocsStructuralElement {
  paragraph?: DocsParagraph;
  table?: { tableRows?: { tableCells?: { content?: DocsStructuralElement[] }[] }[] };
}

function flattenDocText(doc: Record<string, unknown>): string {
  const body = doc.body as { content?: DocsStructuralElement[] } | undefined;
  if (!body?.content) return '';
  const out: string[] = [];
  collectDocText(body.content, out);
  return out.join('').replace(/\n{3,}/g, '\n\n').trim();
}

function collectDocText(content: DocsStructuralElement[], out: string[]): void {
  for (const el of content) {
    if (el.paragraph?.elements) {
      for (const pe of el.paragraph.elements) {
        if (pe.textRun?.content) out.push(pe.textRun.content);
      }
    }
    if (el.table?.tableRows) {
      for (const row of el.table.tableRows) {
        for (const cell of row.tableCells ?? []) {
          if (cell.content) collectDocText(cell.content, out);
        }
      }
    }
  }
}
