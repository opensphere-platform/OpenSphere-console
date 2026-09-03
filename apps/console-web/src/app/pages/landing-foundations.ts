import { ConsoleIndexContentService } from '../core/console-index-content.service';
import { ChangeDetectionStrategy, Component, input, inject } from '@angular/core';
import type {
  AGENT_RUNTIME_SPECTRUM,
  AI_LIFECYCLE,
  CBSS_COMPONENTS,
  CONTROL_BEAMS,
  CONTROL_ENGINE_PICTOGRAMS,
  CONTROL_ENGINE_STAGES,
  CONTROL_ENGINE_SURFACES,
  CONTROL_ENGINE_TARGETS,
  CONTROL_PILLARS,
  DUPA_INSTALL_STAGES,
  DUPA_PLUGIN_ROLES,
  FOUNDATION_CONCEPT_TABS,
  FoundationConceptTabId,
  MODEL_LOCATIONS,
  PFSS_CAPABILITIES,
  SERVICE_STACKS,
} from '../architecture/foundation-concepts.model';

@Component({
  selector: 'os-landing-foundations',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="foundation-docs">
      @if (page() === 'service-stacks') {
          <article
            class="foundation-panel"
            id="foundation-panel-service-stacks"
          >
            <section class="document-intro">
              <div class="document-intro-heading">
                <span class="section-pictogram">
                  <img [src]="tabs[0].pictogram" [alt]="tabs[0].pictogramAlt" width="70" height="70" />
                </span>
                <div>
                  <p class="foundation-eyebrow">{{ copy('service-stack') }}</p>
                  <h3>{{ copy('같이-설치되는-묶음이-아니라-하나의-운영-책임으로-닫히는-서비스-단위') }}</h3>
                </div>
              </div>
              <p>
                {{ copy('service-stack은-repository나-화면의-분류가-아닙니다-독립된-lifecycle-owner-권한-상태-모델-복') }}
              </p>
            </section>

            <div class="stack-flow" [attr.aria-label]="copy('hiss-cbss-pfss-responsibility-flow')">
              @for (stack of serviceStacks; track stack.id; let last = $last) {
                <div>
                  <span>{{ stack.id }}</span>
                  <strong>{{ stack.name }}</strong>
                  <small>{{ stack.role }}</small>
                </div>
                @if (!last) { <b aria-hidden="true">{{ copy('symbol') }}</b> }
              }
            </div>

            <div class="definition-grid definition-grid-three">
              @for (stack of serviceStacks; track stack.id) {
                <section class="definition-card">
                  <header><span>{{ stack.id }}</span><h4>{{ stack.name }}</h4></header>
                  <p>{{ stack.role }}</p>
                  <dl>
                    <div><dt>{{ copy('owns') }}</dt><dd>@for (item of stack.owns; track item) { <span>{{ item }}</span> }</dd></div>
                    <div><dt>{{ copy('must-not-own') }}</dt><dd>@for (item of stack.excludes; track item) { <span>{{ item }}</span> }</dd></div>
                    <div><dt>{{ copy('ready-evidence') }}</dt><dd>{{ stack.evidence }}</dd></div>
                  </dl>
                </section>
              }
            </div>

            <section class="document-section capability-contract">
              <div class="section-title">
                <div class="section-title-lockup">
                  <img src="/assets/pictograms/systems.svg" [attr.alt]="copy('service-stack-operating-functions')" width="52" height="52" />
                  <div><p class="foundation-eyebrow">{{ copy('service-stack-function-contract') }}</p><h3>{{ copy('stack마다-독립적으로-닫혀야-하는-네-가지-운영-기능') }}</h3></div>
                </div>
                <p>{{ copy('분류명이-아니라-실제-설치-운영-복구-책임을-입출력과-증거로-확인합니다') }}</p>
              </div>
              <div class="capability-grid">
                <article><span>{{ copy('01') }}</span><h4>{{ copy('desired-state-접수') }}</h4><p>{{ copy('stack-owner가-지원하는-schema로-설치-변경-의도를-받고-다른-stack의-내부-객체를-직접-쓰지-않습니다') }}</p><small>{{ copy('input-signed-claim-output-accepted-revision') }}</small></article>
                <article><span>{{ copy('02') }}</span><h4>{{ copy('reconcile와-격리') }}</h4><p>{{ copy('자신의-adapter와-credential-범위-안에서만-actual-state를-수렴시키고-실패-전파를-경계에서-차단합니다') }}</p><small>{{ copy('input-desired-revision-output-bounded-operation') }}</small></article>
                <article><span>{{ copy('03') }}</span><h4>{{ copy('readiness-관측') }}</h4><p>{{ copy('프로세스-존재가-아니라-서비스-i-o-sync-policy와-dependency-postcondition으로-ready를-판정') }}</p><small>{{ copy('input-runtime-evidence-output-ready-or-degraded') }}</small></article>
                <article><span>{{ copy('04') }}</span><h4>{{ copy('upgrade와-복구') }}</h4><p>{{ copy('exact-digest-backup-restore-rollback-절차를-자신의-lifecycle-안에서-닫고-증거를-보존합니') }}</p><small>{{ copy('input-approved-plan-output-receipt-and-recovery-point') }}</small></article>
              </div>
            </section>

            <section class="decision-block">
              <div class="decision-label">{{ copy('design-intent') }}</div>
              <div>
                <h4>{{ copy('왜-관리-도구와-대상-리소스를-완전히-분리하는가') }}</h4>
                <p>
                  {{ copy('관리-ui-durable-authority-reconciler와-실제-workload를-한-제품-단위로-묶으면-ui-업데이트가') }}
                </p>
                <ul>
                  <li><strong>{{ copy('장애-격리') }}</strong> {{ copy('beszel이나-ui가-느려져도-supabase-ledger와-pfss-operand는-계속-동작합니다') }}</li>
                  <li><strong>{{ copy('권한-최소화') }}</strong> {{ copy('observer는-읽기만-git-authority는-선언만-operator는-자신의-object만-변경합니다') }}</li>
                  <li><strong>{{ copy('독립-복구') }}</strong> {{ copy('console-backbone-operand의-backup-restore-upgrade-주기를-분리합니다') }}</li>
                  <li><strong>{{ copy('증거-가능성') }}</strong> {{ copy('누가-선언했고-누가-실행했으며-actual-state가-무엇인지-서로-대조할-수-있습니다') }}</li>
                </ul>
              </div>
            </section>

            <section class="document-section">
              <div class="section-title">
                <div class="section-title-lockup"><img src="/assets/pictograms/connected-ecosystem.svg" [attr.alt]="copy('connected-console-backbone-authorities')" width="52" height="52" /><div><p class="foundation-eyebrow">{{ copy('cbss-control-triangle') }}</p><h3>{{ copy('supabase-gitea-beszel이-만드는-console-backbone') }}</h3></div></div>
                <p>{{ copy('세-도구는-서로의-대체재가-아니라-identity-data-desired-change-observation이라는-서로-다른-권') }}</p>
              </div>
              <div class="definition-grid definition-grid-three compact-cards">
                @for (component of cbssComponents; track component.id) {
                  <section class="definition-card">
                    <header>
                      @if (component.productLogo) {
                        <img [src]="component.productLogo" [alt]="component.productLogoAlt ?? component.id" width="36" height="36" style="object-fit:contain" />
                      } @else {
                        <span>{{ component.id }}</span>
                      }
                      <h4>{{ component.name }}</h4>
                    </header>
                    <p>{{ component.role }}</p>
                    <dl>
                      <div><dt>{{ copy('boundary') }}</dt><dd>{{ component.excludes.join(' · ') }}</dd></div>
                      <div><dt>{{ copy('proof') }}</dt><dd>{{ component.evidence }}</dd></div>
                    </dl>
                  </section>
                }
              </div>
              <div class="truth-line">
                <span>{{ copy('supabase') }}</span><b>{{ copy('누가-무엇을-승인했는가') }}</b>
                <i>{{ copy('symbol-2') }}</i><span>{{ copy('gitea') }}</span><b>{{ copy('어떤-desired-change가-review됐는가') }}</b>
                <i>{{ copy('symbol-2') }}</i><span>{{ copy('beszel') }}</span><b>{{ copy('host에서-무엇이-관측되는가') }}</b>
                <i>{{ copy('symbol-3') }}</i><strong>{{ copy('설명-가능한-console-control') }}</strong>
              </div>
            </section>

            <section class="document-section">
              <div class="section-title">
                <div class="section-title-lockup"><img src="/assets/pictograms/control-tower.svg" [attr.alt]="copy('pfss-operator-control-loop')" width="52" height="52" /><div><p class="foundation-eyebrow">{{ copy('pfss-operator-pattern') }}</p><h3>{{ copy('공유-capability를-operator로-제공하는-이유') }}</h3></div></div>
                <p>{{ copy('main-shell의-일회성-명령이-아니라-desired-state와-actual-state를-계속-수렴시키고-복구하기-위해서') }}</p>
              </div>
              <div class="operator-flow" [attr.aria-label]="copy('pfss-operator-reconciliation-flow')">
                <div><span>{{ copy('01') }}</span><strong>{{ copy('model-claim') }}</strong><small>{{ copy('소비자가-원하는-capability') }}</small></div>
                <b>{{ copy('symbol') }}</b><div><span>{{ copy('02') }}</span><strong>{{ copy('plan-approval') }}</strong><small>{{ copy('위험-변경-확인-계약') }}</small></div>
                <b>{{ copy('symbol') }}</b><div><span>{{ copy('03') }}</span><strong>{{ copy('operator') }}</strong><small>{{ copy('idempotent-reconcile-fence') }}</small></div>
                <b>{{ copy('symbol') }}</b><div><span>{{ copy('04') }}</span><strong>{{ copy('operand') }}</strong><small>{{ copy('실제-database-service-model') }}</small></div>
                <b>{{ copy('symbol') }}</b><div><span>{{ copy('05') }}</span><strong>{{ copy('binding-status') }}</strong><small>{{ copy('소비-계약과-ready-증거') }}</small></div>
              </div>
              <div class="definition-grid definition-grid-two compact-cards">
                @for (capability of pfssCapabilities; track capability.id) {
                  <section class="definition-card">
                    <header><span>{{ capability.id }}</span><h4>{{ capability.name }}</h4></header>
                    <p>{{ capability.role }}</p>
                    <dl>
                      <div><dt>{{ copy('owner-scope') }}</dt><dd>{{ capability.owns.join(' · ') }}</dd></div>
                      <div><dt>{{ copy('denied-shortcut') }}</dt><dd>{{ capability.excludes.join(' · ') }}</dd></div>
                    </dl>
                  </section>
                }
              </div>
              <aside class="objective-note">
                <strong>{{ copy('객관적-평가') }}</strong>
                <p>{{ copy('operator는-초기-구현-비용과-상태-설계-부담을-늘립니다-그러나-stateful-capability의-upgrade-re') }}</p>
              </aside>
            </section>
          </article>
      }

      @if (page() === 'dupa') {
          <article class="foundation-panel" id="foundation-panel-dupa">
            <section class="document-intro">
              <div class="document-intro-heading">
                <span class="section-pictogram">
                  <img [src]="tabs[1].pictogram" [alt]="tabs[1].pictogramAlt" width="70" height="70" />
                </span>
                <div>
                  <p class="foundation-eyebrow">{{ copy('dynamic-ui-plugin-architecture') }}</p>
                  <h3>{{ copy('독립-출하-단위를-신뢰-계약으로-조립하는-console-확장-구조') }}</h3>
                </div>
              </div>
              <p>
                {{ copy('dupa는-iframe-sandbox나-frontend-bundler가-아닙니다-독립-image의-subshell-plugin') }}
              </p>
            </section>

            <div class="composition-map" [attr.aria-label]="copy('dupa-host-ownership-hierarchy')">
              <div class="main-node"><span>{{ copy('main') }}</span><strong>{{ copy('opensphere-main-shell') }}</strong><small>{{ copy('frame-session-root-navigation-system-plugins') }}</small></div>
              <div class="composition-branch">
                <section><span>{{ copy('subshell') }}</span><strong>{{ copy('독립-운영-영역') }}</strong><small>{{ copy('hostref-main-own-image-service-nav-lifecycle') }}</small></section>
                <b>{{ copy('hosts') }}</b>
                <section><span>{{ copy('plugin') }}</span><strong>{{ copy('host-귀속-기능') }}</strong><small>{{ copy('hostref-subshell-host-scoped-page-capability') }}</small></section>
              </div>
              <div class="composition-branch system-branch">
                <section><span>{{ copy('system-plugin') }}</span><strong>{{ copy('console-직할-기능') }}</strong><small>{{ copy('console-exact-digest에-결속-독립-image-lifecycle-없음') }}</small></section>
                <b>{{ copy('contrasts-with') }}</b>
                <section><span>{{ copy('registry-extension') }}</span><strong>{{ copy('dupa-설치-기능') }}</strong><small>{{ copy('독립-package-signature-activation-rollback') }}</small></section>
              </div>
            </div>

            <section class="document-section capability-contract">
              <div class="section-title">
                <div class="section-title-lockup"><img src="/assets/pictograms/microservices.svg" [attr.alt]="copy('dupa-extension-functions')" width="52" height="52" /><div><p class="foundation-eyebrow">{{ copy('dupa-execution-functions') }}</p><h3>{{ copy('설치-이후-main-shell이-실제로-수행하는-네-가지-기능') }}</h3></div></div>
                <p>{{ copy('동적-결합은-매-화면마다-재설치하는-것이-아니라-검증된-projection을-빠르게-소비하고-필요할-때만-ui를-적재하는-구조') }}</p>
              </div>
              <div class="capability-grid">
                <article><span>{{ copy('01') }}</span><h4>{{ copy('registry-검증') }}</h4><p>{{ copy('source-digest-signature-compatibility와-hostref를-설치-시점에-검증하고-승인-revisio') }}</p><small>{{ copy('output-immutable-verified-extension-revision') }}</small></article>
                <article><span>{{ copy('02') }}</span><h4>{{ copy('navigation-snapshot') }}</h4><p>{{ copy('메뉴-아이콘-표시-이름-순서를-projection으로-저장해-first-paint에서-원격-readiness-조회-없이-즉시') }}</p><small>{{ copy('output-cached-main-shell-navigation-projection') }}</small></article>
                <article><span>{{ copy('03') }}</span><h4>{{ copy('on-demand-ui-load') }}</h4><p>{{ copy('사용자가-route를-선택할-때-해당-host의-ui만-적재하며-timeout이-다른-subshell과-root-navigat') }}</p><small>{{ copy('output-isolated-host-view-or-bounded-error-state') }}</small></article>
                <article><span>{{ copy('04') }}</span><h4>{{ copy('disable와-rollback') }}</h4><p>{{ copy('projection-runtime-child-contribution과-외부-side-effect를-revision-단위로-정리') }}</p><small>{{ copy('output-teardown-evidence-and-restored-revision') }}</small></article>
              </div>
            </section>

            <section class="document-section">
              <div class="section-title">
                <div class="section-title-lockup"><img src="/assets/pictograms/code-syntax.svg" [attr.alt]="copy('signed-installation-contract')" width="52" height="52" /><div><p class="foundation-eyebrow">{{ copy('install-contract') }}</p><h3>{{ copy('subshell-설치는-파일-복사가-아니라-여섯-단계의-권위-전이') }}</h3></div></div>
                <p>{{ copy('main-shell은-package가-주장한-화면을-즉시-믿지-않고-registry가-검증한-projection만-소비합니다') }}</p>
              </div>
              <ol class="lifecycle-strip">
                @for (stage of dupaStages; track stage.step) {
                  <li><span>{{ stage.step }}</span><h4>{{ stage.title }}</h4><strong>{{ stage.owner }}</strong><p>{{ stage.outcome }}</p><small>{{ stage.evidence }}</small></li>
                }
              </ol>
            </section>

            <section class="decision-block">
              <div class="decision-label">{{ copy('subshell-role') }}</div>
              <div>
                <h4>{{ copy('subshell이-설치-이후에도-소유해야-하는-것') }}</h4>
                <p>
                  {{ copy('subshell은-단순-메뉴-그룹이-아니라-독립된-운영-도메인의-host입니다-자신의-child-plugin-문맥-2단-nav') }}
                </p>
                <ul>
                  <li><strong>{{ copy('자기완결') }}</strong> {{ copy('own-image-service-version-readiness와-장애-표면을-가집니다') }}</li>
                  <li><strong>{{ copy('host-authority') }}</strong> {{ copy('child-plugin의-hostref-compatibility-page-projection을-승인합니다') }}</li>
                  <li><strong>{{ copy('failure-isolation') }}</strong> {{ copy('한-subshell의-load-timeout이-로그인-다른-shell-main-shell-first-paint를-막지-않습니다') }}</li>
                  <li><strong>{{ copy('lifecycle-closure') }}</strong> {{ copy('update-disable-remove-시-자신의-child와-외부-side-effect를-정리합니다') }}</li>
                </ul>
              </div>
            </section>

            <section class="document-section">
              <div class="section-title">
                <div class="section-title-lockup"><img src="/assets/pictograms/microservices.svg" [attr.alt]="copy('subshell-plugin-role-spectrum')" width="52" height="52" /><div><p class="foundation-eyebrow">{{ copy('functional-plugin-roles') }}</p><h3>{{ copy('subshell-귀속-plugin의-기능적-유형') }}</h3></div></div>
                <p>{{ copy('아래-유형은-설치-schema의-새로운-kind가-아닙니다-설치-kind는-모두-plugin이며-책임을-설명하기-위한-기능적') }}</p>
              </div>
              <div class="definition-grid definition-grid-three compact-cards">
                @for (role of pluginRoles; track role.id) {
                  <section class="definition-card"><header><span>{{ role.id }}</span><h4>{{ role.name }}</h4></header><p>{{ role.role }}</p><dl><div><dt>{{ copy('owns') }}</dt><dd>{{ role.owns.join(' · ') }}</dd></div><div><dt>{{ copy('guardrail') }}</dt><dd>{{ role.excludes.join(' · ') }}</dd></div></dl></section>
                }
              </div>
            </section>

            <section class="document-section">
              <div class="section-title">
                <div class="section-title-lockup"><img src="/assets/pictograms/developer-tools.svg" [attr.alt]="copy('agent-runtime-unit-spectrum')" width="52" height="52" /><div><p class="foundation-eyebrow">{{ copy('agent-runtime-spectrum') }}</p><h3>{{ copy('shell-plugin과-runtime-unit을-분리하는-이유') }}</h3></div></div>
                <p>{{ copy('plugin은-제품-설치-호스팅-분류에-예약하고-agent-runtime-내부-조립-단위는-runtime-unit으로-부릅니다') }}</p>
              </div>
              <div class="runtime-spectrum">
                @for (item of runtimeSpectrum; track item.id; let index = $index) {
                  <section><span>R{{ index + 1 }}</span><h4>{{ item.name }}</h4><small>{{ item.id }}</small><p>{{ item.role }}</p><strong>{{ item.evidence }}</strong></section>
                }
              </div>
              <div class="tradeoff-grid">
                <section><span class="positive">{{ copy('benefits') }}</span><h4>{{ copy('동적-결합의-이점') }}</h4><p>{{ copy('model-runtime-workspace를-독립-교체하고-risk에-맞춰-자원을-선택하며-ai-workbench-장애가-r2') }}</p></section>
                <section><span class="caution">{{ copy('cautions') }}</span><h4>{{ copy('동적-결합의-비용') }}</h4><p>{{ copy('version-graph-공급망-신뢰-분산-trace-unload-후-외부-side-effect와-orphan-resource') }}</p></section>
              </div>
              <aside class="objective-note"><strong>{{ copy('객관적-평가') }}</strong><p>{{ copy('원자성은-구성요소-수를-늘리는-것이-아니라-결합-계약을-줄이는-것입니다-두-번째-runtime-구현이-생기기-전-독립-serv') }}</p></aside>
            </section>
          </article>
      }

      @if (page() === 'control-pillars') {
          <article class="foundation-panel" id="foundation-panel-control-pillars">
            <section class="document-intro">
              <div class="document-intro-heading">
                <span class="section-pictogram">
                  <img [src]="tabs[2].pictogram" [alt]="tabs[2].pictogramAlt" width="70" height="70" />
                </span>
                <div><p class="foundation-eyebrow">{{ copy('opensphere-control-surfaces') }}</p><h3>{{ copy('세-기둥은-서로-다른-ux를-제공하지만-같은-구조-하중을-받습니다') }}</h3></div>
              </div>
              <p>{{ copy('osaa-osc-oss가-각자-lifecycle과-권위를-가지면-세-개의-control-plane이-됩니다-opensphere') }}</p>
            </section>

            <div class="structure-frame" [attr.aria-label]="copy('osaa-osc-oss-pillars-connected-by-control-beams')">
              <div class="beam beam-top"><span>{{ copy('capability-registry-owner-api-semantic-action-parity') }}</span></div>
              <div class="pillars">
                @for (pillar of controlPillars; track pillar.id) {
                  <section><span>{{ pillar.id }}</span><h4>{{ pillar.name }}</h4><p>{{ pillar.role }}</p><small>{{ pillar.evidence }}</small></section>
                }
              </div>
              @for (beam of controlBeams; track beam.id) { <div class="beam"><span>{{ beam.name }}</span><small>{{ beam.role }}</small></div> }
              <div class="foundation-base"><span>{{ copy('supabase-durable-ledger') }}</span><span>{{ copy('gitea-reviewed-change') }}</span><span>{{ copy('kubernetes-pfss-runtime-truth') }}</span></div>
            </div>

            <section class="document-section capability-contract">
              <div class="section-title">
                <div class="section-title-lockup"><img src="/assets/pictograms/api.svg" [attr.alt]="copy('shared-control-surface-contract')" width="52" height="52" /><div><p class="foundation-eyebrow">{{ copy('surface-capability-contract') }}</p><h3>{{ copy('네-제어-표면이-나누어-맡는-기능과-공통-완료-기준') }}</h3></div></div>
                <p>{{ copy('console을-포함한-각-표면은-입력-ux만-소유하고-실행-권위와-operation-evidence는-osce를-통해-공유합') }}</p>
              </div>
              <div class="capability-grid">
                <article><span>{{ copy('console') }}</span><h4>{{ copy('시각적-계획-승인') }}</h4><p>{{ copy('폼과-diff로-action을-구성하고-위험-영향-대상-승인-상태와-진행률을-시각화합니다') }}</p><small>{{ copy('does-not-own-domain-mutation-or-runtime-truth') }}</small></article>
                <article><span>{{ copy('oss') }}</span><h4>{{ copy('대화형-운영-터미널') }}</h4><p>{{ copy('인증된-단기-session에서-osc와-허용-도구를-조합하고-동일-operationid를-관찰합니다') }}</p><small>{{ copy('does-not-own-cluster-admin-or-hidden-shell-logic') }}</small></article>
                <article><span>{{ copy('osc') }}</span><h4>{{ copy('기계-판독-명령-계약') }}</h4><p>{{ copy('discoverable-command-typed-flag-stable-json-exit-code로-사람-자동화-ai에-같은-a') }}</p><small>{{ copy('does-not-own-duplicate-business-rules') }}</small></article>
                <article><span>{{ copy('osaa') }}</span><h4>{{ copy('진단-계획-조치-지휘') }}</h4><p>{{ copy('문서와-runtime-evidence를-결합해-closed-action을-선택하고-필요한-승인-뒤-postcondition까지') }}</p><small>{{ copy('does-not-own-shadow-authority-or-unbounded-mutation') }}</small></article>
              </div>
            </section>

            <div class="definition-grid definition-grid-three pillar-cards">
              @for (pillar of controlPillars; track pillar.id) {
                <section class="definition-card"><header><span>{{ pillar.id }}</span><h4>{{ pillar.name }}</h4></header><p>{{ pillar.role }}</p><dl><div><dt>{{ copy('owns') }}</dt><dd>{{ pillar.owns.join(' · ') }}</dd></div><div><dt>{{ copy('cannot-own') }}</dt><dd>{{ pillar.excludes.join(' · ') }}</dd></div><div><dt>{{ copy('evidence') }}</dt><dd>{{ pillar.evidence }}</dd></div></dl></section>
              }
            </div>

            <section class="document-section">
              <div class="section-title"><div class="section-title-lockup"><img src="/assets/pictograms/api.svg" [attr.alt]="copy('postgresql-control-parity-through-one-api')" width="52" height="52" /><div><p class="foundation-eyebrow">{{ copy('one-command-one-owner') }}</p><h3>{{ copy('같은-postgresql-변경을-세-표면이-처리하는-방법') }}</h3></div></div><p>{{ copy('입력-방식만-다르고-plan-approval-apply-operation과-receipt는-pfss-postgresql-own') }}</p></div>
              <div class="parity-flow">
                <div><span>{{ copy('osaa') }}</span><strong>{{ copy('cluster를-이-옵션으로-만들어-줘') }}</strong><small>{{ copy('자연어-closed-action') }}</small></div>
                <div><span>{{ copy('osc') }}</span><strong>{{ copy('os-foundation-postgres-plan-create') }}</strong><small>{{ copy('typed-flags-json') }}</small></div>
                <div><span>{{ copy('oss') }}</span><strong>{{ copy('os-shell에서-같은-os-명령-실행') }}</strong><small>{{ copy('bounded-terminal-session') }}</small></div>
                <b>{{ copy('symbol-4') }}</b>
                <section><span>{{ copy('osce') }}</span><strong>{{ copy('pfss-postgresql-adapter-plan-approval-durable-apply-watch-receipt') }}</strong><small>{{ copy('세-표면-모두-동일-planid-digest-fencing-postcondition을-관찰') }}</small></section>
              </div>
            </section>

            <section class="document-section">
              <div class="section-title"><div class="section-title-lockup"><img src="/assets/pictograms/control-panel.svg" [attr.alt]="copy('control-surface-objective-review')" width="52" height="52" /><div><p class="foundation-eyebrow">{{ copy('objective-review') }}</p><h3>{{ copy('cli와-shell을-유지할-이유와-지켜야-할-한계') }}</h3></div></div></div>
              <div class="tradeoff-grid three-tradeoffs">
                <section><span class="positive">{{ copy('cli') }}</span><h4>{{ copy('ai-친화적인-가장-작은-안정-계약') }}</h4><p>{{ copy('cli는-terminal-ui가-아니라-discoverable-command-tree-stable-json-exit-code와') }}</p></section>
                <section><span class="positive">{{ copy('shell') }}</span><h4>{{ copy('console-안의-재현-가능한-운영-환경') }}</h4><p>{{ copy('브라우저만으로-표현하기-어려운-진단과-조합을-제공하되-identity-ttl-network-resource-audit가-묶인') }}</p></section>
                <section><span class="caution">{{ copy('limit') }}</span><h4>{{ copy('표면은-authority가-아닙니다') }}</h4><p>{{ copy('cli에만-존재하는-business-logic-shell의-raw-cluster-admin-osaa의-shadow-ledger') }}</p></section>
              </div>
            </section>
          </article>
      }

      @if (page() === 'control-engine') {
          <article class="foundation-panel" id="foundation-panel-control-engine">
            <section class="document-intro">
              <div class="document-intro-heading">
                <span class="section-pictogram">
                  <img [src]="tabs[3].pictogram" [alt]="tabs[3].pictogramAlt" width="70" height="70" />
                </span>
                <div>
                  <p class="foundation-eyebrow">{{ copy('osce-cbss-core-service') }}</p>
                  <h3>{{ copy('osce') }}</h3>
                  <p class="canonical-name">{{ copy('opensphere-control-engine') }}</p>
                </div>
              </div>
              <p>
                <strong>{{ copy('cbss-core-service') }}</strong>{{ copy('인-osce는-console-oss-osc-osaa가-서로-다른-제어-로직을-갖지-않도록-action-plan-authoriz') }}
              </p>
            </section>

            <dl class="core-service-identity" [attr.aria-label]="copy('osce-component-identity')">
              <div><dt>{{ copy('분류') }}</dt><dd>{{ copy('cbss-core-service') }}</dd></div>
              <div><dt>{{ copy('기능-성격') }}</dt><dd>{{ copy('platform-control-core-engine') }}</dd></div>
              <div><dt>{{ copy('배포-성격') }}</dt><dd>{{ copy('platform-bundled-core-component') }}</dd></div>
              <div><dt>{{ copy('extension-여부') }}</dt><dd>{{ copy('subshell-console-plugin-binding-아님') }}</dd></div>
            </dl>

            <section class="engine-architecture" [attr.aria-label]="copy('opensphere-control-engine-architecture')">
              <div class="engine-layer-heading">
                <div><span>{{ copy('input-channels') }}</span><h4>{{ copy('누가-어디서-사용하든-같은-제어-의미') }}</h4></div>
                <p>{{ copy('표면은-다르지만-동일한-action-schema-actor-context와-operation을-사용합니다') }}</p>
              </div>
              <div class="engine-surface-grid">
                @for (surface of controlEngineSurfaces; track surface.id) {
                  <section class="engine-node">
                    <img [src]="surface.pictogram" [alt]="surface.pictogramAlt" width="64" height="64" />
                    <div><span>{{ surface.id }}</span><h4>{{ surface.name }}</h4></div>
                    <p>{{ surface.role }}</p>
                    <small>{{ surface.boundary }}</small>
                  </section>
                }
              </div>

              <div class="engine-layer-heading engine-core-heading">
                <div><span>{{ copy('shared-control-core') }}</span><h4>{{ copy('opensphere-control-engine') }}</h4></div>
                <p>{{ copy('하나의-engine이-계획부터-실제-기능-확인과-rollback까지-operation을-닫습니다') }}</p>
              </div>
              <div class="engine-core-grid">
                <section class="engine-core-card primary">
                  <img [src]="controlEnginePictograms.engine" [attr.alt]="copy('central-control-tower-coordinating-operating-channels')" width="82" height="82" />
                  <div>
                    <span>{{ copy('osce') }}</span>
                    <h4>{{ copy('plan-authorize-execute-verify-recover') }}</h4>
                    <p>{{ copy('capability-discovery-영향-범위-실행-정책-durable-operation과-postcondition을-하나의') }}</p>
                  </div>
                </section>
                <section class="engine-core-card">
                  <img [src]="controlEnginePictograms.api" [attr.alt]="copy('structured-api-control-surface')" width="82" height="82" />
                  <div>
                    <span>{{ copy('control-api') }}</span>
                    <h4>{{ copy('구조화된-api가-기본-osc는-공식-command-adapter') }}</h4>
                    <p>{{ copy('r2d2는-api를-우선-사용하고-공식-운영-명령이-osc에-정의된-경우-machine-readable-mode로-같은-계약을') }}</p>
                  </div>
                </section>
              </div>

              <div class="engine-layer-heading">
                <div><span>{{ copy('controlled-components') }}</span><h4>{{ copy('구현을-흡수하지-않고-adapter로-지휘') }}</h4></div>
                <p>{{ copy('각-대상은-자신의-lifecycle과-정본을-유지하며-osce에-표준-제어-능력을-제공합니다') }}</p>
              </div>
              <div class="engine-target-grid">
                @for (target of controlEngineTargets; track target.id) {
                  <section class="engine-node target">
                    <img [src]="target.pictogram" [alt]="target.pictogramAlt" width="68" height="68" />
                    <div><span>{{ target.id }}</span><h4>{{ target.name }}</h4></div>
                    <p>{{ target.role }}</p>
                    <small>{{ target.boundary }}</small>
                  </section>
                }
              </div>
            </section>

            <section class="document-section">
              <div class="section-title">
                <div class="section-title-lockup"><img src="/assets/pictograms/control-tower.svg" [attr.alt]="copy('closed-control-operation-stages')" width="52" height="52" /><div><p class="foundation-eyebrow">{{ copy('one-closed-operation') }}</p><h3>{{ copy('판단에서-복구까지-다섯-단계') }}</h3></div></div>
                <p>{{ copy('사용자는-r2d2에-한-번-요청하지만-내부-실행은-각-단계의-권위와-증거를-잃지-않습니다') }}</p>
              </div>
              <ol class="engine-stages">
                @for (stage of controlEngineStages; track stage.step) {
                  <li>
                    <span>{{ stage.step }}</span>
                    <h4>{{ stage.title }}</h4>
                    <strong>{{ stage.owner }}</strong>
                    <p>{{ stage.outcome }}</p>
                    <small>{{ stage.evidence }}</small>
                  </li>
                }
              </ol>
            </section>

            <section class="document-section capability-contract">
              <div class="section-title">
                <div class="section-title-lockup"><img src="/assets/pictograms/control-panel.svg" [attr.alt]="copy('control-engine-common-capability-catalog')" width="52" height="52" /><div><p class="foundation-eyebrow">{{ copy('osce-capability-catalog') }}</p><h3>{{ copy('모든-제어-채널이-재사용하는-여섯-가지-공통-기능') }}</h3></div></div>
                <p>{{ copy('osce는-component-구현을-흡수하지-않고-계획과-증거의-공통-의미를-제공해-표면별-중복을-제거합니다') }}</p>
              </div>
              <div class="capability-grid capability-grid-six">
                <article><span>{{ copy('01') }}</span><h4>{{ copy('discover') }}</h4><p>{{ copy('registry와-owner-api에서-허용-action-schema-risk와-현재-availability를-조회합니다') }}</p><small>{{ copy('output-capability-revision') }}</small></article>
                <article><span>{{ copy('02') }}</span><h4>{{ copy('plan') }}</h4><p>{{ copy('대상-변경-전후-영향-범위-dependency와-rollback-가능성을-계산합니다') }}</p><small>{{ copy('output-immutable-plan-digest') }}</small></article>
                <article><span>{{ copy('03') }}</span><h4>{{ copy('authorize') }}</h4><p>{{ copy('actor-tenant-assurance-purpose와-risk에-맞는-정책-승인을-plan에-결속합니다') }}</p><small>{{ copy('output-bounded-authorization-context') }}</small></article>
                <article><span>{{ copy('04') }}</span><h4>{{ copy('execute') }}</h4><p>{{ copy('해당-component-adapter만-호출하고-idempotency-fencing-retry와-progress를-operat') }}</p><small>{{ copy('output-durable-operationid') }}</small></article>
                <article><span>{{ copy('05') }}</span><h4>{{ copy('verify') }}</h4><p>{{ copy('api-runtime-data와-필요한-browser-postcondition을-함께-확인해-기능-완료를-판정합니다') }}</p><small>{{ copy('output-owner-receipt-and-evidence-set') }}</small></article>
                <article><span>{{ copy('06') }}</span><h4>{{ copy('recover') }}</h4><p>{{ copy('실패-단계와-적용된-side-effect를-기준으로-rollback-또는-안전한-재시도-경로를-지휘합니다') }}</p><small>{{ copy('output-recovery-receipt-and-final-state') }}</small></article>
              </div>
            </section>

            <section class="decision-block engine-decision">
              <div class="decision-label">{{ copy('control-boundary') }}</div>
              <div>
                <h4>{{ copy('osce가-소유하는-것과-소유하지-않는-것') }}</h4>
                <ul>
                  <li><strong>{{ copy('소유') }}</strong> {{ copy('action-schema-plan-authorization-context-operation-correlation-postcon') }}</li>
                  <li><strong>{{ copy('소유하지-않음') }}</strong> {{ copy('pfss-domain-rule-kubernetes-runtime-truth-subshell-lifecycle과-plugin-h') }}</li>
                  <li><strong>{{ copy('직접-경로-금지') }}</strong> {{ copy('화면-r2d2-shell이-adapter를-우회해-raw-kubectl-sql을-실행하는-구조') }}</li>
                  <li><strong>{{ copy('완료-기준') }}</strong> {{ copy('명령-성공이-아니라-owner-receipt-exact-digest-api와-실제-화면의-기능-확인') }}</li>
                </ul>
              </div>
            </section>
          </article>
      }

      @if (page() === 'ai-lifecycle') {
          <article class="foundation-panel" id="foundation-panel-ai-lifecycle">
            <section class="document-intro">
              <div class="document-intro-heading">
                <span class="section-pictogram">
                  <img [src]="tabs[4].pictogram" [alt]="tabs[4].pictogramAlt" width="70" height="70" />
                </span>
                <div><p class="foundation-eyebrow">{{ copy('agent-model-lifecycle') }}</p><h3>{{ copy('모델을-호출하는-기능-이-아니라-교체-가능한-운영-자원으로-관리합니다') }}</h3></div>
              </div>
              <p>{{ copy('opensphere의-ai-lifecycle은-학습만-뜻하지-않습니다-data-model-provenance-gpu-할당-ev') }}</p>
            </section>

            <ol class="ai-pipeline">
              @for (stage of aiLifecycle; track stage.step) {
                <li><span>{{ stage.step }}</span><h4>{{ stage.title }}</h4><strong>{{ stage.owner }}</strong><p>{{ stage.outcome }}</p><small>{{ stage.evidence }}</small></li>
              }
            </ol>

            <section class="document-section capability-contract">
              <div class="section-title">
                <div class="section-title-lockup"><img src="/assets/pictograms/intelligence.svg" [attr.alt]="copy('ai-lifecycle-operating-functions')" width="52" height="52" /><div><p class="foundation-eyebrow">{{ copy('ai-lifecycle-functions') }}</p><h3>{{ copy('모델-확보부터-교체까지-끊기지-않아야-하는-운영-기능') }}</h3></div></div>
                <p>{{ copy('모델-파일-gpu-endpoint와-agent-배치를-하나로-뭉치지-않고-각-단계의-owner와-lineage를-연결합니다') }}</p>
              </div>
              <div class="capability-grid">
                <article><span>{{ copy('01') }}</span><h4>{{ copy('artifact와-lineage') }}</h4><p>{{ copy('dataset-base-model-adapter-tokenizer-license와-evaluation-결과를-digest로-연') }}</p><small>{{ copy('output-reproducible-model-artifact-record') }}</small></article>
                <article><span>{{ copy('02') }}</span><h4>{{ copy('학습-gpu-할당') }}</h4><p>{{ copy('quota-priority-runtime-class와-job-spec-안에서-train-adapt-workload를-예약하고') }}</p><small>{{ copy('output-resource-bound-training-receipt') }}</small></article>
                <article><span>{{ copy('03') }}</span><h4>{{ copy('평가-승인-serving') }}</h4><p>{{ copy('quality-safety-security-cost-gate를-통과한-artifact만-model-binding과-endpoi') }}</p><small>{{ copy('output-admitted-binding-and-serving-evidence') }}</small></article>
                <article><span>{{ copy('04') }}</span><h4>{{ copy('배치-관측-교체') }}</h4><p>{{ copy('agent가-승인-model-tool-policy로-실행되도록-묶고-drift와-회귀를-감지해-새-revision으로-안전하게') }}</p><small>{{ copy('output-run-provenance-and-replacement-receipt') }}</small></article>
              </div>
            </section>

            <section class="document-section">
              <div class="section-title"><div class="section-title-lockup"><img src="/assets/pictograms/intelligence.svg" [attr.alt]="copy('model-locations-and-bindings')" width="52" height="52" /><div><p class="foundation-eyebrow">{{ copy('where-models-live') }}</p><h3>{{ copy('우리의-ai-모델은-어디에-존재하는가') }}</h3></div></div><p>{{ copy('논리적으로는-pfss-model-claim-binding에-존재하고-물리적으로는-provider-artifact-registr') }}</p></div>
              <div class="definition-grid definition-grid-three compact-cards">
                @for (location of modelLocations; track location.id) {
                  <section class="definition-card"><header><span>{{ location.id }}</span><h4>{{ location.name }}</h4></header><p>{{ location.role }}</p><dl><div><dt>{{ copy('owns') }}</dt><dd>{{ location.owns.join(' · ') }}</dd></div><div><dt>{{ copy('boundary') }}</dt><dd>{{ location.excludes.join(' · ') }}</dd></div><div><dt>{{ copy('proof') }}</dt><dd>{{ location.evidence }}</dd></div></dl></section>
                }
              </div>
              <div class="invocation-flow" [attr.aria-label]="copy('model-invocation-control-flow')">
                <div><span>{{ copy('ai-workbench') }}</span><small>{{ copy('author-configure-evaluate') }}</small></div><b>{{ copy('symbol') }}</b>
                <div><span>{{ copy('agent-manifest') }}</span><small>{{ copy('model-tool-policy-binding') }}</small></div><b>{{ copy('symbol') }}</b>
                <div><span>{{ copy('agent-runtime') }}</span><small>{{ copy('session-loop-approval') }}</small></div><b>{{ copy('symbol') }}</b>
                <div><span>{{ copy('model-runtime-unit') }}</span><small>{{ copy('normalize-invoke') }}</small></div><b>{{ copy('symbol') }}</b>
                <div><span>{{ copy('pfss-model-binding') }}</span><small>{{ copy('provider-or-gpu-endpoint') }}</small></div>
              </div>
              <aside class="objective-note"><strong>{{ copy('호출-원칙') }}</strong><p>{{ copy('ai-workbench-ui나-agent-workspace가-provider-credential을-직접-보유하지-않습니다-ag') }}</p></aside>
            </section>

            <section class="document-section">
              <div class="section-title"><div class="section-title-lockup"><img src="/assets/pictograms/cloud-infrastructure-management.svg" [attr.alt]="copy('gpu-and-playground-infrastructure')" width="52" height="52" /><div><p class="foundation-eyebrow">{{ copy('gpu-and-playground') }}</p><h3>{{ copy('control-plane은-pod-실행-workspace는-risk에-따라-pod-또는-kubevirt') }}</h3></div></div><p>{{ copy('gpu는-agent에게-직접-배정하지-않고-quota-model-serving-workspace-profile을-통해-할당합니') }}</p></div>
              <div class="workspace-compare">
                <section><span>{{ copy('default') }}</span><h4>{{ copy('pod-playground') }}</h4><p>{{ copy('짧은-수명-빠른-시작-표준-kubernetes-network-storage-policy-read-evaluate와-제한된-to') }}</p><dl><div><dt>{{ copy('best-for') }}</dt><dd>{{ copy('ephemeral-evaluation-bounded-code-standard-isolation') }}</dd></div><div><dt>{{ copy('proof') }}</dt><dd>{{ copy('runtimeclass-quota-networkpolicy-teardown-residue-zero') }}</dd></div></dl></section>
                <section><span>{{ copy('stronger-class') }}</span><h4>{{ copy('kubevirt-vm-playground') }}</h4><p>{{ copy('kernel-boundary-vm-tooling-긴-workspace가-필요한-고위험-작업에-선택합니다-설치-의존성이나-기본') }}</p><dl><div><dt>{{ copy('best-for') }}</dt><dd>{{ copy('untrusted-build-stronger-tenant-boundary-vm-specific-tool') }}</dd></div><div><dt>{{ copy('proof') }}</dt><dd>{{ copy('vmi-identity-network-storage-policy-console-fence-teardown') }}</dd></div></dl></section>
              </div>
              <div class="no-downgrade"><strong>{{ copy('no-automatic-downgrade') }}</strong><p>{{ copy('요청된-sandbox-profile을-사용할-수-없으면-실행을-거부합니다-일단-pod로-실행-은-가용성-개선이-아니라-격리-계') }}</p></div>
            </section>

            <section class="document-section">
              <div class="section-title"><div class="section-title-lockup"><img src="/assets/pictograms/connected-ecosystem.svg" [attr.alt]="copy('current-and-target-ai-runtime-states')" width="52" height="52" /><div><p class="foundation-eyebrow">{{ copy('current-vs-target') }}</p><h3>{{ copy('현재-구현과-목표-상태를-구분합니다') }}</h3></div></div></div>
              <div class="state-split">
                <section><span>{{ copy('current') }}</span><h4>{{ copy('r2d2-native-runtime') }}</h4><p>{{ copy('agent-run-step-capability-owner-approval-operation과-receipt-의미론의-최초-구현') }}</p></section>
                <section><span>{{ copy('next-contract') }}</span><h4>{{ copy('agentrunread-v1') }}</h4><p>{{ copy('ai-workbench가-별도-ledger나-kubernetes-proxy-없이-r2d2의-run-step을-read-only') }}</p></section>
                <section><span>{{ copy('deferred') }}</span><h4>{{ copy('composable-runtime-playground') }}</h4><p>{{ copy('두-번째-runtime-구현이나-실제-격리-use-case가-생기고-conformance-cleanup-supply-chain') }}</p></section>
              </div>
            </section>
          </article>
      }
    </section>
  `,
  styles: [`
    :host { --fd-line:var(--os-hairline); --fd-page-title:var(--arch-page-title,clamp(1.55rem,2.2vw,2rem)); --fd-section-title:var(--arch-section-title,1.2rem); --fd-body:var(--arch-body,.9rem); --fd-detail:var(--arch-detail,.8rem); --fd-label:var(--arch-label,.68rem); --fd-card-title:var(--arch-card-title,.98rem); display:block; min-width:0; max-width:100%; }
    :host * { box-sizing:border-box; }
    .foundation-docs { width:100%; min-width:0; max-width:100%; overflow:hidden; color:var(--os-ink); }
    .foundation-panel :where(p,small,strong,h3,h4,dt,dd) { min-width:0; overflow-wrap:anywhere; }
    .section-title,.document-intro { display:flex; justify-content:space-between; align-items:end; gap:2rem; }
    .section-title h3 { margin:0; font-size:var(--fd-section-title); font-weight:550; line-height:1.3; }
    .section-title>p { max-width:42rem; margin:0; color:var(--os-ink); font-size:var(--fd-detail); line-height:1.6; text-align:right; }
    .foundation-eyebrow { margin:0 0 .45rem; color:var(--os-accent); font-size:var(--fd-label); font-weight:700; letter-spacing:.12em; text-transform:uppercase; }
    .section-pictogram { display:grid; place-items:center; }
    .foundation-panel { width:100%; min-width:0; max-width:100%; border:1px solid var(--fd-line); overflow:hidden; background:var(--os-canvas); line-height:1.55; }
    .document-intro { align-items:start; padding:1.35rem 1.25rem; border-bottom:1px solid var(--fd-line); border-left:4px solid var(--os-accent); background:var(--os-surface-1); color:var(--os-ink); }
    .document-intro>.document-intro-heading { display:grid; grid-template-columns:5.6rem minmax(0,1fr); align-items:center; gap:1rem; min-width:0; }
    .section-pictogram { width:5.6rem; height:5.6rem; }
    .document-intro .foundation-eyebrow { color:var(--os-accent); }
    .document-intro h3 { margin:0; overflow-wrap:anywhere; font-size:var(--fd-page-title); font-weight:500; line-height:1.14; letter-spacing:-.025em; }
    .document-intro>p { max-width:42rem; margin:0; color:var(--os-ink); font-size:var(--fd-body); line-height:1.65; }
    .canonical-name { margin:.35rem 0 0; color:var(--os-ink-muted); font-size:var(--fd-card-title); }
    .core-service-identity { display:grid; grid-template-columns:repeat(auto-fit,minmax(12rem,1fr)); gap:.75rem 2rem; margin:0; padding:.85rem 1.25rem; border-bottom:1px solid var(--fd-line); }
    .core-service-identity dt { color:var(--os-ink-muted); font:700 var(--fd-label) var(--os-font-mono); }
    .core-service-identity dd { margin:.2rem 0 0; font-size:var(--fd-detail); font-weight:600; }
    .stack-flow,.operator-flow,.invocation-flow { display:flex; align-items:stretch; padding:1rem 1.25rem; border-bottom:1px solid var(--fd-line); background:var(--os-surface-1); }
    .stack-flow>div,.operator-flow>div,.invocation-flow>div { display:grid; flex:1; align-content:start; min-width:0; padding:.75rem; border:1px solid var(--fd-line); background:var(--os-canvas); }
    .stack-flow>b,.operator-flow>b,.invocation-flow>b { align-self:center; padding:0 .45rem; color:var(--os-ink-muted); font-weight:400; }
    .stack-flow span,.operator-flow span,.invocation-flow span,.composition-map span,.runtime-spectrum span,.pillars span,.parity-flow span,.workspace-compare span,.state-split span,.engine-node span,.engine-core-card span,.engine-stages span { color:var(--os-accent); font:700 var(--fd-label) var(--os-font-mono); }
    .stack-flow strong,.operator-flow strong,.invocation-flow strong { margin-top:.35rem; font-size:var(--fd-card-title); }
    .stack-flow small,.operator-flow small,.invocation-flow small { margin-top:.4rem; color:var(--os-ink-muted); font-size:var(--fd-detail); }
    .definition-grid { display:grid; min-width:0; gap:1px; border:1px solid var(--fd-line); background:var(--fd-line); }
    .definition-grid-three,.pillars,.state-split { grid-template-columns:repeat(3,minmax(0,1fr)); }
    .definition-grid-two,.tradeoff-grid,.workspace-compare { grid-template-columns:repeat(2,minmax(0,1fr)); }
    .definition-card { display:flex; min-width:0; padding:1rem; flex-direction:column; background:var(--os-canvas); }
    .definition-card header { display:grid; min-height:0; padding:0; grid-template-columns:auto minmax(0,1fr); gap:.7rem; background:transparent; color:inherit; }
    .definition-card header>span { padding:.28rem .44rem; background:var(--os-accent-subtle); color:var(--os-accent); font:700 var(--fd-label) var(--os-font-mono); }
    .definition-card h4 { margin:0; overflow-wrap:anywhere; font-size:var(--fd-card-title); }
    .definition-card>p { margin:.8rem 0; color:var(--os-ink); font-size:var(--fd-body); }
    .definition-card dl { margin:auto 0 0; border-top:1px solid var(--fd-line); }
    .definition-card dl div { display:grid; grid-template-columns:5.8rem 1fr; gap:.5rem; padding:.5rem 0; border-bottom:1px solid var(--fd-line); }
    .definition-card dt,.workspace-compare dt { color:var(--os-ink-muted); font-size:var(--fd-label); font-weight:700; text-transform:uppercase; }
    .definition-card dd { display:flex; min-width:0; flex-wrap:wrap; gap:.3rem; margin:0; overflow-wrap:anywhere; font-size:var(--fd-detail); }
    .definition-card dd span { padding:.15rem .3rem; background:var(--os-surface-1); }
    .compact-cards { border:1px solid var(--fd-line); }
    .decision-block { display:grid; grid-template-columns:9rem 1fr; border-bottom:1px solid var(--fd-line); background:var(--os-accent-subtle); }
    .decision-label,.decision-block>div:last-child { padding:1rem; }
    .decision-label { border-right:1px solid var(--fd-line); color:var(--os-accent); font:700 var(--fd-label) var(--os-font-mono); }
    .decision-block h4 { margin:0; font-size:var(--fd-card-title); }
    .decision-block p,.tradeoff-grid p,.workspace-compare p,.state-split p { color:var(--os-ink-muted); font-size:var(--fd-detail); }
    .decision-block ul { display:grid; grid-template-columns:repeat(2,1fr); gap:.6rem 1.2rem; margin:.8rem 0 0; padding:0; list-style:none; font-size:var(--fd-detail); }
    .document-section { padding:1.35rem 1.25rem; border-bottom:1px solid var(--fd-line); }
    .document-section:last-child { border-bottom:0; }
    .section-title { margin-bottom:.7rem; }
    .truth-line { display:grid; grid-template-columns:auto 1fr auto auto 1fr auto auto 1fr auto 1.2fr; align-items:center; margin-top:.75rem; border:1px solid var(--fd-line); }
    .truth-line>* { padding:.7rem; font-size:.78rem; }
    .truth-line span,.truth-line i { color:var(--os-accent); font-style:normal; }
    .truth-line b { color:var(--os-ink-muted); font-weight:400; }
    .truth-line strong,.parity-flow>section { background:var(--os-accent-subtle); color:var(--os-ink); }
    .objective-note,.no-downgrade { display:grid; grid-template-columns:8rem 1fr; gap:1rem; padding:.75rem .85rem; }
    .objective-note { margin-top:.8rem; border-left:4px solid #8a3ffc; background:#f6f2ff; }
    .objective-note p,.no-downgrade p { margin:0; font-size:var(--fd-detail); }
    .composition-map { display:grid; grid-template-columns:1.05fr 1fr 1fr; border-bottom:1px solid var(--fd-line); }
    .composition-map>div { display:grid; min-height:10rem; padding:1rem; border-right:1px solid var(--fd-line); }
    .composition-map>div:last-child { border-right:0; }
    .composition-map strong,.parity-flow strong { margin-top:.45rem; font-size:var(--fd-card-title); }
    .composition-map small,.parity-flow small { margin-top:.35rem; color:var(--os-ink-muted); font-size:var(--fd-detail); }
    .composition-branch { display:grid; grid-template-columns:1fr auto 1fr; gap:.5rem; }
    .composition-branch b { color:var(--os-ink-muted); font-size:.7rem; writing-mode:vertical-rl; }
    .system-branch { background:var(--os-surface-1); }
    .lifecycle-strip,.ai-pipeline { display:grid; grid-template-columns:repeat(auto-fit,minmax(10.5rem,1fr)); gap:1px; min-width:0; margin:0; padding:1px; background:var(--fd-line); list-style:none; }
    .lifecycle-strip li,.ai-pipeline li { min-width:0; min-height:10rem; padding:.85rem; background:var(--os-canvas); }
    .lifecycle-strip span,.ai-pipeline span { color:var(--os-accent); font:650 var(--fd-label) var(--os-font-mono); }
    .lifecycle-strip h4,.ai-pipeline h4,.runtime-spectrum h4,.tradeoff-grid h4,.pillars h4,.workspace-compare h4,.state-split h4 { margin:.6rem 0 0; font-size:var(--fd-card-title); }
    .lifecycle-strip strong,.ai-pipeline strong { display:block; margin-top:.3rem; color:var(--os-ink-muted); font-size:.72rem; }
    .lifecycle-strip p,.ai-pipeline p,.runtime-spectrum p,.pillars p { margin:.7rem 0 0; overflow-wrap:anywhere; color:var(--os-ink); font-size:var(--fd-body); }
    .lifecycle-strip small,.ai-pipeline small,.runtime-spectrum small,.pillars small { display:block; margin-top:.45rem; overflow-wrap:anywhere; color:var(--os-ink-muted); font-size:var(--fd-detail); }
    .runtime-spectrum,.tradeoff-grid,.pillars,.workspace-compare,.state-split { display:grid; border:1px solid var(--fd-line); }
    .runtime-spectrum { grid-template-columns:repeat(auto-fit,minmax(13rem,1fr)); }
    .runtime-spectrum section,.tradeoff-grid section,.pillars section,.workspace-compare section,.state-split section { padding:.85rem; border-right:1px solid var(--fd-line); }
    .runtime-spectrum section:last-child,.tradeoff-grid section:last-child,.pillars section:last-child,.workspace-compare section:last-child,.state-split section:last-child { border-right:0; }
    .runtime-spectrum strong { font-size:.72rem; }
    .tradeoff-grid { margin-top:.8rem; }
    .tradeoff-grid span { font:700 var(--fd-label) var(--os-font-mono); text-transform:uppercase; }
    .positive { color:#198038; } .caution { color:#8e6a00; }
    .three-tradeoffs { grid-template-columns:repeat(3,minmax(0,1fr)); }
    .structure-frame { margin:1rem 1.25rem; border:1px solid var(--fd-line); }
    .beam { display:flex; justify-content:space-between; gap:1rem; padding:.65rem .8rem; border-top:1px solid var(--fd-line); background:var(--os-surface-1); font-size:.76rem; }
    .beam-top { border-top:3px solid var(--os-accent); background:var(--os-accent-subtle); color:var(--os-ink); }
    .pillars section { min-height:10rem; box-shadow:inset 0 -5px var(--os-accent); }
    .foundation-base { display:grid; grid-template-columns:repeat(3,1fr); background:var(--os-surface-1); color:var(--os-ink); }
    .foundation-base span { padding:.7rem; border-right:1px solid var(--fd-line); font-size:.76rem; text-align:center; }
    .parity-flow { display:grid; grid-template-columns:repeat(3,1fr); border:1px solid var(--fd-line); }
    .parity-flow>div { display:grid; padding:.75rem; border-right:1px solid var(--fd-line); }
    .parity-flow>b,.parity-flow>section { grid-column:1/-1; padding:.5rem .8rem; }
    .parity-flow>b { background:var(--os-surface-1); color:var(--os-accent); text-align:center; }
    .ai-pipeline { border-top:0; }
    .invocation-flow { margin-top:.75rem; padding:0; background:transparent; border:1px solid var(--fd-line); }
    .invocation-flow>div { border:0; }
    .workspace-compare dl { margin:.7rem 0 0; }
    .workspace-compare dl div { display:grid; grid-template-columns:5rem 1fr; padding:.35rem 0; border-top:1px solid var(--fd-line); }
    .workspace-compare dd { margin:0; font-size:.78rem; }
    .no-downgrade { grid-template-columns:10rem 1fr; background:#fff4ce; border:1px solid #f1c21b; border-top:0; }
    .no-downgrade strong { color:#8e6a00; font-size:.78rem; }
    .state-split section { min-height:8rem; }
    @media(max-width:76rem){
      .document-intro,.section-title { display:grid; }
      .section-title>p { max-width:none; text-align:left; }
      .stack-flow,.operator-flow,.invocation-flow { display:grid; grid-template-columns:repeat(auto-fit,minmax(11rem,1fr)); gap:.65rem; }
      .stack-flow>b,.operator-flow>b,.invocation-flow>b { display:none; }
      .truth-line { grid-template-columns:auto 1fr; }
      .truth-line i { display:none; }
      .truth-line strong { grid-column:1/-1; }
    }
    @media(max-width:56rem){
      .definition-grid-three,.definition-grid-two,.pillars,.state-split,.three-tradeoffs,.workspace-compare,.composition-map,.tradeoff-grid,.runtime-spectrum,.parity-flow,.foundation-base { grid-template-columns:1fr; }
      .pillars section,.state-split section,.workspace-compare section,.composition-map>div,.tradeoff-grid section,.runtime-spectrum section,.parity-flow>div,.foundation-base span { border-right:0; border-bottom:1px solid var(--fd-line); }
      .decision-block,.decision-block ul { grid-template-columns:1fr; }
      .parity-flow>b,.parity-flow>section { grid-column:1; }
    }
    @media(max-width:36rem){
      .lifecycle-strip,.ai-pipeline { grid-template-columns:1fr; }
      .document-intro,.document-section { padding:1rem; }
      .objective-note,.no-downgrade { grid-template-columns:1fr; }
    }
  `],
})
export class LandingFoundations {
  readonly content = inject(ConsoleIndexContentService);
  readonly copy = (key: string): string => this.content.text('foundations', key);

  readonly page = input.required<FoundationConceptTabId>();
  get tabs(): typeof FOUNDATION_CONCEPT_TABS { return this.content.model('FOUNDATION_CONCEPT_TABS'); }
  get serviceStacks(): typeof SERVICE_STACKS { return this.content.model('SERVICE_STACKS'); }
  get cbssComponents(): typeof CBSS_COMPONENTS { return this.content.model('CBSS_COMPONENTS'); }
  get pfssCapabilities(): typeof PFSS_CAPABILITIES { return this.content.model('PFSS_CAPABILITIES'); }
  get dupaStages(): typeof DUPA_INSTALL_STAGES { return this.content.model('DUPA_INSTALL_STAGES'); }
  get pluginRoles(): typeof DUPA_PLUGIN_ROLES { return this.content.model('DUPA_PLUGIN_ROLES'); }
  get runtimeSpectrum(): typeof AGENT_RUNTIME_SPECTRUM { return this.content.model('AGENT_RUNTIME_SPECTRUM'); }
  get controlPillars(): typeof CONTROL_PILLARS { return this.content.model('CONTROL_PILLARS'); }
  get controlBeams(): typeof CONTROL_BEAMS { return this.content.model('CONTROL_BEAMS'); }
  get controlEnginePictograms(): typeof CONTROL_ENGINE_PICTOGRAMS { return this.content.model('CONTROL_ENGINE_PICTOGRAMS'); }
  get controlEngineSurfaces(): typeof CONTROL_ENGINE_SURFACES { return this.content.model('CONTROL_ENGINE_SURFACES'); }
  get controlEngineTargets(): typeof CONTROL_ENGINE_TARGETS { return this.content.model('CONTROL_ENGINE_TARGETS'); }
  get controlEngineStages(): typeof CONTROL_ENGINE_STAGES { return this.content.model('CONTROL_ENGINE_STAGES'); }
  get aiLifecycle(): typeof AI_LIFECYCLE { return this.content.model('AI_LIFECYCLE'); }
  get modelLocations(): typeof MODEL_LOCATIONS { return this.content.model('MODEL_LOCATIONS'); }
}
