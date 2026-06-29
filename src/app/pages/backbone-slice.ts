import { Component, Input, Output, EventEmitter, OnChanges, signal, computed, inject, ChangeDetectionStrategy } from '@angular/core';
import { ClarityModule, ClrDatagridStringFilterInterface } from '@clr/angular';
import { dump } from 'js-yaml';
import { OsPanel } from '../os/os-panel';
import { CodeEditorComponent } from '../shared/code-editor.component';
import { AuthService } from '../core/auth.service';

/**
 * os-backbone-slice — Backbone 구성요소 우측 슬라이스 상세관리.
 * cluster-manager Pod 상세(shared/resource-detail.component.ts)와 **같은 L/F·같은 컴포넌트**:
 *   os-panel(=clr-side-panel) + 아이콘 액션바 + Field/Value clr-datagrid + YAML app-code-editor(CodeMirror) + Events clr-datagrid.
 * Backbone 고유(접근/PG 데이터)는 동일한 os-card/clr-datagrid로 같은 스타일 유지. **현재 읽기 전용**(쓰기=다음 차수).
 * 백엔드 = dupa /api/admin/backbone/{detail,yaml,pg}(admin 게이트). Secret 값은 절대 노출 안 함(키 이름만).
 */
interface BbPod { name: string; phase: string; node: string; ready: boolean; restarts: number; }
interface BbEvent { type: string; reason: string; message: string; count: number; time: string; object: string; }
interface BbAccess { secret: string; secretKeys: string[]; secretReadable: boolean; proto: string; connect: string; note: string; }
interface BbDetail {
  component: { key: string; name: string; role: string; kind: string };
  namespace: string; pods: BbPod[]; events: BbEvent[]; log: { pod: string; container: string; tail: string } | null;
  service: { dns: string; clusterIP: string; type: string; ports: { name: string; port: number; targetPort: unknown }[] } | null;
  access: BbAccess;
}
interface RawObjs { workload: { metadata?: Record<string, any> } | null; service?: unknown; pvcs?: unknown[]; }
interface PgCol { name: string; type: string; }
interface PgTable { schema: string; name: string; columns: PgCol[]; }
interface PgDb { database: string; size: number; tables: PgTable[]; error?: string; }
interface PgData { enabled: boolean; databases: PgDb[]; audit: { time: string; actor: string; action: string; target: string; result: string }[]; error?: string; }
interface RowData { columns: string[]; rows: (string | null)[][]; }
type ObjRow = Record<string, string | null>;
interface ColDef { key: string; label: string; filter: ColFilter; }
interface GiteaRepo { owner: string; name: string; fullName: string; branch: string; private: boolean; empty: boolean; updated: string; }
interface GiteaResp { reachable: boolean; repos: GiteaRepo[]; hint?: string; }
interface GTreeNode { name: string; path: string; type: 'dir' | 'file'; children: GTreeNode[]; }
interface GiteaFile { name: string; path: string; content: string; lang: 'yaml' | 'text'; }

/** Data Output 컬럼별 문자열 필터(부분일치) — clr-dg-string-filter용. clrDgField와 함께 정렬·필터·페이지네이션 활성. */
class ColFilter implements ClrDatagridStringFilterInterface<ObjRow> {
  constructor(private key: string) {}
  accepts(row: ObjRow, search: string): boolean {
    const v = row[this.key];
    return v != null && String(v).toLowerCase().includes((search || '').toLowerCase());
  }
}

const IC = {
  download: 'M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z',
  refresh: 'M17.65 6.35A8 8 0 1019 13h-2a6 6 0 11-1.76-4.24L13 11h7V4l-2.35 2.35z',
};

