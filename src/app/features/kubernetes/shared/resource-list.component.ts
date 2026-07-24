import { CommonModule } from '@angular/common';
import { Component, EventEmitter, HostListener, Input, OnInit, Output, Signal, computed, inject, signal } from '@angular/core';
import { ClarityModule } from '@clr/angular';
import { K8sService } from '../core/k8s.service';
import { ResourceDetailComponent } from './resource-detail.component';
import { OsLogoComponent } from './os-logo.component';

/** 컬럼 정의 — 원시 K8s 객체에서 값을 뽑고(get), 렌더 종류(kind)로 셀을 그린다. */
export interface ColumnDef {
  id: string;
  label: string;
  get: (o: any) => any;
  /** text(기본) | name(굵게, 추후 상세링크) | age(상대시간) | tags(배지 배열) | status(상태 라벨) | logo(OS 로고) */
  kind?: 'text' | 'name' | 'age' | 'tags' | 'status' | 'logo';
  /** kind=status일 때 색상 매핑 */
  statusOf?: (o: any) => 'success' | 'danger' | 'warning' | 'info' | 'unknown';
  /** 이 컬럼을 다중선택 패싯(드롭다운)으로 노출. kind:'status'면 자동으로 패싯. */
  facet?: boolean;
  /** 패싯 옵션을 원시 get() 대신 파생값으로 (예: ready '3/3' → 'AllReady'/'NotAllReady'). */
  facetDerive?: (o: any) => string | string[];
  /** 고유값이 이 개수를 넘으면 패싯 숨김(free-text로 폴백). 기본 30. */
  facetCap?: number;
}

/** 설정 기반 Clarity Datagrid 공용 리스트. 모든 리소스 목록의 단일 렌더 경로.
 *  제네릭 프록시(K8sService)로 path를 list 하고, columns 설정대로 그린다. */
