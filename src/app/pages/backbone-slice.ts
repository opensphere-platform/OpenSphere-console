import { Component, Input, Output, EventEmitter, OnChanges, signal, computed, inject, ChangeDetectionStrategy } from '@angular/core';
import { ClarityModule, ClrDatagridStringFilterInterface } from '@clr/angular';
import { dump } from 'js-yaml';
import { OsPanel } from '../os/os-panel';
import { CodeEditorComponent } from '../shared/code-editor.component';
import { AuthService } from '../core/auth.service';
import { CarbonIcon } from '../os/carbon-icon';
import Db2Database16 from '@carbon/icons/es/db2--database/16';
import Code16 from '@carbon/icons/es/code/16';
import Cube16 from '@carbon/icons/es/cube/16';

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
interface PgFunc { schema: string; name: string; args: string; rettype: string; lang: string; kind: string; }
interface PgExt { name: string; version: string; }
interface PgDb { database: string; size: number; tables: PgTable[]; functions?: PgFunc[]; extensions?: PgExt[]; error?: string; }
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

/** 구성요소별 상품 로고(images.opl.io.kr 갤러리, Statically CDN). */
const LOGO_CDN = 'https://cdn.statically.io/gh/openplatform-labs/images@main/logos/';
const LOGOS: Record<string, string> = {
  postgres: LOGO_CDN + 'postgresql-icon.svg',
  rustfs: LOGO_CDN + 'rustfs.svg',
  gitea: LOGO_CDN + 'gitea.svg',
};

