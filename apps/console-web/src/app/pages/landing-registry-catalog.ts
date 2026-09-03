import { ConsoleIndexContentService } from '../core/console-index-content.service';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

@Component({
  selector: 'os-landing-registry-catalog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <article class="registry-doc">
      <section class="hero">
        <img src="/assets/pictograms/connected-ecosystem.svg" [attr.alt]="copy('connected-registry-and-catalog-service')" width="88" height="88" />
        <div>
          <p class="eyebrow">{{ copy('registry-catalog-cbss-core-service') }}</p>
          <h1>{{ copy('설치-가능한-것과-현재-검증된-것을-하나의-revision으로-제공합니다') }}</h1>
          <p class="lead">{{ copy('registry-catalog는-개념이나-dupa-내부-캐시가-아니라-독립-배포-버전-상태-api를-가진-읽기-전용-core') }}</p>
        </div>
      </section>

      <dl class="identity">
        <div><dt>{{ copy('분류') }}</dt><dd>{{ copy('cbss-core-service') }}</dd></div>
        <div><dt>{{ copy('제품') }}</dt><dd>{{ copy('opensphere-registry-catalog-service') }}</dd></div>
        <div><dt>{{ copy('공개-계약') }}</dt><dd>{{ copy('get-api-v1-registry') }}</dd></div>
        <div><dt>{{ copy('내부-계약') }}</dt><dd>{{ copy('post-api-v1-registry-resolve') }}</dd></div>
        <div><dt>{{ copy('쓰기-권한') }}</dt><dd>{{ copy('없음-read-projection-only') }}</dd></div>
      </dl>

      <section class="scope-panel" aria-labelledby="registry-scope-title">
        <header>
          <p class="eyebrow">{{ copy('real-service-limited-authority') }}</p>
          <h2 id="registry-scope-title">{{ copy('실체는-분명하지만-현재-범위와-제어-권한은-제한되어-있습니다') }}</h2>
          <p>{{ copy('각-owner의-원본을-읽어-공통-snapshot으로-제공하며-등록되지-않은-구성요소는-coverage-gap으로-드러냅니다') }}</p>
        </header>
        <div class="scope-grid">
          <article>
            <span>{{ copy('현재-제공') }}</span>
            <strong>{{ copy('core-service-extension-module-source') }}</strong>
            <p>{{ copy('release-lock-package-registration-foundation-descriptor를-같은-revision으로') }}</p>
          </article>
          <article>
            <span>{{ copy('수렴-대상') }}</span>
            <strong>{{ copy('공통-registrydescriptorv1-coverage') }}</strong>
            <p>{{ copy('osce-osdst-registry-같은-core-service와-extension을-게시하고-exact-artifact가-없') }}</p>
          </article>
          <article>
            <span>{{ copy('항상-owner-소유') }}</span>
            <strong>{{ copy('instance-runtime-catalog') }}</strong>
            <p>{{ copy('postgresql-cluster-version-replica-storage-backup은-registry에-복제하지-않고-p') }}</p>
          </article>
        </div>
      </section>

      <section class="registry-flow" aria-labelledby="registry-flow-title">
        <header><p class="eyebrow">{{ copy('declaration-to-operation') }}</p><h2 id="registry-flow-title">{{ copy('정의-선택-배포-운영의-권위를-섞지-않습니다') }}</h2></header>
        <div class="flow-grid">
          <article><span>{{ copy('01') }}</span><img src="/assets/pictograms/systems.svg" [attr.alt]="copy('declared-sources')" width="58" height="58" /><h3>{{ copy('sources') }}</h3><p>{{ copy('release-lock-extension-package-registration과-foundation-module-descrip') }}</p><small>{{ copy('권위-release-각-cr-owner') }}</small></article>
          <b aria-hidden="true">{{ copy('symbol') }}</b>
          <article><span>{{ copy('02') }}</span><img src="/assets/pictograms/connected-ecosystem.svg" [attr.alt]="copy('registry-projection')" width="58" height="58" /><h3>{{ copy('registry-projection') }}</h3><p>{{ copy('검증된-객체만-정규화하고-source-health-rejected-object-canonical-revision을-하나의-원자') }}</p><small>{{ copy('권위-registry-catalog') }}</small></article>
          <b aria-hidden="true">{{ copy('symbol') }}</b>
          <article><span>{{ copy('03') }}</span><img src="/assets/pictograms/control-panel.svg" [attr.alt]="copy('deterministic-selection')" width="58" height="58" /><h3>{{ copy('resolve') }}</h3><p>{{ copy('osce가-channel-architecture-요청-plan을-현재-revision에-고정하여-결정적-후보를-얻습니다') }}</p><small>{{ copy('결과-revision-bound-candidate') }}</small></article>
          <b aria-hidden="true">{{ copy('symbol') }}</b>
          <article><span>{{ copy('04') }}</span><img src="/assets/pictograms/cloud-infrastructure-management.svg" [attr.alt]="copy('deployment-and-lifecycle')" width="58" height="58" /><h3>{{ copy('execute-operate') }}</h3><p>{{ copy('argo-cd가-승인된-선언을-배포하고-pfss-owner가-실제-인스턴스-lifecycle과-runtime-truth를-책임') }}</p><small>{{ copy('registry는-직접-설치하지-않음') }}</small></article>
        </div>
      </section>

      <section class="descriptor-model" aria-labelledby="descriptor-model-title">
        <header>
          <p class="eyebrow">{{ copy('common-read-model') }}</p>
          <h2 id="descriptor-model-title">{{ copy('서로-다른-원본을-없애지-않고-소비자가-읽는-언어만-통일합니다') }}</h2>
          <p>{{ copy('공통-descriptor는-새-범용-crd가-아니라-source별-객체에서-허용된-필드만-선택한-registry의-공개-응답입') }}</p>
        </header>
        <div class="descriptor-grid">
          <article>
            <img src="/assets/pictograms/control-tower.svg" [attr.alt]="copy('cbss-core-service-descriptor')" width="52" height="52" />
            <div><small>{{ copy('core-service') }}</small><h3>{{ copy('component') }}</h3></div>
            <p>{{ copy('osce-osdst-registry의-identity-owner-version과-exact-digest를-표현합니다') }}</p>
            <strong>{{ copy('운영은-각-service-owner') }}</strong>
          </article>
          <article>
            <img src="/assets/pictograms/connected-ecosystem.svg" [attr.alt]="copy('console-extension-descriptor')" width="52" height="52" />
            <div><small>{{ copy('console-extension') }}</small><h3>{{ copy('extension') }}</h3></div>
            <p>{{ copy('subshell-plugin-system-plugin의-package-registration과-검증-상태를-표현합니다') }}</p>
            <strong>{{ copy('lifecycle은-dupa-controller') }}</strong>
          </article>
          <article>
            <img src="/assets/pictograms/cloud-infrastructure-management.svg" [attr.alt]="copy('installable-module-descriptor')" width="52" height="52" />
            <div><small>{{ copy('installable') }}</small><h3>{{ copy('module') }}</h3></div>
            <p>{{ copy('설치-가능한-pfss-hiss-기능의-identity-source와-설치-정책을-표현합니다') }}</p>
            <strong>{{ copy('실행은-osce-argo-cd-owner') }}</strong>
          </article>
          <article class="outside">
            <img src="/assets/pictograms/systems.svg" [attr.alt]="copy('runtime-instance-outside-registry')" width="52" height="52" />
            <div><small>{{ copy('outside-registry') }}</small><h3>{{ copy('instance-runtime') }}</h3></div>
            <p>{{ copy('실제-cluster와-제품별-version-profile-capacity는-현재-상태의-owner-api에서-조회합니다') }}</p>
            <strong>{{ copy('registry가-추정하지-않음') }}</strong>
          </article>
        </div>
      </section>

      <section class="coverage-panel" aria-labelledby="coverage-title">
        <div>
          <p class="eyebrow">{{ copy('coverage') }}</p>
          <h2 id="coverage-title">{{ copy('보여야-할-대상과-실제-게시된-대상을-함께-계산합니다') }}</h2>
          <p>{{ copy('목록에-없다는-사실을-미설치-나-정상-으로-해석하지-않습니다-expected-대상이-descriptor를-게시하지-못하면-누락') }}</p>
        </div>
        <dl>
          <div><dt>{{ copy('expected') }}</dt><dd>{{ copy('현재-release에서-보여야-할-module-component-extension') }}</dd></div>
          <div><dt>{{ copy('published') }}</dt><dd>{{ copy('검증을-통과해-현재-revision에-포함된-descriptor') }}</dd></div>
          <div><dt>{{ copy('missing-rejected') }}</dt><dd>{{ copy('descriptormissing-digestmissing-unverifiedsource-등-명시적-gap') }}</dd></div>
        </dl>
      </section>

      <section class="contract-grid">
        <article><p class="eyebrow">{{ copy('owns') }}</p><h2>{{ copy('이-서비스가-소유하는-것') }}</h2><ul><li>{{ copy('단일-discovery-api와-snapshot-schema') }}</li><li>{{ copy('source-readiness-freshness-rejection') }}</li><li>{{ copy('extension의-last-known-good-투영') }}</li><li>{{ copy('catalog-후보의-revision-bound-resolution') }}</li></ul></article>
        <article><p class="eyebrow">{{ copy('does-not-own') }}</p><h2>{{ copy('의도적으로-소유하지-않는-것') }}</h2><ul><li>{{ copy('dupa의-설치-검증-롤백-lifecycle') }}</li><li>{{ copy('argo-cd의-sync와-공급망-배포') }}</li><li>{{ copy('pfss-instance의-reconcile-backup-restore') }}</li><li>{{ copy('osce의-승인-실행-사후검증-operation') }}</li></ul></article>
        <article><p class="eyebrow">{{ copy('consumers') }}</p><h2>{{ copy('같은-revision을-읽는-표면') }}</h2><ul><li>{{ copy('console-현재-extension과-설치-가능-항목') }}</li><li>{{ copy('osc-자동완성-조회-동일-candidate') }}</li><li>{{ copy('osaa-현재-시스템-사실과-후보-설명') }}</li><li>{{ copy('osce-durable-operation의-선택-근거') }}</li></ul></article>
      </section>

      <aside><strong>{{ copy('단순화-원칙') }}</strong><span>{{ copy('별도-데이터베이스-이벤트-버스-범용-그래프-저장소를-추가하지-않습니다-kubernetes-watch-메모리-snapshot-단') }}</span></aside>
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
export class LandingRegistryCatalog {
  readonly content = inject(ConsoleIndexContentService);
  readonly copy = (key: string): string => this.content.text('registry-catalog', key);
}