@Component({
  selector: 'app-resource-list',
  standalone: true,
  imports: [CommonModule, ClarityModule, ResourceDetailComponent, OsLogoComponent],
  styles: [`
    .os-kebab { font-size: 1.15rem; line-height: 1; font-weight: 700; }
    .os-row-actions { position: fixed; z-index: 1100; background: var(--clr-global-app-background, #fff); border: 1px solid var(--clr-color-neutral-300, #ccc); border-radius: 4px; box-shadow: 0 3px 12px rgba(0,0,0,.18); min-width: 150px; padding: .25rem 0; }
    .os-row-action { display: block; width: 100%; text-align: left; padding: .42rem 1rem; border: none; background: none; cursor: pointer; font-size: .85rem; color: var(--clr-color-neutral-800, #333); }
    .os-row-action:hover { background: var(--clr-color-neutral-100, #f3f3f3); }
    .os-row-action.danger { color: var(--clr-color-danger-700, #e74c3c); }
  `],
  template: `
    <!-- 목록은 항상 좌측에 유지. 상세는 우측 슬라이드 오버 드로어로 표시. -->
    <div class="os-title-row">
      <h2 class="os-h2">{{ title }}
        <span class="label label-info">Angular · Clarity</span>
        <span *ngIf="dummy" class="label label-warning">DUMMY · 예시</span>
      </h2>
      <span class="os-sub">{{ filtered().length }}<span *ngIf="filtersActive()"> / {{ rows().length }}</span> {{ title.toLowerCase() }}</span>
      <input class="os-search" type="text" placeholder="검색 (이름·네임스페이스·값)" [value]="search()" (input)="search.set($any($event.target).value)" />
      <button *ngIf="createLabel" class="btn btn-sm btn-primary os-create" type="button" (click)="create.emit()">{{ createLabel }}</button>
    </div>

    <!-- 다중선택 패싯 필터 (자체완결 *ngIf 팝오버 — clr-dropdown/CDK Overlay 미사용 → 섀도우 밖 body 포털 탈출 없음) -->
    <div class="os-facets" *ngIf="(namespaced && nsOptions().length) || facetCols().length">
      <!-- Namespace 다중선택 (Headlamp 'All namespaces' 패리티) -->
      <div class="os-facet" *ngIf="namespaced && nsOptions().length">
        <span class="os-facet-trigger" role="button" tabindex="0" [class.is-open]="openFacet() === NS"
              (click)="togglePopover(NS)" (keydown.enter)="togglePopover(NS)">
          Namespace
          <span class="badge badge-info" *ngIf="countFor(NS)">{{ countFor(NS) }}</span>
          <span class="os-facet-caret" aria-hidden="true">▾</span>
        </span>
        <div class="os-filter-popover" *ngIf="openFacet() === NS" role="group" aria-label="Namespace filter">
          <div class="os-filter-head">
            <span>{{ countFor(NS) ? countFor(NS) + ' selected' : 'All namespaces' }}</span>
            <span class="os-link" role="button" tabindex="0" *ngIf="countFor(NS)" (click)="clearFacet(NS)" (keydown.enter)="clearFacet(NS)">Clear</span>
          </div>
          <label *ngFor="let ns of nsOptions()">
            <input type="checkbox" [checked]="isPicked(NS, ns)" (change)="toggle(NS, ns, $any($event.target).checked)" />
            <span>{{ ns }}</span>
          </label>
        </div>
      </div>

      <!-- 컬럼 패싯 (kind:'status' 자동 + facet:true). 옵션 0개(또는 cap 초과)면 숨김. -->
      <ng-container *ngFor="let c of facetCols()">
        <div class="os-facet" *ngIf="optionsFor(c).length">
          <span class="os-facet-trigger" role="button" tabindex="0" [class.is-open]="openFacet() === c.id"
                (click)="togglePopover(c.id)" (keydown.enter)="togglePopover(c.id)">
            {{ c.label }}
            <span class="badge badge-info" *ngIf="countFor(c.id)">{{ countFor(c.id) }}</span>
            <span class="os-facet-caret" aria-hidden="true">▾</span>
          </span>
          <div class="os-filter-popover" *ngIf="openFacet() === c.id" role="group" [attr.aria-label]="c.label + ' filter'">
            <div class="os-filter-head">
              <span>{{ countFor(c.id) ? countFor(c.id) + ' selected' : 'All' }}</span>
              <span class="os-link" role="button" tabindex="0" *ngIf="countFor(c.id)" (click)="clearFacet(c.id)" (keydown.enter)="clearFacet(c.id)">Clear</span>
            </div>
            <label *ngFor="let v of optionsFor(c)">
              <input type="checkbox" [checked]="isPicked(c.id, v)" (change)="toggle(c.id, v, $any($event.target).checked)" />
              <span class="label" *ngIf="c.kind === 'status'" [ngClass]="statusClass(statusSwatch(c, v))">{{ v }}</span>
              <span *ngIf="c.kind !== 'status'">{{ v }}</span>
            </label>
          </div>
        </div>
      </ng-container>

      <button type="button" class="btn btn-sm btn-link os-facet-clearall" *ngIf="filtersActive()" (click)="clearAll()">Clear all</button>
    </div>

    <div *ngIf="error()" class="alert alert-danger" role="alert">
      <div class="alert-items"><div class="alert-item static">
        <span class="alert-text">{{ error() }}</span>
      </div></div>
    </div>

    <!-- 404 = 해당 API/CRD 미설치(또는 비활성). 빨간 에러 대신 안내(Headlamp 동작과 동등). -->
    <div *ngIf="unavailable()" class="alert alert-info" role="alert">
      <div class="alert-items"><div class="alert-item static">
        <span class="alert-text">이 리소스 종류는 이 클러스터에 없습니다 — CRD 미설치이거나 API가 비활성화됨. 설치되면 자동으로 표시됩니다.</span>
      </div></div>
    </div>

    <clr-datagrid [clrDgLoading]="loading()">
      <clr-dg-column *ngIf="namespaced" [clrDgSortBy]="nsComparator">Namespace</clr-dg-column>
      <clr-dg-column *ngFor="let c of columns" [clrDgSortBy]="comparator(c)">{{ c.label }}</clr-dg-column>
      <clr-dg-column *ngIf="rowActions"></clr-dg-column>

      <clr-dg-row *clrDgItems="let item of filtered()">
        <clr-dg-cell *ngIf="namespaced">{{ item.metadata?.namespace }}</clr-dg-cell>
        <clr-dg-cell *ngFor="let c of columns" [ngSwitch]="c.kind || 'text'">
          <ng-container *ngSwitchCase="'name'">
            <a *ngIf="kind && pageDetail" class="os-link" role="button" tabindex="0" (click)="rowOpen.emit(item)" (keydown.enter)="rowOpen.emit(item)">{{ c.get(item) }}</a>
            <a *ngIf="kind && !pageDetail" class="os-link" role="button" tabindex="0" (click)="selected.set(item)" (keydown.enter)="selected.set(item)">{{ c.get(item) }}</a>
            <a *ngIf="!kind && dummy" class="os-link" role="button" tabindex="0" (click)="rowClick.emit(item)" (keydown.enter)="rowClick.emit(item)">{{ c.get(item) }}</a>
            <strong *ngIf="!kind && !dummy">{{ c.get(item) }}</strong>
          </ng-container>
          <ng-container *ngSwitchCase="'age'">{{ age(c.get(item)) }}</ng-container>
          <ng-container *ngSwitchCase="'tags'">
            <span *ngFor="let t of asArray(c.get(item))" class="label">{{ t }}</span>
            <span *ngIf="asArray(c.get(item)).length === 0" class="os-muted">—</span>
          </ng-container>
          <ng-container *ngSwitchCase="'status'">
            <span class="label" [ngClass]="statusClass(c.statusOf?.(item))">{{ c.get(item) }}</span>
          </ng-container>
          <ng-container *ngSwitchCase="'logo'"><app-os-logo [os]="c.get(item)" [size]="22"></app-os-logo></ng-container>
          <ng-container *ngSwitchDefault>{{ display(c.get(item)) }}</ng-container>
        </clr-dg-cell>
        <clr-dg-cell *ngIf="rowActions"><button class="os-iconbtn os-kebab" type="button" title="작업" (click)="toggleActions(item, $event)">⋮</button></clr-dg-cell>
      </clr-dg-row>

      <clr-dg-footer>
        <clr-dg-pagination #pg [clrDgPageSize]="20">
          <clr-dg-page-size [clrPageSizeOptions]="[10, 20, 50, 100]">{{ title }} per page</clr-dg-page-size>
          {{ pg.firstItem + 1 }} - {{ pg.lastItem + 1 }} / {{ pg.totalItems }}
        </clr-dg-pagination>
      </clr-dg-footer>
    </clr-datagrid>

    <!-- 행 작업 메뉴 (자체완결 fixed 팝오버 — clr-dropdown 미사용, 섀도우 포털 탈출 없음) -->
    <div class="os-row-actions" *ngIf="openActions() as item" [style.top.px]="actionsPos().top" [style.left.px]="actionsPos().left">
      <button *ngFor="let a of rowActions!(item)" type="button" class="os-row-action" [class.danger]="a.danger" (click)="runAction(a)">{{ a.label }}</button>
    </div>

    <!-- 우측 슬라이드 오버 상세 드로어 (좌측 끝 드래그로 리사이즈). 그레이 백드롭 없음(불투명·고z로 겹침 방지), 닫기는 헤더 X -->

    <div class="os-drawer" *ngIf="selected() as sel" [ngStyle]="{ width: full() ? '100%' : drawerW() + 'px' }">
      <div class="os-drawer-handle" *ngIf="!full()" (pointerdown)="startResize($event)"></div>
      <div class="os-drawer-main">
        <div class="os-drawer-head">
          <span class="os-drawer-title">{{ kind }} · {{ sel.metadata?.name }}</span>
          <span class="os-drawer-ctrls">
            <button class="os-iconbtn" type="button" [title]="full() ? '복원' : '전체 보기'" [attr.aria-label]="full() ? 'Restore' : 'Maximize'" (click)="full.set(!full())">
              <svg viewBox="0 0 24 24" class="os-ic"><path [attr.d]="full() ? icRestore : icMax"/></svg>
            </button>
            <button class="os-iconbtn" type="button" title="닫기" aria-label="Close" (click)="closeDrawer()">
              <svg viewBox="0 0 24 24" class="os-ic"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
            </button>
          </span>
        </div>
        <div class="os-drawer-body">
          <app-resource-detail
            [kind]="kind!"
            [listPath]="path"
            [namespaced]="namespaced"
            [item]="sel"
            [scalable]="scalable"
            [restartable]="restartable"
            [cordonable]="cordonable"
            [vm]="vm"
            (back)="selected.set(null)"
            (changed)="load()"
          />
        </div>
      </div>
    </div>
  `,
})
export class ResourceListComponent implements OnInit {
  /** 화면 제목(복수형, 예: Pods) */
  @Input({ required: true }) title!: string;
  /** K8s list 경로(예: /api/v1/pods) */
  @Input({ required: true }) path!: string;
  /** 네임스페이스 컬럼 표시 여부 */
  @Input() namespaced = true;
  /** 컬럼 설정 */
  @Input({ required: true }) columns!: ColumnDef[];
  /** K8s Kind — 지정 시 이름 클릭으로 상세(detail) 진입 + 액션 활성 */
  @Input() kind?: string;
  /** 스케일 가능(Deployment/ReplicaSet/StatefulSet 등) */
  @Input() scalable = false;
  /** 롤링 재시작 가능(Deployment/StatefulSet/DaemonSet 등) */
  @Input() restartable = false;
  /** 코든/드레인 가능(Node) */
  @Input() cordonable = false;
  /** KubeVirt VM 라이프사이클(Start/Stop/Restart) 액션 활성 — kind='VirtualMachine'과 함께 사용. */
  @Input() vm = false;
  /** 행별 작업(⋮) — item을 받아 작업 목록 반환. 지정 시 마지막에 작업(⋮) 컬럼 표시. */
  @Input() rowActions?: (item: any) => Array<{ label: string; danger?: boolean; run: () => void }>;
  /** 페이지 상세 모드 — 이름 클릭 시 드로어 대신 (rowOpen)으로 상위에 위임(상위가 전체 페이지로 상세 렌더). OpenShift 방식. */
  @Input() pageDetail = false;
  /** 더미 모드 — 지정 시 프록시 호출 대신 staticRows를 그대로 렌더(예시 페이지). */
  @Input() dummy = false;
  /** 더미 정적 행(K8s 객체 형태). dummy=true와 함께 사용. */
  @Input() staticRows: any[] | null = null;
  /** 우상단 Create 버튼 라벨(있으면 표시). */
  @Input() createLabel?: string;
  /** Create 버튼 클릭 — 상위(더미 래퍼)가 생성 위저드로 전환. */
  @Output() create = new EventEmitter<void>();
  /** 더미 모드에서 행(이름) 클릭 — 상위가 상세로 전환. */
  @Output() rowClick = new EventEmitter<any>();
  /** pageDetail 모드에서 행(이름) 클릭 — 상위가 전체 페이지 상세로 전환. */
  @Output() rowOpen = new EventEmitter<any>();
  // ── 검색 + 다중선택 패싯 필터 (Headlamp 네임스페이스 다중선택 패리티, 섀도우 자체완결) ──
  /** 네임스페이스 패싯의 예약 facetId */
  readonly NS = '__ns__';
  /** 전역 자유 검색(이름·네임스페이스·모든 컬럼 값 텍스트 매칭) */
  readonly search = signal('');
  /** facetId → 선택값들. 빈 배열/미존재 = 제약 없음(=전체, Headlamp empty=all). */
  readonly selections = signal<Record<string, string[]>>({});
  /** 한 번에 하나의 팝오버만 열림 */
  readonly openFacet = signal<string | null>(null);
  /** 열린 행-작업 메뉴 대상 item + fixed 위치 */
  readonly openActions = signal<any | null>(null);
  readonly actionsPos = signal<{ top: number; left: number }>({ top: 0, left: 0 });

