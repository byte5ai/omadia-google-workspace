import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';

import { GoogleServiceAccountAuth } from '../src/googleAuth.js';
import { GoogleAuthError } from '../src/errors.js';

function pem(): string {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;
}

function tokenFetch(captured: { body?: string }): typeof fetch {
  return (async (_url: string, init: { body?: string }) => {
    captured.body = init.body;
    return new Response(
      JSON.stringify({ access_token: 'A', expires_in: 3600, token_type: 'Bearer' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
}

test('mints a 3-part RS256 JWT with correct claims + jwt-bearer grant', async () => {
  const captured: { body?: string } = {};
  const auth = new GoogleServiceAccountAuth({
    clientEmail: 'sa@p.iam.gserviceaccount.com',
    privateKey: pem(),
    fetch: tokenFetch(captured),
  });
  const t = await auth.getToken('user@x.com', ['scopeA', 'scopeB']);
  assert.equal(t, 'A');

  const params = new URLSearchParams(captured.body);
  assert.equal(params.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const parts = params.get('assertion')!.split('.');
  assert.equal(parts.length, 3);

  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  assert.equal(header.alg, 'RS256');
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  assert.equal(claims.iss, 'sa@p.iam.gserviceaccount.com');
  assert.equal(claims.sub, 'user@x.com');
  assert.equal(claims.scope, 'scopeA scopeB');
  assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
  assert.equal(claims.exp - claims.iat, 3600);
});

test('caches per subject+scope; new subject re-mints; invalidate forces refresh', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(
      JSON.stringify({ access_token: `T${calls}`, expires_in: 3600, token_type: 'Bearer' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  const auth = new GoogleServiceAccountAuth({ clientEmail: 'sa@x', privateKey: pem(), fetch: fetchImpl });

  const a = await auth.getToken('u@x', ['s']);
  const b = await auth.getToken('u@x', ['s']);
  assert.equal(a, b);
  assert.equal(calls, 1);

  const c = await auth.getToken('other@x', ['s']);
  assert.notEqual(a, c);
  assert.equal(calls, 2);

  auth.invalidate('u@x', ['s']);
  await auth.getToken('u@x', ['s']);
  assert.equal(calls, 3);
});

test('token endpoint error surfaces a GoogleAuthError with the description', async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'bad sub' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
  const auth = new GoogleServiceAccountAuth({ clientEmail: 'sa@x', privateKey: pem(), fetch: fetchImpl });
  await assert.rejects(
    () => auth.getToken('u@x', ['s']),
    (e) => e instanceof GoogleAuthError && /bad sub/.test(e.message),
  );
});

test('normalizes escaped \\n in a single-line private key', async () => {
  const escaped = pem().replace(/\n/g, '\\n');
  const captured: { body?: string } = {};
  const auth = new GoogleServiceAccountAuth({
    clientEmail: 'sa@x',
    privateKey: escaped,
    fetch: tokenFetch(captured),
  });
  // If newline normalization failed, signing would throw GoogleAuthError.
  assert.equal(await auth.getToken('u@x', ['s']), 'A');
});

test('missing subject or empty scopes throws', async () => {
  const auth = new GoogleServiceAccountAuth({
    clientEmail: 'sa@x',
    privateKey: pem(),
    fetch: (async () => new Response('{}')) as unknown as typeof fetch,
  });
  await assert.rejects(() => auth.getToken('', ['s']), GoogleAuthError);
  await assert.rejects(() => auth.getToken('u@x', []), GoogleAuthError);
});
