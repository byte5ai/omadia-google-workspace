/**
 * @omadia/integration-google-workspace — public surface.
 *
 * Ships both the plugin-form `activate()` entry point AND the library exports
 * (client, cache, auth, types) so the host can load the plugin and the
 * agent-builder can resolve the `googleworkspace.client` service type
 * (`GoogleWorkspaceClient`, referenced from manifest `service_types`).
 *
 * Consumers read the client via
 *   ctx.services.get<GoogleWorkspaceClient>('googleworkspace.client')
 */

export {
  activate,
  GOOGLEWORKSPACE_CLIENT_SERVICE_NAME,
  GOOGLEWORKSPACE_CACHE_SERVICE_NAME,
} from './plugin.js';
export type { GoogleWorkspacePluginHandle } from './plugin.js';

export { GoogleWorkspaceClient } from './googleClient.js';
export type {
  GoogleApi,
  GoogleWorkspaceClientOptions,
  RequestOptions,
} from './googleClient.js';

export { ResponseCache } from './responseCache.js';
export type { ResponseCacheOptions } from './responseCache.js';

export { GoogleServiceAccountAuth } from './googleAuth.js';
export type { GoogleServiceAccountAuthOptions } from './googleAuth.js';

export { GoogleAuthError, GoogleApiError, GoogleInputError, formatToolError } from './errors.js';

export {
  assembleScopes,
  parseScopeOverride,
  parseSurfaces,
  ALL_SURFACES,
} from './scopes.js';
export type { Surface } from './scopes.js';
