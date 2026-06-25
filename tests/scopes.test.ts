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

test('drive writes use FULL scopes and drop the superseded .readonly variants', () => {
  const s = assembleScopes(['drive'], true);
  assert.ok(s.includes('https://www.googleapis.com/auth/drive'));
  assert.ok(s.includes('https://www.googleapis.com/auth/documents'));
  assert.ok(s.includes('https://www.googleapis.com/auth/spreadsheets'));
  // The narrow read-only variants must NOT be requested alongside the full ones
  // (DWD literal matching → requesting an un-authorised .readonly fails the token).
  assert.ok(!s.includes('https://www.googleapis.com/auth/drive.readonly'));
  assert.ok(!s.includes('https://www.googleapis.com/auth/documents.readonly'));
  assert.ok(!s.includes('https://www.googleapis.com/auth/spreadsheets.readonly'));
});

test('drive read-only keeps the .readonly variants (no full scopes)', () => {
  const s = assembleScopes(['drive'], false);
  assert.ok(s.includes('https://www.googleapis.com/auth/drive.readonly'));
  assert.ok(!s.includes('https://www.googleapis.com/auth/drive'));
});

test('full all-surface + writes set is exactly the 11 scopes a sensible DWD entry lists', () => {
  const s = assembleScopes(['calendar', 'gmail', 'drive', 'directory', 'people'], true);
  assert.deepEqual(s, [
    'https://www.googleapis.com/auth/admin.directory.user.readonly',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/contacts.readonly',
    'https://www.googleapis.com/auth/directory.readonly',
    'https://www.googleapis.com/auth/documents',
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/gmail.compose',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/spreadsheets',
  ]);
});