@Component({
  selector: 'os-backbone-slice',
  imports: [ClarityModule, OsPanel, CodeEditorComponent],
  template: `
    <os-panel [open]="true" [title]="row.name" [subtitle]="row.kind + ' · ' + row.role + ' · ns ' + namespace()" (closed)="close()">
      @if (err(); as e) {
        <clr-alert [clrAlertType]="'danger'" [clrAlertClosable]="false"><clr-alert-item><span class="alert-text">{{ e }}</span></clr-alert-item></clr-alert>
      }
      @if (loading()) { <p class="os-sub">불러오는 중…</p> }

      @if (detail(); as d) {
        <clr-tabs>
          <!-- 탭1: 일반정보 + 파트(파드) -->
          <clr-tab>
            <button clrTabLink>일반정보</button>
            <clr-tab-content>
              <div class="os-actions">
                <button class="os-iconbtn" title="YAML 다운로드" aria-label="Download YAML" (click)="download()"><svg viewBox="0 0 24 24" class="os-ic"><path [attr.d]="ic.download"/></svg></button>
                <button class="os-iconbtn" title="새로고침" aria-label="Refresh" (click)="reload()"><svg viewBox="0 0 24 24" class="os-ic"><path [attr.d]="ic.refresh"/></svg></button>
              </div>
              <clr-datagrid>
                <clr-dg-column>Field</clr-dg-column>
                <clr-dg-column>Value</clr-dg-column>
                @for (r of info(); track r.k) {
                  <clr-dg-row><clr-dg-cell><strong>{{ r.k }}</strong></clr-dg-cell><clr-dg-cell>{{ r.v }}</clr-dg-cell></clr-dg-row>
                }
              </clr-datagrid>
              <div class="os-card">
                <div class="os-card-h">접근 (Access) · Secret 값 미노출</div>
                <clr-datagrid>
                  <clr-dg-column>Field</clr-dg-column>
                  <clr-dg-column>Value</clr-dg-column>
                  @for (r of accessInfo(d); track r.k) {
                    <clr-dg-row><clr-dg-cell><strong>{{ r.k }}</strong></clr-dg-cell><clr-dg-cell>{{ r.v }}</clr-dg-cell></clr-dg-row>
                  }
                </clr-datagrid>
              </div>
              <div class="os-card">
                <div class="os-card-h">파트 · 파드 ({{ d.pods.length }})</div>
                <clr-datagrid>
                  <clr-dg-column>Name</clr-dg-column>
                  <clr-dg-column>Ready</clr-dg-column>
                  <clr-dg-column>Restarts</clr-dg-column>
                  <clr-dg-column>Node</clr-dg-column>
                  @for (po of d.pods; track po.name) {
                    <clr-dg-row>
                      <clr-dg-cell>{{ po.name }}</clr-dg-cell>
                      <clr-dg-cell>@if (po.ready) { <span class="label label-success">Ready</span> } @else { <span class="label label-warning">{{ po.phase }}</span> }</clr-dg-cell>
                      <clr-dg-cell>{{ po.restarts }}</clr-dg-cell>
                      <clr-dg-cell>{{ po.node }}</clr-dg-cell>
                    </clr-dg-row>
                  }
                  <clr-dg-placeholder>파드 없음</clr-dg-placeholder>
                </clr-datagrid>
              </div>
              <clr-alert [clrAlertType]="'info'" [clrAlertClosable]="false" [clrAlertLightweight]="true"><clr-alert-item><span class="alert-text">쓰기 액션(scale·restart·YAML 편집·삭제)은 다음 차수입니다. 현재는 읽기 전용.</span></clr-alert-item></clr-alert>
            </clr-tab-content>
          </clr-tab>

          <!-- 탭2: Contents (PostgreSQL 트리 / Gitea 코드 / RustFS) — 탭 진입 시 로드 -->
          <clr-tab>
            <button clrTabLink (click)="loadContents()">Contents</button>
            <clr-tab-content>
        @if (row.key === 'postgres') {
          <div class="os-card">
            <div class="os-card-h">데이터 · PostgreSQL (읽기 전용)</div>
            @if (pg(); as g) {
              @if (g.enabled) {
                <!-- DATABASE → TABLE → COLUMN 트리(pgAdmin 형태). 테이블 클릭 → 행 미리보기(Data Output). -->
                <div class="pg-tree">
                  <clr-tree>
                    @for (d of g.databases; track d.database) {
                      <clr-tree-node>
                        <span class="t-db">🛢 {{ d.database }}</span> <span class="t-meta">{{ fmtSize(d.size) }} · {{ d.tables.length }} tables{{ d.error ? ' · ' + d.error : '' }}</span>
                        @for (t of d.tables; track t.schema + t.name) {
                          <clr-tree-node>
                            <button class="t-tbl" type="button" (click)="preview(d.database, t.schema, t.name)" [class.t-active]="rowsTitle() === d.database + '.' + t.schema + '.' + t.name">▦ {{ t.schema }}.{{ t.name }} <span class="t-meta">({{ t.columns.length }} cols)</span></button>
                            @for (c of t.columns; track c.name) {
                              <clr-tree-node><span class="t-col">{{ c.name }}</span> <span class="t-type">{{ c.type }}</span></clr-tree-node>
                            }
                          </clr-tree-node>
                        }
                      </clr-tree-node>
                    }
                  </clr-tree>
                </div>

                @if (rowsTitle()) {
                  <div class="os-card-h" style="border-top:1px solid #e6e8ec">Data Output · <span class="mono">{{ rowsTitle() }}</span> @if (rows(); as rd) { · {{ rd.rows.length }} rows (LIMIT 50) }</div>
                  @if (rows()) {
                    <div class="pg-out">
                      <clr-datagrid>
                        @for (c of cols(); track c.key) {
                          <clr-dg-column [clrDgField]="c.key">
                            {{ c.label }}
                            <clr-dg-string-filter [clrDgStringFilter]="c.filter"></clr-dg-string-filter>
                          </clr-dg-column>
                        }
                        @for (r of objRows(); track $index) {
                          <clr-dg-row>
                            @for (c of cols(); track c.key) { <clr-dg-cell>{{ r[c.key] === null ? 'NULL' : r[c.key] }}</clr-dg-cell> }
                          </clr-dg-row>
                        }
                        <clr-dg-placeholder>행 없음</clr-dg-placeholder>
                        <clr-dg-footer>
                          <clr-dg-pagination #pgp [clrDgPageSize]="10">
                            <clr-dg-page-size [clrPageSizeOptions]="[10, 20, 50]">행/페이지</clr-dg-page-size>
                            {{ pgp.firstItem + 1 }} – {{ pgp.lastItem + 1 }} / {{ pgp.totalItems }}
                          </clr-dg-pagination>
                        </clr-dg-footer>
                      </clr-datagrid>
                    </div>
                  } @else { <p class="os-sub" style="padding:8px 14px">{{ rowsErr() || '불러오는 중…' }}</p> }
                }

                @if (g.audit.length) {
                  <div class="os-card-h" style="border-top:1px solid #e6e8ec">audit_log · console DB (최근 {{ g.audit.length }})</div>
                  <clr-datagrid>
                    <clr-dg-column>Time</clr-dg-column>
                    <clr-dg-column>Actor</clr-dg-column>
                    <clr-dg-column>Action</clr-dg-column>
                    <clr-dg-column>Result</clr-dg-column>
                    @for (a of g.audit; track $index) {
                      <clr-dg-row>
                        <clr-dg-cell>{{ a.time }}</clr-dg-cell><clr-dg-cell>{{ a.actor }}</clr-dg-cell>
                        <clr-dg-cell>{{ a.action }} {{ a.target }}</clr-dg-cell>
                        <clr-dg-cell><span class="label" [class.label-success]="a.result === 'accepted'" [class.label-warning]="a.result === 'warning'">{{ a.result }}</span></clr-dg-cell>
                      </clr-dg-row>
                    }
                  </clr-datagrid>
                }
              } @else { <p class="os-sub" style="padding:8px 14px">PostgreSQL 미연결(Backbone 미설치 또는 폴백). {{ g.error || '' }}</p> }
            } @else { <p class="os-sub" style="padding:8px 14px">불러오는 중…</p> }
          </div>
        } @else if (row.key === 'rustfs') {
          <div class="os-card"><div class="os-card-h">데이터 · RustFS (S3)</div><p class="os-sub" style="padding:8px 14px">S3 버킷/오브젝트 브라우즈는 다음 차수(storage.js · @aws-sdk/client-s3 또는 SigV4).</p></div>
        } @else if (row.key === 'gitea') {
          <div class="os-card">
            <div class="os-card-h">데이터 · Gitea (Git 코드 뷰)</div>
            @if (giteaResp(); as g) {
              @if (!g.reachable) { <p class="os-sub" style="padding:8px 14px">Gitea 접근 불가: {{ g.hint }}</p> }
              @else if (!g.repos.length) { <p class="os-sub" style="padding:8px 14px">공개 레포 없음. <code>tools/local-dev/provision-gitea.sh</code> 로 관리자+샘플 레포를 시드하세요.</p> }
              @else {
                <div class="g-repos">
                  @for (rp of g.repos; track rp.fullName) {
                    <button class="g-repo" type="button" (click)="selectRepo(rp)" [class.g-active]="giteaRepo()?.fullName === rp.fullName">📦 {{ rp.fullName }} <span class="t-meta">· {{ rp.branch }}{{ rp.private ? ' · private' : '' }}</span></button>
                  }
                </div>
                @if (giteaRepo()) {
                  <div class="g-split">
                    <div class="g-tree">
                      @if (giteaTreeHint()) { <p class="os-sub" style="padding:4px 8px">{{ giteaTreeHint() }}</p> }
                      <clr-tree>
                        <clr-tree-node *clrRecursiveFor="let n of giteaTreeRoots(); getChildren: getChildren">
                          @if (n.type === 'dir') { <span class="g-dir">📁 {{ n.name }}</span> }
                          @else { <button class="g-file" type="button" (click)="openFile(n.path)" [class.g-active]="giteaFile()?.path === n.path">📄 {{ n.name }}</button> }
                        </clr-tree-node>
                      </clr-tree>
                    </div>
                    <div class="g-code">
                      @if (giteaFile(); as f) {
                        <div class="os-card-h"><span class="mono">{{ f.path }}</span></div>
                        <app-code-editor [value]="f.content" [language]="f.lang" [readOnly]="true" height="380px"></app-code-editor>
                      } @else { <p class="os-sub" style="padding:8px 14px">파일을 선택하세요.</p> }
                    </div>
                  </div>
                }
              }
            } @else { <p class="os-sub" style="padding:8px 14px">불러오는 중…</p> }
          </div>
        }
            </clr-tab-content>
          </clr-tab>

          <!-- 탭3: YAML -->
          <clr-tab>
            <button clrTabLink>YAML</button>
            <clr-tab-content>
              <app-code-editor [value]="yamlText()" language="yaml" [readOnly]="true" height="460px"></app-code-editor>
            </clr-tab-content>
          </clr-tab>

          <!-- 탭4: 이벤트 (+ 로그) -->
          <clr-tab>
            <button clrTabLink>이벤트</button>
            <clr-tab-content>
              <clr-datagrid>
                <clr-dg-column>Type</clr-dg-column>
                <clr-dg-column>Reason</clr-dg-column>
                <clr-dg-column>Message</clr-dg-column>
                <clr-dg-column>Age</clr-dg-column>
                @for (e of d.events; track $index) {
                  <clr-dg-row>
                    <clr-dg-cell><span class="label" [class.label-warning]="e.type === 'Warning'" [class.label-info]="e.type !== 'Warning'">{{ e.type }}</span></clr-dg-cell>
                    <clr-dg-cell>{{ e.reason }}</clr-dg-cell>
                    <clr-dg-cell>{{ e.message }}</clr-dg-cell>
                    <clr-dg-cell>{{ age(e.time) }}</clr-dg-cell>
                  </clr-dg-row>
                }
                <clr-dg-placeholder>No events.</clr-dg-placeholder>
              </clr-datagrid>
              @if (d.log; as lg) {
                <div class="os-card">
                  <div class="os-card-h">Logs · {{ lg.pod }} / {{ lg.container }}</div>
                  <app-code-editor [value]="lg.tail" language="log" [dark]="true" height="300px"></app-code-editor>
                </div>
              }
            </clr-tab-content>
          </clr-tab>
        </clr-tabs>
      }
    </os-panel>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
      .os-sub { color: var(--os-ink-muted, #525252); font-size: 0.72rem; margin: 0.2rem 0; }
      .mono { font-family: var(--os-font-mono, monospace); font-size: 0.7rem; }
      .pg-tree { max-height: 22rem; overflow: auto; padding: 0.3rem 0.6rem; }
      .pg-tree .t-db { font-weight: 600; color: var(--os-ink, #161616); font-size: 0.74rem; }
      .pg-tree .t-meta { color: var(--os-ink-muted, #525252); font-size: 0.62rem; }
      .pg-tree .t-tbl { border: 0; background: none; padding: 0; cursor: pointer; color: var(--os-ink, #161616); font-size: 0.72rem; font-family: var(--os-font-mono, monospace); }
      .pg-tree .t-tbl:hover { color: var(--os-accent, #4c6fff); text-decoration: underline; }
      .pg-tree .t-tbl.t-active { color: var(--os-accent, #4c6fff); font-weight: 700; }
      .pg-tree .t-col { font-family: var(--os-font-mono, monospace); font-size: 0.7rem; color: var(--os-ink, #161616); }
      .pg-tree .t-type { font-size: 0.62rem; color: #0b7285; margin-left: 0.4rem; }
      .pg-out { max-height: 24rem; overflow: auto; }
      .pg-out clr-dg-cell { font-family: var(--os-font-mono, monospace); font-size: 0.64rem; }
      .g-repos { display: flex; flex-wrap: wrap; gap: 0.3rem; padding: 0.5rem 0.6rem; border-bottom: 1px solid #e6e8ec; }
      .g-repo { border: 1px solid #d9dde3; background: #fff; border-radius: 4px; padding: 0.2rem 0.5rem; cursor: pointer; font-size: 0.68rem; color: var(--os-ink, #161616); }
      .g-repo:hover { border-color: var(--os-accent, #4c6fff); }
      .g-repo.g-active { border-color: var(--os-accent, #4c6fff); background: var(--os-accent-subtle, rgba(76,111,255,0.12)); font-weight: 600; }
      .g-split { display: flex; gap: 0; align-items: stretch; }
      .g-tree { flex: 0 0 40%; max-width: 40%; max-height: 26rem; overflow: auto; border-right: 1px solid #e6e8ec; padding: 0.3rem 0.4rem; }
      .g-code { flex: 1 1 60%; min-width: 0; }
      .g-dir { font-size: 0.72rem; color: var(--os-ink-muted, #525252); }
      .g-file { border: 0; background: none; padding: 0; cursor: pointer; color: var(--os-ink, #161616); font-size: 0.72rem; font-family: var(--os-font-mono, monospace); }
      .g-file:hover { color: var(--os-accent, #4c6fff); text-decoration: underline; }
      .g-file.g-active { color: var(--os-accent, #4c6fff); font-weight: 700; }
    `,
  ],
})
export class BackboneSlice implements OnChanges {
  @Input({ required: true }) row!: { key: string; name: string; role: string; kind: string };
  @Output() closed = new EventEmitter<void>();

