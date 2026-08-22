import { ChangeDetectionStrategy, Component } from '@angular/core';

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

const DIALOGUE_STATE_FIELDS: readonly DialogueStateField[] = [
  { name: 'domain', meaning: '현재 대화가 다루는 서비스 영역', example: 'pfss.postgresql' },
  {
    name: 'activeIntent',
    meaning: '현재 사용자가 확인하거나 수행하려는 일',
    example: 'create.capability.check',
  },
  {
    name: 'activeResourceRefs[]',
    meaning: '이름이 아니라 canonical ID로 식별한 대상',
    example: 'PostgresClaim/.../foundation-data-pg',
  },
  {
    name: 'slotValues',
    meaning: '스키마가 요구하는 입력과 이미 확인된 값',
    example: 'version · replicas · storageClass',
  },
  {
    name: 'authorityRef',
    meaning: '실제 상태와 변경을 소유하는 Owner',
    example: 'PFSS PostgreSQL Owner',
  },
  {
    name: 'capabilityRefs[]',
    meaning: '현재 Owner가 광고한 조회·계획·실행 기능',
    example: 'status · create.plan · create.apply',
  },
  {
    name: 'evidenceRefs[]',
    meaning: '해당 턴에서 얻은 관측 결과와 freshness',
    example: 'observationId · observedAt',
  },
  {
    name: 'operationRef',
    meaning: '승인·실행·검증을 잇는 내구 작업 식별자',
    example: 'operationId · planDigest',
  },
] as const;

const UPSTREAM_REFERENCES: readonly UpstreamReference[] = [
  {
    name: 'Dialogue State Tracking',
    contribution: '의도·대상·필요 입력을 매 턴의 구조화된 상태로 유지합니다.',
    decision: '핵심 개념 채택',
    href: 'https://aclanthology.org/2021.sigdial-1.25/',
  },
  {
    name: 'Schema-Guided Dialogue',
    contribution: '고정된 명령 목록 대신 서비스/API 스키마로 intent와 slot을 해석합니다.',
    decision: 'OSCE Capability Schema와 결합',
    href: 'https://research.google/pubs/towards-scalable-multi-domain-conversational-agents-the-schema-guided-dialogue-dataset/',
  },
  {
    name: 'Rasa Tracker',
    contribution: '대화 이벤트와 slot을 세션을 넘어 저장하는 실용적인 tracker 모델을 제공합니다.',
    decision: '상태 모델만 참고',
    href: 'https://rasa.com/docs/reference/integrations/action-server/sdk-tracker/',
  },
  {
    name: 'Agent Session & Checkpoint',
    contribution: '대화 이력과 실행 상태를 thread/checkpoint 단위로 보존하고 재개합니다.',
    decision: '기존 Supabase 저장 구조로 충족',
    href: 'https://docs.langchain.com/oss/javascript/langgraph/persistence',
  },
  {
    name: 'Resource Graph & State Binding',
    contribution: '논리 객체와 실제 운영 객체, 그리고 객체 사이의 관계를 안정된 참조로 연결합니다.',
    decision: 'OSAA Operational Resource Graph 재사용',
    href: 'https://developer.hashicorp.com/terraform/language/state/purpose',
  },
  {
    name: 'MCP Resources & Tools',
    contribution: 'AI가 읽을 리소스와 호출할 도구를 표준 인터페이스로 노출합니다.',
    decision: '향후 외부 연동 adapter로만 검토',
    href: 'https://modelcontextprotocol.io/specification/2025-06-18/server/index',
  },
] as const;

