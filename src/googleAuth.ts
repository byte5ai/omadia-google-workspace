/**
 * GoogleServiceAccountAuth — domain-wide-delegation (DWD) token acquisition.
 *
 * Server-to-server auth: a Google Cloud **service account** with domain-wide
 * delegation authorised in the Workspace Admin console. There is no interactive
 * sign-in. To act as a particular user we mint a signed JWT whose `sub` claim
 * names that user's email ("impersonation"), exchange it at the Google token
 * endpoint for an access token, and cache the token per `(subject, scopeSet)`.
 *
 * The JWT is signed RS256 with the service account's PEM private key using the
 * built-in `node:crypto` — no third-party JWT or googleapis library, so all
 * network egress stays inside the injected `fetch` (`ctx.http.fetch`, which is
 * allow-listed + rate-limited by the host). This mirrors the way the Dynamics
 * integration hand-rolls its OData client rather than pulling in an SDK that
 * would bypass the kernel's auditable boundary.
 *
 * Phase 2 (per-user 3-legged OAuth) will add a second token source behind the
 * same `getToken(subject, scopes)` shape; nothing downstream needs to change.
 */

import { createSign } from 'node:crypto';

import { GoogleAuthError } from './errors.js';

/** Google token endpoint response — only the fields we consume. */
interface TokenResponse {
  readonly access_token: string;
  readonly expires_in: number;
  readonly token_type: string;
}

export interface GoogleServiceAccountAuthOptions {
  /** Service-account email, e.g. `omadia@project.iam.gserviceaccount.com`. */
  readonly clientEmail: string;
  /**
   * Service-account PEM private key. Accepts the value with literal `\n`
   * escapes (as pasted from a JSON key file into a single-line secret field) —
   * they are normalised to real newlines before signing.
   */
  readonly privateKey: string;
  /**
   * OAuth2 token endpoint. Defaults to the global Google endpoint; overridable
   * for sovereign deployments.
   */
  readonly tokenUrl?: string;
  /**
   * The fetch implementation to use. In production this is `ctx.http.fetch`
   * (allow-listed + rate-limited). Injected so the class is unit-testable and
   * never reaches for the global.
   */
  readonly fetch: typeof fetch;
  /** Optional structured logger. */
  readonly log?: (message: string) => void;
}

const DEFAULT_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
/** Refresh the token this many ms before its stated expiry to avoid races. */
const TOKEN_REFRESH_SKEW_MS = 60_000;
/** JWT validity window in seconds (Google caps assertion lifetime at 1h). */
const JWT_TTL_SECONDS = 3600;

interface CachedToken {
  value: string;
  expiresAt: number;
}

export class GoogleServiceAccountAuth {
  private readonly clientEmail: string;
  private readonly privateKey: string;
  private readonly tokenUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (message: string) => void;

  /** Cached tokens keyed by `subject\nsortedScopes`. */
  private readonly tokens = new Map<string, CachedToken>();
  /** In-flight requests per key, so concurrent calls share one round-trip. */
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(opts: GoogleServiceAccountAuthOptions) {
    if (!opts.clientEmail) throw new GoogleAuthError('service-account clientEmail is required');
    if (!opts.privateKey) throw new GoogleAuthError('service-account privateKey is required');
    this.clientEmail = opts.clientEmail.trim();
    this.privateKey = normalizePrivateKey(opts.privateKey);
    this.tokenUrl = (opts.tokenUrl ?? DEFAULT_TOKEN_URL).trim();
    this.fetchImpl = opts.fetch;
    this.log = opts.log ?? (() => {});
  }

  /**
   * Acquire an access token to act as `subject` for `scopes`. Cached until
   * ~1 min before expiry; concurrent requests for the same key coalesce.
   */
  async getToken(subject: string, scopes: readonly string[]): Promise<string> {
    if (!subject) throw new GoogleAuthError('an impersonation subject (user email) is required');
    if (!scopes || scopes.length === 0) {
      throw new GoogleAuthError('at least one OAuth scope is required');
    }
    const key = `${subject}\n${[...scopes].sort().join(' ')}`;

    const now = Date.now();
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAt - TOKEN_REFRESH_SKEW_MS > now) {
      return cached.value;
    }

    let pending = this.inFlight.get(key);
    if (!pending) {
      pending = this.requestToken(subject, scopes, key).finally(() => {
        this.inFlight.delete(key);
      });
      this.inFlight.set(key, pending);
    }
    return pending;
  }

  /** Drop a cached token (used on a 401 so the next call re-mints). */
  invalidate(subject: string, scopes: readonly string[]): void {
    this.tokens.delete(`${subject}\n${[...scopes].sort().join(' ')}`);
  }

  private async requestToken(
    subject: string,
    scopes: readonly string[],
    key: string,
  ): Promise<string> {
    const assertion = this.buildSignedJwt(subject, scopes);
    const body = new URLSearchParams({ grant_type: JWT_BEARER_GRANT, assertion });

    let res: Response;
    try {
      res = await this.fetchImpl(this.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch (err) {
      throw new GoogleAuthError(
        `token request transport error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const text = await res.text();
    if (!res.ok) {
      // Google returns `{ error, error_description }`; surface the description.
      let detail = text;
      try {
        const parsed = JSON.parse(text) as { error_description?: string; error?: string };
        detail = parsed.error_description ?? parsed.error ?? text;
      } catch {
        /* keep raw text */
      }
      throw new GoogleAuthError(`token endpoint → HTTP ${res.status}: ${detail}`);
    }

    let json: TokenResponse;
    try {
      json = JSON.parse(text) as TokenResponse;
    } catch {
      throw new GoogleAuthError('token endpoint returned a non-JSON body');
    }
    if (!json.access_token) {
      throw new GoogleAuthError('token endpoint returned no access_token');
    }
    this.tokens.set(key, {
      value: json.access_token,
      expiresAt: Date.now() + json.expires_in * 1000,
    });
    this.log(`[googleworkspace] acquired token for ${subject} (expires in ${json.expires_in}s)`);
    return json.access_token;
  }

  /** Build and RS256-sign the assertion JWT for `subject` + `scopes`. */
  private buildSignedJwt(subject: string, scopes: readonly string[]): string {
    const nowSec = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const claims = {
      iss: this.clientEmail,
      sub: subject,
      scope: [...scopes].join(' '),
      aud: this.tokenUrl,
      iat: nowSec,
      exp: nowSec + JWT_TTL_SECONDS,
    };
    const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`;
    let signature: string;
    try {
      signature = createSign('RSA-SHA256')
        .update(signingInput)
        .end()
        .sign(this.privateKey, 'base64url');
    } catch (err) {
      throw new GoogleAuthError(
        `failed to sign the assertion JWT — the private key is likely malformed (expected a PEM block). ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return `${signingInput}.${signature}`;
  }
}

/** Base64url-encode a UTF-8 string without padding. */
function base64Url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

/**
 * Normalise a PEM private key: convert literal `\n` escapes (as pasted from a
 * JSON key file into a single-line field) into real newlines, and trim.
 */
function normalizePrivateKey(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.includes('\\n') ? trimmed.replace(/\\n/g, '\n') : trimmed;
}