  private auth = inject(AuthService);
  readonly ic = IC;
  readonly detail = signal<BbDetail | null>(null);
  readonly raw = signal<RawObjs | null>(null);
  readonly pg = signal<PgData | null>(null);
  readonly rows = signal<RowData | null>(null);
  readonly rowsTitle = signal<string>('');
  readonly rowsErr = signal<string>('');
  // Gitea Git 코드 뷰
  readonly giteaResp = signal<GiteaResp | null>(null);
  readonly giteaRepo = signal<GiteaRepo | null>(null);
  readonly giteaTreeRoots = signal<GTreeNode[]>([]);
  readonly giteaTreeHint = signal<string>('');
  readonly giteaFile = signal<GiteaFile | null>(null);
  readonly getChildren = (n: GTreeNode): GTreeNode[] => n.children;
  private loadedContents = false;
  readonly loading = signal(true);
  readonly err = signal<string>('');
  readonly yamlText = computed(() => this.toYaml(this.raw()));
  // Data Output을 객체행으로 변환(컬럼키 c0,c1…) → clrDgField 정렬/필터/페이지네이션. 컬럼명 충돌·특수문자 회피.
  readonly cols = computed<ColDef[]>(() => (this.rows()?.columns || []).map((label, i) => ({ key: 'c' + i, label, filter: new ColFilter('c' + i) })));
  readonly objRows = computed<ObjRow[]>(() => (this.rows()?.rows || []).map((r) => { const o: ObjRow = {}; r.forEach((v, i) => (o['c' + i] = v)); return o; }));

