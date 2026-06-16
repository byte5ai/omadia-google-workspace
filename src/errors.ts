/**
 * Error types shared across the Google Workspace integration, plus a single
 * `formatToolError` that turns any thrown error into a short, model-readable
 * string with no stack traces or secrets.
 */

/** Raised when the service-account JWT-bearer token exchange fails. */
export class GoogleAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleAuthError';
  }
}

/** Raised when a Google API responds with a non-2xx status. */
export class GoogleApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly reason: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'GoogleApiError';
  }
}

/** Raised by client-side argument validation before any network call. */
export class GoogleInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleInputError';
  }
}

/**
 * Turn client errors into a short, model-readable message. Never leaks the
 * private key, access token, or a stack trace.
 */
export function formatToolError(err: unknown): string {
  if (err instanceof GoogleAuthError) {
    return `Error: Google Workspace authentication failed — ${err.message}. Check the service-account client email + private key, that domain-wide delegation is configured in the Admin console for the required scopes, and that the impersonated user exists.`;
  }
  if (err instanceof GoogleApiError) {
    const reason = err.reason ? ` [${err.reason}]` : '';
    return `Error: Google API returned HTTP ${err.status}${reason}: ${err.message}`;
  }
  if (err instanceof GoogleInputError) {
    return `Error: ${err.message}`;
  }
  return `Error: ${err instanceof Error ? err.message : String(err)}`;
}