  /** 패싯 컬럼(상태 컬럼 자동 + facet:true 명시) */
  readonly facetCols = computed<ColumnDef[]>(() => this.columns.filter(c => c.facet || c.kind === 'status'));

  private facetVal(c: ColumnDef, o: any): string[] {
    const raw = c.facetDerive ? c.facetDerive(o) : c.get(o);
    return (Array.isArray(raw) ? raw : [raw]).map(v => this.norm(v)).filter(v => v !== '');
  }

  /** 컬럼별 옵션 시그널(ngOnInit에서 1회 생성 — CD마다 computed 재생성 방지). cap 초과 시 빈 배열(패싯 숨김). */
  private optMap = new Map<string, Signal<string[]>>();
  optionsFor(c: ColumnDef): string[] { return this.optMap.get(c.id)?.() ?? []; }

  /** 네임스페이스 옵션(로드된 rows에서 도출) */
  readonly nsOptions = computed(() => {
    if (!this.namespaced) return [];
    const set = new Set<string>();
    for (const o of this.rows()) { const ns = o.metadata?.namespace; if (ns) set.add(ns); }
    return [...set].sort((a, b) => this.strcmp(a, b));
  });

  /** 필터 활성 여부(카운트 배지 'X / total' 표시) */
  readonly filtersActive = computed(() =>
    !!this.search().trim() || Object.values(this.selections()).some(v => v.length > 0));