  readonly namespace = () => this.detail()?.namespace || 'opensphere-backbone';

  private authGet(): RequestInit {
    return { cache: 'no-store', headers: { authorization: 'Bearer ' + (this.auth.token() || '') } };
  }

  ngOnChanges(): void { this.reload(); }

  async reload(): Promise<void> {
    this.loading.set(true); this.err.set(''); this.loadedContents = false;
    this.detail.set(null); this.raw.set(null); this.pg.set(null);
    this.rows.set(null); this.rowsTitle.set(''); this.rowsErr.set('');
    this.giteaResp.set(null); this.giteaRepo.set(null); this.giteaTreeRoots.set([]); this.giteaFile.set(null); this.giteaTreeHint.set('');
    const k = encodeURIComponent(this.row.key);
    try {
      const [dr, yr] = await Promise.all([
        fetch('/api/admin/backbone/detail?component=' + k, this.authGet()),
        fetch('/api/admin/backbone/yaml?component=' + k, this.authGet()),
      ]);
      if (dr.status === 401 || dr.status === 403) { this.err.set('관리자 권한이 필요합니다 (opensphere-console-admins).'); return; }
      if (!dr.ok) { this.err.set(`상세 조회 실패 (HTTP ${dr.status})`); return; }
      this.detail.set(await dr.json());
      if (yr.ok) this.raw.set(await yr.json());
    } catch (e) { this.err.set('상세 조회 실패: ' + e); } finally { this.loading.set(false); }

  }

