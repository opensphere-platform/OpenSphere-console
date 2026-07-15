import { Component, OnInit, OnDestroy, signal, computed, inject, ChangeDetectionStrategy } from '@angular/core';
import { ClarityModule } from '@clr/angular';
import { FormsModule } from '@angular/forms';
import { BackendUnavailable } from '../os/backend-unavailable';
import { OsPageHeader } from '../os/os-page-header';
import { OsPanel } from '../os/os-panel';
import { OsActionDialog } from '../os/os-action-dialog';
import { HttpService } from '../core/http.service';

interface OaaHealth {
  service: string;
  version: string;
  namespace: string;
  ok?: boolean;
  /** CONSTITUTION-0004 §4.2 서버측 fail-closed mutation gate 상태. true일 때만 Kubernetes mutation/action
   *  tool이 서버에서 제공된다(exactly 'true'인 OAA_MUTATION_ENABLED). UI 확인만으로는 gate를 열 수 없다. */
  mutationEnabled?: boolean;
  /** gate가 닫혀 있을 때 서버가 보내는 안정적 reason code(예: mutation_disabled_until_his_ready). */
  mutationGateReason?: string | null;
  ragEnabled?: boolean;
  pgConfigured?: boolean;
  embedDim?: number;
  allowedNamespaces?: string[];
  scaleMax?: number;
}

interface LlmKey {
  id: string;
  provider: string;
  displayName: string;
  baseUrl: string;
  defaultModel: string;
  embeddingModel: string;
  enabled: boolean;
  keyFingerprint: string;
  secretRef: string;
  updatedAt: string;
  updatedBy: string;
}
interface LlmKeyForm {
  id: string;
  provider: string;
  displayName: string;
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  embeddingModel: string;
  enabled: boolean;
  reason: string;
}
interface KnowledgeStats {
  enabled: boolean;
  embedDim: number;
  manualSeedPath: string;
  documents: number;
  chunks: number;
  manualDocuments: number;
  manualChunks: number;
  manualConcepts: number;
  manualRelations: number;
  manualSources: { source: string; documents: number; chunks: number }[];
  embeddingModes: { mode: string; chunks: number }[];
  embeddingKeys: { id: string; provider: string; displayName: string; embeddingModel: string }[];
}
interface OaaTool {
  id: string;
  name: string;
  version?: string;
  channel: string;
  readOnly: boolean;
  endpoint?: { method: string; path: string };
  riskLevel?: string;
  confirmation?: string;
  confirmationTemplate?: string;
}
interface OaaToolManifest {
  schema: string;
  service: string;
  version: string;
  generatedAt: string;
  allowedNamespaces: string[];
  scaleMax: number;
  tools: OaaTool[];
  storage?: string;
}
interface OaaActionBinding {
  id: string;
  title: string;
  intent: string;
  toolId: string;
  sourceId: string;
  sectionId?: string;
  riskLevel: string;
  confirmation: string;
  confirmationTemplate?: string;
  controlPlane?: string;
  valid?: boolean;
  targetHints?: { namespace?: string; deployment?: string; maxReplicas?: number };
  requiredInputs?: { type: string; fields: Record<string, string> };
  citations?: { sourceId: string; sourcePath?: string }[];
}
interface OaaActionBindingManifest {
  schema: string;
  service: string;
  version: string;
  generatedAt: string;
  bindings: OaaActionBinding[];
  invalidBindings: { id: string; toolId: string }[];
  storage?: string;
}

/**
 * /manage/oaa — OAA(OpenSphere AI Agent) Gateway 관리 표면. **셸 네이티브** 전용 페이지(CONSTITUTION-0004 §4.2/§4.4).
 * OAA Core는 Main Shell native capability이고 OAA Gateway는 CBS consumer인 별도 서버 workload다 — 여기서는
 * Gateway health, LLM provider key custody, Knowledge/Manual Registry, Tool Registry/Action Bindings만 다룬다.
 * Backbone(admin-backbone.ts)에는 절대 다시 흡수하지 않는다(§8 감사 판정).
 *
 * 모든 호출은 same-origin `/api/oaa/*` + HttpService(내부적으로 AuthService.token()을 Bearer로 첨부, cross-origin 차단).
 * LLM API key는 여기서 절대 localStorage/sessionStorage/log/DOM 목록에 저장하지 않는다 — 생성/회전 성공(또는 실패) 직후
 * 폼의 apiKey 필드를 즉시 비우고, 목록에는 서버가 계산한 fingerprint만 보여준다.
 *
 * mutation(쓰기) 바인딩 실행은 정확한 confirmation 문자열 + 사유(reason) 둘 다 로컬에서 먼저 검증하고,
 * 서버가 보고하는 health.mutationEnabled === true이면서 tool manifest/action binding 로드가 모두
 * 성공하지 않았으면(mutationGateOpen=false) 서버로 실행 요청을 보내지 않는다. 이는 UI 편의 게이트일 뿐이다 —
 * 실제 강제는 opensphere-console-oaa-gateway 서버가 Cluster Manager Activated + HIS Preflight Ready 이전에는
 * OAA_MUTATION_ENABLED가 정확히 'true'가 아닌 한 모든 Kubernetes mutation/action tool을 tool manifest/action
 * binding 응답에서 제거하고 실행 요청을 403(mutation_disabled_until_his_ready)으로 fail-closed 처리하는
 * 방식으로 이미 수행한다(CONSTITUTION-0004 §4.2). 이 페이지는 그 서버 정책을 대체하지 않는다.
 */
