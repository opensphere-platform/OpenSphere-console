import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const page = fs.readFileSync(new URL('./admin-external-channels.ts', import.meta.url), 'utf8');
const panel = fs.readFileSync(new URL('../os/os-panel.ts', import.meta.url), 'utf8');

test('backup target editor has distinct guidance, scrollable body sections, and a persistent action footer', () => {
  assert.match(page, /class="backup-target-editor"/);
  assert.match(page, /class="backup-panel-intro" id="backup-target-guidance"/);
  assert.match(page, /aria-describedby="backup-target-guidance"/);
  assert.match(page, /<legend>저장 위치<\/legend>/);
  assert.match(page, /<legend>버킷 정책 확인<\/legend>/);
  assert.match(page, /<legend>전용 자격 증명<\/legend>/);
  assert.match(page, /<legend>감사 메모<\/legend>/);
  assert.match(page, /osPanelFooter class="backup-panel-footer"/);
  assert.match(page, /backup-panel-footer__actions/);
});

test('shared side panel keeps header and footer fixed while only the body scrolls', () => {
  assert.match(panel, /\.modal-content\s*\{[\s\S]{0,220}display:\s*flex;[\s\S]{0,220}overflow:\s*hidden;/);
  assert.match(panel, /\.side-panel-title\s*\{[\s\S]{0,260}flex:\s*0 0 auto;[\s\S]{0,260}border-bottom:/);
  assert.match(panel, /\.side-panel-body\s*\{[\s\S]{0,320}flex:\s*1 1 auto;[\s\S]{0,320}overflow-y:\s*auto;/);
  assert.match(panel, /\.os-panel-footer\s*\{[\s\S]{0,260}flex:\s*0 0 auto;[\s\S]{0,260}border-top:/);
});

test('backup panel copy avoids mixed-language credential guidance and tiny helper text', () => {
  assert.doesNotMatch(page, /credentials are write-only/);
  assert.match(page, /자격 증명은 저장 후 다시 표시하지 않음/);
  assert.match(page, /\.backup-form-grid \.clr-subtext[\s\S]{0,160}font-size:\.72rem/);
  assert.match(page, /\.backup-panel-footer__note[\s\S]{0,140}font-size:\.74rem/);
});
