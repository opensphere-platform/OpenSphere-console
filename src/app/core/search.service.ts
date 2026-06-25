import { Injectable, computed, inject } from '@angular/core';
import { ExtensionHostService } from './extension-host.service';
import { PerspectiveService } from './perspective.service';
import { SearchResult, SearchProvider } from './search.types';

export type { SearchResult, SearchProvider } from './search.types';

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
  /** 데이터층/셸 provider(예: OpenSearch). 런타임 플러그인 provider는 ext가 소유(search:contribute). */
  private dataProviders: SearchProvider[] = [];

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

  /** @deprecated queryLocal()+queryProviders()로 분리됨. 동기 로컬만 반환(구 호출 호환). */
  query(q: string): SearchResult[] { return this.queryLocal(q); }
}
