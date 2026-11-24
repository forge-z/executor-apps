import test from 'node:test';
import assert from 'node:assert/strict';
import { windowFor, dateBrt, exactUrl, publication } from '../.build/src/core.js';

test('Monday starts Friday at the actual capture time, not at legacy noon', () => {
  assert.deepEqual(windowFor(new Date('2026-11-23T11:45:00-03:00')), {
    date_brt: '2026-11-23', start: '2026-11-20T14:45:00.000Z', end: '2026-11-23T14:45:00.000Z'
  });
});
test('other days use 24h and derive the date in São Paulo', () => {
  assert.deepEqual(windowFor(new Date('2026-11-24T12:17:00-03:00')), {
    date_brt: '2026-11-24', start: '2026-11-23T15:17:00.000Z', end: '2026-11-24T15:17:00.000Z'
  });
  assert.equal(dateBrt(new Date('2026-11-25T02:59:59Z')), '2026-11-24');
});
test('exact canonical URLs remove known tracking and fragments, not substantive query/path variants', () => {
  assert.equal(exactUrl('https://News.example:443/p?id=1&edition=br&utm_source=x&fbclid=y#top'), 'https://news.example/p?id=1&edition=br');
  assert.notEqual(exactUrl('https://news.example/p?id=1'), exactUrl('https://news.example/p?id=2'));
  assert.notEqual(exactUrl('https://news.example/p/'), exactUrl('https://news.example/p'));
  assert.equal(exactUrl('https://u:p@news.example/p'), null);
  assert.equal(exactUrl('file:///etc/hosts'), null);
  assert.equal(exactUrl('https:news.example/p'), null);
});
test('date-only, timezone-less and impossible dates never become confirmed published timestamps', () => {
  for (const value of ['2026-11-23','2026-11-23T10:00:00','2026-02-30T00:00:00Z',null]) assert.equal(publication(value), null);
  assert.equal(publication('2026-11-23T10:00:00-03:00'), '2026-11-23T13:00:00.000Z');
});
