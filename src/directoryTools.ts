/**
 * Directory / People tools (READ-ONLY).
 *
 *   - `gw_directory_users` — list/search Workspace users (Admin SDK Directory).
 *                            Impersonates the ADMIN subject.
 *   - `gw_people_search`   — search a user's contacts (People API). Impersonates
 *                            the normal subject.
 *
 * Useful for resolving a name → email before scheduling or mailing.
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
// gw_directory_users
// ---------------------------------------------------------------------------
export const directoryUsersSpec: NativeToolSpec = {
  name: 'gw_directory_users',
  description:
    'List or search users in the Google Workspace directory (Admin SDK). READ-ONLY. Use "query" with Admin search syntax (e.g. "name:Anna", "email:anna*", "orgName=Sales"). Returns name, primary email, org unit. Resolves people → emails for scheduling/mailing. Requires the admin subject to be delegated for admin.directory.user.readonly.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Admin Directory search, e.g. "name:Anna", "email:anna*", "orgName=Engineering". Omit to list users.',
      },
      domain: {
        type: 'string',
        description: 'Restrict to one domain (e.g. "byte5.de"). Omit to use the whole customer account.',
      },
      maxResults: { type: 'number', description: `Max users per page (1–${MAX_RESULTS}, default ${DEFAULT_RESULTS}).` },
      pageToken: {
        type: 'string',
        description: 'Page cursor from a previous call\'s "nextPageToken" to fetch the next page.',
      },
    },
    required: [],
  },
};

export const DIRECTORY_USERS_PROMPT_DOC =
  '\n- `gw_directory_users`: READ-ONLY Workspace directory lookup (Admin SDK). Search with `query` (`name:Anna`, `email:anna*`, `orgName=Sales`) to resolve a person → primary email before scheduling/mailing. Impersonates the configured admin user.\n';

export function createDirectoryUsersHandler(deps: ToolDeps): NativeToolHandler {
  return async (raw: unknown): Promise<string> => {
    const input = (raw ?? {}) as Record<string, unknown>;
    try {
      const subject = resolveSubject(deps, input.user, { admin: true });
      const params = {
        query: str(input.query),
        domain: str(input.domain),
        maxResults: clamp(input.maxResults, DEFAULT_RESULTS, MAX_RESULTS),
        orderBy: 'email',
        pageToken: str(input.pageToken),
      };
      const key = `dir:users:${subject}:${JSON.stringify(params)}`;
      const result = await deps.cache.getOrSet(key, () =>
        deps.client.listDirectoryUsers(subject, params),
      );
      const users = ((result.users as Record<string, unknown>[]) ?? []).map(trimUser);
      return JSON.stringify(
        { count: users.length, nextPageToken: result.nextPageToken, users },
        null,
        2,
      );
    } catch (err) {
      return formatToolError(err);
    }
  };
}

// ---------------------------------------------------------------------------
// gw_people_search
// ---------------------------------------------------------------------------
export const peopleSearchSpec: NativeToolSpec = {
  name: 'gw_people_search',
  description:
    "Search a user's Google Contacts by name, email or phone (People API). READ-ONLY. Returns matching contacts with names, emails and phone numbers. Use \"user\" to search a specific person's contacts.",
  input_schema: {
    type: 'object',
    properties: {
      user: { type: 'string', description: "Whose contacts to search (email). Omit for the default user." },
      query: { type: 'string', description: 'Search text (name, email fragment, etc.). Required.' },
      pageSize: { type: 'number', description: `Max contacts (1–30, default 10).` },
    },
    required: ['query'],
  },
};

export const PEOPLE_SEARCH_PROMPT_DOC =
  "\n- `gw_people_search`: READ-ONLY — search a user's Google Contacts by name/email/phone (People API). Pass `user` to search someone else's contacts.\n";

export function createPeopleSearchHandler(deps: ToolDeps): NativeToolHandler {
  return async (raw: unknown): Promise<string> => {
    const input = (raw ?? {}) as Record<string, unknown>;
    try {
      const subject = resolveSubject(deps, input.user);
      const query = str(input.query);
      if (!query) throw new GoogleInputError('"query" is required.');
      const pageSize = clamp(input.pageSize, 10, 30);
      const key = `people:search:${subject}:${query}:${pageSize}`;
      const result = await deps.cache.getOrSet(key, () =>
        deps.client.searchContacts(subject, { query, pageSize }),
      );
      const results = ((result.results as Record<string, unknown>[]) ?? []).map((r) =>
        trimPerson(r.person as Record<string, unknown>),
      );
      return JSON.stringify({ subject, query, count: results.length, contacts: results }, null, 2);
    } catch (err) {
      return formatToolError(err);
    }
  };
}

// ---------------------------------------------------------------------------
// Helpers — trim verbose Directory / People payloads.
// ---------------------------------------------------------------------------
function trimUser(u: Record<string, unknown>): Record<string, unknown> {
  const name = u.name as { fullName?: string } | undefined;
  return {
    id: u.id,
    primaryEmail: u.primaryEmail,
    fullName: name?.fullName,
    orgUnitPath: u.orgUnitPath,
    suspended: u.suspended,
    isAdmin: u.isAdmin,
  };
}

function trimPerson(person: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!person) return {};
  const names = (person.names as { displayName?: string }[] | undefined) ?? [];
  const emails = (person.emailAddresses as { value?: string }[] | undefined) ?? [];
  const phones = (person.phoneNumbers as { value?: string }[] | undefined) ?? [];
  const orgs = (person.organizations as { name?: string; title?: string }[] | undefined) ?? [];
  return {
    displayName: names[0]?.displayName,
    emails: emails.map((e) => e.value).filter(Boolean),
    phones: phones.map((p) => p.value).filter(Boolean),
    organization: orgs[0] ? { name: orgs[0].name, title: orgs[0].title } : undefined,
  };
}
