import { Injectable, computed, inject } from '@angular/core';
import { ExtensionHostService } from './extension-host.service';
import { PerspectiveService } from './perspective.service';
import { ApiService, CatalogEntity } from './api.service';
import { ManualService } from './manual.service';
import { SearchResult, SearchProvider } from './search.types';

export type { SearchResult, SearchProvider } from './search.types';

/** 섹션별 검색 결과 — 검색 팔레트(2단 모달)가 Resources/Services/Documentation/Marketplace로 분류 표시. */
export interface SectionId { id: 'resources' | 'services' | 'documentation' | 'marketplace'; }
export interface SearchSections {
  resources: SearchResult[];
  services: SearchResult[];
  documentation: SearchResult[];
  marketplace: SearchResult[];
}

/**
 * 셸 레벨 검색 (헌법 §6 "하나의 셸"). 두 표면을 명시적으로 분리한다:
 *
 *  1) 즉시 "이동(Go to)" — 동기 로컬 인덱스(셸 정적 페이지·로드된 플러그인 페이지·워크스페이스).
 *     네비게이션 점프. 네트워크 없음. → queryLocal().
 *  2) 비동기 "검색" — provider 결과. 두 federation 모드를 한 seam으로 받는다 → queryProviders():
 *       (a) 런타임 기여: 플러그인이 `search:contribute`로 등록한 provider(클라이언트 콘텐츠).
 *           ExtensionHostService.searchProviders()가 소유 — 결과는 pluginId 출처로 태깅.
 *       (b) 데이터층: 셸/부트스트랩이 addProvider()로 주입(예: OpenSearch 전문검색 — 모든
 *           컴포넌트가 공유 인덱스에 색인). 미연결이면 빈 결과.
 *
 *  ⚠️ provider는 비동기(Promise) 가능 — OpenSearch 같은 백엔드 질의를 받기 위함(동기 computed에 가두지 않음).
 */
@Injectable({ providedIn: 'root' })
export class SearchService {
  private ext = inject(ExtensionHostService);
  private psp = inject(PerspectiveService);
  private api = inject(ApiService);
  private manual = inject(ManualService);
  /** 데이터층/셸 provider(예: OpenSearch). 런타임 플러그인 provider는 ext가 소유(search:contribute). */
  private dataProviders: SearchProvider[] = [];

  /** 내장 문서 인덱스(Documentation 섹션) — 정적. 추후 docs provider로 확장 가능. */
  private readonly DOCS: SearchResult[] = [
    { label: 'Search Language Syntax', sublabel: 'Search', path: '/catalog', kind: 'result' },
    { label: 'Free Text Search', sublabel: 'Search', path: '/catalog', kind: 'result' },
    { label: 'Developer Catalog 가이드', sublabel: 'Catalog', path: '/catalog', kind: 'result' },
    { label: 'APIs 탐색', sublabel: 'API', path: '/apis', kind: 'result' },
    { label: 'Plugins(확장) 관리', sublabel: 'Console', path: '/admin/plugins', kind: 'result' },
    { label: '역할/권한(RBAC)', sublabel: 'Identity', path: '/admin/roles', kind: 'result' },
    { label: '콘솔 관리자 온보딩', sublabel: 'Identity', path: '/console-admins', kind: 'result' },
  ];

  /** 카탈로그 엔티티 캐시(검색 키 입력마다 재요청 방지) — 실패 시 빈 목록(graceful). */
  private _catalog?: Promise<CatalogEntity[]>;
  private catalog(): Promise<CatalogEntity[]> {
    return (this._catalog ??= this.api.catalogEntities().catch(() => [] as CatalogEntity[]));
  }

  /** 정적 셸 페이지 인덱스 */
  private readonly STATIC: SearchResult[] = [
    { label: '홈 · Perspectives', sublabel: '셸 홈', path: '/', kind: 'page' },
    { label: 'Developer Catalog', sublabel: 'RHDH 카탈로그', path: '/catalog', kind: 'page' },
    { label: 'APIs', sublabel: 'API 목록', path: '/apis', kind: 'page' },
    { label: 'Plugins', sublabel: '플러그인 관리(Admin)', path: '/admin/plugins', kind: 'page' },
  ];

  /** 즉시 로컬 인덱스(정적 + 동적 플러그인 페이지 + 워크스페이스) — "이동" 표면 */
  readonly index = computed<SearchResult[]>(() => [
    ...this.STATIC,
    ...this.ext.pages().map((p) => ({
      label: p.title, sublabel: `플러그인 · ${p.navBand}`, path: `/p/${p.id}`, kind: 'plugin' as const,
    })),
    ...this.psp.allowedWorkspaces().map((w) => ({
      label: `${w.label} Workspace`, sublabel: w.desc, path: '/', kind: 'workspace' as const,
    })),
  ]);

  /** 데이터층/셸 provider 등록(OpenSearch 등). 런타임 플러그인 provider는 search:contribute로 ext에 등록된다. */
  addProvider(p: SearchProvider): void { this.dataProviders.push(p); }

  /** 즉시 동기 로컬 검색("이동"). substring(label·sublabel). */
  queryLocal(q: string): SearchResult[] {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return this.index()
      .filter((r) => r.label.toLowerCase().includes(s) || r.sublabel.toLowerCase().includes(s))
      .slice(0, 20);
  }

