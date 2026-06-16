/**
 * Google Calendar tools.
 *
 * Read-only (always on):
 *   - `gw_calendar_list_events` — list/search events in a time window.
 *   - `gw_calendar_freebusy`    — free/busy windows across calendars.
 * Writes (opt-in via `enable_writes`):
 *   - `gw_calendar_create_event`
 *   - `gw_calendar_update_event`
 *
 * All reads go through the short-TTL cache keyed by the impersonated subject.
 */

import type { NativeToolHandler, NativeToolSpec } from '@omadia/plugin-api';

import { formatToolError, GoogleInputError } from './errors.js';
import { resolveSubject, type ToolDeps } from './toolDeps.js';

const MAX_RESULTS = 100;
const DEFAULT_RESULTS = 25;

function clamp(value: unknown, def: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

// ---------------------------------------------------------------------------
// gw_calendar_list_events
// ---------------------------------------------------------------------------
export const calendarListEventsSpec: NativeToolSpec = {
  name: 'gw_calendar_list_events',
  description:
    'List or search Google Calendar events in a time window. READ-ONLY. Times are RFC3339 (e.g. "2026-06-13T00:00:00Z"). Returns events expanded into single instances ordered by start time. Use "user" to read a specific person\'s calendar (their email); omit it to use the default user.',
  input_schema: {
    type: 'object',
    properties: {
      user: {
        type: 'string',
        description: 'Email of the user whose calendar to read. Omit to use the default user.',
      },
      calendarId: {
        type: 'string',
        description: 'Calendar id. Default "primary". Can be another calendar the user can see.',
      },
      timeMin: { type: 'string', description: 'RFC3339 lower bound (inclusive) for event start.' },
      timeMax: { type: 'string', description: 'RFC3339 upper bound (exclusive) for event start.' },
      q: { type: 'string', description: 'Free-text search over event fields.' },
      maxResults: {
        type: 'number',
        description: `Max events per page (1–${MAX_RESULTS}, default ${DEFAULT_RESULTS}).`,
      },
      pageToken: {
        type: 'string',
        description: 'Page cursor from a previous call\'s "nextPageToken" to fetch the next page.',
      },
    },
    required: [],
  },
};

export const CALENDAR_LIST_EVENTS_PROMPT_DOC =
  '\n- `gw_calendar_list_events`: READ-ONLY list/search of Google Calendar events in a time window (RFC3339 `timeMin`/`timeMax`). Pass `user` (an email) to read someone else\'s calendar; omit for the default user. For "is X free?" questions prefer `gw_calendar_freebusy`.\n';

export function createCalendarListEventsHandler(deps: ToolDeps): NativeToolHandler {
  return async (raw: unknown): Promise<string> => {
    const input = (raw ?? {}) as Record<string, unknown>;
    try {
      const subject = resolveSubject(deps, input.user);
      const calendarId = str(input.calendarId) ?? 'primary';
      const params = {
        calendarId,
        timeMin: str(input.timeMin),
        timeMax: str(input.timeMax),
        q: str(input.q),
        maxResults: clamp(input.maxResults, DEFAULT_RESULTS, MAX_RESULTS),
        singleEvents: true,
        pageToken: str(input.pageToken),
      };
      const key = `cal:events:${subject}:${JSON.stringify(params)}`;
      const result = await deps.cache.getOrSet(key, () => deps.client.listEvents(subject, params));
      const items = (result.items as unknown[]) ?? [];
      return JSON.stringify(
        { subject, calendarId, count: items.length, nextPageToken: result.nextPageToken, events: items },
        null,
        2,
      );
    } catch (err) {
      return formatToolError(err);
    }
  };
}

// ---------------------------------------------------------------------------
// gw_calendar_freebusy
// ---------------------------------------------------------------------------
export const calendarFreeBusySpec: NativeToolSpec = {
  name: 'gw_calendar_freebusy',
  description:
    'Query free/busy windows for one or more Google calendars in a time range. READ-ONLY. Use this to answer "when is X free?" / "find a common slot". Times are RFC3339. calendarIds are usually user emails.',
  input_schema: {
    type: 'object',
    properties: {
      user: { type: 'string', description: 'Email to impersonate for the query. Omit for default.' },
      timeMin: { type: 'string', description: 'RFC3339 start of the window (required).' },
      timeMax: { type: 'string', description: 'RFC3339 end of the window (required).' },
      calendarIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Calendars to check, usually user emails. Defaults to the impersonated user.',
      },
    },
    required: ['timeMin', 'timeMax'],
  },
};