@Component({
  selector: 'os-admin-oaa',
  imports: [ClarityModule, FormsModule, BackendUnavailable, OsPageHeader, OsPanel, OsActionDialog],
  template: `
    <div class="os-page">
      <os-page-header title="OAA Gateway" tag="Core·Admin · OpenSphere AI Agent 관리 표면" />
      @if (gatewayDown(); as d) {
        <os-backend-unavailable
          feature="OAA Gateway"
          backend="opensphere-console-oaa-gateway (/api/oaa)"
          hint="opensphere-console-oaa-gateway 배포 · Backbone PostgreSQL/pgvector 연결 시 복구됩니다. 미배포여도 콘솔 로그인/관리/Manual은 영향받지 않습니다."
          [detail]="d"
        />
      } @else {
        <p class="os-sub">
          OAA Core는 Main Shell native capability이고, OAA Gateway는 보안·격리를 위한 별도 CBS consumer workload입니다
          (<code>CONSTITUTION-0004 §4.2</code>). Provider key 미배포 시 채팅은 <strong>Degraded</strong>일 수 있으나 콘솔 관리는 항상 동작합니다.
          @if (health(); as h) { · <code>{{ h.service }}</code> v{{ h.version }} · ns <code>{{ h.namespace }}</code> }
        </p>

        @if (msg(); as m) {
          <clr-alert [clrAlertType]="m.type" [clrAlertClosable]="true" (clrAlertClosedChange)="msg.set(null)">
            <clr-alert-item><span class="alert-text">{{ m.text }}</span></clr-alert-item>
          </clr-alert>
        }

        <clr-tabs>
          <!-- 탭1: Gateway health/readiness -->
          <clr-tab>
            <button clrTabLink>Gateway</button>
            <clr-tab-content>
              <div class="os-actions">
                <button class="btn btn-sm btn-outline" [disabled]="healthBusy()" (click)="loadHealth()">새로고침</button>
                @if (healthBusy()) { <span class="spinner spinner-inline"></span> }
              </div>
              <div class="os-card">
                <div class="os-card-h">Health / Readiness</div>
                <div class="gw-body">
                  @if (health(); as h) {
                    <span class="label label-success">Reachable</span>
                    <span class="os-mono">{{ h.service }} · v{{ h.version }} · ns {{ h.namespace }}</span>
                  } @else {
                    <span class="label label-warning">조회 중이거나 응답 없음</span>
                  }
                  <span class="label" [class.label-success]="mutationGateOpen()" [class.label-warning]="!mutationGateOpen()">
                    Mutation gate: {{ mutationGateOpen() ? 'open' : 'closed' }}{{ !mutationGateOpen() && mutationGateReasonText() ? ' (' + mutationGateReasonText() + ')' : '' }}
                  </span>
                </div>
                <p class="os-sub">Mutation gate는 서버가 보고하는 <code>health.mutationEnabled === true</code>(CONSTITUTION-0004 §4.2 fail-closed)이고 tool manifest · action binding 로드가 모두 성공했을 때만 열립니다. Cluster Manager Activated + HIS Preflight Ready 이전에는 서버가 Kubernetes mutation/action tool을 제공하지 않으므로 이 UI 표시와 무관하게 실행은 항상 403으로 차단됩니다.</p>
              </div>

              @if (knowledgeStats(); as ks) {
                @if (!ks.enabled || !ks.embeddingKeys.length) {
                  <clr-alert clrAlertType="info" [clrAlertClosable]="false">
                    <clr-alert-item><span class="alert-text">Degraded: {{ !ks.enabled ? 'RAG/knowledge store가 비활성' : '임베딩 모델을 가진 활성 LLM key가 없음' }} — OAA 채팅만 저하되고 콘솔 관리 기능에는 영향이 없습니다.</span></clr-alert-item>
                  </clr-alert>
                }
              } @else if (!llmKeys().length && llmKeysLoaded()) {
                <clr-alert clrAlertType="info" [clrAlertClosable]="false">
                  <clr-alert-item><span class="alert-text">Degraded: 등록된 LLM provider key가 없습니다 — OAA 채팅만 저하되고 콘솔 관리 기능에는 영향이 없습니다.</span></clr-alert-item>
                </clr-alert>
              }
            </clr-tab-content>
          </clr-tab>

          <!-- 탭2: LLM Provider Keys -->
          <clr-tab>
            <button clrTabLink (click)="ensureLlmKeysLoaded()">LLM Keys</button>
            <clr-tab-content>
              <div class="os-actions">
                <button class="btn btn-sm btn-outline" [disabled]="llmBusy()" (click)="loadLlmKeys()">새로고침</button>
                <button class="btn btn-sm btn-primary" [disabled]="llmBusy()" (click)="openCreateKey()">Key 추가</button>
                @if (llmBusy()) { <span class="spinner spinner-inline"></span> }
              </div>
              <clr-datagrid [clrDgLoading]="llmBusy()">
                <clr-dg-column>ID</clr-dg-column>
                <clr-dg-column>Provider</clr-dg-column>
                <clr-dg-column>Model</clr-dg-column>
                <clr-dg-column>Fingerprint</clr-dg-column>
                <clr-dg-column>상태</clr-dg-column>
                <clr-dg-column>업데이트</clr-dg-column>
                <clr-dg-column></clr-dg-column>
                @for (k of llmKeys(); track k.id) {
                  <clr-dg-row>
                    <clr-dg-cell><strong>{{ k.displayName || k.id }}</strong><div class="os-mono">{{ k.id }}</div></clr-dg-cell>
                    <clr-dg-cell>{{ k.provider }}</clr-dg-cell>
                    <clr-dg-cell class="os-mono">{{ k.defaultModel || '-' }}</clr-dg-cell>
                    <clr-dg-cell class="os-mono">{{ k.keyFingerprint }}</clr-dg-cell>
                    <clr-dg-cell>
                      @if (k.enabled) { <span class="label label-success">Enabled</span> }
                      @else { <span class="label">Disabled</span> }
                    </clr-dg-cell>
                    <clr-dg-cell class="os-mono">{{ k.updatedAt }} · {{ k.updatedBy }}</clr-dg-cell>
                    <clr-dg-cell>
                      <button class="btn btn-sm btn-link" (click)="openRotateKey(k)">회전</button>
                      <button class="btn btn-sm btn-link btn-danger" (click)="openDeleteKey(k)">삭제</button>
                    </clr-dg-cell>
                  </clr-dg-row>
                }
                <clr-dg-placeholder>등록된 LLM key가 없습니다.</clr-dg-placeholder>
                <clr-dg-footer>{{ llmKeys().length }} keys — raw key material은 절대 표시되지 않습니다(fingerprint만).</clr-dg-footer>
              </clr-datagrid>
            </clr-tab-content>
          </clr-tab>

          <!-- 탭3: Knowledge / Manual Registry -->
          <clr-tab>
            <button clrTabLink (click)="ensureKnowledgeLoaded()">Knowledge</button>
            <clr-tab-content>
              <div class="os-actions">
                <button class="btn btn-sm btn-outline" [disabled]="knowledgeBusy()" (click)="loadKnowledgeStats()">새로고침</button>
                <button class="btn btn-sm btn-outline" [disabled]="knowledgeBusy()" (click)="seedBundledManuals()">Seed bundled manuals</button>
                <button class="btn btn-sm btn-primary" [disabled]="knowledgeBusy()" (click)="reembedKnowledge()">Re-embed</button>
                @if (knowledgeBusy()) { <span class="spinner spinner-inline"></span> }
              </div>
              @if (knowledgeStats(); as ks) {
                <div class="stat-grid">
                  <div><span>Documents</span><strong>{{ ks.documents }}</strong></div>
                  <div><span>Chunks</span><strong>{{ ks.chunks }}</strong></div>
                  <div><span>Manual docs</span><strong>{{ ks.manualDocuments || 0 }}</strong></div>
                  <div><span>Manual chunks</span><strong>{{ ks.manualChunks || 0 }}</strong></div>
                  <div><span>Concepts</span><strong>{{ ks.manualConcepts || 0 }}</strong></div>
                  <div><span>Relations</span><strong>{{ ks.manualRelations || 0 }}</strong></div>
                  <div><span>Vector dim</span><strong>{{ ks.embedDim }}</strong></div>
                  <div><span>Embedding keys</span><strong>{{ ks.embeddingKeys.length }}</strong></div>
                </div>
                <p class="os-sub">Manual sources:
                  @for (s of ks.manualSources || []; track s.source) { <span class="label label-purple">{{ s.source }} {{ s.documents }}/{{ s.chunks }}</span> }
                  @if (!(ks.manualSources || []).length) { <span class="os-mono">없음 — "Seed bundled manuals" 사용</span> }
                </p>
              } @else if (knowledgeError()) {
                <clr-alert clrAlertType="danger" [clrAlertClosable]="false"><clr-alert-item><span class="alert-text">{{ knowledgeError() }}</span></clr-alert-item></clr-alert>
              } @else {
                <p class="os-sub">불러오는 중…</p>
              }
            </clr-tab-content>
          </clr-tab>

          <!-- 탭4: Tool Registry / Action Bindings -->
          <clr-tab>
            <button clrTabLink (click)="ensureToolsLoaded()">Tools &amp; Bindings</button>
            <clr-tab-content>
              <div class="os-actions">
                <button class="btn btn-sm btn-outline" [disabled]="toolBusy()" (click)="loadToolManifest()">Tools 새로고침</button>
                <button class="btn btn-sm btn-outline" [disabled]="toolBusy()" (click)="loadActionBindings()">Bindings 새로고침</button>
                @if (toolBusy()) { <span class="spinner spinner-inline"></span> }
              </div>

              @if (toolManifest(); as tm) {
                <h3>Tool Registry <span class="os-engine">{{ tm.tools.length }} tools</span></h3>
                <clr-datagrid>
                  <clr-dg-column>Tool</clr-dg-column>
                  <clr-dg-column>Channel</clr-dg-column>
                  <clr-dg-column>Endpoint</clr-dg-column>
                  <clr-dg-column>Risk</clr-dg-column>
                  <clr-dg-column>Confirmation</clr-dg-column>
                  @for (t of tm.tools; track t.id) {
                    <clr-dg-row>
                      <clr-dg-cell><strong>{{ t.name }}</strong><div class="os-mono">{{ t.id }}</div></clr-dg-cell>
                      <clr-dg-cell>{{ t.channel }}</clr-dg-cell>
                      <clr-dg-cell class="os-mono">{{ t.endpoint?.method || '-' }} {{ t.endpoint?.path || '-' }}</clr-dg-cell>
                      <clr-dg-cell><span class="label" [class.label-success]="t.readOnly" [class.label-warning]="!t.readOnly">{{ t.riskLevel || (t.readOnly ? 'read' : 'write') }}</span></clr-dg-cell>
                      <clr-dg-cell class="os-mono">{{ t.confirmation || 'none' }}</clr-dg-cell>
                    </clr-dg-row>
                  }
                  <clr-dg-placeholder>등록된 tool이 없습니다.</clr-dg-placeholder>
                </clr-datagrid>
              }

              @if (actionBindings(); as ab) {
                <h3>Action Bindings <span class="os-engine">{{ ab.bindings.length }}건 · invalid {{ ab.invalidBindings.length }}</span></h3>
                <clr-datagrid>
                  <clr-dg-column>Binding</clr-dg-column>
                  <clr-dg-column>Intent / Risk</clr-dg-column>
                  <clr-dg-column>Tool</clr-dg-column>
                  <clr-dg-column>Confirmation</clr-dg-column>
                  <clr-dg-column></clr-dg-column>
                  @for (b of ab.bindings; track b.id) {
                    <clr-dg-row>
                      <clr-dg-cell><strong>{{ b.title }}</strong><div class="os-mono">{{ b.id }}</div></clr-dg-cell>
                      <clr-dg-cell><span class="label" [class.label-success]="b.riskLevel === 'read'" [class.label-warning]="b.riskLevel !== 'read'">{{ b.intent }} / {{ b.riskLevel }}</span></clr-dg-cell>
                      <clr-dg-cell><span class="os-mono">{{ b.toolId }}</span> @if (b.valid === false) { <span class="label label-danger">invalid</span> }</clr-dg-cell>
                      <clr-dg-cell class="os-mono">{{ b.confirmation }}</clr-dg-cell>
                      <clr-dg-cell>
                        <button class="btn btn-sm btn-link" [disabled]="b.valid === false" (click)="openExecute(b)">Use</button>
                      </clr-dg-cell>
                    </clr-dg-row>
                  }
                  <clr-dg-placeholder>등록된 action binding이 없습니다.</clr-dg-placeholder>
                </clr-datagrid>
              }
            </clr-tab-content>
          </clr-tab>
        </clr-tabs>

        <!-- LLM key 생성/회전 — 인라인 폼 대신 우측 슬라이딩 패널. apiKey는 password 입력이고 성공/실패 직후 즉시 비운다. -->
        <os-panel [open]="llmPanelOpen()" [title]="llmEditingId() ? 'LLM Key 회전 — ' + llmEditingId() : 'LLM Key 추가'" subtitle="OAA Gateway · Kubernetes Secret custody" (closed)="closeKeyPanel()">
          <p class="os-sub">API key는 게이트웨이가 Kubernetes Secret으로만 보관합니다. 이 화면은 raw key를 절대 저장·표시하지 않으며, 저장 직후 입력값을 비웁니다.</p>
          <form clrForm clrLayout="vertical">
            <clr-input-container>
              <label>ID</label>
              <input clrInput [(ngModel)]="llmForm.id" name="oaa-key-id" placeholder="openai-main" [disabled]="!!llmEditingId() || llmSaving()" maxlength="48" />
            </clr-input-container>
            <clr-select-container>
              <label>Provider</label>
              <select clrSelect [(ngModel)]="llmForm.provider" name="oaa-key-provider" [disabled]="llmSaving()">
                <option value="openai">OpenAI</option>
                <option value="deepseek">DeepSeek</option>
                <option value="azure-openai">Azure OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="google">Google</option>
                <option value="custom">Custom</option>
              </select>
            </clr-select-container>
            <clr-input-container>
              <label>Display name</label>
              <input clrInput [(ngModel)]="llmForm.displayName" name="oaa-key-display" placeholder="OpenAI Main" [disabled]="llmSaving()" maxlength="120" />
            </clr-input-container>
            <clr-input-container>
              <label>Base URL</label>
              <input clrInput [(ngModel)]="llmForm.baseUrl" name="oaa-key-baseurl" placeholder="https://api.openai.com/v1" [disabled]="llmSaving()" maxlength="200" />
            </clr-input-container>
            <clr-input-container>
              <label>Default model</label>
              <input clrInput [(ngModel)]="llmForm.defaultModel" name="oaa-key-model" placeholder="gpt-4.1" [disabled]="llmSaving()" maxlength="128" />
            </clr-input-container>
            <clr-input-container>
              <label>Embedding model (선택)</label>
              <input clrInput [(ngModel)]="llmForm.embeddingModel" name="oaa-key-embed" placeholder="text-embedding-3-large" [disabled]="llmSaving()" maxlength="128" />
            </clr-input-container>
            <clr-input-container>
              <label>API key{{ llmEditingId() ? ' (비우면 메타데이터만 갱신)' : '' }}</label>
              <input clrInput type="password" autocomplete="off" [(ngModel)]="llmForm.apiKey" name="oaa-key-secret" placeholder="sk-..." [disabled]="llmSaving()" maxlength="256" />
            </clr-input-container>
            <clr-checkbox-container>
              <clr-checkbox-wrapper>
                <input type="checkbox" clrCheckbox [(ngModel)]="llmForm.enabled" name="oaa-key-enabled" [disabled]="llmSaving()" />
                <label>Enabled</label>
              </clr-checkbox-wrapper>
            </clr-checkbox-container>
            <clr-input-container>
              <label>사유 (필수)</label>
              <input clrInput [(ngModel)]="llmForm.reason" name="oaa-key-reason" placeholder="초기 설정 / 회전 사유" [disabled]="llmSaving()" maxlength="200" />
            </clr-input-container>
          </form>
          <div class="panel-actions">
            <button class="btn btn-primary" [disabled]="llmSaving() || !llmForm.id.trim() || (!llmEditingId() && !llmForm.apiKey.trim()) || !llmForm.reason.trim()" (click)="saveLlmKey()">저장</button>
            <button class="btn btn-outline" [disabled]="llmSaving()" (click)="closeKeyPanel()">취소</button>
            @if (llmSaving()) { <span class="spinner spinner-inline"></span> }
          </div>
        </os-panel>

        <os-action-dialog
          [open]="!!deleteTarget()"
          title="LLM Key 삭제"
          [message]="deleteTarget() ? ('키 ' + deleteTarget()!.id + ' 를 삭제합니다. 진행 중인 채팅에 즉시 영향을 줄 수 있습니다.') : ''"
          confirmLabel="삭제"
          [danger]="true"
          [busy]="llmBusy()"
          [reasonRequired]="true"
          reasonLabel="삭제 사유"
          [minReasonLength]="4"
          (confirmed)="confirmDeleteKey($event)"
          (cancelled)="cancelDeleteKey()"
        />

        <!-- Action binding 실행 — 정확한 confirmation 문자열 + 사유가 모두 충족돼야만 실행 버튼이 활성화되고,
             그 전에는 절대 fetch하지 않는다(로컬 게이트). 서버가 다시 독립적으로 confirmation을 검증한다. -->
        <os-panel [open]="!!execBinding()" [title]="execBinding() ? 'Execute — ' + execBinding()!.title : 'Execute'" subtitle="audited binding execution" (closed)="closeExecute()">
          @if (execBinding(); as b) {
            <p class="os-sub">
              <span class="os-mono">{{ b.id }}</span> · {{ b.intent }} / <span class="label" [class.label-success]="b.riskLevel === 'read'" [class.label-warning]="b.riskLevel !== 'read'">{{ b.riskLevel }}</span>
              · tool <span class="os-mono">{{ b.toolId }}</span>
            </p>
            @if (b.riskLevel !== 'read' && !mutationGateOpen()) {
              <clr-alert clrAlertType="warning" [clrAlertClosable]="false">
                <clr-alert-item><span class="alert-text">Mutation gate closed{{ mutationGateReasonText() ? ' (' + mutationGateReasonText() + ')' : '' }} — 서버가 Kubernetes mutation/action tool을 아직 제공하지 않습니다(CONSTITUTION-0004 §4.2). health.mutationEnabled가 true를 보고하고 tool manifest/action binding 로드가 모두 성공해야 이 버튼이 활성화되며, 그 뒤에도 서버가 다시 독립적으로 gate와 confirmation을 검증합니다.</span></clr-alert-item>
              </clr-alert>
            }
            <form clrForm clrLayout="vertical">
              @for (key of execFieldKeys(b); track key) {
                <clr-input-container>
                  <label>{{ key }}</label>
                  <input clrInput [(ngModel)]="execInputs[key]" [name]="'exec-' + key" [placeholder]="b.requiredInputs?.fields?.[key] || ''" [disabled]="execBusy()" />
                </clr-input-container>
              }
              @if (b.confirmation !== 'none') {
                <clr-input-container>
                  <label>Confirmation (정확히 일치해야 함)</label>
                  <input clrInput [(ngModel)]="execConfirm" name="exec-confirm" [placeholder]="expectedConfirmText()" [disabled]="execBusy()" />
                </clr-input-container>
                <p class="os-sub">정확히 입력: <code>{{ expectedConfirmText() }}</code></p>
              }
              <clr-input-container>
                <label>사유 (필수)</label>
                <input clrInput [(ngModel)]="execReason" name="exec-reason" placeholder="실행 목적" [disabled]="execBusy()" maxlength="240" />
              </clr-input-container>
            </form>
            <div class="panel-actions">
              <button class="btn btn-primary" [disabled]="!canSubmitExecute()" (click)="executeBinding()">Execute</button>
              <button class="btn btn-outline" [disabled]="execBusy()" (click)="closeExecute()">취소</button>
              @if (execBusy()) { <span class="spinner spinner-inline"></span> }
            </div>
            @if (execError()) { <clr-alert clrAlertType="danger" [clrAlertClosable]="false"><clr-alert-item><span class="alert-text">{{ execError() }}</span></clr-alert-item></clr-alert> }
            @if (execResult()) { <pre class="exec-result">{{ execResult() }}</pre> }
          }
        </os-panel>
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
      .gw-body { display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap; padding: 0.6rem 0.9rem; }
      .stat-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0.6rem; margin-bottom: 0.55rem; }
      .stat-grid div { border: 1px solid #e1e5ea; border-radius: 4px; padding: 0.55rem 0.65rem; background: #f8fafc; }
      .stat-grid span { display: block; color: var(--os-muted); font-size: 0.62rem; }
      .stat-grid strong { display: block; margin-top: 0.15rem; font-size: 1rem; color: #1b2733; }
      .panel-actions { display: flex; gap: 0.5rem; align-items: center; margin-top: 0.6rem; }
      .exec-result { margin: 0.7rem 0 0; max-height: 16rem; overflow: auto; border: 1px solid #e1e5ea; border-radius: 4px; background: #0f2230; color: #d7e6ee; padding: 0.7rem; font-size: 0.66rem; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
      @media (max-width: 980px) { .stat-grid { grid-template-columns: 1fr 1fr; } }
    `,
  ],
})
export class AdminOaa implements OnInit, OnDestroy {
  private http = inject(HttpService);

