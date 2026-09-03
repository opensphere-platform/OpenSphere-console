import { ConsoleIndexContentService } from '../core/console-index-content.service';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

interface DialogueStateField {
  name: string;
  meaning: string;
  example: string;
}

interface UpstreamReference {
  name: string;
  contribution: string;
  decision: string;
  href: string;
}

declare const DIALOGUE_STATE_FIELDS: readonly DialogueStateField[];

declare const EXAMPLE_DIALOGUE_STATE: string;

declare const UPSTREAM_REFERENCES: readonly UpstreamReference[];

@Component({
  selector: 'os-landing-osaa-dialogue-state',
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <article class="dialogue-state-page" aria-labelledby="dialogue-state-title">
      <section class="document-intro">
        <div class="intro-lockup">
          <img
            src="/assets/pictograms/intelligence.svg"
            [attr.alt]="copy('ai-reasoning-connected-to-structured-system-state')"
            width="76"
            height="76"
          />
          <div>
            <p class="eyebrow">{{ copy('osdst-cbss-core-service') }}</p>
            <h1 id="dialogue-state-title">{{ copy('osdst') }}</h1>
            <p>
              <strong>{{ copy('osaa-dialogue-state-tracker') }}</strong>{{ copy('는-일반-llm-대화-이력을-opensphere의-서비스-리소스-권위-근거에-결속된-운영-대화로-바꾸는-cbss-핵심-서비스입') }}
              <strong>{{ copy('schema-guided-dialogue-state-tracking') }}</strong>{{ copy('입니다') }}
            </p>
          </div>
        </div>
        <dl class="naming-decision">
          <div>
            <dt>{{ copy('canonical-name') }}</dt>
            <dd>{{ copy('osaa-dialogue-state-tracker') }}</dd>
          </div>
          <div>
            <dt>{{ copy('acronym') }}</dt>
            <dd>{{ copy('osdst') }}</dd>
          </div>
          <div>
            <dt>{{ copy('classification') }}</dt>
            <dd>{{ copy('cbss-core-service-agent-core-engine') }}</dd>
          </div>
          <div>
            <dt>{{ copy('deployment') }}</dt>
            <dd>{{ copy('platform-bundled-core-component') }}</dd>
          </div>
          <div>
            <dt>{{ copy('extension') }}</dt>
            <dd>{{ copy('subshell-console-plugin-binding-아님') }}</dd>
          </div>
          <div>
            <dt>{{ copy('폐기한-표현') }}</dt>
            <dd>{{ copy('system-context-binding-업스트림-표준-용어가-아님') }}</dd>
          </div>
        </dl>
      </section>

      <section class="strategy-overview" aria-labelledby="strategy-overview-title">
        <div class="strategy-heading">
          <p class="eyebrow">{{ copy('goal-and-development-strategy') }}</p>
          <h2 id="strategy-overview-title">{{ copy('대화-이력을-운영-가능한-상태로-바꿉니다') }}</h2>
          <p>
            {{ copy('새-대화-프레임워크를-만드는-것이-목표가-아닙니다-이미-존재하는-conversation-osce-owner-증거-체계를-구조화') }}
          </p>
        </div>
        <div class="strategy-strip">
          <article>
            <span>{{ copy('현재-기반') }}</span>
            <img
              src="/assets/pictograms/console.svg"
              [attr.alt]="copy('durable-conversation-baseline')"
              width="44"
              height="44"
            />
            <strong>{{ copy('durable-conversation') }}</strong>
            <p>
              {{ copy('supabase에-사용자별-대화-메시지를-저장하고-최근-80개-60-000자-문맥을-재구성합니다') }}
            </p>
          </article>
          <article>
            <span>{{ copy('현재-공백') }}</span>
            <img
              src="/assets/pictograms/code-syntax.svg"
              [attr.alt]="copy('missing-typed-dialogue-state')"
              width="44"
              height="44"
            />
            <strong>{{ copy('typed-state-미구현') }}</strong>
            <p>
              {{ copy('intent-resource-slot이-검증된-객체가-아니라-아직-과거-메시지-안의-자연어로만-남아-있습니다') }}
            </p>
          </article>
          <article>
            <span>{{ copy('개발-목표') }}</span>
            <img
              src="/assets/pictograms/connected-ecosystem.svg"
              [attr.alt]="copy('schema-guided-operating-dialogue')"
              width="44"
              height="44"
            />
            <strong>{{ copy('schema-guided-control') }}</strong>
            <p>
              {{ copy('google식-intent-slot-추적을-osce-capability-schema와-canonical-resource에-결속') }}
            </p>
          </article>
          <article>
            <span>{{ copy('완료-기준') }}</span>
            <img
              src="/assets/pictograms/ai-governance-lifecycle-factsheet.svg"
              [attr.alt]="copy('evidence-backed-operation')"
              width="44"
              height="44"
            />
            <strong>{{ copy('evidence-backed-action') }}</strong>
            <p>
              {{ copy('상태-유지-live-관측-승인된-실행과-postcondition이-하나의-operation으로-이어져야-합니다') }}
            </p>
          </article>
        </div>
      </section>

      <section class="document-section" aria-labelledby="structure-title">
        <div class="section-title">
          <div class="section-title-lockup">
            <img
              src="/assets/pictograms/connected-ecosystem.svg"
              [attr.alt]="copy('dialogue-state-connected-to-system-capabilities-and-resources')"
              width="52"
              height="52"
            />
            <div>
              <p class="eyebrow">{{ copy('one-state-three-sources') }}</p>
              <h2 id="structure-title">{{ copy('대화는-세-종류의-상태를-구분해서-연결합니다') }}</h2>
            </div>
          </div>
          <p>
            {{ copy('대화-상태는-운영-현실의-복사본이-아닙니다-무엇을-묻는지-기억하고-실제-사실은-매번-권위-있는-owner에서-다시-읽습니다') }}
          </p>
        </div>
        <div class="definition-grid">
          <article>
            <span class="definition-number">{{ copy('01') }}</span>
            <img
              src="/assets/pictograms/intelligence.svg"
              [attr.alt]="copy('structured-dialogue-state')"
              width="48"
              height="48"
            />
            <h3>{{ copy('dialogue-state') }}</h3>
            <p>{{ copy('현재-domain-intent-대상-리소스와-입력값을-턴-사이에-유지합니다') }}</p>
            <small>{{ copy('기억하는-것-무엇에-관해-무엇을-하려는가') }}</small>
          </article>
          <article>
            <span class="definition-number">{{ copy('02') }}</span>
            <img
              src="/assets/pictograms/api.svg"
              [attr.alt]="copy('osce-capability-schema')"
              width="48"
              height="48"
            />
            <h3>{{ copy('osce-capability-schema-2') }}</h3>
            <p>{{ copy('owner가-실제로-제공하는-status-plan-apply-watch-기능과-필요한-입력을-정의합니다') }}</p>
            <small>{{ copy('결정하는-것-어떤-공식-기능을-호출할-수-있는가') }}</small>
          </article>
          <article>
            <span class="definition-number">{{ copy('03') }}</span>
            <img
              src="/assets/pictograms/systems.svg"
              [attr.alt]="copy('operational-resource-graph-and-evidence')"
              width="48"
              height="48"
            />
            <h3>{{ copy('resource-graph-evidence') }}</h3>
            <p>{{ copy('canonical-resource-관계와-해당-턴에서-관측한-실제-상태-freshness를-연결합니다') }}</p>
            <small>{{ copy('증명하는-것-현재-실제로-무엇이-확인되었는가') }}</small>
          </article>
        </div>
      </section>

      <section class="document-section" aria-labelledby="google-method-title">
        <div class="section-title">
          <div class="section-title-lockup">
            <img
              src="/assets/pictograms/developer-tools.svg"
              [attr.alt]="copy('google-dialogue-methods-adapted-to-opensphere')"
              width="52"
              height="52"
            />
            <div>
              <p class="eyebrow">{{ copy('upstream-method-native-control') }}</p>
              <h2 id="google-method-title">
                {{ copy('google의-구조를-대화-계층에-적용하고-운영-계층은-osce로-확장합니다') }}
              </h2>
            </div>
          </div>
          <p>
            {{ copy('google-sgd는-서비스-intent-slot을-동적으로-해석하고-adk는-session-state-memory를-분리합니') }}
          </p>
        </div>

        <div class="method-layers">
          <article>
            <span>{{ copy('google-sgd-d3st') }}</span>
            <img
              src="/assets/pictograms/intelligence.svg"
              [attr.alt]="copy('schema-guided-dialogue-understanding')"
              width="48"
              height="48"
            />
            <h3>{{ copy('대화-이해') }}</h3>
            <p>
              {{ copy('자연어-설명이-포함된-service-schema를-보고-active-intent와-필요한-slot을-추적합니다') }}
            </p>
            <small>{{ copy('채택-schema-intent-required-optional-result-slots') }}</small>
          </article>
          <article>
            <span>{{ copy('google-adk-dialogflow-cx') }}</span>
            <img
              src="/assets/pictograms/microservices.svg"
              [attr.alt]="copy('session-state-and-memory-separation')"
              width="48"
              height="48"
            />
            <h3>{{ copy('상태-lifecycle') }}</h3>
            <p>
              {{ copy('메시지-이벤트-세션-상태-세션을-넘는-지식을-서로-다른-수명과-저장-책임으로-분리합니다') }}
            </p>
            <small>{{ copy('채택-session-state-memory-및-parameter-정규화') }}</small>
          </article>
          <article>
            <span>{{ copy('opensphere-native') }}</span>
            <img
              src="/assets/pictograms/control-tower.svg"
              [attr.alt]="copy('opensphere-operational-authority')"
              width="48"
              height="48"
            />
            <h3>{{ copy('운영-권위와-증거') }}</h3>
            <p>{{ copy('osce가-capability를-검증하고-owner가-실제-상태-계획-실행-사후-검증을-소유합니다') }}</p>
            <small>{{ copy('추가-authority-evidence-approval-operation') }}</small>
          </article>
        </div>

        <div
          class="schema-mapping-wrap"
          tabindex="0"
          [attr.aria-label]="copy('google-schema-to-opensphere-mapping')"
        >
          <table class="schema-mapping">
            <thead>
              <tr>
                <th scope="col">{{ copy('google-schema') }}</th>
                <th scope="col">{{ copy('opensphere-계약') }}</th>
                <th scope="col">{{ copy('pfss-postgresql-예') }}</th>
                <th scope="col">{{ copy('추가-검증') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row"><code>{{ copy('service-name') }}</code></th>
                <td><code>{{ copy('domain-authorityref') }}</code></td>
                <td>{{ copy('pfss-postgresql-pfss-postgresql-owner') }}</td>
                <td>{{ copy('등록된-owner와-schema-version-일치') }}</td>
              </tr>
              <tr>
                <th scope="row"><code>{{ copy('intent') }}</code></th>
                <td><code>{{ copy('activeintent-capabilityref') }}</code></td>
                <td>{{ copy('status-create-plan-create-apply') }}</td>
                <td>{{ copy('owner가-현재-광고한-capability인지-확인') }}</td>
              </tr>
              <tr>
                <th scope="row"><code>{{ copy('required-slots') }}</code></th>
                <td><code>{{ copy('slotvalues') }}</code></td>
                <td>{{ copy('name-version-replicas-storageclass') }}</td>
                <td>{{ copy('형식-정책-기본값과-누락-입력-검증') }}</td>
              </tr>
              <tr>
                <th scope="row"><code>{{ copy('service-call') }}</code></th>
                <td><code>{{ copy('owner-operation') }}</code></td>
                <td>{{ copy('postgresclaim-status-또는-create-plan') }}</td>
                <td>{{ copy('읽기-변경-분리-승인-plan-digest') }}</td>
              </tr>
              <tr>
                <th scope="row"><code>{{ copy('service-results') }}</code></th>
                <td><code>{{ copy('evidencerefs-operationref') }}</code></td>
                <td>{{ copy('observationid-operationid-receipt') }}</td>
                <td>{{ copy('observedat-expiresat-postcondition') }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="method-boundary">
          <strong>{{ copy('도입-경계') }}</strong>
          <p>
            {{ copy('google-dataset-모델-adk-runtime을-제품-의존성으로-넣지-않습니다-검증된-데이터-모델과-lifecycle') }}
          </p>
        </div>
      </section>

      <section class="document-section" aria-labelledby="flow-title">
        <div class="section-title">
          <div class="section-title-lockup">
            <img
              src="/assets/pictograms/control-tower.svg"
              [attr.alt]="copy('closed-operational-dialogue-flow')"
              width="52"
              height="52"
            />
            <div>
              <p class="eyebrow">{{ copy('closed-operational-flow') }}</p>
              <h2 id="flow-title">{{ copy('질문에서-근거가-있는-답변까지') }}</h2>
            </div>
          </div>
          <p>
            {{ copy('osaa가-추론을-담당하지만-실제-상태의-권위와-변경-권한은-osce와-각-component-owner에-남습니다') }}
          </p>
        </div>
        <div class="operational-flow" [attr.aria-label]="copy('user-utterance-to-verified-response-flow')">
          <article>
            <img
              src="/assets/pictograms/console.svg"
              [attr.alt]="copy('user-conversation-surface')"
              width="46"
              height="46"
            /><span>{{ copy('01') }}</span>
            <h3>{{ copy('user-utterance') }}</h3>
            <p>{{ copy('자연어-질문과-후속-지시') }}</p>
          </article>
          <b aria-hidden="true">{{ copy('symbol') }}</b>
          <article>
            <img
              src="/assets/pictograms/intelligence.svg"
              [attr.alt]="copy('dialogue-state-tracker')"
              width="46"
              height="46"
            /><span>{{ copy('02') }}</span>
            <h3>{{ copy('state-resolve') }}</h3>
            <p>{{ copy('domain-intent-resource-slots') }}</p>
          </article>
          <b aria-hidden="true">{{ copy('symbol') }}</b>
          <article>
            <img
              src="/assets/pictograms/api.svg"
              [attr.alt]="copy('osce-capability-resolution')"
              width="46"
              height="46"
            /><span>{{ copy('03') }}</span>
            <h3>{{ copy('capability-resolve') }}</h3>
            <p>{{ copy('owner-action-policy-risk') }}</p>
          </article>
          <b aria-hidden="true">{{ copy('symbol') }}</b>
          <article>
            <img
              src="/assets/pictograms/control-panel.svg"
              [attr.alt]="copy('owner-read-plan-or-execute')"
              width="46"
              height="46"
            /><span>{{ copy('04') }}</span>
            <h3>{{ copy('owner-operation-2') }}</h3>
            <p>{{ copy('live-read-plan-apply-watch') }}</p>
          </article>
          <b aria-hidden="true">{{ copy('symbol') }}</b>
          <article>
            <img
              src="/assets/pictograms/ai-governance-lifecycle-factsheet.svg"
              [attr.alt]="copy('verified-evidence-response')"
              width="46"
              height="46"
            /><span>{{ copy('05') }}</span>
            <h3>{{ copy('evidence-response') }}</h3>
            <p>{{ copy('result-freshness-uncertainty') }}</p>
          </article>
        </div>
      </section>

      <section class="document-section" aria-labelledby="contract-title">
        <div class="section-title">
          <div class="section-title-lockup">
            <img
              src="/assets/pictograms/code-syntax.svg"
              [attr.alt]="copy('typed-dialogue-state-contract')"
              width="52"
              height="52"
            />
            <div>
              <p class="eyebrow">{{ copy('minimum-state-contract') }}</p>
              <h2 id="contract-title">{{ copy('저장해야-할-것은-사실의-사본이-아니라-안정된-참조입니다') }}</h2>
            </div>
          </div>
          <p>
            {{ copy('운영-사실은-시간이-지나면-낡습니다-dialogue-state는-canonical-reference를-유지하고-답변-시점의-l') }}
          </p>
        </div>
        <div class="state-contract">
          @for (field of stateFields; track field.name) {
            <article>
              <code>{{ field.name }}</code>
              <p>{{ field.meaning }}</p>
              <small>{{ field.example }}</small>
            </article>
          }
        </div>
      </section>

      <section class="document-section" aria-labelledby="implementation-contract-title">
        <div class="section-title">
          <div class="section-title-lockup">
            <img
              src="/assets/pictograms/code-syntax.svg"
              [attr.alt]="copy('concrete-dialogue-state-implementation-contract')"
              width="52"
              height="52"
            />
            <div>
              <p class="eyebrow">{{ copy('concrete-native-implementation') }}</p>
              <h2 id="implementation-contract-title">
                {{ copy('현재-저장-구조를-유지하고-typed-projection만-추가합니다') }}
              </h2>
            </div>
          </div>
          <p>
            {{ copy('conversation-전체를-새-엔진으로-옮기지-않습니다-현재-메시지-원장은-그대로-두고-빠르게-읽는-현재-상태-projec') }}
          </p>
        </div>

        <div class="implementation-baseline">
          <article class="implemented">
            <span>{{ copy('이미-구현됨') }}</span>
            <h3>{{ copy('osaa-durable-conversation') }}</h3>
            <ul>
              <li><code>{{ copy('osaa-conversation') }}</code> {{ copy('symbol-2') }} <code>{{ copy('conversation-message') }}</code></li>
              <li>{{ copy('사용자-소유권과-supabase-rls') }}</li>
              <li><code>{{ copy('conversationid') }}</code>{{ copy('와-turn-request-중복-방지') }}</li>
              <li>{{ copy('최근-80개-60-000자-server-owned-context') }}</li>
              <li>{{ copy('agentrun-toolrun-evidence-operation-ledger') }}</li>
            </ul>
          </article>
          <article class="to-build">
            <span>{{ copy('이번-전략의-구현-대상') }}</span>
            <h3>{{ copy('typed-dialogue-state-projection') }}</h3>
            <ul>
              <li><code>{{ copy('osaa-conversation-state') }}</code> {{ copy('현재-projection과-revision') }}</li>
              <li><code>{{ copy('conversation-message-metadata-statedelta') }}</code> {{ copy('턴별-변경-이력') }}</li>
              <li>{{ copy('osce-schema-version과-owner-authority-binding') }}</li>
              <li>{{ copy('llm-제안-뒤-deterministic-validator-통과') }}</li>
              <li>{{ copy('live-evidence와-active-operation-reference-연결') }}</li>
            </ul>
          </article>
        </div>

        <div class="contract-detail">
          <div>
            <p class="eyebrow">{{ copy('target-projection-v1') }}</p>
            <h3>{{ copy('pfss-postgresql-상태-예시') }}</h3>
            <pre tabindex="0"><code>{{ exampleState }}</code></pre>
          </div>
          <div class="storage-rules">
            <article>
              <strong><code>{{ copy('slotvalues') }}</code>{{ copy('에-저장') }}</strong>
              <p>{{ copy('사용자가-요청한-desired-input과-schema가-정규화한-값만-저장합니다') }}</p>
              <small>{{ copy('예-postgresql-18-replicas-2') }}</small>
            </article>
            <article>
              <strong>{{ copy('운영-사실은-저장하지-않음') }}</strong>
              <p>
                {{ copy('ready-pod-수-owner-응답은-state의-사실-값이-아니라-유효기간이-있는-evidence-reference입니다') }}
              </p>
              <small>{{ copy('매-답변-시-live-read-또는-명시적-last-known-판정') }}</small>
            </article>
            <article>
              <strong>{{ copy('동시성은-revision으로-차단') }}</strong>
              <p>{{ copy('현재-revision과-turn-request를-비교해-중복-순서-역전-상태-변경을-거부합니다') }}</p>
              <small>{{ copy('optimistic-state-transition-idempotent-turn') }}</small>
            </article>
          </div>
        </div>

        <div class="state-transaction" [attr.aria-label]="copy('dialogue-state-transaction-steps')">
          <article>
            <span>{{ copy('01') }}</span><strong>{{ copy('load') }}</strong>
            <p>{{ copy('현재-projection과-새-utterance를-읽음') }}</p>
          </article>
          <article>
            <span>{{ copy('02') }}</span><strong>{{ copy('propose') }}</strong>
            <p>{{ copy('llm이-intent-resource-slot-delta를-제안') }}</p>
          </article>
          <article>
            <span>{{ copy('03') }}</span><strong>{{ copy('validate') }}</strong>
            <p>{{ copy('osce-schema-owner-canonical-id로-결정-검증') }}</p>
          </article>
          <article>
            <span>{{ copy('04') }}</span><strong>{{ copy('observe-plan') }}</strong>
            <p>{{ copy('owner가-live-read-또는-변경-계획-수행') }}</p>
          </article>
          <article>
            <span>{{ copy('05') }}</span><strong>{{ copy('commit') }}</strong>
            <p>{{ copy('state-revision-delta-evidence-operation을-원자-기록') }}</p>
          </article>
          <article>
            <span>{{ copy('06') }}</span><strong>{{ copy('respond') }}</strong>
            <p>{{ copy('검증된-상태와-해당-턴-증거로만-답변') }}</p>
          </article>
        </div>
      </section>

      <section class="document-section" aria-labelledby="continuity-title">
        <div class="section-title">
          <div class="section-title-lockup">
            <img
              src="/assets/pictograms/microservices.svg"
              [attr.alt]="copy('three-related-conversation-turns')"
              width="52"
              height="52"
            />
            <div>
              <p class="eyebrow">{{ copy('reference-continuity') }}</p>
              <h2 id="continuity-title">{{ copy('pfss-postgresql-대화는-이렇게-이어져야-합니다') }}</h2>
            </div>
          </div>
        </div>
        <div class="turn-sequence">
          <article>
            <span>{{ copy('turn-01') }}</span>
            <h3>{{ copy('현재-운영-인스턴스가-있는가') }}</h3>
            <dl>
              <div>
                <dt>{{ copy('domain') }}</dt>
                <dd>{{ copy('pfss-postgresql') }}</dd>
              </div>
              <div>
                <dt>{{ copy('intent') }}</dt>
                <dd>{{ copy('status') }}</dd>
              </div>
              <div>
                <dt>{{ copy('resource') }}</dt>
                <dd>{{ copy('foundation-data-pg') }}</dd>
              </div>
            </dl>
          </article>
          <article>
            <span>{{ copy('turn-02') }}</span>
            <h3>{{ copy('삭제할-수-있나') }}</h3>
            <dl>
              <div>
                <dt>{{ copy('유지') }}</dt>
                <dd>{{ copy('domain-resource') }}</dd>
              </div>
              <div>
                <dt>{{ copy('변경') }}</dt>
                <dd>{{ copy('release-capability-check') }}</dd>
              </div>
              <div>
                <dt>{{ copy('재검증') }}</dt>
                <dd>{{ copy('owner-capability-protection') }}</dd>
              </div>
            </dl>
          </article>
          <article>
            <span>{{ copy('turn-03') }}</span>
            <h3>{{ copy('새로운-인스턴스-생성은') }}</h3>
            <dl>
              <div>
                <dt>{{ copy('유지') }}</dt>
                <dd>{{ copy('pfss-postgresql') }}</dd>
              </div>
              <div>
                <dt>{{ copy('변경') }}</dt>
                <dd>{{ copy('create-capability-check') }}</dd>
              </div>
              <div>
                <dt>{{ copy('대상') }}</dt>
                <dd>{{ copy('기존-claim-pfss-service') }}</dd>
              </div>
            </dl>
          </article>
        </div>
      </section>

      <section class="document-section" aria-labelledby="truth-title">
        <div class="section-title">
          <div class="section-title-lockup">
            <img
              src="/assets/pictograms/ai-governance-lifecycle-factsheet.svg"
              [attr.alt]="copy('evidence-backed-answer-rules')"
              width="52"
              height="52"
            />
            <div>
              <p class="eyebrow">{{ copy('truth-and-evidence-gates') }}</p>
              <h2 id="truth-title">{{ copy('r2d2가-지켜야-할-답변-규칙') }}</h2>
            </div>
          </div>
          <p>
            {{ copy('말이-그럴듯한지가-아니라-해당-턴의-도구-호출-owner-응답과-증거-참조가-답변을-지지하는지로-판정합니다') }}
          </p>
        </div>
        <div class="truth-grid">
          <article class="required">
            <strong>{{ copy('반드시') }}</strong>
            <ul>
              <li>{{ copy('live-조회를-주장하면-해당-턴의-evidenceref를-제시') }}</li>
              <li>{{ copy('조회-실패를-관찰-불가능-으로-표현') }}</li>
              <li>{{ copy('owner가-광고한-capability로-실행-가능성-판정') }}</li>
              <li>{{ copy('실행-후-postcondition과-receipt까지-연결') }}</li>
            </ul>
          </article>
          <article class="forbidden">
            <strong>{{ copy('금지') }}</strong>
            <ul>
              <li>{{ copy('tool-call-없이-확인했습니다-라고-답변') }}</li>
              <li>{{ copy('오래된-snapshot을-현재-사실로-재사용') }}</li>
              <li>{{ copy('api-실패를-리소스-부재로-해석') }}</li>
              <li>{{ copy('모델-추론을-mutation-권위로-사용') }}</li>
            </ul>
          </article>
        </div>
      </section>

      <section class="document-section" aria-labelledby="delivery-plan-title">
        <div class="section-title">
          <div class="section-title-lockup">
            <img
              src="/assets/pictograms/control-panel.svg"
              [attr.alt]="copy('osaa-dialogue-state-delivery-plan')"
              width="52"
              height="52"
            />
            <div>
              <p class="eyebrow">{{ copy('delivery-plan-bounded-increments') }}</p>
              <h2 id="delivery-plan-title">
                {{ copy('다섯-단계로-구현하고-각-단계에서-독립적으로-판정합니다') }}
              </h2>
            </div>
          </div>
          <p>
            {{ copy('프레임워크-도입부터-시작하지-않습니다-데이터-계약-schema-adapter-validator-evidence-결속-사용자-검') }}
          </p>
        </div>

        <ol class="delivery-phases">
          <li>
            <span>{{ copy('01') }}</span>
            <img
              src="/assets/pictograms/code-syntax.svg"
              [attr.alt]="copy('state-contract-and-migration')"
              width="42"
              height="42"
            />
            <div>
              <strong>{{ copy('state-contract-migration') }}</strong>
              <p><code>{{ copy('conversation-state') }}</code>{{ copy('revision-statedelta와-rls를-추가합니다') }}</p>
              <small>{{ copy('gate-재시작-후-같은-conversation-state-복구') }}</small>
            </div>
          </li>
          <li>
            <span>{{ copy('02') }}</span>
            <img
              src="/assets/pictograms/api.svg"
              [attr.alt]="copy('osce-schema-adapter')"
              width="42"
              height="42"
            />
            <div>
              <strong>{{ copy('osce-schema-adapter') }}</strong>
              <p>{{ copy('owner-capability를-service-intent-slot-schema로-투영합니다') }}</p>
              <small>{{ copy('gate-새-capability가-모델-재학습-없이-노출') }}</small>
            </div>
          </li>
          <li>
            <span>{{ copy('03') }}</span>
            <img
              src="/assets/pictograms/intelligence.svg"
              [attr.alt]="copy('state-resolver-and-validator')"
              width="42"
              height="42"
            />
            <div>
              <strong>{{ copy('resolver-deterministic-validator') }}</strong>
              <p>{{ copy('llm은-delta를-제안하고-서버가-schema-id-정책으로-확정합니다') }}</p>
              <small>{{ copy('gate-미등록-intent-resource-slot-거부') }}</small>
            </div>
          </li>
          <li>
            <span>{{ copy('04') }}</span>
            <img
              src="/assets/pictograms/control-tower.svg"
              [attr.alt]="copy('evidence-and-operation-binding')"
              width="42"
              height="42"
            />
            <div>
              <strong>{{ copy('evidence-operation-binding') }}</strong>
              <p>{{ copy('live-read-plan-approval-apply와-postcondition을-같은-턴에-연결합니다') }}</p>
              <small>{{ copy('gate-근거-없는-현재-사실-완료-주장-차단') }}</small>
            </div>
          </li>
          <li>
            <span>{{ copy('05') }}</span>
            <img
              src="/assets/pictograms/console.svg"
              [attr.alt]="copy('console-state-inspection-and-evaluation')"
              width="42"
              height="42"
            />
            <div>
              <strong>{{ copy('console-inspection-evaluation') }}</strong>
              <p>{{ copy('운영자는-현재-intent-resource-evidence-operation을-대화에서-확인합니다') }}</p>
              <small>{{ copy('gate-pfss-기준-시나리오와-장애-시나리오-통과') }}</small>
            </div>
          </li>
        </ol>

        <div class="acceptance-block">
          <div class="acceptance-heading">
            <img
              src="/assets/pictograms/ai-governance-lifecycle-factsheet.svg"
              [attr.alt]="copy('acceptance-test-contract')"
              width="52"
              height="52"
            />
            <div>
              <p class="eyebrow">{{ copy('acceptance-contract') }}</p>
              <h3>{{ copy('r2d2-완성도는-실제-대화-결과로-판정합니다') }}</h3>
            </div>
          </div>
          <div
            class="acceptance-table-wrap"
            tabindex="0"
            [attr.aria-label]="copy('dialogue-state-acceptance-scenarios')"
          >
            <table class="acceptance-table">
              <thead>
                <tr>
                  <th scope="col">{{ copy('시나리오') }}</th>
                  <th scope="col">{{ copy('반드시-유지할-상태') }}</th>
                  <th scope="col">{{ copy('합격-판정') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">{{ copy('운영-인스턴스가-있는가') }}</th>
                  <td>{{ copy('pfss-postgresql-status') }}</td>
                  <td>{{ copy('같은-턴의-owner-evidence로-대상-ready-관측-시각-제시') }}</td>
                </tr>
                <tr>
                  <th scope="row">{{ copy('삭제할-수-있나-2') }}</th>
                  <td>{{ copy('기존-resource-유지-intent만-delete-capability로-전환') }}</td>
                  <td>{{ copy('보호-백업-권한을-별도-조회하고-plan-가능-여부를-판정') }}</td>
                </tr>
                <tr>
                  <th scope="row">{{ copy('새-인스턴스-생성은') }}</th>
                  <td>{{ copy('domain-유지-기존-resource는-생성-대상에서-해제') }}</td>
                  <td>{{ copy('create-schema의-누락-slot만-질문하고-기존-장애를-복사하지-않음') }}</td>
                </tr>
                <tr>
                  <th scope="row">{{ copy('owner-api-500') }}</th>
                  <td>{{ copy('canonical-resource-reference-유지') }}</td>
                  <td>{{ copy('없음-이-아니라-현재-관찰-불가능-으로-답변') }}</td>
                </tr>
                <tr>
                  <th scope="row">{{ copy('변경-실행') }}</th>
                  <td>{{ copy('plandigest-approval-operationref') }}</td>
                  <td>{{ copy('receipt와-postcondition-전에는-완료라고-답하지-않음') }}</td>
                </tr>
                <tr>
                  <th scope="row">{{ copy('새-owner-capability-설치') }}</th>
                  <td>{{ copy('새-schemaref-revision') }}</td>
                  <td>{{ copy('llm-재학습-없이-새로운-intent-slot을-해석') }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section class="document-section" aria-labelledby="upstream-title">
        <div class="section-title">
          <div class="section-title-lockup">
            <img
              src="/assets/pictograms/cloud-infrastructure-management.svg"
              [attr.alt]="copy('upstream-concepts-assessed-for-opensphere')"
              width="52"
              height="52"
            />
            <div>
              <p class="eyebrow">{{ copy('upstream-assessment') }}</p>
              <h2 id="upstream-title">
                {{ copy('검증된-개념은-수용하고-실행-프레임워크는-중복-도입하지-않습니다') }}
              </h2>
            </div>
          </div>
          <p>
            {{ copy('현재-osaa-gateway-supabase-osce-operation-ledger를-유지하면서-필요한-상태-모델만-얇게-추가') }}
          </p>
        </div>
        <div class="upstream-table-wrap" tabindex="0" [attr.aria-label]="copy('upstream-reference-assessment')">
          <table class="upstream-table">
            <thead>
              <tr>
                <th scope="col">{{ copy('upstream') }}</th>
                <th scope="col">{{ copy('가져올-개념') }}</th>
                <th scope="col">{{ copy('opensphere-결정') }}</th>
              </tr>
            </thead>
            <tbody>
              @for (reference of upstreamReferences; track reference.name) {
                <tr>
                  <th scope="row">
                    <a [href]="reference.href" target="_blank" rel="noopener noreferrer">{{
                      reference.name
                    }}</a>
                  </th>
                  <td>{{ reference.contribution }}</td>
                  <td>{{ reference.decision }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        <div class="implementation-decision">
          <img
            src="/assets/pictograms/control-panel.svg"
            [attr.alt]="copy('bounded-implementation-decision')"
            width="58"
            height="58"
          />
          <div>
            <p class="eyebrow">{{ copy('implementation-boundary') }}</p>
            <h3>{{ copy('개념은-채택-새-orchestration-framework는-보류') }}</h3>
            <p>
              {{ copy('rasa-langgraph-temporal을-지금-추가하지-않습니다-먼저-typed-dialogue-state-tracker를') }}
            </p>
          </div>
        </div>
      </section>
    </article>
  `,
  styles: [
    `
      :host {
        display: block;
        min-width: 0;
        max-width: 100%;
      }
      .dialogue-state-page {
        --od-page-title: var(--arch-page-title, clamp(1.55rem, 2.2vw, 2rem));
        --od-section-title: var(--arch-section-title, 1.2rem);
        --od-card-title: var(--arch-card-title, 0.98rem);
        --od-body: var(--arch-body, 0.9rem);
        --od-detail: var(--arch-detail, 0.8rem);
        --od-label: var(--arch-label, 0.68rem);
        width: 100%;
        min-width: 0;
        max-width: 100%;
        color: var(--os-ink);
        overflow: hidden;
      }
      .dialogue-state-page :where(p, h1, h2, h3, dt, dd, li, small, code) {
        min-width: 0;
        overflow-wrap: anywhere;
      }
      .document-intro {
        display: grid;
        grid-template-columns: minmax(0, 1.55fr) minmax(19rem, 0.8fr);
        gap: 2rem;
        align-items: end;
        padding: 1.25rem 0 1.75rem;
        border-bottom: 1px solid var(--os-hairline);
      }
      .intro-lockup {
        display: grid;
        grid-template-columns: 5.5rem minmax(0, 1fr);
        gap: 1rem;
        align-items: start;
      }
      .intro-lockup > img {
        width: 5rem;
        height: 5rem;
        object-fit: contain;
      }
      .eyebrow {
        margin: 0 0 0.45rem;
        color: var(--os-accent);
        font-size: var(--od-label);
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      .document-intro h1 {
        margin: 0;
        font-size: var(--od-page-title);
        font-weight: 500;
        line-height: 1.16;
        letter-spacing: -0.02em;
      }
      .document-intro .intro-lockup p:last-child {
        max-width: 60rem;
        margin: 0.8rem 0 0;
        color: var(--os-ink-muted);
        font-size: var(--od-body);
        line-height: 1.65;
      }
      .naming-decision {
        margin: 0;
        border: 1px solid var(--os-hairline);
        background: var(--os-canvas);
      }
      .naming-decision > div {
        display: grid;
        grid-template-columns: 7.6rem minmax(0, 1fr);
        gap: 0.7rem;
        padding: 0.65rem 0.75rem;
        border-bottom: 1px solid var(--os-hairline);
      }
      .naming-decision > div:last-child {
        border-bottom: 0;
      }
      .naming-decision dt {
        color: var(--os-ink-muted);
        font-size: var(--od-label);
        font-weight: 700;
        text-transform: uppercase;
      }
      .naming-decision dd {
        margin: 0;
        font-size: var(--od-detail);
        line-height: 1.45;
      }
      .document-section {
        margin-top: 2rem;
      }
      .section-title {
        display: flex;
        justify-content: space-between;
        gap: 2rem;
        align-items: end;
        margin-bottom: 0.7rem;
      }
      .section-title-lockup {
        display: grid;
        grid-template-columns: 3.5rem minmax(0, 1fr);
        gap: 0.8rem;
        align-items: center;
      }
      .section-title-lockup > img {
        width: 3.25rem;
        height: 3.25rem;
        object-fit: contain;
      }
      .section-title h2 {
        margin: 0;
        font-size: var(--od-section-title);
        font-weight: 550;
        line-height: 1.3;
      }
      .section-title > p {
        max-width: 41rem;
        margin: 0;
        color: var(--os-ink-muted);
        font-size: var(--od-detail);
        line-height: 1.55;
        text-align: right;
      }
      .definition-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        border: 1px solid var(--os-hairline);
        background: var(--os-canvas);
      }
      .definition-grid article {
        display: grid;
        grid-template-columns: auto 3.25rem minmax(0, 1fr);
        grid-template-rows: auto auto 1fr;
        column-gap: 0.75rem;
        min-height: 10rem;
        padding: 1rem;
        border-right: 1px solid var(--os-hairline);
      }
      .definition-grid article:last-child {
        border-right: 0;
      }
      .definition-grid img {
        grid-column: 2;
        grid-row: 1/4;
        width: 3rem;
        height: 3rem;
        object-fit: contain;
      }
      .definition-number {
        grid-column: 1;
        grid-row: 1/4;
        color: var(--os-accent);
        font-family: var(--os-font-mono);
        font-size: var(--od-label);
      }
      .definition-grid h3 {
        grid-column: 3;
        margin: 0;
        font-size: var(--od-card-title);
      }
      .definition-grid p {
        grid-column: 3;
        margin: 0.45rem 0 0;
        color: var(--os-ink-muted);
        font-size: var(--od-body);
        line-height: 1.55;
      }
      .definition-grid small {
        grid-column: 3;
        align-self: end;
        margin-top: 0.7rem;
        color: var(--os-ink-muted);
        font-size: var(--od-detail);
      }
      .operational-flow {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr) auto) minmax(0, 1fr);
        align-items: stretch;
        border: 1px solid var(--os-hairline);
        background: var(--os-canvas);
      }
      .operational-flow article {
        display: grid;
        grid-template-columns: 3.2rem minmax(0, 1fr);
        column-gap: 0.65rem;
        align-content: start;
        min-height: 9.5rem;
        padding: 0.9rem;
      }
      .operational-flow img {
        grid-row: 1/4;
        width: 2.9rem;
        height: 2.9rem;
        object-fit: contain;
      }
      .operational-flow span {
        color: var(--os-accent);
        font-family: var(--os-font-mono);
        font-size: var(--od-label);
      }
      .operational-flow h3 {
        margin: 0.35rem 0 0;
        font-size: var(--od-card-title);
      }
      .operational-flow p {
        margin: 0.35rem 0 0;
        color: var(--os-ink-muted);
        font-size: var(--od-detail);
        line-height: 1.5;
      }
      .operational-flow > b {
        display: grid;
        place-items: center;
        min-width: 1.3rem;
        color: var(--os-accent);
        font-size: 1.15rem;
        font-weight: 400;
      }
      .state-contract {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        border: 1px solid var(--os-hairline);
        background: var(--os-canvas);
      }
      .state-contract article {
        min-height: 7.6rem;
        padding: 0.8rem;
        border-right: 1px solid var(--os-hairline);
        border-bottom: 1px solid var(--os-hairline);
      }
      .state-contract article:nth-child(4n) {
        border-right: 0;
      }
      .state-contract article:nth-last-child(-n + 4) {
        border-bottom: 0;
      }
      .state-contract code {
        color: var(--os-accent);
        font-family: var(--os-font-mono);
        font-size: var(--od-detail);
        font-weight: 650;
      }
      .state-contract p {
        margin: 0.55rem 0 0;
        font-size: var(--od-body);
        line-height: 1.5;
      }
      .state-contract small {
        display: block;
        margin-top: 0.5rem;
        color: var(--os-ink-muted);
        font-size: var(--od-detail);
      }
      .turn-sequence {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        border: 1px solid var(--os-hairline);
        background: var(--os-canvas);
      }
      .turn-sequence article {
        padding: 1rem;
        border-right: 1px solid var(--os-hairline);
      }
      .turn-sequence article:last-child {
        border-right: 0;
      }
      .turn-sequence > article > span {
        color: var(--os-accent);
        font-family: var(--os-font-mono);
        font-size: var(--od-label);
      }
      .turn-sequence h3 {
        margin: 0.55rem 0 0.8rem;
        font-size: var(--od-card-title);
      }
      .turn-sequence dl {
        margin: 0;
      }
      .turn-sequence dl > div {
        display: grid;
        grid-template-columns: 5.5rem minmax(0, 1fr);
        gap: 0.5rem;
        padding: 0.4rem 0;
        border-top: 1px solid var(--os-hairline);
      }
      .turn-sequence dt {
        color: var(--os-ink-muted);
        font-size: var(--od-label);
        font-weight: 700;
        text-transform: uppercase;
      }
      .turn-sequence dd {
        margin: 0;
        font-size: var(--od-detail);
      }
      .truth-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        border: 1px solid var(--os-hairline);
        background: var(--os-canvas);
      }
      .truth-grid article {
        padding: 1rem 1.1rem;
      }
      .truth-grid article + article {
        border-left: 1px solid var(--os-hairline);
      }
      .truth-grid strong {
        display: block;
        padding-bottom: 0.55rem;
        border-bottom: 3px solid var(--os-success);
        font-size: var(--od-card-title);
      }
      .truth-grid .forbidden strong {
        border-color: var(--os-danger);
      }
      .truth-grid ul {
        margin: 0.75rem 0 0;
        padding-left: 1.15rem;
      }
      .truth-grid li {
        margin: 0.4rem 0;
        font-size: var(--od-body);
        line-height: 1.5;
      }
      .upstream-table-wrap {
        overflow-x: auto;
        border: 1px solid var(--os-hairline);
        background: var(--os-canvas);
      }
      .upstream-table-wrap:focus-visible {
        outline: 2px solid var(--os-accent);
        outline-offset: 2px;
      }
      .upstream-table {
        width: 100%;
        min-width: 54rem;
        border-collapse: collapse;
        table-layout: fixed;
      }
      .upstream-table th,
      .upstream-table td {
        padding: 0.7rem 0.8rem;
        border-right: 1px solid var(--os-hairline);
        border-bottom: 1px solid var(--os-hairline);
        text-align: left;
        vertical-align: top;
        font-size: var(--od-detail);
        line-height: 1.5;
      }
      .upstream-table tr:last-child > * {
        border-bottom: 0;
      }
      .upstream-table tr > *:last-child {
        border-right: 0;
      }
      .upstream-table thead th {
        background: var(--os-surface-1);
        font-size: var(--od-label);
        text-transform: uppercase;
      }
      .upstream-table th:first-child {
        width: 22%;
      }
      .upstream-table th:last-child {
        width: 25%;
      }
      .upstream-table a {
        color: var(--os-link);
        font-weight: 650;
      }
      .implementation-decision {
        display: grid;
        grid-template-columns: 4.2rem minmax(0, 1fr);
        gap: 1rem;
        align-items: center;
        margin-top: 1rem;
        padding: 1rem;
        border-left: 4px solid var(--os-accent);
        background: var(--os-surface-1);
      }
      .implementation-decision > img {
        width: 3.7rem;
        height: 3.7rem;
        object-fit: contain;
      }
      .implementation-decision h3 {
        margin: 0;
        font-size: var(--od-card-title);
      }
      .implementation-decision p:last-child {
        margin: 0.45rem 0 0;
        color: var(--os-ink-muted);
        font-size: var(--od-body);
        line-height: 1.55;
      }
      @media screen and (max-width: 76rem) {
        .document-intro {
          grid-template-columns: 1fr;
        }
        .naming-decision {
          max-width: 48rem;
        }
        .operational-flow {
          grid-template-columns: 1fr;
        }
        .operational-flow article {
          min-height: 0;
          border-bottom: 1px solid var(--os-hairline);
        }
        .operational-flow article:last-child {
          border-bottom: 0;
        }
        .operational-flow > b {
          min-height: 1.7rem;
          transform: rotate(90deg);
        }
      }
      @media screen and (max-width: 60rem) {
        .section-title {
          display: block;
        }
        .section-title > p {
          margin-top: 0.45rem;
          text-align: left;
        }
        .definition-grid,
        .turn-sequence {
          grid-template-columns: 1fr;
        }
        .definition-grid article,
        .turn-sequence article {
          border-right: 0;
          border-bottom: 1px solid var(--os-hairline);
        }
        .definition-grid article:last-child,
        .turn-sequence article:last-child {
          border-bottom: 0;
        }
        .state-contract {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        .state-contract article:nth-child(4n) {
          border-right: 1px solid var(--os-hairline);
        }
        .state-contract article:nth-child(2n) {
          border-right: 0;
        }
        .state-contract article:nth-last-child(-n + 4) {
          border-bottom: 1px solid var(--os-hairline);
        }
        .state-contract article:nth-last-child(-n + 2) {
          border-bottom: 0;
        }
      }
      @media screen and (max-width: 38rem) {
        .intro-lockup {
          grid-template-columns: 1fr;
        }
        .naming-decision > div {
          grid-template-columns: 1fr;
          gap: 0.2rem;
        }
        .state-contract,
        .truth-grid {
          grid-template-columns: 1fr;
        }
        .state-contract article,
        .state-contract article:nth-child(2n),
        .state-contract article:nth-child(4n) {
          border-right: 0;
          border-bottom: 1px solid var(--os-hairline);
        }
        .state-contract article:last-child {
          border-bottom: 0;
        }
        .truth-grid article + article {
          border-left: 0;
          border-top: 1px solid var(--os-hairline);
        }
        .implementation-decision {
          grid-template-columns: 1fr;
        }
      }
    `,
  ],
})
export class LandingOsaaDialogueState {
  readonly content = inject(ConsoleIndexContentService);
  readonly copy = (key: string): string => this.content.text('osaa-dialogue-state', key);

  get stateFields(): typeof DIALOGUE_STATE_FIELDS { return this.content.model('DIALOGUE_STATE_FIELDS'); }
  get upstreamReferences(): typeof UPSTREAM_REFERENCES { return this.content.model('UPSTREAM_REFERENCES'); }
  get exampleState(): typeof EXAMPLE_DIALOGUE_STATE { return this.content.model('EXAMPLE_DIALOGUE_STATE'); }
}
