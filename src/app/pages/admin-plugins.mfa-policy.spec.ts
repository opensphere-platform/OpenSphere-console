import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, 'admin-plugins.ts'), 'utf8');

test('Extension 설치 UI는 Registry가 판정한 Catalog 항목만 노출한다', () => {
  assert.ok(source.includes('installCatalogDescriptor(descriptor, snapshot.revision)'));
  assert.ok(source.includes('descriptor.executionRevision'));
  assert.ok(!source.includes('고급 OCI 설치'));
});
test('Catalog 설치 버튼은 사유, snapshot과 실행 revision에 반응한다', () => {
  assert.ok(source.includes("readonly catalogInstallReason = signal('')"));
  assert.ok(source.includes('(input)="catalogInstallReason.set($any($event.target).value)"'));
  assert.ok(source.includes('[disabled]="installing() || snapshot.stale || catalogInstallReason().trim().length < 8 || !descriptor.release.artifactRef"'));
});
