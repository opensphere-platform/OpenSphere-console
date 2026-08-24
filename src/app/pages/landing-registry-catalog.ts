import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  selector: 'os-landing-registry-catalog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <article class="registry-doc">
      <section class="hero">
        <img src="/assets/pictograms/connected-ecosystem.svg" alt="Connected Registry and Catalog service" width="88" height="88" />
        <div>
          <p class="eyebrow">REGISTRY &amp; CATALOG · CBSS CORE SERVICE</p>
          <h1>설치 가능한 것과 현재 검증된 것을 하나의 revision으로 제공합니다.</h1>
          <p class="lead">Registry &amp; Catalog는 개념이나 DUPA 내부 캐시가 아니라 독립 배포·버전·상태 API를 가진 읽기 전용 Core Service입니다.</p>
        </div>
      </section>

      <dl class="identity">
        <div><dt>분류</dt><dd>CBSS Core Service</dd></div>
        <div><dt>제품</dt><dd>OpenSphere Registry &amp; Catalog Service</dd></div>
        <div><dt>공개 계약</dt><dd>GET /api/v1/registry</dd></div>
        <div><dt>내부 계약</dt><dd>POST /api/v1/registry/resolve</dd></div>
        <div><dt>쓰기 권한</dt><dd>없음 · read projection only</dd></div>
      </dl>

      <section class="registry-flow" aria-labelledby="registry-flow-title">
        <header><p class="eyebrow">DECLARATION TO OPERATION</p><h2 id="registry-flow-title">정의·선택·배포·운영의 권위를 섞지 않습니다.</h2></header>
        <div class="flow-grid">
          <article><span>01</span><img src="/assets/pictograms/systems.svg" alt="Declared sources" width="58" height="58" /><h3>Sources</h3><p>Extension Package·Registration과 Foundation module descriptor의 설치 자격·배포 출처를 관측합니다.</p><small>권위: 각 CR Owner</small></article>
          <b aria-hidden="true">→</b>
          <article><span>02</span><img src="/assets/pictograms/connected-ecosystem.svg" alt="Registry projection" width="58" height="58" /><h3>Registry projection</h3><p>검증된 객체만 정규화하고 source health, rejected object, canonical revision을 하나의 원자적 snapshot으로 게시합니다.</p><small>권위: Registry &amp; Catalog</small></article>
          <b aria-hidden="true">→</b>
          <article><span>03</span><img src="/assets/pictograms/control-panel.svg" alt="Deterministic selection" width="58" height="58" /><h3>Resolve</h3><p>OSCE가 channel·architecture·요청 plan을 현재 revision에 고정하여 결정적 후보를 얻습니다.</p><small>결과: revision-bound candidate</small></article>
          <b aria-hidden="true">→</b>
          <article><span>04</span><img src="/assets/pictograms/cloud-infrastructure-management.svg" alt="Deployment and lifecycle" width="58" height="58" /><h3>Execute &amp; operate</h3><p>Argo CD가 승인된 선언을 배포하고 PFSS Owner가 실제 인스턴스 lifecycle과 runtime truth를 책임집니다.</p><small>Registry는 직접 설치하지 않음</small></article>
        </div>
      </section>

      <section class="contract-grid">
        <article><p class="eyebrow">OWNS</p><h2>이 서비스가 소유하는 것</h2><ul><li>단일 discovery API와 snapshot schema</li><li>source readiness·freshness·rejection</li><li>Extension의 last-known-good 투영</li><li>Catalog 후보의 revision-bound resolution</li></ul></article>
        <article><p class="eyebrow">DOES NOT OWN</p><h2>의도적으로 소유하지 않는 것</h2><ul><li>DUPA의 설치·검증·롤백 lifecycle</li><li>Argo CD의 sync와 공급망 배포</li><li>PFSS instance의 reconcile·backup·restore</li><li>OSCE의 승인·실행·사후검증 operation</li></ul></article>
        <article><p class="eyebrow">CONSUMERS</p><h2>같은 revision을 읽는 표면</h2><ul><li>Console · 현재 Extension과 설치 가능 항목</li><li>OSC · 자동완성·조회·동일 candidate</li><li>OSAA · 현재 시스템 사실과 후보 설명</li><li>OSCE · durable operation의 선택 근거</li></ul></article>
      </section>

      <aside><strong>단순화 원칙</strong><span>별도 데이터베이스, 이벤트 버스, 범용 그래프 저장소를 추가하지 않습니다. Kubernetes watch → 메모리 snapshot → 단일 API라는 최소 구조로 시작하며, 실제 부하와 장애 증거가 생길 때만 확장합니다.</span></aside>
    </article>
  `,
  styles: [`
    :host{display:block;min-width:0;max-width:100%}.registry-doc{--body:.9rem;--detail:.8rem;display:grid;min-width:0;max-width:100%;gap:1.35rem;color:var(--os-ink)}
    .hero{display:grid;grid-template-columns:6rem minmax(0,1fr);gap:1.25rem;align-items:center;padding:1.5rem;border-inline-start:4px solid var(--os-accent);background:var(--os-canvas)}
    .eyebrow{margin:0;color:var(--os-accent);font-size:.7rem;font-weight:700;letter-spacing:.11em}.hero h1{max-width:68rem;margin:.35rem 0;font-size:1.55rem;line-height:1.25}.lead{max-width:72rem;margin:.55rem 0 0;color:var(--os-ink-muted);font-size:var(--body);line-height:1.6}
    .identity{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));margin:0;border:1px solid var(--os-hairline);background:var(--os-canvas)}.identity>div{padding:1rem;border-inline-end:1px solid var(--os-hairline)}.identity>div:last-child{border-inline-end:0}.identity dt{color:var(--os-ink-muted);font-size:.72rem}.identity dd{margin:.35rem 0 0;font-size:var(--detail);font-weight:650;line-height:1.45}
    .registry-flow{min-width:0;padding:1.3rem;border:1px solid var(--os-hairline);background:var(--os-canvas)}.registry-flow>header{display:block;min-height:0;margin:0 0 1rem;padding:0;background:transparent;color:var(--os-ink)}.registry-flow h2,.contract-grid h2{margin:.3rem 0;font-size:1.15rem}.flow-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr) 2rem) minmax(0,1fr);align-items:stretch;min-width:0}.flow-grid article{display:grid;grid-template-columns:auto 3.7rem minmax(0,1fr);min-width:0;gap:.35rem .7rem;align-content:start;padding:1rem;border:1px solid var(--os-hairline)}.flow-grid article>span{color:var(--os-accent);font:700 .68rem var(--os-font-mono)}.flow-grid article>img{grid-row:1/4}.flow-grid h3{margin:0;font-size:.92rem}.flow-grid p{grid-column:3;margin:.25rem 0;overflow-wrap:anywhere;color:var(--os-ink-muted);font-size:var(--detail);line-height:1.55}.flow-grid small{grid-column:3;color:var(--os-ink-subtle);font-size:.7rem}.flow-grid>b{display:grid;place-items:center;min-width:0;padding:.25rem;color:var(--os-accent);font-size:2rem}
    .contract-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border:1px solid var(--os-hairline);background:var(--os-canvas)}.contract-grid article{padding:1.15rem;border-inline-end:1px solid var(--os-hairline)}.contract-grid article:last-child{border-inline-end:0}.contract-grid ul{margin:.8rem 0 0;padding-inline-start:1.15rem}.contract-grid li{margin:.45rem 0;color:var(--os-ink-muted);font-size:var(--detail);line-height:1.45}
    aside{display:grid;grid-template-columns:9rem minmax(0,1fr);gap:1rem;padding:1rem;border-inline-start:3px solid #f1c21b;background:#fff8e1;color:#525252;font-size:var(--detail);line-height:1.55}aside strong{color:#684e00}
    @media(max-width:76rem){.identity,.contract-grid{grid-template-columns:1fr}.identity>div,.contract-grid article{border-inline-end:0;border-bottom:1px solid var(--os-hairline)}.identity>div:last-child,.contract-grid article:last-child{border-bottom:0}.flow-grid{grid-template-columns:1fr}.flow-grid>b{transform:rotate(90deg)}}
    @media(max-width:48rem){.hero{grid-template-columns:1fr}.flow-grid article{grid-template-columns:auto 1fr}.flow-grid article>img{grid-row:auto}.flow-grid p,.flow-grid small{grid-column:1/-1}aside{grid-template-columns:1fr}}
  `],
})
export class LandingRegistryCatalog {}