  readonly msg = signal<{ type: 'success' | 'danger' | 'info'; text: string } | null>(null);

  // Gateway health/readiness
  readonly health = signal<OaaHealth | null>(null);
  readonly gatewayDown = signal<string>('');
  readonly healthBusy = signal(false);
  private timer: ReturnType<typeof setInterval> | null = null;

  // LLM provider keys
  readonly llmKeys = signal<LlmKey[]>([]);
  readonly llmKeysLoaded = signal(false);
  readonly llmBusy = signal(false);
  readonly llmSaving = signal(false);
  readonly llmPanelOpen = signal(false);
  readonly llmEditingId = signal<string>('');
  llmForm: LlmKeyForm = this.emptyLlmForm();
  readonly deleteTarget = signal<LlmKey | null>(null);

  // Knowledge / Manual Registry
  readonly knowledgeStats = signal<KnowledgeStats | null>(null);
  readonly knowledgeLoaded = signal(false);
  readonly knowledgeBusy = signal(false);
  readonly knowledgeError = signal<string>('');

  // Tool Registry / Action Bindings
  readonly toolManifest = signal<OaaToolManifest | null>(null);
  readonly actionBindings = signal<OaaActionBindingManifest | null>(null);
  readonly toolsLoaded = signal(false);
  readonly toolBusy = signal(false);

