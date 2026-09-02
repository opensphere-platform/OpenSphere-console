import type { OsNotification } from './notification.service';

/**
 * 순수 머지 로직 (Angular 무의존 — 단위 테스트 가능). NotificationService.recompute()가 사용.
 * 소스 버킷들을 flatten → dedupKey(`source|key`) 최신 우선 → time desc 정렬 → seen 기반 read 반영.
 * (persistent 분기는 발행 시점(push)에서 처리되므로 여기 입력은 영구 알림만 들어온다.)
 */
export function mergeNotifications(
  buckets: OsNotification[][],
  seen: ReadonlySet<string>,
): OsNotification[] {
  const byDedup = new Map<string, OsNotification>();
  const plain: OsNotification[] = [];
  for (const n of buckets.flat()) {
    const tagged = { ...n, read: seen.has(n.id) || n.read };
    if (n.dedupKey) byDedup.set(`${n.source}|${n.dedupKey}`, tagged);
    else plain.push(tagged);
  }
  return [...plain, ...byDedup.values()].sort((a, b) =>
    a.time < b.time ? 1 : a.time > b.time ? -1 : 0,
  );
}