@Component({
  selector: 'os-backbone-slice',
  imports: [ClarityModule, OsPanel, CodeEditorComponent, CarbonIcon],
  template: `
    <os-panel [open]="true" [title]="row.name" [subtitle]="row.kind + ' · ' + row.role + ' · ns ' + namespace()" [logoSrc]="logoSrc()" (closed)="close()">
      @if (authExpired()) {
        <clr-alert [clrAlertType]="'warning'" [clrAlertClosable]="false">
          <clr-alert-item><span class="alert-text">세션이 만료됐습니다(15분) — 다시 로그인해주세요. <a (click)="reAuth()">다시 로그인 →</a></span></clr-alert-item>
        </clr-alert>
      } @else if (err(); as e) {
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
                <!-- 벡터(pgvector) 지원 상태 — 설치 확장(pg_extension)에서 'vector' 자동 도출. -->
                @if (vectorVersion(); as vv) {
                  <div class="pg-cap pg-cap-ok">🧮 벡터(pgvector) 지원 · v{{ vv }} — vector/halfvec/sparsevec 타입 · HNSW·IVFFlat 인덱스 · L2/Cosine/IP 거리연산</div>
                } @else {
                  <div class="pg-cap pg-cap-no">벡터 미지원 — pgvector 확장 없음 (CREATE EXTENSION vector 필요)</div>
                }
                <!-- DATABASE → TABLE → COLUMN 트리(pgAdmin 형태). 테이블 클릭 → 행 미리보기(Data Output). -->
                <div class="pg-tree">
                  <clr-tree>
                    @for (d of g.databases; track d.database) {
                      <clr-tree-node>
                        <span class="t-db"><os-cicon [icon]="dbIcon" [size]="16"/> {{ d.database }}</span> <span class="t-meta">{{ fmtSize(d.size) }} · {{ d.tables.length }} tables{{ d.error ? ' · ' + d.error : '' }}</span>
                        @for (t of d.tables; track t.schema + t.name) {
                          <clr-tree-node>
                            <button class="t-tbl" type="button" (click)="preview(d.database, t.schema, t.name)" [class.t-active]="rowsTitle() === d.database + '.' + t.schema + '.' + t.name">▦ {{ t.schema }}.{{ t.name }} <span class="t-meta">({{ t.columns.length }} cols)</span></button>
                            @for (c of t.columns; track c.name) {
                              <clr-tree-node><span class="t-col">{{ c.name }}</span> <span class="t-type">{{ c.type }}</span></clr-tree-node>
                            }
                          </clr-tree-node>
                        }
                        @if (d.functions?.length) {
                          <clr-tree-node>
                            <span class="t-grp"><os-cicon [icon]="fnIcon" [size]="16"/> Functions <span class="t-meta">({{ d.functions.length }})</span></span>
                            @for (fn of d.functions; track fn.schema + fn.name + fn.args) {
                              <clr-tree-node>
                                <span class="t-fn">{{ fn.kind === 'proc' ? '⚙' : 'ƒ' }} {{ fn.schema }}.{{ fn.name }}({{ fn.args }})</span> <span class="t-type">→ {{ fn.rettype }} · {{ fn.lang }}</span>
                                <button class="t-act" type="button" (click)="editFunction(d.database, fn)">편집</button>
                                <button class="t-act t-del" type="button" (click)="deleteFunction(d.database, fn)">삭제</button>
                              </clr-tree-node>
                            }
                          </clr-tree-node>
                        }
                        @if (d.extensions?.length) {
                          <clr-tree-node>
                            <span class="t-grp"><os-cicon [icon]="extIcon" [size]="16"/> Extensions <span class="t-meta">({{ d.extensions.length }})</span></span>
                            @for (ex of d.extensions; track ex.name) {
                              <clr-tree-node><span class="t-ext">{{ ex.name }}</span> <span class="t-type">{{ ex.version }}</span></clr-tree-node>
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
                } @else {
                  <!-- 테이블 미선택 시 — 동일 위치에 빈 Data Output 그리드 배치(레이아웃 안정·일관 L/F). -->
                  <div class="os-card-h" style="border-top:1px solid #e6e8ec">Data Output</div>
                  <div class="pg-out">
                    <clr-datagrid>
                      <clr-dg-placeholder>왼쪽 트리에서 테이블을 선택하면 행이 표시됩니다 (SELECT * LIMIT 50).</clr-dg-placeholder>
                    </clr-datagrid>
                  </div>
                }
                <!-- 함수 추가(가이드 폼) — admin 게이트, backbone PG 첫 DDL 쓰기. 생성 후 트리 갱신. -->
                <div class="os-card-h" style="border-top:1px solid #e6e8ec"><button class="t-tbl" type="button" (click)="fnOpen.set(!fnOpen())">{{ fnOpen() ? '−' : '+' }} 함수 추가</button></div>
                @if (fnOpen()) {
                  <div class="fn-form">
                    @if (fnMsg(); as m) { <clr-alert [clrAlertType]="m.type" [clrAlertClosable]="true" (clrAlertClosedChange)="fnMsg.set(null)"><clr-alert-item><span class="alert-text">{{ m.text }}</span></clr-alert-item></clr-alert> }
                    <div class="fn-row">
                      <label>Database<select [value]="fnDb()" (change)="fnDb.set($any($event.target).value)">@for (d of g.databases; track d.database) { <option [value]="d.database">{{ d.database }}</option> }</select></label>
                      <label>Schema<input [value]="fnSchema()" (input)="fnSchema.set($any($event.target).value)" placeholder="public"></label>
                      <label>Name<input [value]="fnName()" (input)="fnName.set($any($event.target).value)" placeholder="my_func"></label>
                    </div>
                    <div class="fn-row">
                      <label>Args<input [value]="fnArgs()" (input)="fnArgs.set($any($event.target).value)" placeholder="a integer, b text"></label>
                      <label>Returns<input [value]="fnReturns()" (input)="fnReturns.set($any($event.target).value)" placeholder="integer"></label>
                      <label>Language<select [value]="fnLang()" (change)="fnLang.set($any($event.target).value)"><option value="plpgsql">plpgsql</option><option value="sql">sql</option></select></label>
                    </div>
                    <label class="fn-body">Body<textarea [value]="fnBody()" (input)="fnBody.set($any($event.target).value)" rows="6" placeholder="BEGIN RETURN a + length(b); END;"></textarea></label>
                    <div class="fn-actions">
                      <label class="fn-chk"><input type="checkbox" [checked]="fnReplace()" (change)="fnReplace.set($any($event.target).checked)"> OR REPLACE</label>
                      <button class="btn btn-sm btn-primary" [disabled]="fnBusy()" (click)="addFunction()">함수 생성</button>
                      @if (fnBusy()) { <span class="spinner spinner-inline"></span> }
                    </div>
                    <p class="os-sub">⚠️ admin 전용·감사 기록. Body는 PL/pgSQL·SQL 코드(달러 인용). 생성 후 Functions 트리에 반영됩니다.</p>
                  </div>
                }
                <!-- audit_log는 우측 '감사로그' 별도 탭으로 분리(아래 탭3). -->
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

          <!-- 탭3: 감사로그 (console DB audit_log) — Contents 우측 별도 탭, postgres 전용. 진입 시 로드. -->
          @if (row.key === 'postgres') {
          <clr-tab>
            <button clrTabLink (click)="loadContents()">감사로그</button>
            <clr-tab-content>
              <div class="os-card">
                <div class="os-card-h">audit_log · console DB (최근 {{ pg()?.audit?.length || 0 }})</div>
                @if (pg(); as g) {
                  @if (g.enabled) {
                    @if (g.audit.length) {
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
                    } @else { <p class="os-sub" style="padding:8px 14px">감사 레코드 없음.</p> }
                  } @else { <p class="os-sub" style="padding:8px 14px">PostgreSQL 미연결(Backbone 미설치 또는 폴백). {{ g.error || '' }}</p> }
                } @else { <p class="os-sub" style="padding:8px 14px">불러오는 중…</p> }
              </div>
            </clr-tab-content>
          </clr-tab>
          }

          <!-- 탭4: YAML -->
          <clr-tab>
            <button clrTabLink>YAML</button>
            <clr-tab-content>
              <app-code-editor [value]="yamlText()" language="yaml" [readOnly]="true" height="460px"></app-code-editor>
            </clr-tab-content>
          </clr-tab>

          <!-- 탭5: 이벤트 (+ 로그) -->
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
      .pg-tree .t-db { display: inline-flex; align-items: center; gap: 0.3rem; font-weight: 600; color: var(--os-ink, #161616); font-size: 0.74rem; }
      .pg-tree .t-meta { color: var(--os-ink-muted, #525252); font-size: 0.62rem; }
      .pg-tree .t-tbl { border: 0; background: none; padding: 0; cursor: pointer; color: var(--os-ink, #161616); font-size: 0.72rem; font-family: var(--os-font-mono, monospace); }
      .pg-tree .t-tbl:hover { color: var(--os-accent, #4c6fff); text-decoration: underline; }
      .pg-tree .t-tbl.t-active { color: var(--os-accent, #4c6fff); font-weight: 700; }
      .pg-tree .t-col { font-family: var(--os-font-mono, monospace); font-size: 0.7rem; color: var(--os-ink, #161616); }
      .pg-tree .t-type { font-size: 0.62rem; color: #0b7285; margin-left: 0.4rem; }
      .pg-tree .t-grp { display: inline-flex; align-items: center; gap: 0.3rem; font-weight: 600; font-size: 0.7rem; color: var(--os-ink-muted, #525252); }
      .pg-tree .t-fn { font-family: var(--os-font-mono, monospace); font-size: 0.7rem; color: var(--os-ink, #161616); }
      .pg-tree .t-act { border: 1px solid #d9dde3; background: #fff; border-radius: 3px; margin-left: 0.4rem; padding: 0 0.3rem; cursor: pointer; font-size: 0.58rem; color: var(--os-ink-muted, #525252); }
      .pg-tree .t-act:hover { border-color: var(--os-accent, #4c6fff); color: var(--os-accent, #4c6fff); }
      .pg-tree .t-del:hover { border-color: #c21d2c; color: #c21d2c; }
      .pg-tree .t-ext { font-family: var(--os-font-mono, monospace); font-size: 0.7rem; color: var(--os-ink, #161616); }
      .pg-cap { margin: 0.4rem 0.6rem; padding: 0.4rem 0.6rem; border-radius: 4px; font-size: 0.68rem; }
      .pg-cap-ok { background: rgba(36, 161, 72, 0.12); color: #0e6027; border: 1px solid rgba(36, 161, 72, 0.3); }
      .pg-cap-no { background: rgba(0, 0, 0, 0.04); color: var(--os-ink-muted, #525252); border: 1px solid #e6e8ec; }
      .fn-form { padding: 0.5rem 0.7rem; display: flex; flex-direction: column; gap: 0.5rem; }
      .fn-row { display: flex; gap: 0.6rem; flex-wrap: wrap; }
      .fn-form label { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.64rem; color: var(--os-ink-muted, #525252); flex: 1 1 8rem; }
      .fn-form input, .fn-form select, .fn-form textarea { font-size: 0.7rem; padding: 0.25rem 0.4rem; border: 1px solid #d9dde3; border-radius: 3px; font-family: var(--os-font-mono, monospace); }
      .fn-body { width: 100%; }
      .fn-body textarea { width: 100%; resize: vertical; }
      .fn-actions { display: flex; align-items: center; gap: 0.7rem; }
      .fn-chk { flex-direction: row !important; align-items: center; gap: 0.3rem; }
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
  readonly dbIcon = Db2Database16;

  logoSrc(): string {
    return LOGOS[this.row.key] || '';
  }
  readonly fnIcon = Code16;
  readonly extIcon = Cube16;
  readonly detail = signal<BbDetail | null>(null);
  readonly raw = signal<RawObjs | null>(null);
  readonly pg = signal<PgData | null>(null);
  readonly rows = signal<RowData | null>(null);
  readonly rowsTitle = signal<string>('');
  readonly rowsErr = signal<string>('');
  // 함수 추가(가이드 폼) 상태
  readonly fnOpen = signal(false);
  readonly fnDb = signal('');
  readonly fnSchema = signal('public');
  readonly fnName = signal('');
  readonly fnArgs = signal('');
  readonly fnReturns = signal('integer');
  readonly fnLang = signal('plpgsql');
  readonly fnBody = signal('');
  readonly fnReplace = signal(false);
  readonly fnBusy = signal(false);
  readonly fnMsg = signal<{ type: 'success' | 'danger'; text: string } | null>(null);
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
    this.loading.set(true); this.err.set(''); this.authExpired.set(false); this.loadedContents = false;
    this.detail.set(null); this.raw.set(null); this.pg.set(null);
    this.rows.set(null); this.rowsTitle.set(''); this.rowsErr.set('');
    this.giteaResp.set(null); this.giteaRepo.set(null); this.giteaTreeRoots.set([]); this.giteaFile.set(null); this.giteaTreeHint.set('');
    const k = encodeURIComponent(this.row.key);
    try {
      const [dr, yr] = await Promise.all([
        fetch('/api/admin/backbone/detail?component=' + k, this.authGet()),
        fetch('/api/admin/backbone/yaml?component=' + k, this.authGet()),
      ]);
      if (this.checkExpired(dr.status)) return;
      if (dr.status === 401 || dr.status === 403) { this.err.set('관리자 권한이 필요합니다 (opensphere-console-admins).'); return; }
      if (!dr.ok) { this.err.set(`상세 조회 실패 (HTTP ${dr.status})`); return; }
      this.detail.set(await dr.json());
      if (yr.ok) this.raw.set(await yr.json());
    } catch (e) { this.err.set('상세 조회 실패: ' + e); } finally { this.loading.set(false); }

  }

  /** id_token 만료(15분, refresh_token/iframe 갱신 모두 불가 — Kanidm 제약) 감지 → 재로그인 안내.
   *  실제 권한 부족(403) 케이스와 구분해, 만료일 때만 이 배너를 띄운다. */
  readonly authExpired = signal(false);
  private checkExpired(status: number): boolean {
    if (status === 401 && this.auth.isTokenExpired()) { this.authExpired.set(true); return true; }
    return false;
  }
  reAuth(): void { void this.auth.reAuthenticate(); }

  /** Contents 탭 진입 시 지연 로드(PostgreSQL pg / Gitea repos). 1회만. */
  async loadContents(): Promise<void> {
    if (this.loadedContents) return;
    this.loadedContents = true;
    if (this.row.key === 'postgres') {
      try {
        const r = await fetch('/api/admin/backbone/pg', this.authGet());
        if (this.checkExpired(r.status)) return;
        if (r.ok) { this.pg.set(await r.json()); if (!this.fnDb()) this.fnDb.set(this.pg()?.databases?.[0]?.database || ''); }
      } catch { /* pg 실패 무시 */ }
    } else if (this.row.key === 'gitea') {
      await this.loadGitea();
    }
  }

  // ── Gitea Git 코드 뷰 ──
  private async loadGitea(): Promise<void> {
    try {
      const r = await fetch('/api/admin/backbone/gitea', this.authGet());
      if (this.checkExpired(r.status)) return;
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
      if (this.checkExpired(r.status)) return;
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
      if (this.checkExpired(r.status)) { this.giteaFile.set(null); return; }
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

  /** Field/Value — raw 워크로드 metadata + 컨테이너 이미지(버전). */
  info(): { k: string; v: string }[] {
    const wl = this.raw()?.workload as { metadata?: Record<string, any>; spec?: any } | null;
    const m = wl?.metadata || {};
    const image = wl?.spec?.template?.spec?.containers?.[0]?.image || '';
    const rows = [
      { k: 'Name', v: m['name'] },
      { k: 'Namespace', v: m['namespace'] },
      { k: 'Image · 버전', v: image },
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

  /** 함수 생성(가이드 폼) — POST /pg/function. admin 게이트·감사. 성공 시 트리 갱신. */
  async addFunction(): Promise<void> {
    if (this.fnBusy()) return;
    const database = this.fnDb() || this.pg()?.databases?.[0]?.database || '';
    if (!database || !this.fnName().trim()) { this.fnMsg.set({ type: 'danger', text: 'Database와 Name은 필수입니다.' }); return; }
    this.fnBusy.set(true); this.fnMsg.set(null);
    try {
      const r = await fetch('/api/admin/backbone/pg/function', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + (this.auth.token() || ''), 'content-type': 'application/json' },
        body: JSON.stringify({ database, schema: this.fnSchema() || 'public', name: this.fnName(), args: this.fnArgs(), returns: this.fnReturns(), language: this.fnLang(), body: this.fnBody(), replace: this.fnReplace() }),
      });
      if (this.checkExpired(r.status)) return;
      if (r.status === 401 || r.status === 403) { this.fnMsg.set({ type: 'danger', text: '관리자 권한이 필요합니다.' }); return; }
      const j = await r.json().catch(() => ({} as { error?: string }));
      if (!r.ok) { this.fnMsg.set({ type: 'danger', text: j.error || `생성 실패 (HTTP ${r.status})` }); return; }
      this.fnMsg.set({ type: 'success', text: `함수 ${this.fnSchema() || 'public'}.${this.fnName()} 생성됨.` });
      this.fnName.set(''); this.fnArgs.set(''); this.fnBody.set('');
      this.loadedContents = false; await this.loadContents(); // Functions 트리 갱신
    } catch (e) { this.fnMsg.set({ type: 'danger', text: '요청 실패: ' + e }); }
    finally { this.fnBusy.set(false); }
  }

  /** 함수 편집 — 소스 로드 후 폼에 채우고 OR REPLACE 모드로 전환(수정=CREATE OR REPLACE). */
  async editFunction(database: string, fn: PgFunc): Promise<void> {
    this.fnMsg.set(null); this.fnOpen.set(true);
    const enc = encodeURIComponent;
    try {
      const q = `database=${enc(database)}&schema=${enc(fn.schema)}&name=${enc(fn.name)}&args=${enc(fn.args)}`;
      const r = await fetch('/api/admin/backbone/pg/function/source?' + q, this.authGet());
      if (this.checkExpired(r.status)) return;
      if (r.status === 401 || r.status === 403) { this.fnMsg.set({ type: 'danger', text: '관리자 권한이 필요합니다.' }); return; }
      const s = await r.json().catch(() => ({} as { args?: string; returns?: string; language?: string; body?: string; error?: string }));
      if (!r.ok) { this.fnMsg.set({ type: 'danger', text: s.error || `소스 조회 실패 (HTTP ${r.status})` }); return; }
      this.fnDb.set(database); this.fnSchema.set(fn.schema); this.fnName.set(fn.name);
      this.fnArgs.set(s.args || fn.args); this.fnReturns.set(s.returns || fn.rettype); this.fnLang.set(s.language || fn.lang);
      this.fnBody.set(s.body || ''); this.fnReplace.set(true);
      this.fnMsg.set({ type: 'success', text: `${fn.schema}.${fn.name} 로드됨 — 수정 후 '함수 생성'(OR REPLACE)을 누르세요.` });
    } catch (e) { this.fnMsg.set({ type: 'danger', text: '소스 조회 실패: ' + e }); }
  }

  /** 함수 삭제(DROP) — 확인 후 identity args로 특정 오버로드 제거. 감사 기록. */
  async deleteFunction(database: string, fn: PgFunc): Promise<void> {
    if (!confirm(`함수 ${fn.schema}.${fn.name}(${fn.args}) 를 삭제할까요?`)) return;
    this.fnMsg.set(null); this.fnOpen.set(true);
    try {
      const r = await fetch('/api/admin/backbone/pg/function/drop', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + (this.auth.token() || ''), 'content-type': 'application/json' },
        body: JSON.stringify({ database, schema: fn.schema, name: fn.name, args: fn.args }),
      });
      if (this.checkExpired(r.status)) return;
      if (r.status === 401 || r.status === 403) { this.fnMsg.set({ type: 'danger', text: '관리자 권한이 필요합니다.' }); return; }
      const j = await r.json().catch(() => ({} as { error?: string }));
      if (!r.ok) { this.fnMsg.set({ type: 'danger', text: j.error || `삭제 실패 (HTTP ${r.status})` }); return; }
      this.fnMsg.set({ type: 'success', text: `함수 ${fn.schema}.${fn.name} 삭제됨.` });
      this.loadedContents = false; await this.loadContents(); // 트리 갱신
    } catch (e) { this.fnMsg.set({ type: 'danger', text: '삭제 실패: ' + e }); }
  }

  /** 설치된 'vector' 확장 버전(아무 DB에서나) — 없으면 ''. 벡터 지원 배너용. */
  vectorVersion(): string {
    for (const d of this.pg()?.databases || []) {
      const v = (d.extensions || []).find((e) => e.name === 'vector');
      if (v) return v.version;
    }
    return '';
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
      if (this.checkExpired(r.status)) return;
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