  /** Contents 탭 진입 시 지연 로드(PostgreSQL pg / Gitea repos). 1회만. */
  async loadContents(): Promise<void> {
    if (this.loadedContents) return;
    this.loadedContents = true;
    if (this.row.key === 'postgres') {
      try { const r = await fetch('/api/admin/backbone/pg', this.authGet()); if (r.ok) this.pg.set(await r.json()); } catch { /* pg 실패 무시 */ }
    } else if (this.row.key === 'gitea') {
      await this.loadGitea();
    }
  }

  // ── Gitea Git 코드 뷰 ──
  private async loadGitea(): Promise<void> {
    try {
      const r = await fetch('/api/admin/backbone/gitea', this.authGet());
      if (!r.ok) return;
      const g: GiteaResp = await r.json();
      this.giteaResp.set(g);
      if (g.repos?.length) await this.selectRepo(g.repos[0]);
    } catch { /* gitea 실패 무시 */ }
  }
  async selectRepo(repo: GiteaRepo): Promise<void> {
    this.giteaRepo.set(repo); this.giteaTreeRoots.set([]); this.giteaFile.set(null); this.giteaTreeHint.set('');
    const q = `owner=${encodeURIComponent(repo.owner)}&repo=${encodeURIComponent(repo.name)}&ref=${encodeURIComponent(repo.branch)}`;
    try {
      const r = await fetch('/api/admin/backbone/gitea/tree?' + q, this.authGet());
      if (!r.ok) return;
      const t = await r.json();
      this.giteaTreeRoots.set(this.buildTree(t.tree || []));
      if (t.hint) this.giteaTreeHint.set(t.hint);
    } catch { /* tree 실패 무시 */ }
  }
  async openFile(path: string): Promise<void> {
    const repo = this.giteaRepo(); if (!repo) return;
    this.giteaFile.set({ name: path.split('/').pop() || path, path, content: '불러오는 중…', lang: 'text' });
    const q = `owner=${encodeURIComponent(repo.owner)}&repo=${encodeURIComponent(repo.name)}&ref=${encodeURIComponent(repo.branch)}&path=${encodeURIComponent(path)}`;
    try {
      const r = await fetch('/api/admin/backbone/gitea/file?' + q, this.authGet());
      if (!r.ok) { this.giteaFile.set({ name: path, path, content: `조회 실패 (HTTP ${r.status})`, lang: 'text' }); return; }
      const f = await r.json();
      this.giteaFile.set({ name: f.name || path, path, content: f.content || '', lang: this.fileLang(path) });
    } catch (e) { this.giteaFile.set({ name: path, path, content: '조회 실패: ' + e, lang: 'text' }); }
  }
  private fileLang(path: string): 'yaml' | 'text' { return /\.ya?ml$/i.test(path) ? 'yaml' : 'text'; }
  /** flat path 목록(git/trees recursive) → 중첩 트리. dir 우선·알파벳 정렬. */
  private buildTree(flat: { path: string; type: string }[]): GTreeNode[] {
    const root: GTreeNode = { name: '', path: '', type: 'dir', children: [] };
    for (const item of flat) {
      const parts = item.path.split('/');
      let cur = root;
      for (let i = 0; i < parts.length; i++) {
        const isLast = i === parts.length - 1;
        const pp = parts.slice(0, i + 1).join('/');
        let child = cur.children.find((c) => c.name === parts[i]);
        if (!child) { child = { name: parts[i], path: pp, type: isLast && item.type === 'file' ? 'file' : 'dir', children: [] }; cur.children.push(child); }
        cur = child;
      }
    }
    const sort = (n: GTreeNode): void => {
      n.children.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
      n.children.forEach(sort);
    };
    sort(root);
    return root.children;
  }

