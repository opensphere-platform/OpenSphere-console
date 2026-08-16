import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

/** Host-owned failure boundary used when a lazy system-plugin surface cannot load. */
@Component({
  selector: 'os-system-plugin-unavailable',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="system-plugin-unavailable" role="alert">
      <p class="eyebrow">SYSTEM PLUGIN DEGRADED</p>
      <h1>{{ displayName }}</h1>
      <p>이 기능의 화면을 불러오지 못했습니다. Main Shell과 다른 Extension은 계속 사용할 수 있습니다.</p>
      <a routerLink="/">Console 홈으로 돌아가기</a>
    </main>
  `,
  styles: [`
    .system-plugin-unavailable { max-width: 48rem; margin: 5rem auto; padding: 2rem; }
    .eyebrow { color: var(--os-warning, #f1c21b); font-weight: 700; letter-spacing: .08em; }
  `],
})
export class SystemPluginUnavailable {
  private readonly route = inject(ActivatedRoute);
  readonly displayName = String(this.route.snapshot.data['systemPluginName'] || 'System Plugin');
}