export const CALENDAR_FREEBUSY_PROMPT_DOC =
  '\n- `gw_calendar_freebusy`: READ-ONLY free/busy lookup across Google calendars for a time range (RFC3339). Best tool for "when is X free" and finding common meeting slots — pass `calendarIds` (usually emails). Prefer this over listing events for availability.\n';

export function createCalendarFreeBusyHandler(deps: ToolDeps): NativeToolHandler {
  return async (raw: unknown): Promise<string> => {
    const input = (raw ?? {}) as Record<string, unknown>;
    try {
      const subject = resolveSubject(deps, input.user);
      const timeMin = str(input.timeMin);
      const timeMax = str(input.timeMax);
      if (!timeMin || !timeMax) {
        throw new GoogleInputError('"timeMin" and "timeMax" (RFC3339) are required.');
      }
      const ids = Array.isArray(input.calendarIds)
        ? input.calendarIds.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
        : [];
      const calendarIds = ids.length > 0 ? ids : [subject];
      const key = `cal:fb:${subject}:${timeMin}:${timeMax}:${calendarIds.sort().join(',')}`;
      const result = await deps.cache.getOrSet(key, () =>
        deps.client.freeBusy(subject, { timeMin, timeMax, calendarIds }),
      );
      return JSON.stringify({ subject, timeMin, timeMax, calendars: result.calendars }, null, 2);
    } catch (err) {
      return formatToolError(err);
    }
  };
}

// ---------------------------------------------------------------------------
// gw_calendar_create_event (write)
// ---------------------------------------------------------------------------
export const calendarCreateEventSpec: NativeToolSpec = {
  name: 'gw_calendar_create_event',
  description:
    'Create a Google Calendar event. WRITE — only call after confirming intent with the user. Provide summary, start/end (RFC3339 dateTime), optional attendees and description. Returns the created event.',
  input_schema: {
    type: 'object',
    properties: {
      user: { type: 'string', description: 'Email of the calendar owner. Omit for default user.' },
      calendarId: { type: 'string', description: 'Target calendar id. Default "primary".' },
      summary: { type: 'string', description: 'Event title.' },
      description: { type: 'string', description: 'Event description / notes.' },
      location: { type: 'string', description: 'Event location.' },
      start: { type: 'string', description: 'RFC3339 start dateTime, e.g. "2026-06-20T10:00:00+02:00".' },
      end: { type: 'string', description: 'RFC3339 end dateTime.' },
      attendees: {
        type: 'array',
        items: { type: 'string' },
        description: 'Attendee emails to invite.',
      },
      sendUpdates: {
        type: 'string',
        description: 'Notification policy: "all", "externalOnly", or "none" (default "none").',
      },
    },
    required: ['summary', 'start', 'end'],
  },
};

export const CALENDAR_CREATE_EVENT_PROMPT_DOC =
  '\n- `gw_calendar_create_event`: WRITE — create a Google Calendar event (summary + RFC3339 start/end, optional attendees). Only after the user confirms the details. Set `sendUpdates:"all"` to notify attendees.\n';

