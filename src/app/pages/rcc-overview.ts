import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ClarityModule } from '@clr/angular';

@Component({
  selector: 'polyon-rcc-overview',
  imports: [RouterLink, ClarityModule],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="rcc-overview">
      <section class="hero">
        <p class="eyebrow">PolyON Region Control Center</p>
        <h1>CC1·CC2 통합 운영</h1>
        <p>Supabase 신원과 Gitea 변경 통제를 유지하면서 각 Control Center의 현재 상태를 한곳에서 확인합니다.</p>
      </section>

      <section aria-labelledby="control-centers-title">
        <h2 id="control-centers-title">Control Centers</h2>
        <div class="cards">
          <article class="card">
            <div class="card-block">
              <div class="card-title-row">
                <h3>CC2</h3>
                <span class="label label-success">연결 대상</span>
              </div>
              <p>CC2 Kubernetes와 Linux 호스트 상태를 한 지역 문맥에서 조회합니다.</p>
              <div class="card-actions">
                <a class="btn btn-sm btn-primary" routerLink="/cc/cc2/kubernetes">Kubernetes</a>
                <a class="btn btn-sm btn-outline" routerLink="/cc/cc2/hosts">Linux 호스트</a>
              </div>
            </div>
          </article>

          <article class="card is-disabled" aria-disabled="true">
            <div class="card-block">
              <div class="card-title-row">
                <h3>CC1</h3>
                <span class="label">후속 연결</span>
              </div>
              <p>CC2 인수 검증 뒤 같은 계약으로 연결합니다.</p>
            </div>
          </article>
        </div>
      </section>

      <section class="contracts" aria-labelledby="contracts-title">
        <h2 id="contracts-title">운영 계약</h2>
        <ul>
          <li>사용자와 권한의 기준은 Supabase입니다.</li>
          <li>운영 변경은 Gitea 검토·승인 경로만 사용합니다.</li>
          <li>Kubernetes 직접 화면은 1차에서 읽기 전용입니다.</li>
          <li>Secret, exec, port-forward와 범용 쓰기는 차단합니다.</li>
        </ul>
      </section>
    </div>
  `,
  styles: [`
    .rcc-overview { margin: -1.5rem; min-height: calc(100% + 3rem); padding: 2rem; background: var(--os-overview-bg); }
    .hero { max-width: 64rem; padding: 1.25rem 0 2.25rem; }
    .eyebrow { margin: 0 0 .5rem; color: var(--os-accent); font-size: .72rem; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
    h1 { margin: 0; color: var(--os-ink); font-size: clamp(2rem, 4vw, 3.4rem); font-weight: 300; letter-spacing: -.03em; }
    .hero p:last-child { max-width: 48rem; color: var(--os-ink-muted); font-size: 1rem; }
    h2 { margin: 1.5rem 0 .75rem; color: var(--os-ink); font-size: 1rem; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr)); gap: 1rem; max-width: 64rem; }
    .card { margin: 0; }
    .card-title-row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
    .card-title-row h3 { margin: 0; font-size: 1.15rem; }
    .card p { min-height: 2.8rem; color: var(--os-ink-muted); }
    .card-actions { display: flex; flex-wrap: wrap; gap: .5rem; }
    .is-disabled { opacity: .68; }
    .contracts { max-width: 64rem; margin-top: 2rem; padding: 1rem 1.25rem; border: 1px solid var(--os-hairline); background: #fff; }
    .contracts h2 { margin-top: 0; }
    .contracts ul { margin-bottom: 0; padding-left: 1.2rem; color: var(--os-ink-muted); }
    .contracts li + li { margin-top: .35rem; }
  `],
})
export class RccOverviewPage {}
