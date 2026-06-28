import { Injectable, signal } from '@angular/core';

export interface IconEntry { token: string; label: string; svg: string; search: string }

/**
 * IconLibraryService — Carbon 아이콘 **전체 라이브러리**(2600+종)를 지연 로딩으로 노출.
 *   - @carbon/icons/metadata.json(단일 파일: 이름·친절명·별칭·원본 SVG)을 동적 import → 별도 청크.
 *     (es 집계 import는 10k 모듈을 한 번에 열어 빌드가 EMFILE로 실패 → metadata 단일 파일이 정답.)
 *   - 렌더는 원본 SVG 문자열을 그대로(OsRawIcon이 DomSanitizer로 trust). 피커·셸 1단 공용.
 *   - token = 아이콘 name. 정규화 키로 매핑해 kebab/Pascal 모두 해석.
 */
@Injectable({ providedIn: 'root' })
export class IconLibraryService {
  readonly list = signal<IconEntry[]>([]);
  readonly loaded = signal(false);
  private byToken = new Map<string, string>();
  private loading: Promise<void> | null = null;

  static norm(s: string): string { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
  private static clean(svg: string): string {
    return (svg || '').replace(/<title>[\s\S]*?<\/title>/g, '').replace(/\s id="icon"/g, '');
  }

  /** metadata.json을 한 번만 로딩(이후 캐시). 동적 import → 지연 청크. */
  ensure(): Promise<void> {
    if (this.loaded()) return Promise.resolve();
    if (this.loading) return this.loading;
    this.loading = import('@carbon/icons/metadata.json')
      .then((mod: any) => {
        const data = mod.default ?? mod;
        const icons: any[] = data.icons ?? [];
        const list: IconEntry[] = [];
        for (const ic of icons) {
          const assets: any[] = ic.assets ?? [];
          if (!assets.length) continue;
          const asset = assets.slice().sort((a, b) => (a.size || 99) - (b.size || 99))[0]; // 최소 사이즈
          const svg = IconLibraryService.clean(asset.source || '');
          if (!svg) continue;
          const token: string = ic.name;
          list.push({
            token,
            label: ic.friendlyName || token,
            svg,
            search: [ic.name, ic.friendlyName, ...(ic.aliases || [])].join(' ').toLowerCase(),
          });
          this.byToken.set(IconLibraryService.norm(token), svg);
        }
        list.sort((a, b) => a.label.localeCompare(b.label));
        this.list.set(list);
        this.loaded.set(true);
      })
      .catch((e) => { console.warn('[icon-library] metadata 로딩 실패', e); });
    return this.loading;
  }

  /** token → 원본 SVG(없으면 null). 미로딩이면 백그라운드 ensure() 트리거 후 null(로딩 시 signal 갱신→재렌더). */
  getSvg(token: string | undefined | null): string | null {
    if (!token) return null;
    if (!this.loaded()) { this.ensure(); return null; }
    return this.byToken.get(IconLibraryService.norm(token)) ?? null;
  }
}