  /** Field/Value — raw 워크로드 metadata(resource-detail info()와 동일 항목). */
  info(): { k: string; v: string }[] {
    const m = this.raw()?.workload?.metadata || {};
    const rows = [
      { k: 'Name', v: m['name'] },
      { k: 'Namespace', v: m['namespace'] },
      { k: 'Created', v: m['creationTimestamp'] },
      { k: 'UID', v: m['uid'] },
      { k: 'Resource Version', v: m['resourceVersion'] },
      { k: 'Labels', v: Object.entries(m['labels'] || {}).map(([a, b]) => `${a}=${b}`).join(', ') },
      { k: 'Annotations', v: Object.keys(m['annotations'] || {}).join(', ') },
    ];
    return rows.filter((r) => r.v != null && r.v !== '') as { k: string; v: string }[];
  }

  accessInfo(d: BbDetail): { k: string; v: string }[] {
    const rows: { k: string; v: string }[] = [];
    if (d.service) {
      rows.push({ k: 'DNS', v: d.service.dns });
      rows.push({ k: 'ClusterIP', v: `${d.service.clusterIP} · ${d.service.type}` });
      rows.push({ k: '포트', v: (d.service.ports || []).map((p) => `${p.name}:${p.port}→${p.targetPort}`).join(', ') });
    }
    rows.push({ k: '프로토콜', v: d.access.proto });
    rows.push({ k: 'Secret', v: d.access.secret || '—' });
    rows.push({ k: '키(값 미노출)', v: d.access.secretReadable ? d.access.secretKeys.map((x) => `${x}=••••`).join(', ') : '읽기 권한 없음/미존재' });
    rows.push({ k: '연결', v: d.access.connect });
    if (d.access.note) rows.push({ k: '비고', v: d.access.note });
    return rows.filter((r) => r.v != null && r.v !== '');
  }

