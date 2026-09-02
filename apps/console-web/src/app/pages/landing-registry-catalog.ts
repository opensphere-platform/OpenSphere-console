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
          <p class="lead">Registry &amp; Catalog는 개념이나 DUPA 내부 캐시가 아니라 독립 배포·버전·상태 API를 가진 읽기 전용 Core Service입니다. 다만 Windows Registry처럼 설정을 저장·변경하는 중앙 DB나 모든 작업을 실행하는 controller는 아닙니다.</p>
        </div>
      </section>

      <dl class="identity">
        <div><dt>분류</dt><dd>CBSS Core Service</dd></div>
        <div><dt>제품</dt><dd>OpenSphere Registry &amp; Catalog Service</dd></div>
        <div><dt>공개 계약</dt><dd>GET /api/v1/registry</dd></div>
        <div><dt>내부 계약</dt><dd>POST /api/v1/registry/resolve</dd></div>
        <div><dt>쓰기 권한</dt><dd>없음 · read projection only</dd></div>
      </dl>

      <section class="scope-panel" aria-labelledby="registry-scope-title">
        <header>
          <p class="eyebrow">REAL SERVICE · LIMITED AUTHORITY</p>
          <h2 id="registry-scope-title">실체는 분명하지만, 현재 범위와 제어 권한은 제한되어 있습니다.</h2>
          <p>각 Owner의 원본을 읽어 공통 snapshot으로 제공하며, 등록되지 않은 구성요소는 Coverage gap으로 드러냅니다.</p>
        </header>
        <div class="scope-grid">
          <article>
            <span>현재 제공</span>
            <strong>Core Service + Extension + Module source</strong>
            <p>Release Lock, Package·Registration, Foundation descriptor를 같은 revision으로 정규화합니다.</p>
          </article>
          <article>
            <span>수렴 대상</span>
            <strong>공통 RegistryDescriptorV1 · Coverage</strong>
            <p>OSCE·OSDST·Registry 같은 Core Service와 Extension을 게시하고, exact artifact가 없는 Module은 gap으로 표시합니다.</p>
          </article>
          <article>
            <span>항상 Owner 소유</span>
            <strong>Instance + Runtime Catalog</strong>
            <p>PostgreSQL cluster, version·replica·storage·backup은 Registry에 복제하지 않고 PFSS Owner가 답합니다.</p>
          </article>
        </div>
      </section>

      <section class="registry-flow" aria-labelledby="registry-flow-title">
        <header><p class="eyebrow">DECLARATION TO OPERATION</p><h2 id="registry-flow-title">정의·선택·배포·운영의 권위를 섞지 않습니다.</h2></header>
        <div class="flow-grid">
          <article><span>01</span><img src="/assets/pictograms/systems.svg" alt="Declared sources" width="58" height="58" /><h3>Sources</h3><p>Release Lock, Extension Package·Registration과 Foundation module descriptor의 설치 자격·배포 출처를 관측합니다.</p><small>권위: Release · 각 CR Owner</small></article>
          <b aria-hidden="true">→</b>
          <article><span>02</span><img src="/assets/pictograms/connected-ecosystem.svg" alt="Registry projection" width="58" height="58" /><h3>Registry projection</h3><p>검증된 객체만 정규화하고 source health, rejected object, canonical revision을 하나의 원자적 snapshot으로 게시합니다.</p><small>권위: Registry &amp; Catalog</small></article>
          <b aria-hidden="true">→</b>
          <article><span>03</span><img src="/assets/pictograms/control-panel.svg" alt="Deterministic selection" width="58" height="58" /><h3>Resolve</h3><p>OSCE가 channel·architecture·요청 plan을 현재 revision에 고정하여 결정적 후보를 얻습니다.</p><small>결과: revision-bound candidate</small></article>
          <b aria-hidden="true">→</b>
          <article><span>04</span><img src="/assets/pictograms/cloud-infrastructure-management.svg" alt="Deployment and lifecycle" width="58" height="58" /><h3>Execute &amp; operate</h3><p>Argo CD가 승인된 선언을 배포하고 PFSS Owner가 실제 인스턴스 lifecycle과 runtime truth를 책임집니다.</p><small>Registry는 직접 설치하지 않음</small></article>
        </div>
      </section>

      <section class="descriptor-model" aria-labelledby="descriptor-model-title">
        <header>
          <p class="eyebrow">COMMON READ MODEL</p>
          <h2 id="descriptor-model-title">서로 다른 원본을 없애지 않고, 소비자가 읽는 언어만 통일합니다.</h2>
          <p>공통 Descriptor는 새 범용 CRD가 아니라 source별 객체에서 허용된 필드만 선택한 Registry의 공개 응답입니다.</p>
        </header>
        <div class="descriptor-grid">
          <article>
            <img src="/assets/pictograms/control-tower.svg" alt="CBSS Core Service descriptor" width="52" height="52" />
            <div><small>CORE SERVICE</small><h3>Component</h3></div>
            <p>OSCE·OSDST·Registry의 identity, Owner, version과 exact digest를 표현합니다.</p>
            <strong>운영은 각 Service Owner</strong>
          </article>
          <article>
            <img src="/assets/pictograms/connected-ecosystem.svg" alt="Console Extension descriptor" width="52" height="52" />
            <div><small>CONSOLE EXTENSION</small><h3>Extension</h3></div>
            <p>subShell·plugin·System Plugin의 Package, Registration과 검증 상태를 표현합니다.</p>
            <strong>lifecycle은 DUPA Controller</strong>
          </article>
          <article>
            <img src="/assets/pictograms/cloud-infrastructure-management.svg" alt="Installable module descriptor" width="52" height="52" />
            <div><small>INSTALLABLE</small><h3>Module</h3></div>
            <p>설치 가능한 PFSS/HISS 기능의 identity, source와 설치 정책을 표현합니다.</p>
            <strong>실행은 OSCE · Argo CD · Owner</strong>
          </article>
          <article class="outside">
            <img src="/assets/pictograms/systems.svg" alt="Runtime instance outside Registry" width="52" height="52" />
            <div><small>OUTSIDE REGISTRY</small><h3>Instance · Runtime</h3></div>
            <p>실제 cluster와 제품별 version/profile/capacity는 현재 상태의 Owner API에서 조회합니다.</p>
            <strong>Registry가 추정하지 않음</strong>
          </article>
        </div>
      </section>

      <section class="coverage-panel" aria-labelledby="coverage-title">
        <div>
          <p class="eyebrow">COVERAGE</p>
          <h2 id="coverage-title">보여야 할 대상과 실제 게시된 대상을 함께 계산합니다.</h2>
          <p>목록에 없다는 사실을 “미설치”나 “정상”으로 해석하지 않습니다. expected 대상이 Descriptor를 게시하지 못하면 누락 사유를 명시합니다.</p>
        </div>
        <dl>
          <div><dt>Expected</dt><dd>현재 release에서 보여야 할 Module·Component·Extension</dd></div>
          <div><dt>Published</dt><dd>검증을 통과해 현재 revision에 포함된 Descriptor</dd></div>
          <div><dt>Missing · Rejected</dt><dd>DescriptorMissing·DigestMissing·UnverifiedSource 등 명시적 gap</dd></div>
        </dl>
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
    :host{display:block;min-width:0;max-width:100%}.registry-doc{--body:.9rem;--detail:.8rem;display:grid;grid-template-columns:minmax(0,1fr);min-width:0;max-width:100%;gap:1.35rem;color:var(--os-ink)}
    .hero{display:grid;grid-template-columns:6rem minmax(0,1fr);gap:1.25rem;align-items:center;padding:1.5rem;border-inline-start:4px solid var(--os-accent);background:var(--os-canvas)}
    .eyebrow{margin:0;color:var(--os-accent);font-size:.7rem;font-weight:700;letter-spacing:.11em}.hero h1{max-width:68rem;margin:.35rem 0;font-size:1.55rem;line-height:1.25}.lead{max-width:72rem;margin:.55rem 0 0;color:var(--os-ink-muted);font-size:var(--body);line-height:1.6}
    .identity{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));margin:0;border:1px solid var(--os-hairline);background:var(--os-canvas)}.identity>div{padding:1rem;border-inline-end:1px solid var(--os-hairline)}.identity>div:last-child{border-inline-end:0}.identity dt{color:var(--os-ink-muted);font-size:.72rem}.identity dd{margin:.35rem 0 0;font-size:var(--detail);font-weight:650;line-height:1.45}
    .scope-panel,.descriptor-model{padding:1.3rem;border:1px solid var(--os-hairline);background:var(--os-canvas)}.scope-panel>header,.descriptor-model>header{min-width:0;margin-bottom:1rem;white-space:normal}.scope-panel h2,.descriptor-model h2,.coverage-panel h2{margin:.3rem 0;font-size:1.15rem;line-height:1.35}.scope-panel header>p:last-child,.descriptor-model header>p:last-child,.coverage-panel>div>p:last-child{max-width:74rem;margin:.45rem 0 0;overflow-wrap:anywhere;color:var(--os-ink-muted);font-size:var(--detail);line-height:1.55}
    .scope-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border:1px solid var(--os-hairline)}.scope-grid article{min-width:0;padding:1rem;border-inline-end:1px solid var(--os-hairline)}.scope-grid article:last-child{border-inline-end:0}.scope-grid span,.descriptor-grid small{color:var(--os-accent);font-size:.7rem;font-weight:700;letter-spacing:.07em}.scope-grid strong{display:block;margin:.45rem 0;font-size:.92rem;line-height:1.4}.scope-grid p{margin:0;color:var(--os-ink-muted);font-size:var(--detail);line-height:1.55}
    .registry-flow{min-width:0;padding:1.3rem;border:1px solid var(--os-hairline);background:var(--os-canvas)}.registry-flow>header{display:block;min-height:0;margin:0 0 1rem;padding:0;background:transparent;color:var(--os-ink)}.registry-flow h2,.contract-grid h2{margin:.3rem 0;font-size:1.15rem}.flow-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr) 2rem) minmax(0,1fr);align-items:stretch;min-width:0}.flow-grid article{display:grid;grid-template-columns:auto 3.7rem minmax(0,1fr);min-width:0;gap:.35rem .7rem;align-content:start;padding:1rem;border:1px solid var(--os-hairline)}.flow-grid article>span{color:var(--os-accent);font:700 .68rem var(--os-font-mono)}.flow-grid article>img{grid-row:1/4}.flow-grid h3{margin:0;overflow-wrap:anywhere;font-size:.92rem}.flow-grid p{grid-column:3;margin:.25rem 0;overflow-wrap:anywhere;color:var(--os-ink-muted);font-size:var(--detail);line-height:1.55}.flow-grid small{grid-column:3;overflow-wrap:anywhere;color:var(--os-ink-subtle);font-size:.7rem}.flow-grid>b{display:grid;place-items:center;min-width:0;padding:.25rem;color:var(--os-accent);font-size:2rem}
    .contract-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border:1px solid var(--os-hairline);background:var(--os-canvas)}.contract-grid article{padding:1.15rem;border-inline-end:1px solid var(--os-hairline)}.contract-grid article:last-child{border-inline-end:0}.contract-grid ul{margin:.8rem 0 0;padding-inline-start:1.15rem}.contract-grid li{margin:.45rem 0;color:var(--os-ink-muted);font-size:var(--detail);line-height:1.45}
    .descriptor-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border:1px solid var(--os-hairline)}.descriptor-grid article{display:grid;grid-template-columns:3.3rem minmax(0,1fr);min-width:0;gap:.6rem .75rem;padding:1rem;border-inline-end:1px solid var(--os-hairline)}.descriptor-grid article:last-child{border-inline-end:0}.descriptor-grid article.outside{background:var(--os-surface-1)}.descriptor-grid img{width:3rem;height:3rem;object-fit:contain}.descriptor-grid h3{margin:.2rem 0 0;font-size:.94rem}.descriptor-grid p,.descriptor-grid strong{grid-column:1/-1}.descriptor-grid p{margin:.35rem 0;color:var(--os-ink-muted);font-size:var(--detail);line-height:1.55}.descriptor-grid strong{padding-top:.6rem;border-top:1px solid var(--os-hairline);font-size:var(--detail);line-height:1.4}
    .coverage-panel{display:grid;grid-template-columns:minmax(18rem,.7fr) minmax(0,1.3fr);gap:1.25rem;padding:1.3rem;border-inline-start:4px solid var(--os-accent);background:var(--os-surface-1)}.coverage-panel dl{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin:0;border:1px solid var(--os-hairline);background:var(--os-canvas)}.coverage-panel dl>div{min-width:0;padding:1rem;border-inline-end:1px solid var(--os-hairline)}.coverage-panel dl>div:last-child{border-inline-end:0}.coverage-panel dt{color:var(--os-accent);font-size:.72rem;font-weight:700}.coverage-panel dd{margin:.4rem 0 0;overflow-wrap:anywhere;color:var(--os-ink-muted);font-size:var(--detail);line-height:1.5}
    aside{display:grid;grid-template-columns:9rem minmax(0,1fr);gap:1rem;padding:1rem;border-inline-start:3px solid #f1c21b;background:#fff8e1;color:#525252;font-size:var(--detail);line-height:1.55}aside strong{color:#684e00}
    @media(max-width:76rem){.identity,.contract-grid,.scope-grid,.descriptor-grid,.coverage-panel,.coverage-panel dl{grid-template-columns:1fr}.identity>div,.contract-grid article,.scope-grid article,.descriptor-grid article,.coverage-panel dl>div{border-inline-end:0;border-bottom:1px solid var(--os-hairline)}.identity>div:last-child,.contract-grid article:last-child,.scope-grid article:last-child,.descriptor-grid article:last-child,.coverage-panel dl>div:last-child{border-bottom:0}.flow-grid{grid-template-columns:1fr}.flow-grid>b{transform:rotate(90deg)}}
    @media(max-width:48rem){.hero{grid-template-columns:1fr}.flow-grid article{grid-template-columns:auto 1fr}.flow-grid article>img{grid-row:auto}.flow-grid p,.flow-grid small{grid-column:1/-1}aside{grid-template-columns:1fr}}
  `],
})
export class LandingRegistryCatalog {}