export function createCalendarCreateEventHandler(deps: ToolDeps): NativeToolHandler {
  return async (raw: unknown): Promise<string> => {
    const input = (raw ?? {}) as Record<string, unknown>;
    try {
      const subject = resolveSubject(deps, input.user);
      const calendarId = str(input.calendarId) ?? 'primary';
      const summary = str(input.summary);
      const start = str(input.start);
      const end = str(input.end);
      if (!summary || !start || !end) {
        throw new GoogleInputError('"summary", "start" and "end" (RFC3339) are required.');
      }
      const attendees = Array.isArray(input.attendees)
        ? input.attendees
            .filter((v): v is string => typeof v === 'string' && v.includes('@'))
            .map((email) => ({ email }))
        : undefined;
      const event: Record<string, unknown> = {
        summary,
        description: str(input.description),
        location: str(input.location),
        start: { dateTime: start },
        end: { dateTime: end },
        ...(attendees && attendees.length > 0 ? { attendees } : {}),
      };
      const created = await deps.client.createEvent(subject, calendarId, event, {
        sendUpdates: str(input.sendUpdates) ?? 'none',
      });
      deps.cache.clear();
      return JSON.stringify(
        { created: true, id: created.id, htmlLink: created.htmlLink, event: created },
        null,
        2,
      );
    } catch (err) {
      return formatToolError(err);
    }
  };
}

// ---------------------------------------------------------------------------
// gw_calendar_update_event (write)
// ---------------------------------------------------------------------------
export const calendarUpdateEventSpec: NativeToolSpec = {
  name: 'gw_calendar_update_event',
  description:
    'Update fields of an existing Google Calendar event (partial patch). WRITE — only after confirming with the user. Identify the event by id; pass only the fields to change.',
  input_schema: {
    type: 'object',
    properties: {
      user: { type: 'string', description: 'Email of the calendar owner. Omit for default user.' },
      calendarId: { type: 'string', description: 'Calendar id. Default "primary".' },
      eventId: { type: 'string', description: 'Id of the event to update (required).' },
      summary: { type: 'string', description: 'New title.' },
      description: { type: 'string', description: 'New description.' },
      location: { type: 'string', description: 'New location.' },
      start: { type: 'string', description: 'New RFC3339 start dateTime.' },
      end: { type: 'string', description: 'New RFC3339 end dateTime.' },
      sendUpdates: { type: 'string', description: '"all", "externalOnly", or "none" (default "none").' },
    },
    required: ['eventId'],
  },
};

export const CALENDAR_UPDATE_EVENT_PROMPT_DOC =
  '\n- `gw_calendar_update_event`: WRITE — partial-update an existing Google Calendar event by `eventId`; pass only the fields to change. Confirm with the user first.\n';

export function createCalendarUpdateEventHandler(deps: ToolDeps): NativeToolHandler {
  return async (raw: unknown): Promise<string> => {
    const input = (raw ?? {}) as Record<string, unknown>;
    try {
      const subject = resolveSubject(deps, input.user);
      const calendarId = str(input.calendarId) ?? 'primary';
      const eventId = str(input.eventId);
      if (!eventId) throw new GoogleInputError('"eventId" is required.');
      const patch: Record<string, unknown> = {};
      if (str(input.summary)) patch.summary = str(input.summary);
      if (str(input.description)) patch.description = str(input.description);
      if (str(input.location)) patch.location = str(input.location);
      if (str(input.start)) patch.start = { dateTime: str(input.start) };
      if (str(input.end)) patch.end = { dateTime: str(input.end) };
      if (Object.keys(patch).length === 0) {
        throw new GoogleInputError('nothing to update — provide at least one field to change.');
      }
      const updated = await deps.client.patchEvent(subject, calendarId, eventId, patch, {
        sendUpdates: str(input.sendUpdates) ?? 'none',
      });
      deps.cache.clear();
      return JSON.stringify({ updated: true, id: updated.id, event: updated }, null, 2);
    } catch (err) {
      return formatToolError(err);
    }
  };
}
