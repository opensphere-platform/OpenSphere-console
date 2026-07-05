import { Component, OnInit, OnDestroy, signal, computed, inject, ChangeDetectionStrategy } from '@angular/core';
import { ClarityModule } from '@clr/angular';
import { FormsModule } from '@angular/forms';
import { BackendUnavailable } from '../os/backend-unavailable';
import { OsPageHeader } from '../os/os-page-header';
import { OsDatagrid, OsCellDef, OsColumn } from '../os/os-datagrid';
import { AuthService } from '../core/auth.service';
import { BackboneGraph } from './backbone-graph';
import { BackboneSlice } from './backbone-slice';

interface BbComponent { key: string; name: string; role: string; kind: string; installed: boolean; ready: boolean; detail: string; }
interface BbState { namespace: string; nsExists: boolean; installed: boolean; ready: boolean; components: BbComponent[]; }
interface CtrlStatus { crdReady: boolean; dbConnected: boolean; runs: number; total: number; bound: number; lastRun: string; lastError: string; intervalSec: number; finalizer: string; }
interface Claim {
  namespace: string; name: string; phase: string; deleting: boolean; message: string;
  spec: { postgres: boolean; objectStore: boolean; gitOps: boolean };
  postgres: { secretRef: string; database: string } | null;
  objectStore: { bucket: string; state: string } | null;
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
  createdAt: string;
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
  documents: number;
  chunks: number;
  manualDocuments: number;
  manualChunks: number;
  manualConcepts: number;
  manualRelations: number;
  manualSeedPath: string;
  manualSources: { source: string; documents: number; chunks: number }[];
  embeddingModes: { mode: string; chunks: number }[];
  embeddingKeys: { id: string; provider: string; displayName: string; embeddingModel: string }[];
}
interface KnowledgeForm {
  namespace: string;
  sourceType: string;
  sourceId: string;
  title: string;
  content: string;
}
interface OaaTool {
  id: string;
  name: string;
  channel: string;
  readOnly: boolean;
  endpoint?: { method: string; path: string };
  riskLevel?: string;
  confirmation?: string;
  confirmationTemplate?: string;
  auditEventType?: string;
}
interface OaaToolManifest {
  schema: string;
  service: string;
  version: string;
  generatedAt: string;
  allowedNamespaces: string[];
  scaleMax: number;
  tools: OaaTool[];
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
  citations?: { sourceId: string; sourcePath?: string }[];
}
interface OaaActionBindingManifest {
  schema: string;
  service: string;
  version: string;
  generatedAt: string;
  bindings: OaaActionBinding[];
  invalidBindings: { id: string; toolId: string }[];
}
interface OaaActionForm {
  bindingId: string;
  inputs: string;
  confirm: string;
}
interface ManualConcept {
  id: string;
  type: string;
  name: string;
  aliases?: string[];
  summary: string;
  definition?: string;
  authorityTier: number;
  status: string;
  sourceIds?: string[];
  tags?: string[];
}
interface ManualRelation {
  id: string;
  fromId: string;
  toId: string;
  relation: string;
  confidence: string;
  authorityTier: number;
  sourceId: string;
}
interface ManualConceptGraph {
  schema: string;
  generatedAt: string;
  query: string;
  concepts: ManualConcept[];
  relations: ManualRelation[];
}

/**
 * Backbone — 콘솔 제어평면 상태저장 스택(PostgreSQL · RustFS · Gitea) 설치/상태. **셸 네이티브** 페이지.
 * 백엔드 = dupa-registry-controller(/api/admin/backbone/{status,install}, admin 게이트). docs/BACKBONE-ARCHITECTURE.md.
 * Foundation(사용자 워크로드 지원)과 분리된 콘솔 전용 데이터 티어. 설치는 멱등(POST 409=보존).
 */
