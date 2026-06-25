import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeNotifications } from './notification.merge.ts';
import type { OsNotification } from './notification.service.ts';

// 외부 의존성 0 — Node 내장 러너로 순수 머지 로직 검증:
//   node --test src/app/core/notification.merge.spec.ts
// (.spec.ts라 ng build(tsconfig.app.json)에서 제외됨)

const base: OsNotification = {
  id: 'x',
  source: 'p1',
  severity: 'info',
  title: 't',
  persistent: true,
  time: '2026-06-23T00:00:00.000Z',
  read: false,
};
const mk = (p: Partial<OsNotification>): OsNotification => ({ ...base, ...p });

test('빈 입력 → 빈 배열', () => {
  assert.deepEqual(mergeNotifications([], new Set()), []);
});

test('time 내림차순 정렬', () => {
  const out = mergeNotifications(
    [
      [
        mk({ id: 'a', time: '2026-06-23T01:00:00.000Z' }),
        mk({ id: 'b', time: '2026-06-23T03:00:00.000Z' }),
        mk({ id: 'c', time: '2026-06-23T02:00:00.000Z' }),
      ],
    ],
    new Set(),
  );
  assert.deepEqual(out.map((n) => n.id), ['b', 'c', 'a']);
});

test('dedupKey 최신 우선(같은 source) — 한 건만 남고 나중 값이 이긴다', () => {
  const out = mergeNotifications(
    [
      [
        mk({ id: 'old', dedupKey: 'k', title: 'OLD', time: '2026-06-23T01:00:00.000Z' }),
        mk({ id: 'new', dedupKey: 'k', title: 'NEW', time: '2026-06-23T02:00:00.000Z' }),
      ],
    ],
    new Set(),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'NEW');
});

test('다른 source의 같은 dedupKey는 별개 유지', () => {
  const out = mergeNotifications(
    [[mk({ id: 'a', source: 'p1', dedupKey: 'k' }), mk({ id: 'b', source: 'p2', dedupKey: 'k' })]],
    new Set(),
  );
  assert.equal(out.length, 2);
});

test('seen 집합의 id는 read=true', () => {
  const out = mergeNotifications(
    [[mk({ id: 'a', read: false }), mk({ id: 'b', read: false })]],
    new Set(['a']),
  );
  assert.equal(out.find((n) => n.id === 'a')!.read, true);
  assert.equal(out.find((n) => n.id === 'b')!.read, false);
});

test('여러 소스 버킷 flatten', () => {
  const out = mergeNotifications([[mk({ id: 'a' })], [mk({ id: 'b' })]], new Set());
  assert.equal(out.length, 2);
});