  // Action binding execution (mutation gate)
  readonly execBinding = signal<OaaActionBinding | null>(null);
  execInputs: Record<string, string> = {};
  execConfirm = '';
  execReason = '';
  readonly execBusy = signal(false);
  readonly execResult = signal<string>('');
  readonly execError = signal<string>('');

  /** UI 게이트 — 단순 데이터 로드 성공만으로는 열리지 않는다. 서버가 명시적으로 보고하는
   *  health.mutationEnabled === true(CONSTITUTION-0004 §4.2 fail-closed 서버 상태)이면서, tool manifest와
   *  action binding 로드도 모두 성공했을 때만 true다. 이 값은 UI 편의 게이트일 뿐이며 실제 강제는 항상
   *  서버(executeActionBinding / restartDeployment / scaleDeployment)가 다시 독립적으로 수행한다. */
  readonly mutationGateOpen = computed<boolean>(
    () => !this.gatewayDown() && this.health()?.mutationEnabled === true && !!this.toolManifest() && !!this.actionBindings(),
  );

  /** health가 로드되지 않았거나 게이트가 닫혀 있을 때 화면에 보여줄 사람이 읽을 수 있는 gate reason. */
  readonly mutationGateReasonText = computed<string>(() => {
    const h = this.health();
    if (!h) return 'health 정보 없음';
    if (h.mutationEnabled === true) return '';
    return h.mutationGateReason || 'mutation_disabled_until_his_ready';
  });