@Component({
  selector: 'os-admin-backbone',
  imports: [ClarityModule, FormsModule, BackendUnavailable, OsPageHeader, OsDatagrid, OsCellDef, BackboneGraph, BackboneSlice],
  template: `
    <div class="os-page">
      <os-page-header title="Backbone" tag="Core·Admin · 콘솔 데이터 티어" />
      @if (down(); as d) {
      <os-backend-unavailable
        feature="Backbone"
        backend="dupa-registry-controller (/api/admin/backbone)"
        hint="dupa-registry-controller 배포 · ClusterRole(dupa-backbone-installer) 적용 시 복구됩니다."
        [detail]="d"
      />
    } @else {
    <p class="os-sub">
      콘솔 제어평면 상태저장 스택 — PostgreSQL · RustFS · Gitea. Foundation(사용자 워크로드 지원)과 분리된 콘솔 전용 데이터 티어.
      @if (state(); as s) { · ns <code>{{ s.namespace }}</code> · {{ s.installed ? '설치됨' : '미설치' }} · {{ s.ready ? '정상(Ready)' : '준비중' }} }
    </p>

    @if (authExpired()) {
      <clr-alert [clrAlertType]="'warning'" [clrAlertClosable]="false">
        <clr-alert-item><span class="alert-text">API 인증 토큰이 만료되었습니다. 화면 로그인은 유지되어도 저장/조회 전 인증 갱신이 필요합니다. <a (click)="reAuth()">인증 갱신 →</a></span></clr-alert-item>
      </clr-alert>
    } @else if (msg(); as m) {
      <clr-alert [clrAlertType]="m.type" [clrAlertClosable]="true" (clrAlertClosedChange)="msg.set(null)">
        <clr-alert-item><span class="alert-text">{{ m.text }}</span></clr-alert-item>
      </clr-alert>
    }

    <clr-tabs>
      <!-- 탭1: 구성요소 -->
      <clr-tab>
        <button clrTabLink>구성요소</button>
        <clr-tab-content>
          <div class="os-actions">
            <button class="btn btn-primary" [disabled]="busy() || installing()" (click)="install()">{{ state()?.installed ? 'Backbone 재적용' : 'Backbone 설치' }}</button>
            <button class="btn btn-outline" [disabled]="busy() || installing()" (click)="refresh()">새로고침</button>
            @if (busy() && !installing()) { <span class="spinner spinner-inline"></span> }
          </div>

          @if (installing()) {
            <div class="bb-progress-wrap">
              <div class="bb-progress-head">
                <span>설치 진행 중… 컴포넌트 {{ readyCount() }}/{{ totalCount() }} Ready</span>
                <span class="bb-progress-pct">{{ progress() }}%</span>
              </div>
              <div class="bb-progress-track"><div class="bb-progress-bar" [style.width.%]="progress()"></div></div>
              <div class="bb-log">
                @for (l of logs(); track $index) { <div class="bb-log-line">{{ l }}</div> }
                @if (!logs().length) { <div class="bb-log-empty">로그 대기 중…</div> }
              </div>
            </div>
          }

          <p class="os-sub">행을 클릭하면 우측 슬라이스에서 일반정보·Contents·YAML·이벤트를 봅니다(읽기 전용).</p>
          <os-datagrid [columns]="cols" [rows]="components()" [selected]="selectedRow()" (rowClick)="openDetail($event)" empty="상태 조회 중…">
            <ng-template osCell="name" let-c><strong>{{ c.name }}</strong> <span class="os-mono">· {{ c.kind }}</span></ng-template>
            <ng-template osCell="status" let-c>
              @if (c.ready) { <span class="label label-success">Ready</span> }
              @else if (c.installed) { <span class="label label-warning">NotReady</span> }
              @else { <span class="label">미설치</span> }
            </ng-template>
            <ng-template osCell="detail" let-c><span class="os-mono">{{ c.detail }}</span></ng-template>
          </os-datagrid>
          <p class="os-sub">⚠️ 로컬(local-path) 단일노드: 단일 replica · 논리 백업 전용(스냅샷 불가). 운영은 네트워크 스토리지로 격상. 설계: <code>docs/BACKBONE-ARCHITECTURE.md</code></p>
        </clr-tab-content>
      </clr-tab>

      <!-- 탭2: 의존 관계 -->
      <clr-tab>
        <button clrTabLink>의존 관계</button>
        <clr-tab-content>
          <p class="os-sub">콘솔 서비스가 어느 데이터티어에 연결되는지(누가 무엇을). 점선 = 예정. 데이터티어 색 = 라이브 상태.</p>
          <os-backbone-graph [statusByKey]="statusByKey()" />
        </clr-tab-content>
      </clr-tab>

      <!-- 탭3: 컨트롤러 (BackboneClaim 할당 reconciler 상태 + 테넌트 요청 목록) -->
      <clr-tab>
        <button clrTabLink (click)="loadOaaGateway()">OAA Gateway</button>
        <clr-tab-content>
          <div class="os-actions">
            <button class="btn btn-sm btn-outline" [disabled]="llmBusy()" (click)="loadLlmKeys()">Refresh</button>
            @if (llmBusy()) { <span class="spinner spinner-inline"></span> }
          </div>

          <div class="oaa-layout">
            <section class="oaa-form">
              <h2>LLM Key</h2>
              <div class="oaa-grid">
                <label><span>ID</span><input class="clr-input" name="oaa-id" [(ngModel)]="llmForm.id" placeholder="openai-main" /></label>
                <label>
                  <span>Provider</span>
                  <select class="clr-select" name="oaa-provider" [(ngModel)]="llmForm.provider" (ngModelChange)="applyProviderDefaults($event)">
                    <option value="openai">OpenAI</option>
                    <option value="deepseek">DeepSeek</option>
                    <option value="azure-openai">Azure OpenAI</option>
                    <option value="anthropic">Anthropic</option>
                    <option value="google">Google</option>
                    <option value="custom">Custom</option>
                  </select>
                </label>
                <label><span>Display name</span><input class="clr-input" name="oaa-display-name" [(ngModel)]="llmForm.displayName" placeholder="OpenAI Main" /></label>
                <label><span>Base URL</span><input class="clr-input" name="oaa-base-url" [(ngModel)]="llmForm.baseUrl" placeholder="https://api.openai.com/v1" /></label>
                <label><span>Default model</span><input class="clr-input" name="oaa-default-model" [(ngModel)]="llmForm.defaultModel" placeholder="gpt-4.1" /></label>
                <label><span>Embedding model</span><input class="clr-input" name="oaa-embedding-model" [(ngModel)]="llmForm.embeddingModel" placeholder="text-embedding-3-large" /></label>
                <label><span>API key</span><input class="clr-input" type="password" name="oaa-api-key" [(ngModel)]="llmForm.apiKey" autocomplete="off" placeholder="sk-..." /></label>
                <label><span>Reason</span><input class="clr-input" name="oaa-reason" [(ngModel)]="llmForm.reason" placeholder="initial setup / rotation" /></label>
              </div>
              <label class="oaa-check"><input type="checkbox" name="oaa-enabled" [(ngModel)]="llmForm.enabled" /><span>Enabled</span></label>
              <div class="os-actions">
                <button class="btn btn-primary" [disabled]="llmSaving()" (click)="saveLlmKey()">Save key</button>
                <button class="btn btn-outline" [disabled]="llmSaving()" (click)="resetLlmForm()">Clear</button>
                @if (llmSaving()) { <span class="spinner spinner-inline"></span> }
              </div>
            </section>

            <section class="oaa-list">
              <h2>Registered Keys <span class="os-engine">({{ llmKeys().length }})</span></h2>
              <clr-datagrid>
                <clr-dg-column>ID</clr-dg-column>
                <clr-dg-column>Provider</clr-dg-column>
                <clr-dg-column>Model</clr-dg-column>
                <clr-dg-column>Fingerprint</clr-dg-column>
                <clr-dg-column>Status</clr-dg-column>
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
                    <clr-dg-cell>
                      <button class="btn btn-sm btn-link" (click)="editLlmKey(k)">Edit</button>
                      <button class="btn btn-sm btn-link btn-danger" (click)="deleteLlmKey(k)">Delete</button>
                    </clr-dg-cell>
                  </clr-dg-row>
                }
                <clr-dg-placeholder>No LLM keys</clr-dg-placeholder>
                <clr-dg-footer>{{ llmKeys().length }} keys</clr-dg-footer>
              </clr-datagrid>
            </section>
          </div>

          <section class="oaa-knowledge">
            <div class="oaa-section-head">
              <h2>Knowledge Store <span class="os-engine">PostgreSQL + pgvector</span></h2>
              <div class="os-actions oaa-inline-actions">
                <button class="btn btn-sm btn-outline" [disabled]="knowledgeBusy()" (click)="loadKnowledgeStats()">Refresh</button>
                <button class="btn btn-sm btn-outline" [disabled]="knowledgeBusy()" (click)="seedKnowledge()">Seed built-ins</button>
                <button class="btn btn-sm btn-outline" [disabled]="knowledgeBusy()" (click)="seedBundledManuals()">Seed manuals</button>
                <button class="btn btn-sm btn-primary" [disabled]="knowledgeBusy()" (click)="reembedKnowledge()">Re-embed</button>
                @if (knowledgeBusy()) { <span class="spinner spinner-inline"></span> }
              </div>
            </div>

            @if (knowledgeStats(); as ks) {
              <div class="oaa-stat-grid">
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
                @for (s of ks.manualSources || []; track s.source) {
                  <span class="label label-purple">{{ s.source }} {{ s.documents }}/{{ s.chunks }}</span>
                }
                @if (!(ks.manualSources || []).length) { <span class="os-mono">No manual sources yet. Use Seed manuals.</span> }
              </p>
              <p class="os-sub">Modes:
                @for (m of ks.embeddingModes; track m.mode) {
                  <span class="label">{{ m.mode }} {{ m.chunks }}</span>
                }
                @if (!ks.embeddingModes.length) { <span class="os-mono">none</span> }
              </p>
              <p class="os-sub">Provider keys:
                @for (k of ks.embeddingKeys; track k.id) {
                  <span class="label label-info">{{ k.id }} / {{ k.embeddingModel }}</span>
                }
                @if (!ks.embeddingKeys.length) { <span class="os-mono">No enabled key has an embedding model. Re-embed will use hash fallback unless strict provider mode is available.</span> }
              </p>
            }

            <div class="oaa-concepts">
              <div class="oaa-bindings-head oaa-concepts-head">
                <h3>Concept Graph <span class="os-engine">ManualConcept / ManualRelation</span></h3>
                <div class="oaa-search-row oaa-concept-query">
                  <input class="clr-input" name="oaa-concept-query" [(ngModel)]="conceptQuery" placeholder="perspective / oaa-gateway / AI Level" />
                  <button class="btn btn-sm btn-outline" [disabled]="knowledgeBusy()" (click)="loadConceptGraph()">Load</button>
                </div>
              </div>
              @if (conceptGraph(); as cg) {
                <div class="oaa-concept-grid">
                  @for (c of cg.concepts || []; track c.id) {
                    <div class="oaa-concept-card">
                      <div class="oaa-concept-title">
                        <strong>{{ c.name }}</strong>
                        <span class="label label-info">{{ c.type }}</span>
                        <span class="label">T{{ c.authorityTier }}</span>
                      </div>
                      <div class="os-mono">{{ c.id }}</div>
                      <p>{{ c.summary }}</p>
                      @if (c.sourceIds?.length) {
                        <div class="os-mono">sources: {{ (c.sourceIds || []).join(', ') }}</div>
                      }
                    </div>
                  }
                  @if (!(cg.concepts || []).length) { <p class="os-sub">No concepts loaded yet.</p> }
                </div>
                <div class="oaa-relation-list">
                  <strong>Relations</strong>
                  @for (r of cg.relations || []; track r.id) {
                    <div class="oaa-relation">
                      <span class="os-mono">{{ r.fromId }}</span>
                      <span class="label">{{ r.relation }}</span>
                      <span class="os-mono">{{ r.toId }}</span>
                    </div>
                  }
                  @if (!(cg.relations || []).length) { <p class="os-sub">No relations for current concept set.</p> }
                </div>
              } @else {
                <p class="os-sub">No concept graph loaded yet.</p>
              }
            </div>

            <div class="oaa-knowledge-grid">
              <div class="oaa-doc-form">
                <h3>Manual document</h3>
                <div class="oaa-grid">
                  <label><span>Namespace</span><input class="clr-input" name="oaa-doc-namespace" [(ngModel)]="knowledgeForm.namespace" /></label>
                  <label><span>Source type</span><input class="clr-input" name="oaa-doc-source-type" [(ngModel)]="knowledgeForm.sourceType" placeholder="manual / policy / catalog" /></label>
                  <label><span>Source ID</span><input class="clr-input" name="oaa-doc-source-id" [(ngModel)]="knowledgeForm.sourceId" placeholder="opensphere-note-001" /></label>
                  <label><span>Title</span><input class="clr-input" name="oaa-doc-title" [(ngModel)]="knowledgeForm.title" /></label>
                </div>
                <label class="oaa-textarea-label"><span>Content</span><textarea class="clr-textarea" name="oaa-doc-content" [(ngModel)]="knowledgeForm.content" rows="7"></textarea></label>
                <div class="os-actions">
                  <button class="btn btn-sm btn-primary" [disabled]="knowledgeBusy()" (click)="saveKnowledgeDoc()">Save document</button>
                  <button class="btn btn-sm btn-outline" [disabled]="knowledgeBusy()" (click)="resetKnowledgeForm()">Clear</button>
                </div>
              </div>

              <div class="oaa-search">
                <h3>Search test</h3>
                <div class="oaa-search-row">
                  <input class="clr-input" name="oaa-search-query" [(ngModel)]="knowledgeQuery" placeholder="OpenSphere 10 Perspective" />
                  <button class="btn btn-sm btn-outline" [disabled]="knowledgeBusy()" (click)="searchKnowledge()">Search</button>
                </div>
                <div class="oaa-search-results">
                  @for (item of knowledgeResults(); track item.sourceId + '-' + item.chunkIndex) {
                    <div class="oaa-result">
                      <strong>{{ item.title }}</strong>
                      <span class="os-mono">{{ item.sourceType }}/{{ item.sourceId }} #{{ item.chunkIndex }} · {{ fmtScore(item.score) }}</span>
                    </div>
                  }
                  @if (!knowledgeResults().length) { <p class="os-sub">No search results yet.</p> }
                </div>
              </div>
            </div>
          </section>

          <section class="oaa-tools">
            <div class="oaa-section-head">
              <h2>Tool Registry <span class="os-engine">OAA executable capabilities</span></h2>
              <div class="os-actions oaa-inline-actions">
                <button class="btn btn-sm btn-outline" [disabled]="toolBusy()" (click)="loadToolManifest()">Refresh</button>
                @if (toolBusy()) { <span class="spinner spinner-inline"></span> }
              </div>
            </div>

            @if (toolManifest(); as tm) {
              <div class="oaa-tool-summary">
                <div><span>Schema</span><strong>{{ tm.schema }}</strong></div>
                <div><span>Service</span><strong>{{ tm.service }} / {{ tm.version }}</strong></div>
                <div><span>Read tools</span><strong>{{ readToolCount(tm) }}</strong></div>
                <div><span>Write tools</span><strong>{{ writeToolCount(tm) }}</strong></div>
                <div><span>Scale max</span><strong>{{ tm.scaleMax }}</strong></div>
              </div>
              <p class="os-sub">Allowed namespaces:
                @for (ns of tm.allowedNamespaces || []; track ns) {
                  <span class="label label-info">{{ ns }}</span>
                }
              </p>
              <clr-datagrid class="oaa-tool-grid">
                <clr-dg-column>Tool</clr-dg-column>
                <clr-dg-column>Channel</clr-dg-column>
                <clr-dg-column>Endpoint</clr-dg-column>
                <clr-dg-column>Risk</clr-dg-column>
                <clr-dg-column>Confirmation</clr-dg-column>
                @for (t of tm.tools || []; track t.id) {
                  <clr-dg-row>
                    <clr-dg-cell>
                      <strong>{{ t.name }}</strong>
                      <div class="os-mono">{{ t.id }}</div>
                    </clr-dg-cell>
                    <clr-dg-cell>{{ t.channel }}</clr-dg-cell>
                    <clr-dg-cell class="os-mono">{{ t.endpoint?.method || '-' }} {{ t.endpoint?.path || '-' }}</clr-dg-cell>
                    <clr-dg-cell>
                      <span class="label" [class.label-success]="t.readOnly" [class.label-warning]="!t.readOnly">{{ t.riskLevel || (t.readOnly ? 'read' : 'write') }}</span>
                    </clr-dg-cell>
                    <clr-dg-cell>
                      <span class="os-mono">{{ t.confirmation || 'none' }}</span>
                      @if (t.confirmationTemplate) { <div class="os-mono">{{ t.confirmationTemplate }}</div> }
                    </clr-dg-cell>
                  </clr-dg-row>
                }
                <clr-dg-placeholder>No OAA tools registered.</clr-dg-placeholder>
                <clr-dg-footer>{{ tm.tools.length }} tools</clr-dg-footer>
              </clr-datagrid>
            } @else {
              <p class="os-sub">No tool manifest loaded yet.</p>
            }

            <div class="oaa-bindings-head">
              <h3>Action Bindings <span class="os-engine">manual source -> executable tool</span></h3>
              <button class="btn btn-sm btn-outline" [disabled]="toolBusy()" (click)="loadActionBindings()">Refresh bindings</button>
            </div>
            @if (actionBindings(); as ab) {
              <div class="oaa-tool-summary oaa-binding-summary">
                <div><span>Schema</span><strong>{{ ab.schema }}</strong></div>
                <div><span>Bindings</span><strong>{{ ab.bindings.length }}</strong></div>
                <div><span>Invalid</span><strong>{{ ab.invalidBindings.length }}</strong></div>
              </div>
              <clr-datagrid class="oaa-tool-grid">
                <clr-dg-column>Binding</clr-dg-column>
                <clr-dg-column>Intent</clr-dg-column>
                <clr-dg-column>Tool</clr-dg-column>
                <clr-dg-column>Source</clr-dg-column>
                <clr-dg-column>Confirmation</clr-dg-column>
                <clr-dg-column></clr-dg-column>
                @for (b of ab.bindings || []; track b.id) {
                  <clr-dg-row>
                    <clr-dg-cell>
                      <strong>{{ b.title }}</strong>
                      <div class="os-mono">{{ b.id }}</div>
                    </clr-dg-cell>
                    <clr-dg-cell>
                      <span class="label" [class.label-success]="b.riskLevel === 'read'" [class.label-warning]="b.riskLevel !== 'read'">{{ b.intent }} / {{ b.riskLevel }}</span>
                    </clr-dg-cell>
                    <clr-dg-cell>
                      <span class="os-mono">{{ b.toolId }}</span>
                      @if (b.valid === false) { <span class="label label-danger">invalid</span> }
                    </clr-dg-cell>
                    <clr-dg-cell>
                      <span class="os-mono">{{ b.sourceId }}</span>
                      @if (b.citations?.length) { <div class="os-mono">{{ b.citations?.[0]?.sourcePath || '' }}</div> }
                    </clr-dg-cell>
                    <clr-dg-cell>
                      <span class="os-mono">{{ b.confirmation || 'none' }}</span>
                      @if (b.confirmationTemplate) { <div class="os-mono">{{ b.confirmationTemplate }}</div> }
                    </clr-dg-cell>
                    <clr-dg-cell>
                      <button class="btn btn-sm btn-link" [disabled]="b.valid === false" (click)="selectActionBinding(b)">Use</button>
                    </clr-dg-cell>
                  </clr-dg-row>
                }
                <clr-dg-placeholder>No action bindings registered.</clr-dg-placeholder>
                <clr-dg-footer>{{ ab.bindings.length }} bindings</clr-dg-footer>
              </clr-datagrid>
            } @else {
              <p class="os-sub">No action bindings loaded yet.</p>
            }

            <div class="oaa-action-runner">
              <h3>Execute Binding <span class="os-engine">audited binding execution</span></h3>
              <div class="oaa-runner-grid">
                <label><span>Binding ID</span><input class="clr-input" name="oaa-action-binding-id" [(ngModel)]="actionForm.bindingId" /></label>
                <label><span>Confirmation</span><input class="clr-input" name="oaa-action-confirm" [(ngModel)]="actionForm.confirm" placeholder="exact confirmation for write actions" /></label>
              </div>
              <label class="oaa-textarea-label"><span>Inputs JSON</span><textarea class="clr-textarea" name="oaa-action-inputs" [(ngModel)]="actionForm.inputs" rows="5"></textarea></label>
              <div class="os-actions">
                <button class="btn btn-sm btn-primary" [disabled]="actionBusy()" (click)="executeActionBinding()">Execute</button>
                <button class="btn btn-sm btn-outline" [disabled]="actionBusy()" (click)="resetActionRunner()">Clear</button>
                @if (actionBusy()) { <span class="spinner spinner-inline"></span> }
              </div>
              @if (actionResult(); as ar) {
                <pre class="oaa-action-result">{{ ar }}</pre>
              }
            </div>
          </section>
        </clr-tab-content>
      </clr-tab>

      <clr-tab>
        <button clrTabLink (click)="loadController()">컨트롤러</button>
        <clr-tab-content>
          @if (ctrl(); as c) {
            <div class="os-actions"><button class="btn btn-sm btn-outline" (click)="loadController()">새로고침</button></div>
            <h2>할당 컨트롤러 <span class="os-engine">· BackboneClaim reconciler (dupa)</span></h2>
            <clr-datagrid>
              <clr-dg-column>항목</clr-dg-column>
              <clr-dg-column>상태</clr-dg-column>
              <clr-dg-row><clr-dg-cell>CRD</clr-dg-cell><clr-dg-cell>@if (c.crdReady) { <span class="label label-success">installed</span> } @else { <span class="label label-warning">미설치 — backboneclaim-crd.yaml apply 필요</span> }</clr-dg-cell></clr-dg-row>
              <clr-dg-row><clr-dg-cell>PostgreSQL 연결</clr-dg-cell><clr-dg-cell>@if (c.dbConnected) { <span class="label label-success">connected</span> } @else { <span class="label label-warning">미연결</span> }</clr-dg-cell></clr-dg-row>
              <clr-dg-row><clr-dg-cell>Claims (bound/total)</clr-dg-cell><clr-dg-cell>{{ c.bound }} / {{ c.total }}</clr-dg-cell></clr-dg-row>
              <clr-dg-row><clr-dg-cell>Reconcile</clr-dg-cell><clr-dg-cell class="os-mono">runs {{ c.runs }} · 주기 {{ c.intervalSec }}s · last {{ c.lastRun || '—' }}</clr-dg-cell></clr-dg-row>
              @if (c.lastError) { <clr-dg-row><clr-dg-cell>Last error</clr-dg-cell><clr-dg-cell class="os-mono">{{ c.lastError }}</clr-dg-cell></clr-dg-row> }
              <clr-dg-row><clr-dg-cell>Finalizer</clr-dg-cell><clr-dg-cell class="os-mono">{{ c.finalizer }}</clr-dg-cell></clr-dg-row>
            </clr-datagrid>

            <h2>BackboneClaim <span class="os-engine">· 테넌트 요청 ({{ claims().length }})</span></h2>
            <clr-datagrid>
              <clr-dg-column>Namespace</clr-dg-column>
              <clr-dg-column>Name</clr-dg-column>
              <clr-dg-column>Phase</clr-dg-column>
              <clr-dg-column>요청</clr-dg-column>
              <clr-dg-column>바인딩(secretRef)</clr-dg-column>
              @for (cl of claims(); track cl.namespace + cl.name) {
                <clr-dg-row>
                  <clr-dg-cell>{{ cl.namespace }}</clr-dg-cell>
                  <clr-dg-cell>{{ cl.name }}{{ cl.deleting ? ' (deleting)' : '' }}</clr-dg-cell>
                  <clr-dg-cell><span class="label" [class.label-success]="cl.phase === 'Bound'" [class.label-warning]="cl.phase !== 'Bound'">{{ cl.phase }}</span></clr-dg-cell>
                  <clr-dg-cell class="os-mono">{{ specStr(cl) }}</clr-dg-cell>
                  <clr-dg-cell class="os-mono">{{ bindStr(cl) }}</clr-dg-cell>
                </clr-dg-row>
              }
              <clr-dg-placeholder>BackboneClaim 없음 — 소비자(OAH 등)가 CR을 생성하면 여기 표시됩니다.</clr-dg-placeholder>
            </clr-datagrid>
            <p class="os-sub">소비자 NS에 <code>BackboneClaim</code>(spec.postgres.enabled) 생성 → 컨트롤러가 DB·Secret 발급 후 status 바인딩. 명령형 대안: <code>tools/local-dev/provision-backbone-tenant.sh</code></p>
          } @else { <p class="os-sub">불러오는 중…</p> }
        </clr-tab-content>
      </clr-tab>
    </clr-tabs>
      }
    </div>

    @if (selectedRow(); as r) {
      <os-backbone-slice [row]="r" (closed)="closeDetail()" />
    }
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
      .os-sub { color: var(--os-muted); font-size: 0.7rem; margin: 0.3rem 0 0.8rem; }
      .os-engine { font-size: 0.6rem; color: var(--os-muted); font-weight: 400; margin-left: 0.4rem; }
      .os-mono { font-family: monospace; font-size: 0.62rem; color: var(--os-muted); }
      .os-actions { display: flex; gap: 0.5rem; align-items: center; margin: 0.5rem 0 1rem; }
      .label { margin: 0 0.25rem 0.25rem 0; }

      .bb-progress-wrap { background: #fff; border: 1px solid var(--os-border, #d8d8d8); border-radius: 6px; padding: 14px 16px; margin: 0.5rem 0 1rem; }
      .bb-progress-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; font-size: 0.78rem; color: #161616; }
      .bb-progress-pct { font-variant-numeric: tabular-nums; font-weight: 600; }
      .bb-progress-track { height: 7px; border-radius: 999px; background: #eef1f6; overflow: hidden; }
      .bb-progress-bar { height: 100%; border-radius: 999px; background: linear-gradient(90deg, #0072a3, #4dabf5); transition: width 0.4s ease; }
      .bb-log { margin-top: 12px; max-height: 12rem; overflow: auto; background: #0f2230; border-radius: 4px; padding: 8px 10px;
        font-family: monospace; font-size: 0.68rem; line-height: 1.6; color: #cfe0e6; }
      .bb-log-line { white-space: pre-wrap; word-break: break-word; }
      .bb-log-empty { color: #6b8a99; }
      .oaa-layout { display: grid; grid-template-columns: minmax(22rem, 28rem) minmax(0, 1fr); gap: 1.15rem; align-items: start; }
      .oaa-form, .oaa-list { border: 1px solid var(--os-border, #d8d8d8); border-radius: 6px; padding: 1.05rem; background: #fff; }
      .oaa-form h2, .oaa-list h2 { margin: 0 0 0.85rem; font-size: 1rem; }
      .oaa-grid { display: grid; grid-template-columns: 1fr; gap: 0.7rem; }
      .oaa-grid label { display: grid; gap: 0.28rem; font-size: 0.7rem; color: var(--os-muted); }
      .oaa-grid input, .oaa-grid select { width: 100%; max-width: none; min-height: 1.65rem; font-size: 0.72rem; }
      .oaa-check { display: inline-flex; align-items: center; gap: 0.45rem; margin-top: 0.8rem; font-size: 0.72rem; }
      .oaa-knowledge { margin-top: 1.15rem; border: 1px solid var(--os-border, #d8d8d8); border-radius: 6px; padding: 1.05rem; background: #fff; }
      .oaa-tools { margin-top: 1.15rem; border: 1px solid var(--os-border, #d8d8d8); border-radius: 6px; padding: 1.05rem; background: #fff; }
      .oaa-section-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: 0.7rem; }
      .oaa-section-head h2, .oaa-doc-form h3, .oaa-search h3 { margin: 0; font-size: 0.9rem; }
      .oaa-inline-actions { margin: 0; flex-wrap: wrap; justify-content: flex-end; }
      .oaa-stat-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0.6rem; margin-bottom: 0.55rem; }
      .oaa-stat-grid div { border: 1px solid #e1e5ea; border-radius: 4px; padding: 0.55rem 0.65rem; background: #f8fafc; }
      .oaa-stat-grid span { display: block; color: var(--os-muted); font-size: 0.62rem; }
      .oaa-stat-grid strong { display: block; margin-top: 0.15rem; font-size: 1rem; color: #1b2733; }
      .oaa-tool-summary { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 0.6rem; margin-bottom: 0.55rem; }
      .oaa-tool-summary div { border: 1px solid #e1e5ea; border-radius: 4px; padding: 0.55rem 0.65rem; background: #f8fafc; min-width: 0; }
      .oaa-tool-summary span { display: block; color: var(--os-muted); font-size: 0.62rem; }
      .oaa-tool-summary strong { display: block; margin-top: 0.15rem; font-size: 0.72rem; color: #1b2733; word-break: break-word; }
      .oaa-tool-grid { margin-top: 0.8rem; }
      .oaa-bindings-head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin: 1.1rem 0 0.5rem; padding-top: 0.85rem; border-top: 1px solid #e1e5ea; }
      .oaa-bindings-head h3 { margin: 0; font-size: 0.82rem; }
      .oaa-binding-summary { grid-template-columns: 2fr 1fr 1fr; }
      .oaa-action-runner { margin-top: 1rem; padding-top: 0.9rem; border-top: 1px solid #e1e5ea; }
      .oaa-action-runner h3 { margin: 0 0 0.65rem; font-size: 0.82rem; }
      .oaa-runner-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 0.75rem; }
      .oaa-runner-grid label { display: grid; gap: 0.28rem; font-size: 0.7rem; color: var(--os-muted); }
      .oaa-runner-grid input { width: 100%; max-width: none; min-height: 1.65rem; font-size: 0.72rem; }
      .oaa-action-result { margin: 0.7rem 0 0; max-height: 18rem; overflow: auto; border: 1px solid #e1e5ea; border-radius: 4px; background: #0f2230; color: #d7e6ee; padding: 0.7rem; font-size: 0.66rem; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
      .oaa-concepts { margin-top: 0.9rem; padding-top: 0.75rem; border-top: 1px solid #e1e5ea; }
      .oaa-concepts-head { margin-top: 0; padding-top: 0; border-top: 0; }
      .oaa-concept-query { min-width: min(28rem, 100%); margin: 0; }
      .oaa-concept-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.65rem; }
      .oaa-concept-card { border: 1px solid #e1e5ea; border-radius: 4px; background: #fbfcfe; padding: 0.65rem 0.7rem; min-width: 0; }
      .oaa-concept-title { display: flex; align-items: center; gap: 0.35rem; flex-wrap: wrap; }
      .oaa-concept-title strong { font-size: 0.75rem; color: #1b2733; }
      .oaa-concept-card p { margin: 0.35rem 0; color: #42526a; font-size: 0.68rem; line-height: 1.45; }
      .oaa-relation-list { margin-top: 0.7rem; display: grid; gap: 0.35rem; }
      .oaa-relation-list > strong { font-size: 0.72rem; color: #1b2733; }
      .oaa-relation { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); gap: 0.45rem; align-items: center; border: 1px solid #e1e5ea; border-radius: 4px; padding: 0.45rem 0.55rem; background: #fff; }
      .oaa-relation .os-mono { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .oaa-knowledge-grid { display: grid; grid-template-columns: minmax(18rem, 30rem) minmax(0, 1fr); gap: 1rem; margin-top: 0.9rem; }
      .oaa-textarea-label { display: grid; gap: 0.28rem; margin-top: 0.7rem; font-size: 0.7rem; color: var(--os-muted); }
      .oaa-textarea-label textarea { width: 100%; max-width: none; resize: vertical; font-size: 0.72rem; }
      .oaa-search-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.45rem; margin: 0.75rem 0; }
      .oaa-search-row input { width: 100%; max-width: none; }
      .oaa-search-results { display: grid; gap: 0.45rem; }
      .oaa-result { border: 1px solid #e1e5ea; border-radius: 4px; padding: 0.55rem 0.65rem; background: #fbfcfe; }
      .oaa-result strong { display: block; font-size: 0.72rem; color: #1b2733; }
      .oaa-result .os-mono { display: block; margin-top: 0.15rem; }
      @media (max-width: 980px) { .oaa-layout { grid-template-columns: 1fr; } }
      @media (max-width: 980px) { .oaa-knowledge-grid, .oaa-stat-grid, .oaa-tool-summary, .oaa-runner-grid, .oaa-concept-grid, .oaa-relation { grid-template-columns: 1fr; } .oaa-section-head, .oaa-bindings-head { display: block; } .oaa-inline-actions { margin-top: 0.6rem; justify-content: flex-start; } }
    `,
  ],
})
export class AdminBackbone implements OnInit, OnDestroy {
  readonly cols: OsColumn[] = [
    { key: 'name', label: '구성요소' },
    { key: 'role', label: '역할' },
    { key: 'status', label: '상태' },
    { key: 'detail', label: '상세' },
  ];
  readonly state = signal<BbState | null>(null);
  readonly components = computed<BbComponent[]>(() => this.state()?.components ?? []);
  readonly statusByKey = computed<Record<string, { installed: boolean; ready: boolean }>>(() => {
    const m: Record<string, { installed: boolean; ready: boolean }> = {};
    for (const c of this.components()) m[c.key] = { installed: c.installed, ready: c.ready };
    return m;
  });
  readonly down = signal<string>('');
  readonly busy = signal<boolean>(false);
  readonly msg = signal<{ type: 'success' | 'danger' | 'info'; text: string } | null>(null);
  readonly selectedRow = signal<BbComponent | null>(null);
  readonly ctrl = signal<CtrlStatus | null>(null);
  readonly claims = signal<Claim[]>([]);
  readonly llmKeys = signal<LlmKey[]>([]);
  readonly llmBusy = signal(false);
  readonly llmSaving = signal(false);
  readonly knowledgeStats = signal<KnowledgeStats | null>(null);
  readonly knowledgeBusy = signal(false);
  readonly knowledgeResults = signal<any[]>([]);
  readonly conceptGraph = signal<ManualConceptGraph | null>(null);
  readonly toolManifest = signal<OaaToolManifest | null>(null);
  readonly actionBindings = signal<OaaActionBindingManifest | null>(null);
  readonly toolBusy = signal(false);
  readonly actionBusy = signal(false);
  readonly actionResult = signal<string>('');
  llmForm: LlmKeyForm = this.emptyLlmForm();
  knowledgeForm: KnowledgeForm = this.emptyKnowledgeForm();
  actionForm: OaaActionForm = this.emptyActionForm();
  knowledgeQuery = 'OpenSphere 10 Perspective';
  conceptQuery = 'perspective';
  private timer: ReturnType<typeof setInterval> | null = null;