  private toYaml(raw: RawObjs | null): string {
    if (!raw) return '';
    const docs: string[] = [];
    if (raw.workload) docs.push(dump(raw.workload));
    if (raw.service) docs.push(dump(raw.service));
    for (const v of raw.pvcs || []) docs.push(dump(v));
    return docs.join('---\n');
  }

  download(): void {
    const blob = new Blob([this.yamlText()], { type: 'text/yaml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${this.row.name}.yaml`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  fmtSize(bytes: number): string {
    if (!bytes) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let n = bytes;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
  }
  /** 테이블 클릭 → 행 미리보기(SELECT * LIMIT 50). 식별자 검증은 백엔드. */
  async preview(database: string, schema: string, table: string): Promise<void> {
    this.rowsTitle.set(`${database}.${schema}.${table}`);
    this.rows.set(null); this.rowsErr.set('');
    const q = `database=${encodeURIComponent(database)}&schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(table)}`;
    try {
      const r = await fetch('/api/admin/backbone/pg/rows?' + q, this.authGet());
      if (!r.ok) { this.rowsErr.set(`조회 실패 (HTTP ${r.status})`); return; }
      this.rows.set(await r.json());
    } catch (e) { this.rowsErr.set('조회 실패: ' + e); }
  }

  close(): void { this.closed.emit(); }
  age(ts: string): string {
    if (!ts) return '—';
    const ms = Date.now() - new Date(ts).getTime();
    const d = Math.floor(ms / 86400000); if (d > 0) return d + 'd';
    const h = Math.floor(ms / 3600000); if (h > 0) return h + 'h';
    const m = Math.floor(ms / 60000); return m > 0 ? m + 'm' : '<1m';
  }
}
