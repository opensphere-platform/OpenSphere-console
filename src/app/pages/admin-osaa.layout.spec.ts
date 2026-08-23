import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./admin-osaa.ts', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../../_r2d2-page.scss', import.meta.url), 'utf8');

test('R2D2 management separates explanation and live operations with Clarity tabs', () => {
  assert.match(source, /<clr-tabs class="r2d2-page-tabs"/);
  assert.match(source, /<button clrTabLink id="r2d2-overview-tab">개요와 구조<\/button>/);
  assert.match(source, /<button clrTabLink id="r2d2-monitoring-tab">/);
  assert.match(source, /관측 및 운영/);
  assert.match(source, /\[ngTemplateOutlet\]="overviewIntro"/);
  assert.match(source, /\[ngTemplateOutlet\]="overviewDetails"/);
  assert.match(source, /\[ngTemplateOutlet\]="operationalMonitoring"/);
  assert.match(source, /\[ngTemplateOutlet\]="runtimeManagement"/);
});

test('live operations exposes the server-reported Dialogue State rollout at a glance', () => {
  assert.match(source, /OSAA Dialogue State/);
  assert.match(source, /OSAA_DIALOGUE_STATE_MODE/);
  assert.match(source, /관측 기준 <code>\/api\/osaa\/health<\/code>/);
  assert.match(source, /dialogueState\?\.mode/);
  assert.match(source, /recordTransitions/);
  assert.match(source, /exposeContext/);
  assert.match(source, /enforceCurrentFacts/);
  assert.match(source, /enforceMutations/);
  assert.match(source, /case 'off': return '대화 상태 기록/);
  assert.match(source, /<div class="r2d2-dialogue-state-heading">/);
  assert.doesNotMatch(source, /<header>[\s\S]*OSAA Dialogue State/);
  assert.match(styles, /> \.r2d2-dialogue-state-heading \{[^}]*background: #fff;/);
});