  // 설치 진행 표시 — Foundation Host 연결의 설치 페이지(진행바+실시간 로그)와 동일한 UX.
  // 설치 방식 자체(명령형 apply)는 그대로 두고, 이미 있는 status 폴링 + 신규 events 엔드포인트로 진행 상황만 시각화한다.
  readonly installing = signal(false);
  readonly progress = signal(0);
  readonly logs = signal<string[]>([]);
  readonly totalCount = computed(() => this.components().length);
  readonly readyCount = computed(() => this.components().filter((c) => c.ready).length);
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private seenEvents = new Set<string>();

  private auth = inject(AuthService);
  private authGet(): RequestInit {
    return { cache: 'no-store', headers: { authorization: 'Bearer ' + (this.auth.token() || '') } };
  }
  /** Kanidm의 브라우저 SSO 화면 로그인과 API Bearer id_token 만료는 별개다.
   *  401이면서 로컬 id_token도 만료된 경우에만 API 인증 갱신 배너를 표시한다. */
  readonly authExpired = signal(false);
  private checkExpired(status: number): boolean {
    if (status === 401 && this.auth.isTokenExpired()) { this.authExpired.set(true); return true; }
    return false;
  }
  reAuth(): void { void this.auth.reAuthenticate(); }

  async ngOnInit(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => this.refresh(true), 8000); // 목록 상태 자동 갱신(슬라이스는 자체 로드)
  }
  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.stopWatch();
  }

  async refresh(silent = false): Promise<void> {
    try {
      const r = await fetch('/api/admin/backbone/status', this.authGet());
      if (this.checkExpired(r.status)) return;
      if (r.status === 401 || r.status === 403) {
        if (!silent) this.msg.set({ type: 'danger', text: '관리자 권한이 필요합니다 (opensphere-console-admins).' });
        return;
      }
      this.authExpired.set(false);
      if (!r.ok) {
        this.down.set(`status HTTP ${r.status}`);
        return;
      }
      this.down.set('');
      this.state.set(await r.json());
    } catch (e) {
      this.down.set('조회 실패: ' + e);
    }
  }

  openDetail(c: BbComponent): void { this.selectedRow.set(c); } // 슬라이스가 detail/yaml/pg를 자체 로드
  closeDetail(): void { this.selectedRow.set(null); }

  /** 컨트롤러 탭 — reconciler 상태 + BackboneClaim 목록 조회. */
  async loadController(): Promise<void> {
    try {
      const [cr, cl] = await Promise.all([
        fetch('/api/admin/backbone/controller', this.authGet()),
        fetch('/api/admin/backbone/claims', this.authGet()),
      ]);
      if (this.checkExpired(cr.status) || this.checkExpired(cl.status)) return;
      if (cr.ok) this.ctrl.set(await cr.json());
      if (cl.ok) this.claims.set((await cl.json()).items || []);
    } catch { /* 컨트롤러 조회 실패 무시 */ }
  }
  specStr(cl: Claim): string {
    return [cl.spec.postgres ? 'postgres' : '', cl.spec.objectStore ? 'objectStore' : '', cl.spec.gitOps ? 'gitOps' : ''].filter(Boolean).join(', ') || '—';
  }
  bindStr(cl: Claim): string {
    const parts: string[] = [];
    if (cl.postgres) parts.push(`pg:${cl.postgres.database} → ${cl.postgres.secretRef}`);
    if (cl.objectStore) parts.push(`s3:${cl.objectStore.bucket}(${cl.objectStore.state})`);
    return parts.join(' · ') || (cl.message || '-');
  }

  private emptyLlmForm(): LlmKeyForm {
    return {
      id: '',
      provider: 'openai',
      displayName: '',
      apiKey: '',
      baseUrl: 'https://api.openai.com/v1',
      defaultModel: 'gpt-4.1',
      embeddingModel: 'text-embedding-3-large',
      enabled: true,
      reason: '',
    };
  }
  private emptyKnowledgeForm(): KnowledgeForm {
    return { namespace: 'opensphere', sourceType: 'manual', sourceId: '', title: '', content: '' };
  }
  private emptyActionForm(): OaaActionForm {
    return { bindingId: '', inputs: '{}', confirm: '' };
  }
  loadOaaGateway(): void {
    void this.loadLlmKeys();
    void this.loadKnowledgeStats();
    void this.loadConceptGraph();
    void this.loadToolManifest();
    void this.loadActionBindings();
  }
  applyProviderDefaults(provider: string): void {
    const defaults: Record<string, Partial<LlmKeyForm>> = {
      openai: { baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4.1', embeddingModel: 'text-embedding-3-large' },
      deepseek: { baseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-v4-flash', embeddingModel: '' },
      'azure-openai': { baseUrl: '', defaultModel: '', embeddingModel: '' },
      anthropic: { baseUrl: '', defaultModel: '', embeddingModel: '' },
      google: { baseUrl: '', defaultModel: '', embeddingModel: '' },
      custom: { baseUrl: '', defaultModel: '', embeddingModel: '' },
    };
    const preset = defaults[provider];
    if (!preset) return;
    this.llmForm = { ...this.llmForm, provider, ...preset };
  }
  resetLlmForm(): void { this.llmForm = this.emptyLlmForm(); }
  resetKnowledgeForm(): void { this.knowledgeForm = this.emptyKnowledgeForm(); }
  resetActionRunner(): void {
    this.actionForm = this.emptyActionForm();
    this.actionResult.set('');
  }
  fmtScore(value: unknown): string {
    const n = Number(value);
    return Number.isFinite(n) ? n.toFixed(3) : '-';
  }
  readToolCount(tm: OaaToolManifest): number { return (tm.tools || []).filter((t) => t.readOnly).length; }
  writeToolCount(tm: OaaToolManifest): number { return (tm.tools || []).filter((t) => !t.readOnly).length; }
  selectActionBinding(b: OaaActionBinding): void {
    const inputs: Record<string, unknown> = {};
    if (b.intent === 'diagnose' && b.toolId === 'oaa.knowledge.search') inputs['q'] = 'OpenSphere 10 Perspective';
    if (b.toolId === 'oaa.k8s.resource.describe') {
      inputs['kind'] = 'deployment';
      inputs['namespace'] = 'opensphere-backbone';
      inputs['name'] = 'oaa-gateway';
    }
    if (b.toolId === 'oaa.k8s.deployment.rollout' || b.toolId === 'oaa.k8s.deployment.restart' || b.toolId === 'oaa.k8s.deployment.scale') {
      inputs['namespace'] = 'opensphere-backbone';
      inputs['name'] = 'oaa-gateway';
    }
    if (b.toolId === 'oaa.k8s.deployment.scale') inputs['replicas'] = 1;
    this.actionForm = {
      bindingId: b.id,
      inputs: JSON.stringify(inputs, null, 2),
      confirm: b.confirmation === 'none' ? '' : (b.confirmationTemplate || ''),
    };
    this.actionResult.set('');
  }
  editLlmKey(k: LlmKey): void {
    this.llmForm = {
      id: k.id,
      provider: k.provider || 'custom',
      displayName: k.displayName || '',
      apiKey: '',
      baseUrl: k.baseUrl || '',
      defaultModel: k.defaultModel || '',
      embeddingModel: k.embeddingModel || '',
      enabled: k.enabled,
      reason: 'rotate metadata/key',
    };
  }
  async loadLlmKeys(): Promise<void> {
    this.llmBusy.set(true);
    try {
      const r = await fetch('/api/oaa/admin/llm-keys', this.authGet());
      if (this.checkExpired(r.status)) return;
      if (r.status === 401 || r.status === 403) {
        this.msg.set({ type: 'danger', text: 'OAA Gateway admin permission is required.' });
        return;
      }
      if (!r.ok) {
        this.msg.set({ type: 'danger', text: `OAA key load failed (HTTP ${r.status})` });
        return;
      }
      this.llmKeys.set((await r.json()).items || []);
    } catch (e) {
      this.msg.set({ type: 'danger', text: 'OAA key load failed: ' + e });
    } finally {
      this.llmBusy.set(false);
    }
  }
  async saveLlmKey(): Promise<void> {
    if (!this.llmForm.id || !this.llmForm.apiKey) {
      this.msg.set({ type: 'danger', text: 'ID and API key are required.' });
      return;
    }
    this.llmSaving.set(true);
    try {
      const r = await fetch('/api/oaa/admin/llm-keys', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + (this.auth.token() || ''), 'content-type': 'application/json' },
        body: JSON.stringify(this.llmForm),
      });
      if (this.checkExpired(r.status)) return;
      if (r.status === 401 || r.status === 403) {
        this.msg.set({ type: 'danger', text: 'OAA Gateway admin permission is required.' });
        return;
      }
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        this.msg.set({ type: 'danger', text: body.error || `OAA key save failed (HTTP ${r.status})` });
        return;
      }
      const out = await r.json();
      this.msg.set({ type: 'success', text: out.created ? 'LLM key created.' : 'LLM key rotated.' });
      this.resetLlmForm();
      await this.loadLlmKeys();
    } catch (e) {
      this.msg.set({ type: 'danger', text: 'OAA key save failed: ' + e });
    } finally {
      this.llmSaving.set(false);
    }
  }
  async deleteLlmKey(k: LlmKey): Promise<void> {
    const reason = window.prompt(`Delete ${k.id}? Reason`, 'delete from admin console');
    if (reason == null) return;
    this.llmBusy.set(true);
    try {
      const r = await fetch(`/api/oaa/admin/llm-keys/${encodeURIComponent(k.id)}?reason=${encodeURIComponent(reason)}`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer ' + (this.auth.token() || '') },
      });
      if (this.checkExpired(r.status)) return;
      if (r.status === 401 || r.status === 403) {
        this.msg.set({ type: 'danger', text: 'OAA Gateway admin permission is required.' });
        return;
      }
      if (!r.ok) {
        this.msg.set({ type: 'danger', text: `OAA key delete failed (HTTP ${r.status})` });
        return;
      }
      this.msg.set({ type: 'success', text: 'LLM key deleted.' });
      await this.loadLlmKeys();
    } catch (e) {
      this.msg.set({ type: 'danger', text: 'OAA key delete failed: ' + e });
    } finally {
      this.llmBusy.set(false);
    }
  }

  async loadKnowledgeStats(): Promise<void> {
    this.knowledgeBusy.set(true);
    try {
      const r = await fetch('/api/oaa/admin/knowledge/stats', this.authGet());
      if (this.checkExpired(r.status)) return;
      if (r.status === 401 || r.status === 403) {
        this.msg.set({ type: 'danger', text: 'OAA Gateway admin permission is required.' });
        return;
      }
      if (!r.ok) {
        this.msg.set({ type: 'danger', text: `Knowledge stats load failed (HTTP ${r.status})` });
        return;
      }
      this.knowledgeStats.set(await r.json());
    } catch (e) {
      this.msg.set({ type: 'danger', text: 'Knowledge stats load failed: ' + e });
    } finally {
      this.knowledgeBusy.set(false);
    }
  }
  async seedKnowledge(): Promise<void> {
    await this.knowledgePost('/api/oaa/admin/knowledge/seed', {}, 'Built-in knowledge seeded.');
  }
  async seedBundledManuals(): Promise<void> {
    await this.knowledgePost('/api/oaa/admin/knowledge/manual-seed/bundled', {}, 'Bundled manuals seeded.');
  }
  async reembedKnowledge(): Promise<void> {
    await this.knowledgePost('/api/oaa/admin/knowledge/reembed', { strict: false }, 'Knowledge re-embedded.');
  }
  async saveKnowledgeDoc(): Promise<void> {
    if (!this.knowledgeForm.sourceId || !this.knowledgeForm.content.trim()) {
      this.msg.set({ type: 'danger', text: 'Source ID and content are required.' });
      return;
    }
    await this.knowledgePost('/api/oaa/admin/knowledge/documents', this.knowledgeForm, 'Knowledge document saved.', 201);
    this.resetKnowledgeForm();
  }
  private async knowledgePost(url: string, body: unknown, success: string, okStatus = 200): Promise<void> {
    this.knowledgeBusy.set(true);
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + (this.auth.token() || ''), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (this.checkExpired(r.status)) return;
      if (r.status === 401 || r.status === 403) {
        this.msg.set({ type: 'danger', text: 'OAA Gateway admin permission is required.' });
        return;
      }
      if (r.status !== okStatus && !r.ok) {
        const out = await r.json().catch(() => ({}));
        this.msg.set({ type: 'danger', text: out.error || `Knowledge operation failed (HTTP ${r.status})` });
        return;
      }
      this.msg.set({ type: 'success', text: success });
      await this.loadKnowledgeStats();
      await this.loadConceptGraph();
    } catch (e) {
      this.msg.set({ type: 'danger', text: 'Knowledge operation failed: ' + e });
    } finally {
      this.knowledgeBusy.set(false);
    }
  }
  async searchKnowledge(): Promise<void> {
    const q = this.knowledgeQuery.trim();
    if (!q) return;
    this.knowledgeBusy.set(true);
    try {
      const r = await fetch(`/api/oaa/knowledge/search?q=${encodeURIComponent(q)}`, this.authGet());
      if (this.checkExpired(r.status)) return;
      if (!r.ok) {
        this.msg.set({ type: 'danger', text: `Knowledge search failed (HTTP ${r.status})` });
        return;
      }
      this.knowledgeResults.set((await r.json()).items || []);
    } catch (e) {
      this.msg.set({ type: 'danger', text: 'Knowledge search failed: ' + e });
    } finally {
      this.knowledgeBusy.set(false);
    }
  }
  async loadConceptGraph(): Promise<void> {
    this.knowledgeBusy.set(true);
    try {
      const q = this.conceptQuery.trim();
      const qs = q ? `?q=${encodeURIComponent(q)}&limit=64` : '?limit=64';
      const r = await fetch(`/api/oaa/knowledge/concepts${qs}`, this.authGet());
      if (this.checkExpired(r.status)) return;
      if (!r.ok) {
        this.msg.set({ type: 'danger', text: `Concept graph load failed (HTTP ${r.status})` });
        return;
      }
      this.conceptGraph.set(await r.json());
    } catch (e) {
      this.msg.set({ type: 'danger', text: 'Concept graph load failed: ' + e });
    } finally {
      this.knowledgeBusy.set(false);
    }
  }

  async loadToolManifest(): Promise<void> {
    this.toolBusy.set(true);
    try {
      const r = await fetch('/api/oaa/tools/manifest', this.authGet());
      if (this.checkExpired(r.status)) return;
      if (r.status === 401 || r.status === 403) {
        this.msg.set({ type: 'danger', text: 'OAA Gateway permission is required.' });
        return;
      }
      if (!r.ok) {
        this.msg.set({ type: 'danger', text: `OAA tool manifest load failed (HTTP ${r.status})` });
        return;
      }
      this.toolManifest.set(await r.json());
    } catch (e) {
      this.msg.set({ type: 'danger', text: 'OAA tool manifest load failed: ' + e });
    } finally {
      this.toolBusy.set(false);
    }
  }

  async loadActionBindings(): Promise<void> {
    this.toolBusy.set(true);
    try {
      const r = await fetch('/api/oaa/tools/action-bindings', this.authGet());
      if (this.checkExpired(r.status)) return;
      if (r.status === 401 || r.status === 403) {
        this.msg.set({ type: 'danger', text: 'OAA Gateway permission is required.' });
        return;
      }
      if (!r.ok) {
        this.msg.set({ type: 'danger', text: `OAA action bindings load failed (HTTP ${r.status})` });
        return;
      }
      this.actionBindings.set(await r.json());
    } catch (e) {
      this.msg.set({ type: 'danger', text: 'OAA action bindings load failed: ' + e });
    } finally {
      this.toolBusy.set(false);
    }
  }

  async executeActionBinding(): Promise<void> {
    if (!this.actionForm.bindingId.trim()) {
      this.msg.set({ type: 'danger', text: 'Binding ID is required.' });
      return;
    }
    let inputs: unknown = {};
    try {
      inputs = this.actionForm.inputs.trim() ? JSON.parse(this.actionForm.inputs) : {};
    } catch {
      this.msg.set({ type: 'danger', text: 'Inputs JSON is invalid.' });
      return;
    }
    this.actionBusy.set(true);
    this.actionResult.set('');
    try {
      const r = await fetch('/api/oaa/actions/bindings/execute', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + (this.auth.token() || ''), 'content-type': 'application/json' },
        body: JSON.stringify({
          bindingId: this.actionForm.bindingId.trim(),
          inputs,
          confirm: this.actionForm.confirm.trim(),
          reason: 'Backbone OAA Gateway action runner',
        }),
      });
      if (this.checkExpired(r.status)) return;
      const out = await r.json().catch(() => ({}));
      if (!r.ok) {
        this.msg.set({ type: 'danger', text: out.error || `Binding execution failed (HTTP ${r.status})` });
        this.actionResult.set(JSON.stringify(out, null, 2));
        return;
      }
      this.msg.set({ type: 'success', text: 'Binding executed.' });
      this.actionResult.set(out.message || JSON.stringify(out, null, 2));
    } catch (e) {
      this.msg.set({ type: 'danger', text: 'Binding execution failed: ' + e });
    } finally {
      this.actionBusy.set(false);
    }
  }

  async install(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.installing.set(true);
    this.progress.set(5);
    this.logs.set([]);
    this.seenEvents.clear();
    this.log('Backbone 설치 요청 — 네임스페이스/시크릿/워크로드 적용 시작');
    try {
      const r = await fetch('/api/admin/backbone/install', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + (this.auth.token() || ''), 'content-type': 'application/json' },
        body: '{}',
      });
      if (this.checkExpired(r.status)) { this.installing.set(false); return; }
      if (r.status === 401 || r.status === 403) {
        this.msg.set({ type: 'danger', text: '관리자 권한이 필요합니다.' });
        this.installing.set(false);
        return;
      }
      if (!r.ok) {
        this.msg.set({ type: 'danger', text: `설치 실패 (HTTP ${r.status})` });
        this.log(`✕ 실패 (HTTP ${r.status})`);
        this.installing.set(false);
        return;
      }
      this.progress.set(20);
      this.log('적용 완료 — 컴포넌트 기동 대기 중');
      this.state.set(await r.json());
      this.startWatch();
    } catch (e) {
      this.msg.set({ type: 'danger', text: '설치 요청 실패: ' + e });
      this.log('✕ 네트워크 오류: ' + e);
      this.installing.set(false);
    } finally {
      this.busy.set(false);
    }
  }

  private log(m: string): void {
    let t = ''; try { t = new Date().toLocaleTimeString(); } catch { /* noop */ }
    this.logs.update((l) => [...l, `[${t}] ${m}`]);
  }

  private startWatch(): void {
    this.stopWatch();
    this.watchTimer = setInterval(() => this.pollInstall(), 3000);
    this.pollInstall();
  }
  private stopWatch(): void { if (this.watchTimer) { clearInterval(this.watchTimer); this.watchTimer = null; } }

  private async pollInstall(): Promise<void> {
    await this.refresh(true);
    try {
      const r = await fetch('/api/admin/backbone/events', this.authGet());
      if (r.ok) {
        const items = (await r.json()).items || [];
        for (const e of items) {
          const key = e.uid || `${e.reason}:${e.message}`;
          if (this.seenEvents.has(key)) continue;
          this.seenEvents.add(key);
          this.log(`${e.object} ${e.reason}: ${e.message}`.trim());
        }
      }
    } catch { /* 이벤트 조회 실패는 무시 — 진행바는 status로 계속 갱신 */ }

    const total = this.totalCount(), ready = this.readyCount();
    const p = total > 0 ? 20 + Math.round(80 * (ready / total)) : 20;
    this.progress.set(p);

    if (total > 0 && ready === total) {
      this.log('✓ 전체 컴포넌트 Ready — 설치 완료');
      this.progress.set(100);
      this.installing.set(false);
      this.msg.set({ type: 'success', text: 'Backbone 설치가 완료됐습니다 — 전 컴포넌트 Ready.' });
      this.stopWatch();
    }
  }
}