  /** 비동기 provider 검색 — 런타임 기여(search:contribute) + 데이터층(OpenSearch). 출처 태깅·격리(한 provider 실패가 전체를 깨지 않음). */
  async queryProviders(q: string): Promise<SearchResult[]> {
    if (!q.trim()) return [];
    const contributed = Object.entries(this.ext.searchProviders());
    const tasks: Promise<SearchResult[]>[] = [
      ...contributed.map(([pid, p]) =>
        Promise.resolve()
          .then(() => p.query(q))
          .then((r) => r.map((x) => ({ ...x, source: x.source ?? pid })))
          .catch(() => [] as SearchResult[]),
      ),
      ...this.dataProviders.map((p) =>
        Promise.resolve().then(() => p.query(q)).catch(() => [] as SearchResult[]),
      ),
    ];
    const settled = await Promise.all(tasks);
    return settled.flat().slice(0, 30);
  }

  private queryManualContributions(q: string): SearchResult[] {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    const out: SearchResult[] = [];
    for (const [pluginId, source] of Object.entries(this.ext.manualContributions())) {
      for (const doc of source.documents || []) {
        const hay = `${doc.title || ''} ${doc.content || ''} ${(doc.tags || []).join(' ')}`.toLowerCase();
        if (!hay.includes(s)) continue;
        out.push({
          label: doc.title || doc.id,
          sublabel: [source.name || pluginId, doc.documentType || 'manual', doc.sourcePath || 'runtime contribution'].filter(Boolean).join(' · '),
          path: doc.route || `/p/${pluginId}`,
          kind: 'result',
          source: `manual:${pluginId}`,
        });
      }
    }
    return out.slice(0, 6);
  }

  /**
   * 섹션별 검색 — 검색 팔레트(2단 모달)용. 4개 섹션으로 분류:
   *   resources     = 셸 네비 인덱스(페이지·플러그인·워크스페이스) "이동" 대상
   *   services      = 카탈로그 Component(실행 워크로드/서비스)
   *   documentation = 내장 문서 인덱스 + 'documentation' source provider
   *   marketplace   = 카탈로그 API(설치/연동 가능 표면) + 'marketplace' source provider
   * 데이터 없으면 빈 배열(섹션 graceful empty). 한 소스 실패가 전체를 깨지 않음.
   */
  async querySectioned(q: string): Promise<SearchSections> {
    const s = q.trim().toLowerCase();
    const empty: SearchSections = { resources: [], services: [], documentation: [], marketplace: [] };
    if (!s) return empty;

    const resources = this.queryLocal(q).slice(0, 8);
    const documentation = this.DOCS.filter(
      (d) => d.label.toLowerCase().includes(s) || d.sublabel.toLowerCase().includes(s),
    ).slice(0, 6);
    documentation.push(...this.queryManualContributions(q));

    let services: SearchResult[] = [];
    let marketplace: SearchResult[] = [];
    try {
      const cat = await this.catalog();
      const match = (e: CatalogEntity) =>
        e.metadata.name.toLowerCase().includes(s) || (e.metadata.description || '').toLowerCase().includes(s);
      const toResult = (e: CatalogEntity, path: string): SearchResult => ({
        label: e.metadata.name,
        sublabel: (e as any).spec?.system || e.metadata.namespace || e.kind,
        path,
        kind: 'result',
      });
      services = cat.filter((e) => e.kind === 'Component' && match(e)).slice(0, 6).map((e) => toResult(e, '/catalog'));
      marketplace = cat.filter((e) => e.kind === 'API' && match(e)).slice(0, 6).map((e) => toResult(e, '/apis'));
    } catch { /* catalog 미가용 → 빈 섹션 */ }

    try {
      const manualHits = await this.manual.search(q, 6);
      documentation.push(...manualHits.map((hit) => ({
        label: hit.title,
        sublabel: [hit.sourceName || 'Manual', hit.documentType, hit.sourcePath].filter(Boolean).join(' · '),
        path: `/p/manual?doc=${encodeURIComponent(hit.sourceId)}&q=${encodeURIComponent(q)}`,
        kind: 'result' as const,
        source: 'manual-registry',
      })));
    } catch { /* manual registry unavailable */ }

    // provider(런타임 기여·데이터층) 결과는 source 힌트로 섹션 배분, 기본은 services.
    try {
      for (const r of await this.queryProviders(q)) {
        const sec = String((r as any).section || '').toLowerCase();
        if (sec === 'documentation') documentation.push(r);
        else if (sec === 'marketplace') marketplace.push(r);
        else if (sec === 'resources') resources.push(r);
        else services.push(r);
      }
    } catch { /* provider 실패 무시 */ }

    return {
      resources: resources.slice(0, 8),
      services: services.slice(0, 8),
      documentation: documentation.slice(0, 6),
      marketplace: marketplace.slice(0, 6),
    };
  }

  /** @deprecated queryLocal()+queryProviders()로 분리됨. 동기 로컬만 반환(구 호출 호환). */
  query(q: string): SearchResult[] { return this.queryLocal(q); }
}
