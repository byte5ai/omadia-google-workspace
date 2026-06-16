/**
 * Shared dependency bundle handed to every tool handler factory, plus the
 * subject-resolution rule used across all surfaces.
 *
 * Impersonation subject precedence:
 *   1. the explicit `user` argument on the tool call (an email), if given;
 *   2. the admin subject for directory/admin reads (`admin: true`);
 *   3. the default subject from config.
 */

import type { GoogleWorkspaceClient } from './googleClient.js';
import type { ResponseCache } from './responseCache.js';
import { GoogleInputError } from './errors.js';

export interface ToolDeps {
  readonly client: GoogleWorkspaceClient;
  readonly cache: ResponseCache;
  /** Default user the integration acts as when a tool omits `user`. */
  readonly defaultSubject: string;
  /** Admin user impersonated for Directory/Admin SDK reads. */
  readonly adminSubject: string;
}

/** Resolve the impersonation subject for a tool call. */
export function resolveSubject(
  deps: ToolDeps,
  user: unknown,
  opts: { admin?: boolean } = {},
): string {
  const u = typeof user === 'string' ? user.trim() : '';
  if (u) {
    if (!u.includes('@')) {
      throw new GoogleInputError(`"user" must be a full email address, got: '${u}'`);
    }
    return u;
  }
  const fallback = opts.admin ? deps.adminSubject : deps.defaultSubject;
  if (!fallback) {
    throw new GoogleInputError(
      opts.admin
        ? 'no admin user configured — set gw_admin_subject (or gw_subject_default) or pass "user".'
        : 'no default user configured — set gw_subject_default or pass "user".',
    );
  }
  return fallback;
}