  async ngOnInit(): Promise<void> {
    await this.loadHealth();
    await Promise.all([this.loadToolManifest(), this.loadActionBindings()]);
    this.timer = setInterval(() => this.loadHealth(true), 15000);
  }
  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async loadHealth(silent = false): Promise<void> {
    if (!silent) this.healthBusy.set(true);
    try {
      const r = await this.http.request('/api/oaa/health', { cache: 'no-store' });
      if (!r.ok) {
        this.gatewayDown.set(`health HTTP ${r.status}`);
        this.health.set(null);
        return;
      }
      this.gatewayDown.set('');
      this.health.set(await r.json());
    } catch (e) {
      this.gatewayDown.set('조회 실패: ' + e);
      this.health.set(null);
    } finally {
      this.healthBusy.set(false);
    }
  }

  // ---------- LLM provider keys ----------
  private emptyLlmForm(): LlmKeyForm {
    return {
      id: '', provider: 'openai', displayName: '', apiKey: '',
      baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4.1', embeddingModel: 'text-embedding-3-large',
      enabled: true, reason: '',
    };
  }
  ensureLlmKeysLoaded(): void {
    if (!this.llmKeysLoaded()) void this.loadLlmKeys();
  }
  openCreateKey(): void {
    this.llmEditingId.set('');
    this.llmForm = this.emptyLlmForm();
    this.llmPanelOpen.set(true);
  }
  openRotateKey(k: LlmKey): void {
    this.llmEditingId.set(k.id);
    this.llmForm = {
      id: k.id, provider: k.provider || 'custom', displayName: k.displayName || '', apiKey: '',
      baseUrl: k.baseUrl || '', defaultModel: k.defaultModel || '', embeddingModel: k.embeddingModel || '',
      enabled: k.enabled, reason: '',
    };
    this.llmPanelOpen.set(true);
  }
  closeKeyPanel(): void {
    this.llmPanelOpen.set(false);
    this.llmEditingId.set('');
    // apiKey는 패널을 닫을 때(성공/취소 모두) 즉시 비운다 — raw key 잔존 방지.
    this.llmForm = this.emptyLlmForm();
  }
  async loadLlmKeys(): Promise<void> {
    this.llmBusy.set(true);
    try {
      const r = await this.http.request('/api/oaa/admin/llm-keys', { cache: 'no-store' });
      this.llmKeysLoaded.set(true);
      if (r.status === 401 || r.status === 403) {
        this.msg.set({ type: 'danger', text: 'OAA Gateway admin permission is required (opensphere-console-admins).' });
        return;
      }
      if (!r.ok) {
        this.msg.set({ type: 'danger', text: `LLM key load failed (HTTP ${r.status})` });
        return;
      }
      this.llmKeys.set((await r.json()).items || []);
    } catch (e) {
      this.msg.set({ type: 'danger', text: 'LLM key load failed: ' + e });
    } finally {
      this.llmBusy.set(false);
    }
  }
  async saveLlmKey(): Promise<void> {
    if (!this.llmForm.id.trim() || !this.llmForm.reason.trim() || (!this.llmEditingId() && !this.llmForm.apiKey.trim())) {
      this.msg.set({ type: 'danger', text: 'ID, reason, and (for new keys) an API key are required.' });
      return;
    }
    this.llmSaving.set(true);
    try {
      const r = await this.http.request('/api/oaa/admin/llm-keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(this.llmForm),
      });
      const out = await r.json().catch(() => ({}) as any);
      if (r.status === 401 || r.status === 403) {
        this.msg.set({ type: 'danger', text: 'OAA Gateway admin permission is required (opensphere-console-admins).' });
        return;
      }
      if (!r.ok) {
        this.msg.set({ type: 'danger', text: out.error || `LLM key save failed (HTTP ${r.status})` });
        return;
      }
      this.msg.set({ type: 'success', text: out.created ? 'LLM key created.' : 'LLM key rotated.' });
      this.closeKeyPanel();
      await this.loadLlmKeys();
    } catch (e) {
      this.msg.set({ type: 'danger', text: 'LLM key save failed: ' + e });
    } finally {
      // 성공/실패 어느 경로든 secret 입력값을 즉시 비운다(방어적 이중 처리).
      this.llmForm = { ...this.llmForm, apiKey: '' };
      this.llmSaving.set(false);
    }
  }
  openDeleteKey(k: LlmKey): void {
    this.deleteTarget.set(k);
  }
  cancelDeleteKey(): void {
    this.deleteTarget.set(null);
  }
  async confirmDeleteKey(reason: string): Promise<void> {
    const k = this.deleteTarget();
    if (!k) return;
    this.llmBusy.set(true);
    try {
      const r = await this.http.request(
        `/api/oaa/admin/llm-keys/${encodeURIComponent(k.id)}?reason=${encodeURIComponent(reason)}`,
        { method: 'DELETE' },
      );
      if (r.status === 401 || r.status === 403) {
        this.msg.set({ type: 'danger', text: 'OAA Gateway admin permission is required (opensphere-console-admins).' });
        return;
      }
      if (!r.ok) {
        const out = await r.json().catch(() => ({}) as any);
        this.msg.set({ type: 'danger', text: out.error || `LLM key delete failed (HTTP ${r.status})` });
        return;
      }
      this.msg.set({ type: 'success', text: `LLM key ${k.id} deleted.` });
      this.deleteTarget.set(null);
      await this.loadLlmKeys();
    } catch (e) {
      this.msg.set({ type: 'danger', text: 'LLM key delete failed: ' + e });
    } finally {
      this.llmBusy.set(false);
    }
  }

  // ---------- Knowledge / Manual Registry ----------
  ensureKnowledgeLoaded(): void {
    if (!this.knowledgeLoaded()) void this.loadKnowledgeStats();
  }
  async loadKnowledgeStats(): Promise<void> {
    this.knowledgeBusy.set(true);
    this.knowledgeError.set('');
    try {
      const r = await this.http.request('/api/oaa/admin/knowledge/stats', { cache: 'no-store' });
      this.knowledgeLoaded.set(true);
      if (r.status === 401 || r.status === 403) {
        this.knowledgeError.set('OAA Gateway admin permission is required (opensphere-console-admins).');
        return;
      }
      if (!r.ok) {
        this.knowledgeError.set(`Knowledge stats load failed (HTTP ${r.status})`);
        return;
      }
      this.knowledgeStats.set(await r.json());
    } catch (e) {
      this.knowledgeError.set('Knowledge stats load failed: ' + e);
    } finally {
      this.knowledgeBusy.set(false);
    }
  }
  async seedBundledManuals(): Promise<void> {
    await this.knowledgeAction('/api/oaa/admin/knowledge/manual-seed/bundled', {}, 'Bundled manuals seeded.');
  }
  async reembedKnowledge(): Promise<void> {
    await this.knowledgeAction('/api/oaa/admin/knowledge/reembed', { strict: false }, 'Knowledge re-embedded.');
  }
  private async knowledgeAction(url: string, body: unknown, success: string): Promise<void> {
    this.knowledgeBusy.set(true);
    try {
      const r = await this.http.request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (r.status === 401 || r.status === 403) {
        this.msg.set({ type: 'danger', text: 'OAA Gateway admin permission is required (opensphere-console-admins).' });
        return;
      }
      if (!r.ok) {
        const out = await r.json().catch(() => ({}) as any);
        this.msg.set({ type: 'danger', text: out.error || `Knowledge operation failed (HTTP ${r.status})` });
        return;
      }
      this.msg.set({ type: 'success', text: success });
      await this.loadKnowledgeStats();
    } catch (e) {
      this.msg.set({ type: 'danger', text: 'Knowledge operation failed: ' + e });
    } finally {
      this.knowledgeBusy.set(false);
    }
  }

  // ---------- Tool Registry / Action Bindings ----------
  ensureToolsLoaded(): void {
    if (!this.toolsLoaded()) {
      this.toolsLoaded.set(true);
      void this.loadToolManifest();
      void this.loadActionBindings();
    }
  }
  async loadToolManifest(): Promise<void> {
    this.toolBusy.set(true);
    try {
      const r = await this.http.request('/api/oaa/tools/manifest', { cache: 'no-store' });
      if (r.status === 401 || r.status === 403) {
        this.msg.set({ type: 'danger', text: 'OAA Gateway permission is required.' });
        return;
      }
      if (!r.ok) {
        this.msg.set({ type: 'danger', text: `Tool manifest load failed (HTTP ${r.status})` });
        return;
      }
      this.toolManifest.set(await r.json());
    } catch (e) {
      this.msg.set({ type: 'danger', text: 'Tool manifest load failed: ' + e });
    } finally {
      this.toolBusy.set(false);
    }
  }
  async loadActionBindings(): Promise<void> {
    this.toolBusy.set(true);
    try {
      const r = await this.http.request('/api/oaa/tools/action-bindings', { cache: 'no-store' });
      if (r.status === 401 || r.status === 403) {
        this.msg.set({ type: 'danger', text: 'OAA Gateway permission is required.' });
        return;
      }
      if (!r.ok) {
        this.msg.set({ type: 'danger', text: `Action bindings load failed (HTTP ${r.status})` });
        return;
      }
      this.actionBindings.set(await r.json());
    } catch (e) {
      this.msg.set({ type: 'danger', text: 'Action bindings load failed: ' + e });
    } finally {
      this.toolBusy.set(false);
    }
  }

  // ---------- Execute action binding (mutation gate) ----------
  execFieldKeys(b: OaaActionBinding): string[] {
    return Object.keys(b.requiredInputs?.fields || {});
  }
  openExecute(b: OaaActionBinding): void {
    if (b.valid === false) return;
    const inputs: Record<string, string> = {};
    for (const key of this.execFieldKeys(b)) {
      if (key === 'namespace') inputs[key] = b.targetHints?.namespace || '';
      else if (key === 'name' || key === 'deployment') inputs[key] = b.targetHints?.deployment || '';
      else inputs[key] = '';
    }
    this.execInputs = inputs;
    this.execConfirm = '';
    this.execReason = '';
    this.execResult.set('');
    this.execError.set('');
    this.execBinding.set(b);
  }
  closeExecute(): void {
    this.execBinding.set(null);
    this.execInputs = {};
    this.execConfirm = '';
    this.execReason = '';
    this.execResult.set('');
    this.execError.set('');
  }
  /** 서버(bindingConfirmationExpected)와 동일한 치환 규칙을 클라이언트에서 미리 계산해 안내용으로 보여준다.
   *  최종 검증은 항상 서버가 다시 수행한다 — 이 값은 UI 안내일 뿐이다. */
  expectedConfirmText(): string {
    const b = this.execBinding();
    if (!b || b.confirmation === 'none') return '';
    let expected = b.confirmationTemplate || `execute binding ${b.id}`;
    const namespace = this.execInputs['namespace'] || b.targetHints?.namespace || '';
    const deployment = this.execInputs['name'] || this.execInputs['deployment'] || b.targetHints?.deployment || '';
    const replicas = this.execInputs['replicas'] ?? '';
    expected = expected
      .replace(/<namespace>/g, namespace)
      .replace(/<deployment>/g, deployment)
      .replace(/<replicas>/g, String(replicas));
    return expected.trim();
  }
  /** 실행 버튼 활성화 게이트 — exact confirmation string + reason이 모두 충족되고,
   *  mutation(비-read) 바인딩이면 mutationGateOpen()도 열려 있어야 한다. */
  canSubmitExecute(): boolean {
    const b = this.execBinding();
    if (!b || this.execBusy()) return false;
    if (b.riskLevel !== 'read' && !this.mutationGateOpen()) return false;
    if (!this.execReason.trim()) return false;
    if (b.confirmation !== 'none') {
      const expected = this.expectedConfirmText();
      if (!expected || this.execConfirm.trim() !== expected) return false;
    }
    return true;
  }
  private buildExecuteInputs(b: OaaActionBinding): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of this.execFieldKeys(b)) {
      const raw = (this.execInputs[key] ?? '').trim();
      if (!raw) continue;
      out[key] = key === 'replicas' || key === 'limit' ? Number(raw) : raw;
    }
    return out;
  }
  async executeBinding(): Promise<void> {
    const b = this.execBinding();
    // 미충족(게이트 닫힘 / confirmation 불일치 / 사유 없음) 상태에서는 절대 fetch하지 않는다.
    if (!b || !this.canSubmitExecute()) return;
    this.execBusy.set(true);
    this.execError.set('');
    try {
      const body = {
        bindingId: b.id,
        inputs: this.buildExecuteInputs(b),
        confirm: b.confirmation === 'none' ? '' : this.execConfirm.trim(),
        reason: this.execReason.trim(),
      };
      const r = await this.http.request('/api/oaa/actions/bindings/execute', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const out = await r.json().catch(() => ({}) as any);
      if (r.status === 401 || r.status === 403) {
        this.execError.set(out.error || 'Admin permission is required for this action.');
        return;
      }
      if (!r.ok) {
        this.execError.set(out.error || `Execution failed (HTTP ${r.status})`);
        return;
      }
      this.execResult.set(out.message || JSON.stringify(out, null, 2));
      this.msg.set({ type: 'success', text: `Binding executed: ${b.id}` });
    } catch (e) {
      this.execError.set('Execution failed: ' + e);
    } finally {
      this.execBusy.set(false);
    }
  }
}