  /** 단일 진실원: rows에 네임스페이스/컬럼 패싯(패싯 간 AND, 패싯 내 OR) + 자유검색(AND) 적용 */
  readonly filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    const sel = this.selections();
    let list = this.rows();
    const nsSel = sel[this.NS];
    if (this.namespaced && nsSel?.length) list = list.filter(o => nsSel.includes(o.metadata?.namespace));
    for (const c of this.facetCols()) {
      const picked = sel[c.id];
      if (!picked?.length) continue;
      if (!this.optionsFor(c).length) continue; // cap 초과로 숨겨진 패싯은 조용히 필터하지 않음(UI와 일치)
      list = list.filter(o => this.facetVal(c, o).some(v => picked.includes(v)));
    }
    if (q) list = list.filter(o => {
      const hay = [o.metadata?.namespace, ...this.columns.map(c => this.norm(c.get(o)))].join(' ').toLowerCase();
      return hay.includes(q);
    });
    return list;
  });

  // 선택 변경(zoneless-safe: 명시적 signal write로 CD 트리거)
  toggle(facetId: string, value: string, checked: boolean): void {
    this.selections.update(s => {
      const cur = s[facetId] ?? [];
      const next = checked ? [...new Set([...cur, value])] : cur.filter(v => v !== value);
      return { ...s, [facetId]: next };
    });
  }
  isPicked(facetId: string, value: string): boolean { return (this.selections()[facetId] ?? []).includes(value); }
  countFor(facetId: string): number { return (this.selections()[facetId] ?? []).length; }
  clearFacet(facetId: string): void { this.selections.update(s => ({ ...s, [facetId]: [] })); }
  clearAll(): void { this.selections.set({}); this.search.set(''); }
  togglePopover(facetId: string): void { this.openFacet.set(this.openFacet() === facetId ? null : facetId); }

  toggleActions(item: any, ev: Event): void {
    ev.stopPropagation();
    if (this.openActions() === item) { this.openActions.set(null); return; }
    const btn = (ev.target as HTMLElement).closest('button');
    const r = btn ? btn.getBoundingClientRect() : ({ bottom: 0, right: 0 } as DOMRect);
    this.actionsPos.set({ top: r.bottom + 2, left: Math.max(8, r.right - 160) });
    this.openActions.set(item);
  }
  runAction(a: { run: () => void }): void { this.openActions.set(null); a.run(); }

  /** 상태 옵션 배지 색(값에 해당하는 첫 행의 statusOf) */
  statusSwatch(c: ColumnDef, value: string): 'success' | 'danger' | 'warning' | 'info' | 'unknown' {
    const o = this.rows().find(r => this.facetVal(c, r).includes(value));
    return o && c.statusOf ? c.statusOf(o) : 'unknown';
  }

  // 바깥 클릭/Esc 시 팝오버 닫기. 섀도우 이벤트 retarget 때문에 composedPath 사용(CSP-safe, 인라인 핸들러 없음).
  @HostListener('document:click', ['$event'])
  onDocClick(e: MouseEvent): void {
    const path = (e as any).composedPath?.() ?? [];
    if (this.openActions() && !path.some((el: any) => el?.classList?.contains?.('os-row-actions') || el?.classList?.contains?.('os-kebab'))) this.openActions.set(null);
    if (!this.openFacet()) return;
    const inside = path.some((el: any) => el?.classList?.contains?.('os-facet') || el?.classList?.contains?.('os-filter-popover'));
    if (!inside) this.openFacet.set(null);
  }
  @HostListener('document:keydown.escape')
  onEsc(): void { this.openFacet.set(null); this.openActions.set(null); }

  /** 선택된 항목 → 우측 슬라이드 드로어 상세 표시 */
  readonly selected = signal<any | null>(null);
  /** 드로어 폭(px) — 좌측 핸들 드래그로 조정 */
  readonly drawerW = signal(760);
  /** 전체 보기(최대화) 토글 */
  readonly full = signal(false);
  readonly icMax = 'M3 3h7v2H5v5H3V3zm11 0h7v7h-2V5h-5V3zM3 14h2v5h5v2H3v-7zm16 0h2v7h-7v-2h5v-5z';
  readonly icRestore = 'M5 5h6v6H5V5zm9-2h7v7h-2V5h-5V3zM3 13h2v6h6v2H3v-8zm14 1h2v5h-5v-2h3v-3z';

  closeDrawer() { this.selected.set(null); this.full.set(false); }

  startResize(e: PointerEvent) {
    e.preventDefault();
    const drawer = (e.target as HTMLElement).closest('.os-drawer') as HTMLElement;
    const ctx = (drawer?.offsetParent as HTMLElement) || document.documentElement;
    const rect = ctx.getBoundingClientRect();
    const onMove = (ev: PointerEvent) => {
      let w = rect.right - ev.clientX;
      w = Math.max(320, Math.min(w, rect.width - 60));
      this.drawerW.set(w);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  private k8s = inject(K8sService);
  readonly rows = signal<any[]>([]);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  /** 404(API/CRD 미설치) — 빨간 에러 대신 안내 표시 */
  readonly unavailable = signal(false);

  ngOnInit(): void {
    // 컬럼 id 유일성 보장 — optMap/cmp 캐시 키 충돌(같은 id가 서로 덮어씀) + NS 예약어 충돌 방지(fail-fast).
    const ids = this.columns.map(c => c.id);
    if (new Set(ids).size !== ids.length || ids.includes(this.NS)) {
      throw new Error(`ResourceList(${this.title}): 중복/예약 컬럼 id — ${ids.join(', ')}`);
    }
    // 패싯 컬럼별 옵션 시그널을 1회 생성(rows 변경 시 자동 재계산, cap 초과 시 빈 배열로 패싯 숨김).
    for (const c of this.facetCols()) {
      this.optMap.set(c.id, computed(() => {
        const set = new Set<string>();
        for (const o of this.rows()) for (const v of this.facetVal(c, o)) set.add(v);
        const arr = [...set].sort((a, b) => this.strcmp(a, b));
        return arr.length > (c.facetCap ?? 30) ? [] : arr;
      }));
    }
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.unavailable.set(false);
    // 더미 모드: 프록시 호출 없이 정적 예시 행을 렌더.
    if (this.dummy) {
      this.rows.set(this.staticRows || []);
      this.pruneStaleSelections();
      this.loading.set(false);
      return;
    }
    this.k8s.list(this.path).subscribe({
      next: res => { this.rows.set(res.items || []); this.pruneStaleSelections(); this.loading.set(false); },
      error: err => {
        this.loading.set(false);
        this.rows.set([]);
        // 404 = API/CRD 미설치 → 친절 안내(info), 그 외 → 실제 에러(danger)
        if (err?.status === 404) { this.unavailable.set(true); this.error.set(null); }
        else { this.unavailable.set(false); this.error.set(err?.error?.error || err?.message || String(err)); }
      },
    });
  }

  /** 로드 후, 더 이상 데이터에 존재하지 않는 선택값 제거(유령 패싯 "1 selected/0 rows" 방지).
   *  cap 무관하게 원시값(facetVal) 기준 — 단일 .set()로 zoneless-safe. */
  private pruneStaleSelections(): void {
    const cur = this.selections();
    const next: Record<string, string[]> = { ...cur };
    let changed = false;
    const prune = (id: string, live: Set<string>) => {
      const picked = cur[id];
      if (!picked?.length) return;
      const kept = picked.filter(v => live.has(v));
      if (kept.length !== picked.length) { next[id] = kept; changed = true; }
    };
    if (this.namespaced) {
      const live = new Set<string>();
      for (const o of this.rows()) { const ns = o.metadata?.namespace; if (ns) live.add(ns); }
      prune(this.NS, live);
    }
    for (const c of this.facetCols()) {
      const live = new Set<string>();
      for (const o of this.rows()) for (const v of this.facetVal(c, o)) live.add(v);
      prune(c.id, live);
    }
    if (changed) this.selections.set(next);
  }

  // 파생값(get) 기반 커스텀 정렬 comparator(컬럼별 캐시, 안정 참조).
  private cmp = new Map<string, { compare: (a: any, b: any) => number }>();
  readonly nsComparator = { compare: (a: any, b: any) => this.strcmp(a.metadata?.namespace, b.metadata?.namespace) };
  comparator(c: ColumnDef) {
    if (!this.cmp.has(c.id)) {
      this.cmp.set(c.id, { compare: (a: any, b: any) => this.strcmp(this.norm(c.get(a)), this.norm(c.get(b))) });
    }
    return this.cmp.get(c.id)!;
  }
  private norm(v: any): string { return Array.isArray(v) ? v.join(',') : v == null ? '' : String(v); }
  private strcmp(a: any, b: any): number { return a < b ? -1 : a > b ? 1 : 0; }
  asArray(v: any): any[] { return Array.isArray(v) ? v : v == null ? [] : [v]; }
  display(v: any): string { return v == null || v === '' ? '—' : String(v); }
  statusClass(s?: string): Record<string, boolean> {
    return {
      'label-success': s === 'success',
      'label-danger': s === 'danger',
      'label-warning': s === 'warning',
      'label-info': s === 'info',
    };
  }
  age(ts: string): string {
    if (!ts) return '—';
    const ms = Date.now() - new Date(ts).getTime();
    const d = Math.floor(ms / 86400000);
    if (d > 0) return d + 'd';
    const h = Math.floor(ms / 3600000);
    if (h > 0) return h + 'h';
    const m = Math.floor(ms / 60000);
    return m > 0 ? m + 'm' : '<1m';
  }
}
