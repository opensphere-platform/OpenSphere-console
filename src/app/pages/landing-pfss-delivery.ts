import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  selector: 'os-landing-pfss-delivery',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <article class="delivery-page" aria-labelledby="pfss-delivery-title">
      <header class="delivery-intro">
        <div class="delivery-intro-title">
          <img
            src="/assets/pictograms/connected-ecosystem.svg"
            alt="Connected PFSS delivery lifecycle"
            width="72"
            height="72"
          />
          <div>
            <p class="delivery-eyebrow">PFSS DELIVERY CONTROL LOOP</p>
            <h1 id="pfss-delivery-title">PFSS 모듈은 어떻게 설치·운영·업데이트되는가</h1>
          </div>
        </div>
        <p>
          관리자는 Catalog에서 모듈을 선택하지만, 한 제품이 모든 일을 처리하지 않습니다.
          판단·승인·선언·배포·운영을 각 권위가 이어받고, 업데이트는 같은 흐름으로 다시 진입합니다.
        </p>
      </header>

      <section class="delivery-flow" aria-labelledby="delivery-flow-title">
        <div class="delivery-section-heading">
          <div>
            <p class="delivery-eyebrow">INSTALLATION FLOW</p>
            <h2 id="delivery-flow-title">선택에서 운영까지, 여섯 번의 명확한 책임 이동</h2>
          </div>
          <p>
            각 단계의 출력이 다음 단계의 입력이 되며, 앞 단계를 건너뛴 직접 배포는 정상 경로가
            아닙니다.
          </p>
        </div>

        <ol class="delivery-steps">
          <li>
            <span class="step-number">01</span>
            <img
              src="/assets/pictograms/connected-ecosystem.svg"
              alt="Foundation Registry and Catalog"
              width="52"
              height="52"
            />
            <div>
              <small>DISCOVER</small>
              <h3>Registry / Catalog</h3>
            </div>
            <p>서명·호환성·채널·필수 입력을 검증해 설치 가능한 모듈과 버전을 제시합니다.</p>
            <strong>출력 · 검증된 설치 후보</strong>
          </li>
          <li>
            <span class="step-number">02</span>
            <img
              src="/assets/pictograms/control-panel.svg"
              alt="OSCE authorization and planning"
              width="52"
              height="52"
            />
            <div>
              <small>AUTHORIZE</small>
              <h3>Console + OSCE</h3>
            </div>
            <p>관리자 요청을 받아 정책·영향·승인을 확인하고 정확한 변경 계획을 만듭니다.</p>
            <strong>출력 · 승인된 operation plan</strong>
          </li>
          <li>
            <span class="step-number">03</span>
            <img
              class="product-logo"
              src="/assets/product-logos/gitea.svg"
              alt="Gitea"
              width="52"
              height="52"
            />
            <div>
              <small>DECLARE</small>
              <h3>Gitea</h3>
            </div>
            <p>
              설치 대상, 구성, exact image digest를 desired state로 기록하고 변경 이력을 보존합니다.
            </p>
            <strong>출력 · 감사 가능한 Git revision</strong>
          </li>
          <li>
            <span class="step-number">04</span>
            <img
              class="product-logo"
              src="/assets/product-logos/argocd.svg"
              alt="Argo CD"
              width="52"
              height="52"
            />
            <div>
              <small>RECONCILE</small>
              <h3>Argo CD</h3>
            </div>
            <p>Gitea의 승인된 선언을 Kubernetes에 동기화하고 Sync·Health·Drift를 관찰합니다.</p>
            <strong>출력 · 배포 상태와 동기화 증거</strong>
          </li>
          <li>
            <span class="step-number">05</span>
            <img
              src="/assets/pictograms/cloud-infrastructure-management.svg"
              alt="PFSS owner and operator"
              width="52"
              height="52"
            />
            <div>
              <small>OPERATE</small>
              <h3>PFSS Owner / Operator</h3>
            </div>
            <p>서비스 생성·확장·백업·복구·마이그레이션과 실제 domain health를 책임집니다.</p>
            <strong>출력 · 소비 가능한 PFSS capability</strong>
          </li>
          <li>
            <span class="step-number">06</span>
            <img
              src="/assets/pictograms/systems.svg"
              alt="Verified operating evidence"
              width="52"
              height="52"
            />
            <div>
              <small>VERIFY</small>
              <h3>OSCE Postcondition</h3>
            </div>
            <p>
              배포와 서비스 상태를 함께 검증해 operation을 종료하고 현재 증거를 Console에
              돌려줍니다.
            </p>
            <strong>출력 · 완료 receipt 또는 rollback</strong>
          </li>
        </ol>
      </section>

      <section class="update-loop" aria-labelledby="update-loop-title">
        <div class="loop-title">
          <img
            src="/assets/pictograms/systems.svg"
            alt="PFSS update control loop"
            width="64"
            height="64"
          />
          <div>
            <p class="delivery-eyebrow">UPDATE LOOP</p>
            <h2 id="update-loop-title">
              업데이트는 자동 덮어쓰기가 아니라 같은 통제 흐름의 재실행입니다
            </h2>
            <p>
              새 버전의 발견만으로 설치 상태는 변하지 않습니다. 승인된 exact digest가 Gitea에 선언된
              뒤에만 Argo CD가 동기화합니다.
            </p>
          </div>
        </div>
        <ol>
          <li>
            <span>1</span><strong>Registry가 새 버전 발견</strong
            ><small>서명·호환성·정책 검증</small>
          </li>
          <li>
            <span>2</span><strong>OSCE가 변경 승인</strong><small>영향·백업·rollback 계획</small>
          </li>
          <li>
            <span>3</span><strong>Gitea desired state 갱신</strong
            ><small>새 exact digest와 설정 revision</small>
          </li>
          <li>
            <span>4</span><strong>Argo CD가 배포 동기화</strong
            ><small>Sync·Health·Drift evidence</small>
          </li>
          <li>
            <span>5</span><strong>PFSS Owner가 전환 검증</strong
            ><small>migration·service health·postcondition</small>
          </li>
        </ol>
      </section>

      <section class="delivery-boundaries" aria-labelledby="delivery-boundaries-title">
        <div class="delivery-section-heading">
          <div>
            <p class="delivery-eyebrow">AUTHORITY BOUNDARIES</p>
            <h2 id="delivery-boundaries-title">누가 무엇을 결정하고 실행하는가</h2>
          </div>
          <p>Argo CD는 App Store가 아니며 Registry 업데이트를 스스로 선택하지 않습니다.</p>
        </div>
        <dl>
          <div>
            <dt>설치·업데이트 가능 판단</dt>
            <dd>Foundation Registry / Catalog</dd>
          </div>
          <div>
            <dt>관리 요청·정책·승인</dt>
            <dd>Console + OSCE</dd>
          </div>
          <div>
            <dt>Desired-state 정본</dt>
            <dd>Gitea</dd>
          </div>
          <div>
            <dt>Kubernetes 배포 실행</dt>
            <dd>Argo CD · HISS Platform Support Controller</dd>
          </div>
          <div>
            <dt>설치 후 서비스 lifecycle</dt>
            <dd>PFSS Owner / Operator</dd>
          </div>
          <div>
            <dt>최종 완료·복구 판정</dt>
            <dd>OSCE + component postcondition</dd>
          </div>
        </dl>
      </section>

      <aside class="delivery-rule" aria-label="PFSS delivery operating rule">
        <img
          src="/assets/pictograms/control-tower.svg"
          alt="Controlled PFSS delivery"
          width="48"
          height="48"
        />
        <p>
          <strong>한 문장으로:</strong> Catalog가 판단하고, OSCE가 승인하며, Gitea가 선언하고, Argo
          CD가 배포하며, PFSS Owner가 운영합니다.
        </p>
      </aside>
    </article>
  `,
  styles: [
    `
      :host {
        display: block;
        min-width: 0;
        max-width: 100%;
      }
      .delivery-page {
        --delivery-page-title: var(--arch-page-title, clamp(1.55rem, 2.2vw, 2rem));
        --delivery-section-title: var(--arch-section-title, 1.2rem);
        --delivery-card-title: var(--arch-card-title, 0.98rem);
        --delivery-body: var(--arch-body, 0.9rem);
        --delivery-detail: var(--arch-body, 0.9rem);
        --delivery-label: var(--arch-detail, 0.8rem);
        min-width: 0;
        max-width: 100%;
        color: var(--os-ink);
      }
      .delivery-intro {
        display: grid;
        grid-template-columns: minmax(0, 1.45fr) minmax(20rem, 0.75fr);
        gap: 2.5rem;
        align-items: end;
        padding: 1.25rem 0 1.75rem;
        border-bottom: 1px solid var(--os-hairline);
      }
      .delivery-intro-title {
        display: grid;
        grid-template-columns: 5.5rem minmax(0, 1fr);
        gap: 1rem;
        align-items: center;
      }
      .delivery-intro-title img {
        width: 5rem;
        height: 5rem;
        object-fit: contain;
      }
      .delivery-eyebrow {
        margin: 0 0 0.5rem;
        color: var(--os-accent);
        font-size: var(--delivery-label);
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
      }
      h1 {
        margin: 0;
        font-size: var(--delivery-page-title);
        font-weight: 500;
        letter-spacing: -0.025em;
        line-height: 1.14;
      }
      .delivery-intro > p {
        max-width: 40rem;
        margin: 0;
        color: var(--os-ink-muted);
        font-size: var(--delivery-body);
        line-height: 1.65;
      }
      .delivery-flow,
      .update-loop,
      .delivery-boundaries {
        margin-top: 2rem;
      }
      .delivery-section-heading {
        display: flex;
        justify-content: space-between;
        gap: 2rem;
        align-items: end;
        margin-bottom: 0.7rem;
      }
      .delivery-section-heading h2,
      .loop-title h2 {
        margin: 0;
        font-size: var(--delivery-section-title);
        font-weight: 550;
        line-height: 1.3;
      }
      .delivery-section-heading > p {
        max-width: 38rem;
        margin: 0;
        color: var(--os-ink-muted);
        font-size: var(--delivery-detail);
        line-height: 1.55;
        text-align: right;
      }
      .delivery-steps {
        display: grid;
        grid-template-columns: repeat(6, minmax(0, 1fr));
        margin: 0;
        padding: 0;
        border: 1px solid var(--os-hairline);
        background: var(--os-canvas);
        list-style: none;
      }
      .delivery-steps li {
        position: relative;
        display: grid;
        grid-template-columns: 3rem minmax(0, 1fr);
        align-content: start;
        gap: 0.5rem 0.7rem;
        min-width: 0;
        min-height: 16rem;
        padding: 1rem;
        border-right: 1px solid var(--os-hairline);
      }
      .delivery-steps li:last-child {
        border-right: 0;
      }
      .delivery-steps li:not(:last-child)::after {
        content: '›';
        position: absolute;
        z-index: 1;
        top: 50%;
        right: -0.58rem;
        display: grid;
        place-items: center;
        width: 1.1rem;
        height: 1.6rem;
        margin-top: -0.8rem;
        background: var(--os-canvas);
        color: var(--os-accent);
        font-size: 1.35rem;
        line-height: 1;
      }
      .step-number {
        grid-column: 1/-1;
        color: var(--os-accent);
        font: var(--delivery-label) var(--os-font-mono);
      }
      .delivery-steps img {
        width: 2.8rem;
        height: 2.8rem;
        object-fit: contain;
      }
      .delivery-steps .product-logo {
        padding: 0.2rem;
      }
      .delivery-steps small {
        color: var(--os-accent);
        font-size: var(--delivery-label);
        font-weight: 700;
        letter-spacing: 0.06em;
      }
      .delivery-steps h3 {
        margin: 0.15rem 0 0;
        font-size: var(--delivery-card-title);
        line-height: 1.3;
      }
      .delivery-steps p {
        grid-column: 1/-1;
        margin: 0.35rem 0 0;
        color: var(--os-ink-muted);
        font-size: var(--delivery-detail);
        line-height: 1.55;
      }
      .delivery-steps strong {
        grid-column: 1/-1;
        align-self: end;
        margin-top: auto;
        padding-top: 0.65rem;
        border-top: 1px solid var(--os-hairline);
        font-size: var(--delivery-detail);
        line-height: 1.4;
      }
      .update-loop {
        border: 1px solid var(--os-hairline);
        background: var(--os-canvas);
      }
      .loop-title {
        display: grid;
        grid-template-columns: 4.5rem minmax(0, 1fr);
        gap: 1rem;
        align-items: start;
        padding: 1rem;
        border-bottom: 1px solid var(--os-hairline);
        background: var(--os-surface-1);
      }
      .loop-title img {
        width: 4rem;
        height: 4rem;
        object-fit: contain;
      }
      .loop-title p:last-child {
        max-width: 65rem;
        margin: 0.5rem 0 0;
        color: var(--os-ink-muted);
        font-size: var(--delivery-detail);
        line-height: 1.55;
      }
      .update-loop ol {
        display: grid;
        grid-template-columns: repeat(5, minmax(0, 1fr));
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .update-loop li {
        position: relative;
        min-height: 7rem;
        padding: 1rem;
        border-right: 1px solid var(--os-hairline);
      }
      .update-loop li:last-child {
        border-right: 0;
      }
      .update-loop li:not(:last-child)::after {
        content: '→';
        position: absolute;
        top: 0.9rem;
        right: 0.65rem;
        color: var(--os-accent);
        font-size: 1rem;
      }
      .update-loop li span {
        display: grid;
        place-items: center;
        width: 1.6rem;
        height: 1.6rem;
        margin-bottom: 0.65rem;
        border-radius: 50%;
        background: var(--os-accent);
        color: #fff;
        font: var(--delivery-label) var(--os-font-mono);
      }
      .update-loop strong,
      .update-loop small {
        display: block;
      }
      .update-loop strong {
        font-size: var(--delivery-card-title);
        line-height: 1.35;
      }
      .update-loop small {
        margin-top: 0.35rem;
        color: var(--os-ink-muted);
        font-size: var(--delivery-detail);
        line-height: 1.45;
      }
      .delivery-boundaries dl {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        margin: 0;
        border: 1px solid var(--os-hairline);
        background: var(--os-canvas);
      }
      .delivery-boundaries dl > div {
        min-width: 0;
        padding: 1rem;
        border-right: 1px solid var(--os-hairline);
        border-bottom: 1px solid var(--os-hairline);
      }
      .delivery-boundaries dl > div:nth-child(3n) {
        border-right: 0;
      }
      .delivery-boundaries dl > div:nth-last-child(-n + 3) {
        border-bottom: 0;
      }
      .delivery-boundaries dt {
        color: var(--os-ink-muted);
        font-size: var(--delivery-label);
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      .delivery-boundaries dd {
        margin: 0.45rem 0 0;
        font-size: var(--delivery-body);
        font-weight: 650;
        line-height: 1.45;
      }
      .delivery-rule {
        display: grid;
        grid-template-columns: 3.4rem minmax(0, 1fr);
        gap: 0.85rem;
        align-items: center;
        margin-top: 1rem;
        padding: 1rem;
        border-left: 4px solid var(--os-accent);
        background: var(--os-accent-subtle);
      }
      .delivery-rule img {
        width: 3rem;
        height: 3rem;
        object-fit: contain;
      }
      .delivery-rule p {
        margin: 0;
        font-size: var(--delivery-body);
        line-height: 1.6;
      }
      @media (max-width: 82rem) {
        .delivery-steps {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }
        .delivery-steps li {
          min-height: 13rem;
          border-bottom: 1px solid var(--os-hairline);
        }
        .delivery-steps li:nth-child(3n) {
          border-right: 0;
        }
        .delivery-steps li:nth-child(n + 4) {
          border-bottom: 0;
        }
        .delivery-steps li:nth-child(3)::after {
          display: none;
        }
      }
      @media (max-width: 62rem) {
        .delivery-intro {
          grid-template-columns: 1fr;
          gap: 1rem;
        }
        .delivery-section-heading {
          display: block;
        }
        .delivery-section-heading > p {
          margin-top: 0.4rem;
          text-align: left;
        }
        .update-loop ol {
          grid-template-columns: 1fr;
        }
        .update-loop li {
          min-height: 0;
          border-right: 0;
          border-bottom: 1px solid var(--os-hairline);
        }
        .update-loop li:last-child {
          border-bottom: 0;
        }
        .update-loop li:not(:last-child)::after {
          content: '↓';
          top: auto;
          right: 1rem;
          bottom: -0.7rem;
          padding: 0.1rem 0.25rem;
          background: var(--os-canvas);
        }
        .delivery-boundaries dl {
          grid-template-columns: 1fr;
        }
        .delivery-boundaries dl > div,
        .delivery-boundaries dl > div:nth-child(3n),
        .delivery-boundaries dl > div:nth-last-child(-n + 3) {
          border-right: 0;
          border-bottom: 1px solid var(--os-hairline);
        }
        .delivery-boundaries dl > div:last-child {
          border-bottom: 0;
        }
      }
      @media (max-width: 44rem) {
        .delivery-intro-title {
          grid-template-columns: 1fr;
        }
        .delivery-steps {
          grid-template-columns: 1fr;
        }
        .delivery-steps li,
        .delivery-steps li:nth-child(3n),
        .delivery-steps li:nth-child(n + 4) {
          min-height: 0;
          border-right: 0;
          border-bottom: 1px solid var(--os-hairline);
        }
        .delivery-steps li:last-child {
          border-bottom: 0;
        }
        .delivery-steps li:not(:last-child)::after {
          content: '↓';
          top: auto;
          right: 1rem;
          bottom: -0.7rem;
          padding: 0.1rem 0.25rem;
          background: var(--os-canvas);
        }
        .loop-title {
          grid-template-columns: 1fr;
        }
      }
    `,
  ],
})
export class LandingPfssDelivery {}
