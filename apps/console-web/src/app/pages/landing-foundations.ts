import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import {
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
                  <p class="foundation-eyebrow">Service Stack</p>
                  <h3>같이 설치되는 묶음이 아니라, 하나의 운영 책임으로 닫히는 서비스 단위</h3>
                </div>
              </div>
              <p>
                Service Stack은 repository나 화면의 분류가 아닙니다. 독립된 lifecycle owner, 권한,
                상태 모델, 복구 절차와 Ready 증거를 가진 운영 경계입니다. HISS·CBSS·PFSS를 분리한 이유는
                장애와 변경의 전파를 줄이고, 각 계층을 다른 속도로 교체할 수 있게 하기 위해서입니다.
              </p>
            </section>

            <div class="stack-flow" aria-label="HISS CBSS PFSS responsibility flow">
              @for (stack of serviceStacks; track stack.id; let last = $last) {
                <div>
                  <span>{{ stack.id }}</span>
                  <strong>{{ stack.name }}</strong>
                  <small>{{ stack.role }}</small>
                </div>
                @if (!last) { <b aria-hidden="true">→</b> }
              }
            </div>

            <div class="definition-grid definition-grid-three">
              @for (stack of serviceStacks; track stack.id) {
                <section class="definition-card">
                  <header><span>{{ stack.id }}</span><h4>{{ stack.name }}</h4></header>
                  <p>{{ stack.role }}</p>
                  <dl>
                    <div><dt>Owns</dt><dd>@for (item of stack.owns; track item) { <span>{{ item }}</span> }</dd></div>
                    <div><dt>Must not own</dt><dd>@for (item of stack.excludes; track item) { <span>{{ item }}</span> }</dd></div>
                    <div><dt>Ready evidence</dt><dd>{{ stack.evidence }}</dd></div>
                  </dl>
                </section>
              }
            </div>

            <section class="document-section capability-contract">
              <div class="section-title">
                <div class="section-title-lockup">
                  <img src="/assets/pictograms/systems.svg" alt="Service Stack operating functions" width="52" height="52" />
                  <div><p class="foundation-eyebrow">Service Stack function contract</p><h3>Stack마다 독립적으로 닫혀야 하는 네 가지 운영 기능</h3></div>
                </div>
                <p>분류명이 아니라 실제 설치·운영·복구 책임을 입출력과 증거로 확인합니다.</p>
              </div>
              <div class="capability-grid">
                <article><span>01</span><h4>Desired state 접수</h4><p>Stack owner가 지원하는 schema로 설치·변경 의도를 받고 다른 Stack의 내부 객체를 직접 쓰지 않습니다.</p><small>Input: signed claim · Output: accepted revision</small></article>
                <article><span>02</span><h4>Reconcile와 격리</h4><p>자신의 adapter와 credential 범위 안에서만 actual state를 수렴시키고 실패 전파를 경계에서 차단합니다.</p><small>Input: desired revision · Output: bounded operation</small></article>
                <article><span>03</span><h4>Readiness 관측</h4><p>프로세스 존재가 아니라 서비스 I/O, sync, policy와 dependency postcondition으로 Ready를 판정합니다.</p><small>Input: runtime evidence · Output: Ready or Degraded</small></article>
                <article><span>04</span><h4>Upgrade와 복구</h4><p>exact digest, backup, restore, rollback 절차를 자신의 lifecycle 안에서 닫고 증거를 보존합니다.</p><small>Input: approved plan · Output: receipt and recovery point</small></article>
              </div>
            </section>

            <section class="decision-block">
              <div class="decision-label">DESIGN INTENT</div>
              <div>
                <h4>왜 관리 도구와 대상 리소스를 완전히 분리하는가</h4>
                <p>
                  관리 UI, durable authority, reconciler와 실제 workload를 한 제품 단위로 묶으면 UI 업데이트가
                  database·operator·host monitoring까지 흔들고, 하나의 credential이 모든 계층을 관통하게 됩니다.
                  OpenSphere는 표시, 선언, 실행, 관측을 분리하고 object마다 writer를 하나만 둡니다.
                </p>
                <ul>
                  <li><strong>장애 격리</strong> — Beszel이나 UI가 느려져도 Supabase ledger와 PFSS operand는 계속 동작합니다.</li>
                  <li><strong>권한 최소화</strong> — observer는 읽기만, Git authority는 선언만, operator는 자신의 object만 변경합니다.</li>
                  <li><strong>독립 복구</strong> — Console, backbone, operand의 backup·restore·upgrade 주기를 분리합니다.</li>
                  <li><strong>증거 가능성</strong> — 누가 선언했고 누가 실행했으며 actual state가 무엇인지 서로 대조할 수 있습니다.</li>
                </ul>
              </div>
            </section>

            <section class="document-section">
              <div class="section-title">
                <div class="section-title-lockup"><img src="/assets/pictograms/connected-ecosystem.svg" alt="Connected Console Backbone authorities" width="52" height="52" /><div><p class="foundation-eyebrow">CBSS control triangle</p><h3>Supabase + Gitea + Beszel이 만드는 Console Backbone</h3></div></div>
                <p>세 도구는 서로의 대체재가 아니라 identity/data, desired change, observation이라는 서로 다른 권위를 가집니다.</p>
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
                      <div><dt>Boundary</dt><dd>{{ component.excludes.join(' · ') }}</dd></div>
                      <div><dt>Proof</dt><dd>{{ component.evidence }}</dd></div>
                    </dl>
                  </section>
                }
              </div>
              <div class="truth-line">
                <span>Supabase</span><b>누가·무엇을 승인했는가</b>
                <i>+</i><span>Gitea</span><b>어떤 desired change가 review됐는가</b>
                <i>+</i><span>Beszel</span><b>host에서 무엇이 관측되는가</b>
                <i>=</i><strong>설명 가능한 Console control</strong>
              </div>
            </section>

            <section class="document-section">
              <div class="section-title">
                <div class="section-title-lockup"><img src="/assets/pictograms/control-tower.svg" alt="PFSS operator control loop" width="52" height="52" /><div><p class="foundation-eyebrow">PFSS operator pattern</p><h3>공유 capability를 Operator로 제공하는 이유</h3></div></div>
                <p>Main Shell의 일회성 명령이 아니라 desired state와 actual state를 계속 수렴시키고 복구하기 위해서입니다.</p>
              </div>
              <div class="operator-flow" aria-label="PFSS operator reconciliation flow">
                <div><span>01</span><strong>Model / Claim</strong><small>소비자가 원하는 capability</small></div>
                <b>→</b><div><span>02</span><strong>Plan / Approval</strong><small>위험·변경·확인 계약</small></div>
                <b>→</b><div><span>03</span><strong>Operator</strong><small>idempotent reconcile·fence</small></div>
                <b>→</b><div><span>04</span><strong>Operand</strong><small>실제 database·service·model</small></div>
                <b>→</b><div><span>05</span><strong>Binding / Status</strong><small>소비 계약과 Ready 증거</small></div>
              </div>
              <div class="definition-grid definition-grid-two compact-cards">
                @for (capability of pfssCapabilities; track capability.id) {
                  <section class="definition-card">
                    <header><span>{{ capability.id }}</span><h4>{{ capability.name }}</h4></header>
                    <p>{{ capability.role }}</p>
                    <dl>
                      <div><dt>Owner scope</dt><dd>{{ capability.owns.join(' · ') }}</dd></div>
                      <div><dt>Denied shortcut</dt><dd>{{ capability.excludes.join(' · ') }}</dd></div>
                    </dl>
                  </section>
                }
              </div>
              <aside class="objective-note">
                <strong>객관적 평가</strong>
                <p>Operator는 초기 구현 비용과 상태 설계 부담을 늘립니다. 그러나 stateful capability의 upgrade·restore·drift·retry를 다루면서도 이 비용을 피하려 하면, 그 복잡성이 결국 shell script와 운영자 기억 속으로 이동합니다.</p>
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
                  <p class="foundation-eyebrow">Dynamic UI Plugin Architecture</p>
                  <h3>독립 출하 단위를 신뢰 계약으로 조립하는 Console 확장 구조</h3>
                </div>
              </div>
              <p>
                DUPA는 iframe sandbox나 frontend bundler가 아닙니다. 독립 image의 subShell·plugin을 선언하고,
                source·digest·signature·host compatibility를 검증한 뒤 허용된 contribution만 동적으로 Main Shell에 연결하는
                “서명된 신뢰 코드 실행” 모델입니다.
              </p>
            </section>

            <div class="composition-map" aria-label="DUPA host ownership hierarchy">
              <div class="main-node"><span>MAIN</span><strong>OpenSphere Main Shell</strong><small>frame · session · root navigation · system plugins</small></div>
              <div class="composition-branch">
                <section><span>SUBSHELL</span><strong>독립 운영 영역</strong><small>hostRef=main · own image/service/nav/lifecycle</small></section>
                <b>hosts</b>
                <section><span>PLUGIN</span><strong>host 귀속 기능</strong><small>hostRef=&lt;subShell&gt; · host-scoped page/capability</small></section>
              </div>
              <div class="composition-branch system-branch">
                <section><span>SYSTEM PLUGIN</span><strong>Console 직할 기능</strong><small>Console exact digest에 결속 · 독립 image/lifecycle 없음</small></section>
                <b>contrasts with</b>
                <section><span>REGISTRY EXTENSION</span><strong>DUPA 설치 기능</strong><small>독립 package·signature·activation·rollback</small></section>
              </div>
            </div>

            <section class="document-section capability-contract">
              <div class="section-title">
                <div class="section-title-lockup"><img src="/assets/pictograms/microservices.svg" alt="DUPA extension functions" width="52" height="52" /><div><p class="foundation-eyebrow">DUPA execution functions</p><h3>설치 이후 Main Shell이 실제로 수행하는 네 가지 기능</h3></div></div>
                <p>동적 결합은 매 화면마다 재설치하는 것이 아니라 검증된 projection을 빠르게 소비하고 필요할 때만 UI를 적재하는 구조입니다.</p>
              </div>
              <div class="capability-grid">
                <article><span>01</span><h4>Registry 검증</h4><p>source, digest, signature, compatibility와 hostRef를 설치 시점에 검증하고 승인 revision을 고정합니다.</p><small>Output: immutable verified extension revision</small></article>
                <article><span>02</span><h4>Navigation snapshot</h4><p>메뉴·아이콘·표시 이름·순서를 projection으로 저장해 first paint에서 원격 readiness 조회 없이 즉시 렌더링합니다.</p><small>Output: cached Main Shell navigation projection</small></article>
                <article><span>03</span><h4>On-demand UI load</h4><p>사용자가 route를 선택할 때 해당 host의 UI만 적재하며 timeout이 다른 SubShell과 root navigation을 막지 않습니다.</p><small>Output: isolated host view or bounded error state</small></article>
                <article><span>04</span><h4>Disable와 rollback</h4><p>projection, runtime, child contribution과 외부 side effect를 revision 단위로 정리하고 직전 검증본으로 복구합니다.</p><small>Output: teardown evidence and restored revision</small></article>
              </div>
            </section>

            <section class="document-section">
              <div class="section-title">
                <div class="section-title-lockup"><img src="/assets/pictograms/code-syntax.svg" alt="Signed installation contract" width="52" height="52" /><div><p class="foundation-eyebrow">Install contract</p><h3>SubShell 설치는 파일 복사가 아니라 여섯 단계의 권위 전이</h3></div></div>
                <p>Main Shell은 package가 주장한 화면을 즉시 믿지 않고 Registry가 검증한 projection만 소비합니다.</p>
              </div>
              <ol class="lifecycle-strip">
                @for (stage of dupaStages; track stage.step) {
                  <li><span>{{ stage.step }}</span><h4>{{ stage.title }}</h4><strong>{{ stage.owner }}</strong><p>{{ stage.outcome }}</p><small>{{ stage.evidence }}</small></li>
                }
              </ol>
            </section>

            <section class="decision-block">
              <div class="decision-label">SUBSHELL ROLE</div>
              <div>
                <h4>SubShell이 설치 이후에도 소유해야 하는 것</h4>
                <p>
                  SubShell은 단순 메뉴 그룹이 아니라 독립된 운영 도메인의 host입니다. 자신의 child plugin 문맥,
                  2단 navigation, domain workflow, degraded state와 teardown을 소유합니다. Main Shell은 root frame과
                  공통 contract만 제공하며 child를 평면화하거나 대신 복구하지 않습니다.
                </p>
                <ul>
                  <li><strong>자기완결</strong> — own image/service/version/readiness와 장애 표면을 가집니다.</li>
                  <li><strong>Host authority</strong> — child plugin의 hostRef·compatibility·page projection을 승인합니다.</li>
                  <li><strong>Failure isolation</strong> — 한 subShell의 load timeout이 로그인·다른 shell·Main Shell first paint를 막지 않습니다.</li>
                  <li><strong>Lifecycle closure</strong> — update·disable·remove 시 자신의 child와 외부 side effect를 정리합니다.</li>
                </ul>
              </div>
            </section>

            <section class="document-section">
              <div class="section-title">
                <div class="section-title-lockup"><img src="/assets/pictograms/microservices.svg" alt="SubShell plugin role spectrum" width="52" height="52" /><div><p class="foundation-eyebrow">Functional plugin roles</p><h3>SubShell 귀속 plugin의 기능적 유형</h3></div></div>
                <p>아래 유형은 설치 schema의 새로운 kind가 아닙니다. 설치 kind는 모두 plugin이며 책임을 설명하기 위한 기능적 분류입니다.</p>
              </div>
              <div class="definition-grid definition-grid-three compact-cards">
                @for (role of pluginRoles; track role.id) {
                  <section class="definition-card"><header><span>{{ role.id }}</span><h4>{{ role.name }}</h4></header><p>{{ role.role }}</p><dl><div><dt>Owns</dt><dd>{{ role.owns.join(' · ') }}</dd></div><div><dt>Guardrail</dt><dd>{{ role.excludes.join(' · ') }}</dd></div></dl></section>
                }
              </div>
            </section>

            <section class="document-section">
              <div class="section-title">
                <div class="section-title-lockup"><img src="/assets/pictograms/developer-tools.svg" alt="Agent Runtime unit spectrum" width="52" height="52" /><div><p class="foundation-eyebrow">Agent Runtime spectrum</p><h3>Shell plugin과 Runtime Unit을 분리하는 이유</h3></div></div>
                <p>plugin은 제품 설치·호스팅 분류에 예약하고, Agent Runtime 내부 조립 단위는 Runtime Unit으로 부릅니다.</p>
              </div>
              <div class="runtime-spectrum">
                @for (item of runtimeSpectrum; track item.id; let index = $index) {
                  <section><span>R{{ index + 1 }}</span><h4>{{ item.name }}</h4><small>{{ item.id }}</small><p>{{ item.role }}</p><strong>{{ item.evidence }}</strong></section>
                }
              </div>
              <div class="tradeoff-grid">
                <section><span class="positive">Benefits</span><h4>동적 결합의 이점</h4><p>model/runtime/workspace를 독립 교체하고 risk에 맞춰 자원을 선택하며, AI-Workbench 장애가 R2D2나 Console session으로 전파되는 것을 막을 수 있습니다.</p></section>
                <section><span class="caution">Cautions</span><h4>동적 결합의 비용</h4><p>version graph, 공급망 신뢰, 분산 trace, unload 후 외부 side effect와 orphan resource를 별도로 증명해야 합니다. 동적이라는 이유로 호환성과 정리 책임이 사라지지 않습니다.</p></section>
              </div>
              <aside class="objective-note"><strong>객관적 평가</strong><p>원자성은 구성요소 수를 늘리는 것이 아니라 결합 계약을 줄이는 것입니다. 두 번째 Runtime 구현이 생기기 전 독립 service plane을 미리 만들면 오히려 새 monolith가 됩니다. 현재는 R2D2 Native 구현에서 논리 계약을 추출하고 AI-Workbench는 read-only consumer로 붙이는 것이 적절합니다.</p></aside>
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
                <div><p class="foundation-eyebrow">OpenSphere control surfaces</p><h3>세 기둥은 서로 다른 UX를 제공하지만 같은 구조 하중을 받습니다</h3></div>
              </div>
              <p>OSAA, OSC, OSS가 각자 lifecycle과 권위를 가지면 세 개의 control plane이 됩니다. OpenSphere는 이들을 동일한 OSCE Control API, identity, operation, audit라는 보로 연결합니다.</p>
            </section>

            <div class="structure-frame" aria-label="OSAA OSC OSS pillars connected by control beams">
              <div class="beam beam-top"><span>Capability Registry · Owner API · Semantic action parity</span></div>
              <div class="pillars">
                @for (pillar of controlPillars; track pillar.id) {
                  <section><span>{{ pillar.id }}</span><h4>{{ pillar.name }}</h4><p>{{ pillar.role }}</p><small>{{ pillar.evidence }}</small></section>
                }
              </div>
              @for (beam of controlBeams; track beam.id) { <div class="beam"><span>{{ beam.name }}</span><small>{{ beam.role }}</small></div> }
              <div class="foundation-base"><span>Supabase durable ledger</span><span>Gitea reviewed change</span><span>Kubernetes/PFSS runtime truth</span></div>
            </div>

            <section class="document-section capability-contract">
              <div class="section-title">
                <div class="section-title-lockup"><img src="/assets/pictograms/api.svg" alt="Shared control surface contract" width="52" height="52" /><div><p class="foundation-eyebrow">Surface capability contract</p><h3>네 제어 표면이 나누어 맡는 기능과 공통 완료 기준</h3></div></div>
                <p>Console을 포함한 각 표면은 입력 UX만 소유하고 실행 권위와 operation evidence는 OSCE를 통해 공유합니다.</p>
              </div>
              <div class="capability-grid">
                <article><span>Console</span><h4>시각적 계획·승인</h4><p>폼과 diff로 action을 구성하고 위험, 영향 대상, 승인 상태와 진행률을 시각화합니다.</p><small>Does not own: domain mutation or runtime truth</small></article>
                <article><span>OSS</span><h4>대화형 운영 터미널</h4><p>인증된 단기 session에서 OSC와 허용 도구를 조합하고 동일 operationId를 관찰합니다.</p><small>Does not own: cluster-admin or hidden shell logic</small></article>
                <article><span>OSC</span><h4>기계 판독 명령 계약</h4><p>discoverable command, typed flag, stable JSON, exit code로 사람·자동화·AI에 같은 adapter를 제공합니다.</p><small>Does not own: duplicate business rules</small></article>
                <article><span>OSAA</span><h4>진단·계획·조치 지휘</h4><p>문서와 runtime evidence를 결합해 closed action을 선택하고 필요한 승인 뒤 postcondition까지 추적합니다.</p><small>Does not own: shadow authority or unbounded mutation</small></article>
              </div>
            </section>

            <div class="definition-grid definition-grid-three pillar-cards">
              @for (pillar of controlPillars; track pillar.id) {
                <section class="definition-card"><header><span>{{ pillar.id }}</span><h4>{{ pillar.name }}</h4></header><p>{{ pillar.role }}</p><dl><div><dt>Owns</dt><dd>{{ pillar.owns.join(' · ') }}</dd></div><div><dt>Cannot own</dt><dd>{{ pillar.excludes.join(' · ') }}</dd></div><div><dt>Evidence</dt><dd>{{ pillar.evidence }}</dd></div></dl></section>
              }
            </div>

            <section class="document-section">
              <div class="section-title"><div class="section-title-lockup"><img src="/assets/pictograms/api.svg" alt="PostgreSQL control parity through one API" width="52" height="52" /><div><p class="foundation-eyebrow">One command, one owner</p><h3>같은 PostgreSQL 변경을 세 표면이 처리하는 방법</h3></div></div><p>입력 방식만 다르고 plan, approval, apply, operation과 receipt는 PFSS PostgreSQL owner가 하나만 생성합니다.</p></div>
              <div class="parity-flow">
                <div><span>OSAA</span><strong>“cluster를 이 옵션으로 만들어 줘”</strong><small>자연어 → closed action</small></div>
                <div><span>OSC</span><strong>os foundation postgres plan create</strong><small>typed flags → JSON</small></div>
                <div><span>OSS</span><strong>OS Shell에서 같은 os 명령 실행</strong><small>bounded terminal session</small></div>
                <b>↓</b>
                <section><span>OSCE</span><strong>PFSS PostgreSQL adapter → plan → approval → durable apply → watch → receipt</strong><small>세 표면 모두 동일 planId·digest·fencing·postcondition을 관찰</small></section>
              </div>
            </section>

            <section class="document-section">
              <div class="section-title"><div class="section-title-lockup"><img src="/assets/pictograms/control-panel.svg" alt="Control surface objective review" width="52" height="52" /><div><p class="foundation-eyebrow">Objective review</p><h3>CLI와 Shell을 유지할 이유와 지켜야 할 한계</h3></div></div></div>
              <div class="tradeoff-grid three-tradeoffs">
                <section><span class="positive">CLI</span><h4>AI 친화적인 가장 작은 안정 계약</h4><p>CLI는 terminal UI가 아니라 discoverable command tree, stable JSON, exit code와 stdin/stdout을 가진 protocol adapter입니다. 사람·automation·agent가 같은 계약을 재사용할 수 있습니다.</p></section>
                <section><span class="positive">Shell</span><h4>Console 안의 재현 가능한 운영 환경</h4><p>브라우저만으로 표현하기 어려운 진단과 조합을 제공하되, identity·TTL·network·resource·audit가 묶인 일회성 runtime이어야 합니다.</p></section>
                <section><span class="caution">Limit</span><h4>표면은 authority가 아닙니다</h4><p>CLI에만 존재하는 business logic, Shell의 raw cluster-admin, OSAA의 shadow ledger가 생기면 세 기둥은 보에서 분리되고 원자적 구조가 무너집니다.</p></section>
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
                  <p class="foundation-eyebrow">OSCE · CBSS Core Service</p>
                  <h3>OSCE</h3>
                  <p class="canonical-name">OpenSphere Control Engine</p>
                </div>
              </div>
              <p>
                <strong>CBSS Core Service</strong>인 OSCE는 Console, OSS, OSC, OSAA가 서로 다른 제어 로직을
                갖지 않도록 action, plan, authorization, operation, verification과 rollback을 공통으로
                처리합니다. 각 component의 domain 규칙과 runtime truth는 해당 component에 남기고 OSCE는
                전체 작업을 지휘합니다.
              </p>
            </section>

            <dl class="core-service-identity" aria-label="OSCE component identity">
              <div><dt>분류</dt><dd>CBSS Core Service</dd></div>
              <div><dt>기능 성격</dt><dd>Platform Control Core Engine</dd></div>
              <div><dt>배포 성격</dt><dd>Platform-bundled core component</dd></div>
              <div><dt>Extension 여부</dt><dd>SubShell · Console Plugin · Binding 아님</dd></div>
            </dl>

            <section class="engine-architecture" aria-label="OpenSphere Control Engine architecture">
              <div class="engine-layer-heading">
                <div><span>INPUT CHANNELS</span><h4>누가 어디서 사용하든 같은 제어 의미</h4></div>
                <p>표면은 다르지만 동일한 action schema, actor context와 operation을 사용합니다.</p>
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
                <div><span>SHARED CONTROL CORE</span><h4>OpenSphere Control Engine</h4></div>
                <p>하나의 engine이 계획부터 실제 기능 확인과 rollback까지 operation을 닫습니다.</p>
              </div>
              <div class="engine-core-grid">
                <section class="engine-core-card primary">
                  <img [src]="controlEnginePictograms.engine" alt="Central control tower coordinating operating channels" width="82" height="82" />
                  <div>
                    <span>OSCE</span>
                    <h4>Plan · Authorize · Execute · Verify · Recover</h4>
                    <p>capability discovery, 영향 범위, 실행 정책, durable operation과 postcondition을 하나의 상관관계로 관리합니다.</p>
                  </div>
                </section>
                <section class="engine-core-card">
                  <img [src]="controlEnginePictograms.api" alt="Structured API control surface" width="82" height="82" />
                  <div>
                    <span>CONTROL API</span>
                    <h4>구조화된 API가 기본, OSC는 공식 command adapter</h4>
                    <p>R2D2는 API를 우선 사용하고 공식 운영 명령이 OSC에 정의된 경우 machine-readable mode로 같은 계약을 실행합니다.</p>
                  </div>
                </section>
              </div>

              <div class="engine-layer-heading">
                <div><span>CONTROLLED COMPONENTS</span><h4>구현을 흡수하지 않고 adapter로 지휘</h4></div>
                <p>각 대상은 자신의 lifecycle과 정본을 유지하며 OSCE에 표준 제어 능력을 제공합니다.</p>
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
                <div class="section-title-lockup"><img src="/assets/pictograms/control-tower.svg" alt="Closed control operation stages" width="52" height="52" /><div><p class="foundation-eyebrow">One closed operation</p><h3>판단에서 복구까지 다섯 단계</h3></div></div>
                <p>사용자는 R2D2에 한 번 요청하지만 내부 실행은 각 단계의 권위와 증거를 잃지 않습니다.</p>
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
                <div class="section-title-lockup"><img src="/assets/pictograms/control-panel.svg" alt="Control Engine common capability catalog" width="52" height="52" /><div><p class="foundation-eyebrow">OSCE capability catalog</p><h3>모든 제어 채널이 재사용하는 여섯 가지 공통 기능</h3></div></div>
                <p>OSCE는 component 구현을 흡수하지 않고 계획과 증거의 공통 의미를 제공해 표면별 중복을 제거합니다.</p>
              </div>
              <div class="capability-grid capability-grid-six">
                <article><span>01</span><h4>Discover</h4><p>Registry와 owner API에서 허용 action, schema, risk와 현재 availability를 조회합니다.</p><small>Output: capability revision</small></article>
                <article><span>02</span><h4>Plan</h4><p>대상, 변경 전후, 영향 범위, dependency와 rollback 가능성을 계산합니다.</p><small>Output: immutable plan digest</small></article>
                <article><span>03</span><h4>Authorize</h4><p>actor, tenant, assurance, purpose와 risk에 맞는 정책·승인을 plan에 결속합니다.</p><small>Output: bounded authorization context</small></article>
                <article><span>04</span><h4>Execute</h4><p>해당 component adapter만 호출하고 idempotency, fencing, retry와 progress를 operation으로 관리합니다.</p><small>Output: durable operationId</small></article>
                <article><span>05</span><h4>Verify</h4><p>API, runtime, data와 필요한 browser postcondition을 함께 확인해 기능 완료를 판정합니다.</p><small>Output: owner receipt and evidence set</small></article>
                <article><span>06</span><h4>Recover</h4><p>실패 단계와 적용된 side effect를 기준으로 rollback 또는 안전한 재시도 경로를 지휘합니다.</p><small>Output: recovery receipt and final state</small></article>
              </div>
            </section>

            <section class="decision-block engine-decision">
              <div class="decision-label">CONTROL BOUNDARY</div>
              <div>
                <h4>OSCE가 소유하는 것과 소유하지 않는 것</h4>
                <ul>
                  <li><strong>소유</strong> — action schema, plan, authorization context, operation correlation, postcondition과 rollback 지휘</li>
                  <li><strong>소유하지 않음</strong> — PFSS domain rule, Kubernetes runtime truth, SubShell lifecycle과 Plugin host 문맥</li>
                  <li><strong>직접 경로 금지</strong> — 화면·R2D2·Shell이 adapter를 우회해 raw kubectl·SQL을 실행하는 구조</li>
                  <li><strong>완료 기준</strong> — 명령 성공이 아니라 owner receipt, exact digest, API와 실제 화면의 기능 확인</li>
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
                <div><p class="foundation-eyebrow">Agent & model lifecycle</p><h3>모델을 “호출하는 기능”이 아니라 교체 가능한 운영 자원으로 관리합니다</h3></div>
              </div>
              <p>OpenSphere의 AI lifecycle은 학습만 뜻하지 않습니다. data/model provenance, GPU 할당, evaluation gate, serving binding, Agent 업무 투입, 관측과 안전한 교체까지 하나의 연속된 owner/evidence 계약입니다.</p>
            </section>

            <ol class="ai-pipeline">
              @for (stage of aiLifecycle; track stage.step) {
                <li><span>{{ stage.step }}</span><h4>{{ stage.title }}</h4><strong>{{ stage.owner }}</strong><p>{{ stage.outcome }}</p><small>{{ stage.evidence }}</small></li>
              }
            </ol>

            <section class="document-section capability-contract">
              <div class="section-title">
                <div class="section-title-lockup"><img src="/assets/pictograms/intelligence.svg" alt="AI lifecycle operating functions" width="52" height="52" /><div><p class="foundation-eyebrow">AI lifecycle functions</p><h3>모델 확보부터 교체까지 끊기지 않아야 하는 운영 기능</h3></div></div>
                <p>모델 파일, GPU endpoint와 Agent 배치를 하나로 뭉치지 않고 각 단계의 owner와 lineage를 연결합니다.</p>
              </div>
              <div class="capability-grid">
                <article><span>01</span><h4>Artifact와 lineage</h4><p>dataset, base model, adapter, tokenizer, license와 evaluation 결과를 digest로 연결합니다.</p><small>Output: reproducible model artifact record</small></article>
                <article><span>02</span><h4>학습·GPU 할당</h4><p>quota, priority, runtime class와 job spec 안에서 train·adapt workload를 예약하고 비용을 기록합니다.</p><small>Output: resource-bound training receipt</small></article>
                <article><span>03</span><h4>평가·승인·Serving</h4><p>quality, safety, security, cost gate를 통과한 artifact만 Model Binding과 endpoint로 승격합니다.</p><small>Output: admitted binding and serving evidence</small></article>
                <article><span>04</span><h4>배치·관측·교체</h4><p>Agent가 승인 model/tool/policy로 실행되도록 묶고 drift와 회귀를 감지해 새 revision으로 안전하게 전환합니다.</p><small>Output: run provenance and replacement receipt</small></article>
              </div>
            </section>

            <section class="document-section">
              <div class="section-title"><div class="section-title-lockup"><img src="/assets/pictograms/intelligence.svg" alt="Model locations and bindings" width="52" height="52" /><div><p class="foundation-eyebrow">Where models live</p><h3>우리의 AI 모델은 어디에 존재하는가</h3></div></div><p>논리적으로는 PFSS Model Claim/Binding에 존재하고, 물리적으로는 provider·artifact registry·GPU serving runtime 중 하나에 존재합니다.</p></div>
              <div class="definition-grid definition-grid-three compact-cards">
                @for (location of modelLocations; track location.id) {
                  <section class="definition-card"><header><span>{{ location.id }}</span><h4>{{ location.name }}</h4></header><p>{{ location.role }}</p><dl><div><dt>Owns</dt><dd>{{ location.owns.join(' · ') }}</dd></div><div><dt>Boundary</dt><dd>{{ location.excludes.join(' · ') }}</dd></div><div><dt>Proof</dt><dd>{{ location.evidence }}</dd></div></dl></section>
                }
              </div>
              <div class="invocation-flow" aria-label="Model invocation control flow">
                <div><span>AI-Workbench</span><small>author · configure · evaluate</small></div><b>→</b>
                <div><span>Agent Manifest</span><small>model/tool/policy binding</small></div><b>→</b>
                <div><span>Agent Runtime</span><small>session · loop · approval</small></div><b>→</b>
                <div><span>Model Runtime Unit</span><small>normalize · invoke</small></div><b>→</b>
                <div><span>PFSS Model Binding</span><small>provider or GPU endpoint</small></div>
              </div>
              <aside class="objective-note"><strong>호출 원칙</strong><p>AI-Workbench UI나 Agent workspace가 provider credential을 직접 보유하지 않습니다. Agent Runtime은 model binding을 통해 호출하며 capability tool은 별도 owner API와 approval을 통과합니다. 모델 응답은 권위 있는 mutation 명령이 아니라 다음 정책 판단의 입력입니다.</p></aside>
            </section>

            <section class="document-section">
              <div class="section-title"><div class="section-title-lockup"><img src="/assets/pictograms/cloud-infrastructure-management.svg" alt="GPU and playground infrastructure" width="52" height="52" /><div><p class="foundation-eyebrow">GPU and playground</p><h3>Control Plane은 Pod, 실행 workspace는 risk에 따라 Pod 또는 KubeVirt</h3></div></div><p>GPU는 Agent에게 직접 배정하지 않고 quota·model serving·workspace profile을 통해 할당합니다. 더 강한 격리가 필요한 작업을 더 약한 Driver로 자동 하향하지 않습니다.</p></div>
              <div class="workspace-compare">
                <section><span>DEFAULT</span><h4>Pod Playground</h4><p>짧은 수명, 빠른 시작, 표준 Kubernetes network/storage policy. read/evaluate와 제한된 tool 실행의 기본값입니다.</p><dl><div><dt>Best for</dt><dd>ephemeral evaluation · bounded code · standard isolation</dd></div><div><dt>Proof</dt><dd>runtimeClass · quota · NetworkPolicy · teardown residue zero</dd></div></dl></section>
                <section><span>STRONGER CLASS</span><h4>KubeVirt VM Playground</h4><p>kernel boundary, VM tooling, 긴 workspace가 필요한 고위험 작업에 선택합니다. 설치 의존성이나 기본 경로는 아닙니다.</p><dl><div><dt>Best for</dt><dd>untrusted build · stronger tenant boundary · VM-specific tool</dd></div><div><dt>Proof</dt><dd>VMI identity · network/storage policy · console fence · teardown</dd></div></dl></section>
              </div>
              <div class="no-downgrade"><strong>No automatic downgrade</strong><p>요청된 sandbox profile을 사용할 수 없으면 실행을 거부합니다. “일단 Pod로 실행”은 가용성 개선이 아니라 격리 계약 위반입니다.</p></div>
            </section>

            <section class="document-section">
              <div class="section-title"><div class="section-title-lockup"><img src="/assets/pictograms/connected-ecosystem.svg" alt="Current and target AI runtime states" width="52" height="52" /><div><p class="foundation-eyebrow">Current vs target</p><h3>현재 구현과 목표 상태를 구분합니다</h3></div></div></div>
              <div class="state-split">
                <section><span>CURRENT</span><h4>R2D2 Native Runtime</h4><p>Agent run/step, capability owner, approval, operation과 receipt 의미론의 최초 구현입니다. AI-Workbench는 authoring·evaluation·관찰 표면이며 Runtime 자체가 아닙니다.</p></section>
                <section><span>NEXT CONTRACT</span><h4>AgentRunRead v1</h4><p>AI-Workbench가 별도 ledger나 Kubernetes proxy 없이 R2D2의 run/step을 read-only로 소비하는 최소 seam입니다.</p></section>
                <section><span>DEFERRED</span><h4>Composable Runtime & Playground</h4><p>두 번째 Runtime 구현이나 실제 격리 use case가 생기고 conformance·cleanup·supply-chain gate가 준비될 때 추출합니다.</p></section>
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
  readonly page = input.required<FoundationConceptTabId>();
  readonly tabs = FOUNDATION_CONCEPT_TABS;
  readonly serviceStacks = SERVICE_STACKS;
  readonly cbssComponents = CBSS_COMPONENTS;
  readonly pfssCapabilities = PFSS_CAPABILITIES;
  readonly dupaStages = DUPA_INSTALL_STAGES;
  readonly pluginRoles = DUPA_PLUGIN_ROLES;
  readonly runtimeSpectrum = AGENT_RUNTIME_SPECTRUM;
  readonly controlPillars = CONTROL_PILLARS;
  readonly controlBeams = CONTROL_BEAMS;
  readonly controlEnginePictograms = CONTROL_ENGINE_PICTOGRAMS;
  readonly controlEngineSurfaces = CONTROL_ENGINE_SURFACES;
  readonly controlEngineTargets = CONTROL_ENGINE_TARGETS;
  readonly controlEngineStages = CONTROL_ENGINE_STAGES;
  readonly aiLifecycle = AI_LIFECYCLE;
  readonly modelLocations = MODEL_LOCATIONS;
}
