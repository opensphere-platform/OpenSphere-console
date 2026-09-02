import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const page = fs.readFileSync(new URL('./admin-external-channels.ts', import.meta.url), 'utf8');
const panel = fs.readFileSync(new URL('../os/os-panel.ts', import.meta.url), 'utf8');

test('backup target editor has distinct guidance, scrollable body sections, and a persistent action footer', () => {
  assert.match(page, /class="backup-target-editor"/);
  assert.match(page, /class="backup-panel-intro" id="backup-target-guidance"/);
  assert.match(page, /aria-describedby="backup-target-guidance"/);
  assert.match(page, /<legend><span>저장 위치<\/span><small>/);
  assert.match(page, /<legend><span>TLS 신뢰<\/span><small>/);
  assert.match(page, /<legend><span>버킷 정책 확인<\/span><small>/);
  assert.match(page, /<legend><span>전용 자격 증명<\/span><small>/);
  assert.match(page, /<legend><span>감사 메모<\/span><small>/);
  assert.equal(page.match(/<legend><span>/g)?.length, 5);
  assert.doesNotMatch(page, /<legend>[^<]+<\/legend>\s*<p>/);
  assert.match(page, /osPanelFooter class="backup-panel-footer"/);
  assert.match(page, /backup-panel-footer__actions/);
});

test('shared side panel keeps header and footer fixed while only the body scrolls', () => {
  assert.match(panel, /\.modal-content\s*\{[\s\S]{0,220}display:\s*flex;[\s\S]{0,220}overflow:\s*hidden;/);
  assert.match(panel, /\.modal-header--accessible\s*\{[\s\S]{0,220}width:\s*100%;[\s\S]{0,160}padding:\s*0\s*!important;/);
  assert.match(panel, /\.modal-body-wrapper > \.modal-body\s*\{[\s\S]{0,260}width:\s*100%;[\s\S]{0,260}padding:\s*0\s*!important;[\s\S]{0,120}overflow:\s*hidden;/);
  assert.match(panel, /\.modal-footer\s*\{[\s\S]{0,180}width:\s*100%;[\s\S]{0,120}padding:\s*0\s*!important;/);
  assert.match(panel, /\.side-panel-title\s*\{[\s\S]{0,260}flex:\s*0 0 auto;[\s\S]{0,260}border-bottom:/);
  assert.match(panel, /\.side-panel-body\s*\{[\s\S]{0,320}flex:\s*1 1 auto;[\s\S]{0,320}overflow-y:\s*auto;/);
  assert.match(panel, /\.os-panel-footer\s*\{[\s\S]{0,280}flex:\s*0 0 auto;[\s\S]{0,280}width:\s*100%;[\s\S]{0,280}border-top:/);
});

test('backup panel uses S3 profiles, field-level validation and an uncluttered action footer', () => {
  assert.doesNotMatch(page, /credentials are write-only/);
  assert.match(page, /자격 증명은 저장 후 다시 표시하지 않음/);
  assert.match(page, /저장소 프로파일/);
  assert.match(page, /backupTargetSubmitAttempted/);
  assert.match(page, /markAllAsTouched/);
  assert.match(page, /focusBackupTargetField/);
  assert.equal(page.match(/<clr-control-error>/g)?.length, 9);
  assert.doesNotMatch(page, /class="field-error"/);
  assert.doesNotMatch(page, /필수 항목을 입력하면 저장할 수 있습니다/);
  assert.match(page, /\.backup-form-grid \.clr-subtext[\s\S]{0,160}font-size:\.72rem/);
  assert.match(page, /\.backup-panel-footer \{ justify-content:flex-end/);
  assert.match(page, /\.backup-form-section legend \{[^}]*display:flex;[^}]*gap:\.08rem;/);
});
