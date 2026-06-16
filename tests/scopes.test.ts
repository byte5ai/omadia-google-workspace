import test from 'node:test';
import assert from 'node:assert/strict';

import { assembleScopes, parseSurfaces, parseScopeOverride } from '../src/scopes.js';

test('assembleScopes: read-only set, sorted + deduped, no write scopes', () => {
  const s = assembleScopes(['calendar', 'gmail'], false);
  assert.ok(s.includes('https://www.googleapis.com/auth/calendar.readonly'));
  assert.ok(s.includes('https://www.googleapis.com/auth/gmail.readonly'));
  assert.ok(!s.includes('https://www.googleapis.com/auth/calendar.events'));
  assert.deepEqual(s, [...s].sort());
  assert.equal(new Set(s).size, s.length);
});

test('assembleScopes: writes add calendar.events + gmail.send/compose', () => {
  const s = assembleScopes(['calendar', 'gmail'], true);
  assert.ok(s.includes('https://www.googleapis.com/auth/calendar.events'));
  assert.ok(s.includes('https://www.googleapis.com/auth/gmail.send'));
  assert.ok(s.includes('https://www.googleapis.com/auth/gmail.compose'));
});

test('parseSurfaces: empty → all five; invalid entries filtered', () => {
  assert.equal(parseSurfaces('').length, 5);
  assert.equal(parseSurfaces(undefined).length, 5);
  assert.deepEqual(parseSurfaces('calendar, bogus, gmail').sort(), ['calendar', 'gmail']);
  // all-invalid → falls back to all
  assert.equal(parseSurfaces('nope, nada').length, 5);
});

test('parseScopeOverride: empty → undefined; splits + dedups + sorts', () => {
  assert.equal(parseScopeOverride(''), undefined);
  assert.equal(parseScopeOverride(undefined), undefined);
  assert.deepEqual(parseScopeOverride('a b a, c'), ['a', 'b', 'c']);
});
