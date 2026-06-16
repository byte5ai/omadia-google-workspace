/**
 * Test helpers — fake auth, a scripted fetch, and a JSON Response builder.
 * No network, no real credentials.
 */

import type { GoogleServiceAccountAuth } from '../src/googleAuth.js';

export function fakeAuth(): {
  auth: GoogleServiceAccountAuth;
  stats: () => { tokenCalls: number; invalidations: number };
} {
  let tokenCalls = 0;
  let invalidations = 0;
  const auth = {
    getToken: async () => {
      tokenCalls += 1;
      return `tok-${tokenCalls}`;
    },
    invalidate: () => {
      invalidations += 1;
    },
  };
  return {
    auth: auth as unknown as GoogleServiceAccountAuth,
    stats: () => ({ tokenCalls, invalidations }),
  };
}

export interface Captured {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: string };
}

/**
 * A fetch stub driven by an array of step functions. Call N uses step N (the
 * last step repeats for any further calls). Records every call.
 */
export function scriptedFetch(steps: Array<(c: Captured) => Response>): {
  fetchImpl: typeof fetch;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  let i = 0;
  const fetchImpl = (async (url: string, init: Captured['init']) => {
    const c: Captured = { url, init: init ?? {} };
    calls.push(c);
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    return step(c);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

export function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
