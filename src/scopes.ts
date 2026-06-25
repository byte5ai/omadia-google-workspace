/**
 * OAuth scope catalogue + assembly.
 *
 * With domain-wide delegation the access token covers the *union* of the
 * scopes the service account is authorised for in the Admin console. We
 * request that same union at token-exchange time, derived from which surfaces
 * are enabled and whether writes are turned on. The operator must authorise
 * the EXACT scope strings produced here in the Admin console
 * (Security → API controls → Domain-wide delegation), so they are also printed
 * in the setup guide and logged at activation.
 */

export type Surface = 'calendar' | 'gmail' | 'drive' | 'directory' | 'people';

export const ALL_SURFACES: readonly Surface[] = [
  'calendar',
  'gmail',
  'drive',
  'directory',
  'people',
];

/** Read scopes contributed by each surface. */
const READ_SCOPES: Record<Surface, readonly string[]> = {
  calendar: ['https://www.googleapis.com/auth/calendar.readonly'],
  gmail: ['https://www.googleapis.com/auth/gmail.readonly'],
  drive: [
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/documents.readonly',
    'https://www.googleapis.com/auth/spreadsheets.readonly',
  ],
  directory: ['https://www.googleapis.com/auth/admin.directory.user.readonly'],
  people: [
    'https://www.googleapis.com/auth/contacts.readonly',
    'https://www.googleapis.com/auth/directory.readonly',
  ],
};

/** Additional scopes a surface needs once writes are enabled. */
const WRITE_SCOPES: Partial<Record<Surface, readonly string[]>> = {
  calendar: ['https://www.googleapis.com/auth/calendar.events'],
  gmail: [
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.compose',
  ],
  drive: [
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/spreadsheets',
  ],
};

/**
 * Assemble the de-duplicated, sorted scope list for the enabled surfaces.
 * When `enableWrites` is true, the write scopes for surfaces that have them
 * are folded in. The result is stable (sorted) so the token cache key is too.
 */
export function assembleScopes(
  surfaces: readonly Surface[],
  enableWrites: boolean,
): string[] {
  const out = new Set<string>();
  for (const s of surfaces) {
    for (const scope of READ_SCOPES[s]) out.add(scope);
    if (enableWrites) {
      for (const scope of WRITE_SCOPES[s] ?? []) out.add(scope);
    }
  }
  return [...out].sort();
}

/**
 * Parse a comma- or space-separated operator override into a clean scope list.
 * Returns undefined when the input is empty, so the caller falls back to the
 * derived set.
 */
export function parseScopeOverride(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const parts = raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? [...new Set(parts)].sort() : undefined;
}

/** Parse the operator's enabled-surfaces config into a validated list. */
export function parseSurfaces(raw: string | undefined): Surface[] {
  if (!raw || !raw.trim()) return [...ALL_SURFACES];
  const wanted = raw
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const valid = wanted.filter((s): s is Surface =>
    (ALL_SURFACES as readonly string[]).includes(s),
  );
  return valid.length > 0 ? [...new Set(valid)] : [...ALL_SURFACES];
}