@Component({
  selector: 'os-landing-osaa-dialogue-state',
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <article class="dialogue-state-page" aria-labelledby="dialogue-state-title">
      <section class="document-intro">
        <div class="intro-lockup">
          <img
            src="/assets/pictograms/intelligence.svg"
            alt="AI reasoning connected to structured system state"
            width="76"
            height="76"
          />
          <div>
            <p class="eyebrow">OSAA · Schema-guided operational dialogue</p>
            <h1 id="dialogue-state-title">OSAA Dialogue State Tracker</h1>
            <p>
              일반 LLM 대화 이력을 OpenSphere의 서비스·리소스·권위·근거에 결속된 운영 대화로 바꾸는
              구조적 장치입니다. 정식 방법론은
              <strong>Schema-Guided Dialogue State Tracking</strong>입니다.
            </p>
          </div>
        </div>
        <dl class="naming-decision">
          <div>
            <dt>Canonical name</dt>
            <dd>OSAA Dialogue State Tracker</dd>
          </div>
          <div>
            <dt>한국어</dt>
            <dd>OSAA 대화 상태 추적기</dd>
          </div>
          <div>
            <dt>폐기한 표현</dt>
            <dd>System Context Binding — 업스트림 표준 용어가 아님</dd>
          </div>
        </dl>
      </section>

      <section class="document-section" aria-labelledby="structure-title">
        <div class="section-title">
          <div class="section-title-lockup">
            <img
              src="/assets/pictograms/connected-ecosystem.svg"
              alt="Dialogue state connected to system capabilities and resources"
              width="52"
              height="52"
            />
            <div>
              <p class="eyebrow">One state · three sources</p>
              <h2 id="structure-title">대화는 세 종류의 상태를 구분해서 연결합니다</h2>
            </div>
          </div>
          <p>
            대화 상태는 운영 현실의 복사본이 아닙니다. 무엇을 묻는지 기억하고, 실제 사실은 매번 권위
            있는 Owner에서 다시 읽습니다.
          </p>
        </div>
        <div class="definition-grid">
          <article>
            <span class="definition-number">01</span>
            <img
              src="/assets/pictograms/intelligence.svg"
              alt="Structured dialogue state"
              width="48"
              height="48"
            />
            <h3>Dialogue State</h3>
            <p>현재 domain, intent, 대상 리소스와 입력값을 턴 사이에 유지합니다.</p>
            <small>기억하는 것: “무엇에 관해 무엇을 하려는가”</small>
          </article>
          <article>
            <span class="definition-number">02</span>
            <img
              src="/assets/pictograms/api.svg"
              alt="OSCE capability schema"
              width="48"
              height="48"
            />
            <h3>OSCE Capability Schema</h3>
            <p>Owner가 실제로 제공하는 status·plan·apply·watch 기능과 필요한 입력을 정의합니다.</p>
            <small>결정하는 것: “어떤 공식 기능을 호출할 수 있는가”</small>
          </article>
          <article>
            <span class="definition-number">03</span>
            <img
              src="/assets/pictograms/systems.svg"
              alt="Operational resource graph and evidence"
              width="48"
              height="48"
            />
            <h3>Resource Graph & Evidence</h3>
            <p>canonical resource 관계와 해당 턴에서 관측한 실제 상태·freshness를 연결합니다.</p>
            <small>증명하는 것: “현재 실제로 무엇이 확인되었는가”</small>
          </article>
        </div>
      </section>

      <section class="document-section" aria-labelledby="flow-title">
        <div class="section-title">
          <div class="section-title-lockup">
            <img
              src="/assets/pictograms/control-tower.svg"
              alt="Closed operational dialogue flow"
              width="52"
              height="52"
            />
            <div>
              <p class="eyebrow">Closed operational flow</p>
              <h2 id="flow-title">질문에서 근거가 있는 답변까지</h2>
            </div>
          </div>
          <p>
            OSAA가 추론을 담당하지만 실제 상태의 권위와 변경 권한은 OSCE와 각 component Owner에
            남습니다.
          </p>
        </div>
        <div class="operational-flow" aria-label="User utterance to verified response flow">
          <article>
            <img
              src="/assets/pictograms/console.svg"
              alt="User conversation surface"
              width="46"
              height="46"
            /><span>01</span>
            <h3>User utterance</h3>
            <p>자연어 질문과 후속 지시</p>
          </article>
          <b aria-hidden="true">→</b>
          <article>
            <img
              src="/assets/pictograms/intelligence.svg"
              alt="Dialogue state tracker"
              width="46"
              height="46"
            /><span>02</span>
            <h3>State resolve</h3>
            <p>domain · intent · resource · slots</p>
          </article>
          <b aria-hidden="true">→</b>
          <article>
            <img
              src="/assets/pictograms/api.svg"
              alt="OSCE capability resolution"
              width="46"
              height="46"
            /><span>03</span>
            <h3>Capability resolve</h3>
            <p>Owner · action · policy · risk</p>
          </article>
          <b aria-hidden="true">→</b>
          <article>
            <img
              src="/assets/pictograms/control-panel.svg"
              alt="Owner read plan or execute"
              width="46"
              height="46"
            /><span>04</span>
            <h3>Owner operation</h3>
            <p>live read · plan · apply · watch</p>
          </article>
          <b aria-hidden="true">→</b>
          <article>
            <img
              src="/assets/pictograms/ai-governance-lifecycle-factsheet.svg"
              alt="Verified evidence response"
              width="46"
              height="46"
            /><span>05</span>
            <h3>Evidence response</h3>
            <p>result · freshness · uncertainty</p>
          </article>
        </div>
      </section>

      <section class="document-section" aria-labelledby="contract-title">
        <div class="section-title">
          <div class="section-title-lockup">
            <img
              src="/assets/pictograms/code-syntax.svg"
              alt="Typed dialogue state contract"
              width="52"
              height="52"
            />
            <div>
              <p class="eyebrow">Minimum state contract</p>
              <h2 id="contract-title">저장해야 할 것은 사실의 사본이 아니라 안정된 참조입니다</h2>
            </div>
          </div>
          <p>
            운영 사실은 시간이 지나면 낡습니다. Dialogue State는 canonical reference를 유지하고,
            답변 시점의 live evidence를 새로 결속합니다.
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

      <section class="document-section" aria-labelledby="continuity-title">
        <div class="section-title">
          <div class="section-title-lockup">
            <img
              src="/assets/pictograms/microservices.svg"
              alt="Three related conversation turns"
              width="52"
              height="52"
            />
            <div>
              <p class="eyebrow">Reference continuity</p>
              <h2 id="continuity-title">PFSS PostgreSQL 대화는 이렇게 이어져야 합니다</h2>
            </div>
          </div>
        </div>
        <div class="turn-sequence">
          <article>
            <span>TURN 01</span>
            <h3>“현재 운영 인스턴스가 있는가?”</h3>
            <dl>
              <div>
                <dt>domain</dt>
                <dd>pfss.postgresql</dd>
              </div>
              <div>
                <dt>intent</dt>
                <dd>status</dd>
              </div>
              <div>
                <dt>resource</dt>
                <dd>foundation-data-pg</dd>
              </div>
            </dl>
          </article>
          <article>
            <span>TURN 02</span>
            <h3>“삭제할 수 있나?”</h3>
            <dl>
              <div>
                <dt>유지</dt>
                <dd>domain · resource</dd>
              </div>
              <div>
                <dt>변경</dt>
                <dd>release.capability.check</dd>
              </div>
              <div>
                <dt>재검증</dt>
                <dd>Owner capability · protection</dd>
              </div>
            </dl>
          </article>
          <article>
            <span>TURN 03</span>
            <h3>“새로운 인스턴스 생성은?”</h3>
            <dl>
              <div>
                <dt>유지</dt>
                <dd>pfss.postgresql</dd>
              </div>
              <div>
                <dt>변경</dt>
                <dd>create.capability.check</dd>
              </div>
              <div>
                <dt>대상</dt>
                <dd>기존 claim → PFSS service</dd>
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
              alt="Evidence-backed answer rules"
              width="52"
              height="52"
            />
            <div>
              <p class="eyebrow">Truth and evidence gates</p>
              <h2 id="truth-title">R2D2가 지켜야 할 답변 규칙</h2>
            </div>
          </div>
          <p>
            말이 그럴듯한지가 아니라 해당 턴의 도구 호출, Owner 응답과 증거 참조가 답변을
            지지하는지로 판정합니다.
          </p>
        </div>
        <div class="truth-grid">
          <article class="required">
            <strong>반드시</strong>
            <ul>
              <li>live 조회를 주장하면 해당 턴의 evidenceRef를 제시</li>
              <li>조회 실패를 “관찰 불가능”으로 표현</li>
              <li>Owner가 광고한 capability로 실행 가능성 판정</li>
              <li>실행 후 postcondition과 receipt까지 연결</li>
            </ul>
          </article>
          <article class="forbidden">
            <strong>금지</strong>
            <ul>
              <li>tool call 없이 “확인했습니다”라고 답변</li>
              <li>오래된 snapshot을 현재 사실로 재사용</li>
              <li>API 실패를 리소스 부재로 해석</li>
              <li>모델 추론을 mutation 권위로 사용</li>
            </ul>
          </article>
        </div>
      </section>

      <section class="document-section" aria-labelledby="upstream-title">
        <div class="section-title">
          <div class="section-title-lockup">
            <img
              src="/assets/pictograms/cloud-infrastructure-management.svg"
              alt="Upstream concepts assessed for OpenSphere"
              width="52"
              height="52"
            />
            <div>
              <p class="eyebrow">Upstream assessment</p>
              <h2 id="upstream-title">
                검증된 개념은 수용하고 실행 프레임워크는 중복 도입하지 않습니다
              </h2>
            </div>
          </div>
          <p>
            현재 OSAA Gateway·Supabase·OSCE operation ledger를 유지하면서 필요한 상태 모델만 얇게
            추가합니다.
          </p>
        </div>
        <div class="upstream-table-wrap" tabindex="0" aria-label="Upstream reference assessment">
          <table class="upstream-table">
            <thead>
              <tr>
                <th scope="col">Upstream</th>
                <th scope="col">가져올 개념</th>
                <th scope="col">OpenSphere 결정</th>
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
            alt="Bounded implementation decision"
            width="58"
            height="58"
          />
          <div>
            <p class="eyebrow">Implementation boundary</p>
            <h3>개념은 채택, 새 orchestration framework는 보류</h3>
            <p>
              Rasa·LangGraph·Temporal을 지금 추가하지 않습니다. 먼저 typed Dialogue State Tracker를
              OSAA Gateway에 두고 Supabase, OSCE Capability Schema, Operational Resource Graph와
              기존 operation ledger를 연결합니다.
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
  readonly stateFields = DIALOGUE_STATE_FIELDS;
  readonly upstreamReferences = UPSTREAM_REFERENCES;
}
