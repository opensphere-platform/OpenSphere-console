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

const EXAMPLE_DIALOGUE_STATE = `{
  "schema": "osaa.dialogue-state/v1",
  "revision": 12,
  "domain": "pfss.postgresql",
  "activeIntent": "create.capability.check",
  "activeResourceRefs": [
    "opensphere://pfss/postgresql/foundation-data-pg"
  ],
  "slotValues": { "version": "18", "replicas": 2 },
  "authorityRef": "owner://pfss/postgresql",
  "capabilityRefs": ["status", "create.plan", "create.apply"],
  "evidenceRefs": [
    { "id": "observation:...", "observedAt": "...", "expiresAt": "..." }
  ],
  "operationRef": null
}`;

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
    name: 'Google Description-Driven DST',
    contribution: 'intent·slot의 내부 이름보다 자연어 설명을 이용해 새로운 task로 일반화합니다.',
    decision: 'Capability description을 resolver 입력으로 채택',
    href: 'https://research.google/pubs/description-driven-task-oriented-dialog-modeling/',
  },
  {
    name: 'Google ADK Session · State · Memory',
    contribution: '대화 이벤트, 세션 임시 상태와 세션 간 장기 기억의 lifecycle을 분리합니다.',
    decision: '분리 원칙 채택, ADK runtime은 도입하지 않음',
    href: 'https://adk.dev/sessions/',
  },
  {
    name: 'Dialogflow CX Session Parameters',
    contribution: '자연어 원문과 별개로 추출·정규화된 parameter를 session 범위에서 유지합니다.',
    decision: 'slot 원문·정규값 분리 방식 참고',
    href: 'https://docs.cloud.google.com/dialogflow/cx/docs/concept/parameter',
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
            <p class="eyebrow">OSDST · CBSS Core Service</p>
            <h1 id="dialogue-state-title">OSDST</h1>
            <p>
              <strong>OSAA Dialogue State Tracker</strong>는 일반 LLM 대화 이력을 OpenSphere의
              서비스·리소스·권위·근거에 결속된 운영 대화로 바꾸는 CBSS 핵심 서비스입니다. 정식 방법론은
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
            <dt>Acronym</dt>
            <dd>OSDST</dd>
          </div>
          <div>
            <dt>Classification</dt>
            <dd>CBSS Core Service · Agent Core Engine</dd>
          </div>
          <div>
            <dt>Deployment</dt>
            <dd>Platform-bundled core component</dd>
          </div>
          <div>
            <dt>Extension</dt>
            <dd>SubShell · Console Plugin · Binding 아님</dd>
          </div>
          <div>
            <dt>폐기한 표현</dt>
            <dd>System Context Binding — 업스트림 표준 용어가 아님</dd>
          </div>
        </dl>
      </section>

      <section class="strategy-overview" aria-labelledby="strategy-overview-title">
        <div class="strategy-heading">
          <p class="eyebrow">Goal and development strategy</p>
          <h2 id="strategy-overview-title">대화 이력을 운영 가능한 상태로 바꿉니다</h2>
          <p>
            새 대화 프레임워크를 만드는 것이 목표가 아닙니다. 이미 존재하는
            Conversation·OSCE·Owner·증거 체계를 구조화된 대화 상태로 연결해, R2D2가 맥락을
            유지하면서도 현재 사실을 추측하지 않게 합니다.
          </p>
        </div>
        <div class="strategy-strip">
          <article>
            <span>현재 기반</span>
            <img
              src="/assets/pictograms/console.svg"
              alt="Durable conversation baseline"
              width="44"
              height="44"
            />
            <strong>Durable Conversation</strong>
            <p>
              Supabase에 사용자별 대화·메시지를 저장하고 최근 80개·60,000자 문맥을 재구성합니다.
            </p>
          </article>
          <article>
            <span>현재 공백</span>
            <img
              src="/assets/pictograms/code-syntax.svg"
              alt="Missing typed dialogue state"
              width="44"
              height="44"
            />
            <strong>Typed State 미구현</strong>
            <p>
              intent·resource·slot이 검증된 객체가 아니라 아직 과거 메시지 안의 자연어로만 남아
              있습니다.
            </p>
          </article>
          <article>
            <span>개발 목표</span>
            <img
              src="/assets/pictograms/connected-ecosystem.svg"
              alt="Schema guided operating dialogue"
              width="44"
              height="44"
            />
            <strong>Schema-guided Control</strong>
            <p>
              Google식 intent·slot 추적을 OSCE Capability Schema와 canonical resource에 결속합니다.
            </p>
          </article>
          <article>
            <span>완료 기준</span>
            <img
              src="/assets/pictograms/ai-governance-lifecycle-factsheet.svg"
              alt="Evidence backed operation"
              width="44"
              height="44"
            />
            <strong>Evidence-backed Action</strong>
            <p>
              상태 유지, live 관측, 승인된 실행과 postcondition이 하나의 operation으로 이어져야
              합니다.
            </p>
          </article>
        </div>
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

      <section class="document-section" aria-labelledby="google-method-title">
        <div class="section-title">
          <div class="section-title-lockup">
            <img
              src="/assets/pictograms/developer-tools.svg"
              alt="Google dialogue methods adapted to OpenSphere"
              width="52"
              height="52"
            />
            <div>
              <p class="eyebrow">Upstream method · native control</p>
              <h2 id="google-method-title">
                Google의 구조를 대화 계층에 적용하고 운영 계층은 OSCE로 확장합니다
              </h2>
            </div>
          </div>
          <p>
            Google SGD는 서비스·intent·slot을 동적으로 해석하고, ADK는 Session·State·Memory를
            분리합니다. OpenSphere는 그 위에 Owner 권위, live evidence, 승인과 operation receipt를
            추가합니다.
          </p>
        </div>

        <div class="method-layers">
          <article>
            <span>Google SGD · D3ST</span>
            <img
              src="/assets/pictograms/intelligence.svg"
              alt="Schema guided dialogue understanding"
              width="48"
              height="48"
            />
            <h3>대화 이해</h3>
            <p>
              자연어 설명이 포함된 service schema를 보고 active intent와 필요한 slot을 추적합니다.
            </p>
            <small>채택: schema · intent · required/optional/result slots</small>
          </article>
          <article>
            <span>Google ADK · Dialogflow CX</span>
            <img
              src="/assets/pictograms/microservices.svg"
              alt="Session state and memory separation"
              width="48"
              height="48"
            />
            <h3>상태 lifecycle</h3>
            <p>
              메시지 이벤트, 세션 상태, 세션을 넘는 지식을 서로 다른 수명과 저장 책임으로
              분리합니다.
            </p>
            <small>채택: Session · State · Memory 및 parameter 정규화</small>
          </article>
          <article>
            <span>OpenSphere native</span>
            <img
              src="/assets/pictograms/control-tower.svg"
              alt="OpenSphere operational authority"
              width="48"
              height="48"
            />
            <h3>운영 권위와 증거</h3>
            <p>OSCE가 capability를 검증하고 Owner가 실제 상태·계획·실행·사후 검증을 소유합니다.</p>
            <small>추가: authority · evidence · approval · operation</small>
          </article>
        </div>

        <div
          class="schema-mapping-wrap"
          tabindex="0"
          aria-label="Google schema to OpenSphere mapping"
        >
          <table class="schema-mapping">
            <thead>
              <tr>
                <th scope="col">Google schema</th>
                <th scope="col">OpenSphere 계약</th>
                <th scope="col">PFSS PostgreSQL 예</th>
                <th scope="col">추가 검증</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row"><code>service_name</code></th>
                <td><code>domain + authorityRef</code></td>
                <td>pfss.postgresql · PFSS PostgreSQL Owner</td>
                <td>등록된 Owner와 schema version 일치</td>
              </tr>
              <tr>
                <th scope="row"><code>intent</code></th>
                <td><code>activeIntent + capabilityRef</code></td>
                <td>status · create.plan · create.apply</td>
                <td>Owner가 현재 광고한 capability인지 확인</td>
              </tr>
              <tr>
                <th scope="row"><code>required_slots</code></th>
                <td><code>slotValues</code></td>
                <td>name · version · replicas · storageClass</td>
                <td>형식·정책·기본값과 누락 입력 검증</td>
              </tr>
              <tr>
                <th scope="row"><code>service_call</code></th>
                <td><code>owner operation</code></td>
                <td>PostgresClaim status 또는 create plan</td>
                <td>읽기/변경 분리 · 승인 · plan digest</td>
              </tr>
              <tr>
                <th scope="row"><code>service_results</code></th>
                <td><code>evidenceRefs + operationRef</code></td>
                <td>observationId · operationId · receipt</td>
                <td>observedAt · expiresAt · postcondition</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="method-boundary">
          <strong>도입 경계</strong>
          <p>
            Google dataset·모델·ADK runtime을 제품 의존성으로 넣지 않습니다. 검증된 데이터 모델과
            lifecycle 분리 원칙만 수용하고, 구현은 기존 OSAA Gateway·Supabase·OSCE 안에서
            네이티브하게 수행합니다.
          </p>
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

      <section class="document-section" aria-labelledby="implementation-contract-title">
        <div class="section-title">
          <div class="section-title-lockup">
            <img
              src="/assets/pictograms/code-syntax.svg"
              alt="Concrete dialogue state implementation contract"
              width="52"
              height="52"
            />
            <div>
              <p class="eyebrow">Concrete native implementation</p>
              <h2 id="implementation-contract-title">
                현재 저장 구조를 유지하고 typed projection만 추가합니다
              </h2>
            </div>
          </div>
          <p>
            Conversation 전체를 새 엔진으로 옮기지 않습니다. 현재 메시지 원장은 그대로 두고, 빠르게
            읽는 현재 상태 projection과 매 턴의 검증된 state delta를 추가합니다.
          </p>
        </div>

        <div class="implementation-baseline">
          <article class="implemented">
            <span>이미 구현됨</span>
            <h3>OSAA durable conversation</h3>
            <ul>
              <li><code>osaa.conversation</code> · <code>conversation_message</code></li>
              <li>사용자 소유권과 Supabase RLS</li>
              <li><code>conversationId</code>와 turn request 중복 방지</li>
              <li>최근 80개·60,000자 server-owned context</li>
              <li>AgentRun · ToolRun · evidence · operation ledger</li>
            </ul>
          </article>
          <article class="to-build">
            <span>이번 전략의 구현 대상</span>
            <h3>Typed dialogue state projection</h3>
            <ul>
              <li><code>osaa.conversation_state</code> 현재 projection과 revision</li>
              <li><code>conversation_message.metadata.stateDelta</code> 턴별 변경 이력</li>
              <li>OSCE schema version과 Owner authority binding</li>
              <li>LLM 제안 뒤 deterministic validator 통과</li>
              <li>live evidence와 active operation reference 연결</li>
            </ul>
          </article>
        </div>

        <div class="contract-detail">
          <div>
            <p class="eyebrow">Target projection · v1</p>
            <h3>PFSS PostgreSQL 상태 예시</h3>
            <pre tabindex="0"><code>{{ exampleState }}</code></pre>
          </div>
          <div class="storage-rules">
            <article>
              <strong><code>slotValues</code>에 저장</strong>
              <p>사용자가 요청한 desired input과 schema가 정규화한 값만 저장합니다.</p>
              <small>예: PostgreSQL 18 · replicas 2</small>
            </article>
            <article>
              <strong>운영 사실은 저장하지 않음</strong>
              <p>
                Ready·Pod 수·Owner 응답은 state의 사실 값이 아니라 유효기간이 있는 evidence
                reference입니다.
              </p>
              <small>매 답변 시 live read 또는 명시적 last-known 판정</small>
            </article>
            <article>
              <strong>동시성은 revision으로 차단</strong>
              <p>현재 revision과 turn request를 비교해 중복·순서 역전 상태 변경을 거부합니다.</p>
              <small>optimistic state transition · idempotent turn</small>
            </article>
          </div>
        </div>

        <div class="state-transaction" aria-label="Dialogue state transaction steps">
          <article>
            <span>01</span><strong>Load</strong>
            <p>현재 projection과 새 utterance를 읽음</p>
          </article>
          <article>
            <span>02</span><strong>Propose</strong>
            <p>LLM이 intent·resource·slot delta를 제안</p>
          </article>
          <article>
            <span>03</span><strong>Validate</strong>
            <p>OSCE schema·Owner·canonical ID로 결정 검증</p>
          </article>
          <article>
            <span>04</span><strong>Observe / Plan</strong>
            <p>Owner가 live read 또는 변경 계획 수행</p>
          </article>
          <article>
            <span>05</span><strong>Commit</strong>
            <p>state revision·delta·evidence·operation을 원자 기록</p>
          </article>
          <article>
            <span>06</span><strong>Respond</strong>
            <p>검증된 상태와 해당 턴 증거로만 답변</p>
          </article>
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

      <section class="document-section" aria-labelledby="delivery-plan-title">
        <div class="section-title">
          <div class="section-title-lockup">
            <img
              src="/assets/pictograms/control-panel.svg"
              alt="OSAA dialogue state delivery plan"
              width="52"
              height="52"
            />
            <div>
              <p class="eyebrow">Delivery plan · bounded increments</p>
              <h2 id="delivery-plan-title">
                다섯 단계로 구현하고 각 단계에서 독립적으로 판정합니다
              </h2>
            </div>
          </div>
          <p>
            프레임워크 도입부터 시작하지 않습니다. 데이터 계약, schema adapter, validator, evidence
            결속, 사용자 검증 순으로 작은 기능 단위를 완성합니다.
          </p>
        </div>

        <ol class="delivery-phases">
          <li>
            <span>01</span>
            <img
              src="/assets/pictograms/code-syntax.svg"
              alt="State contract and migration"
              width="42"
              height="42"
            />
            <div>
              <strong>State contract & migration</strong>
              <p><code>conversation_state</code>, revision, stateDelta와 RLS를 추가합니다.</p>
              <small>Gate: 재시작 후 같은 conversation state 복구</small>
            </div>
          </li>
          <li>
            <span>02</span>
            <img
              src="/assets/pictograms/api.svg"
              alt="OSCE schema adapter"
              width="42"
              height="42"
            />
            <div>
              <strong>OSCE schema adapter</strong>
              <p>Owner capability를 service·intent·slot schema로 투영합니다.</p>
              <small>Gate: 새 capability가 모델 재학습 없이 노출</small>
            </div>
          </li>
          <li>
            <span>03</span>
            <img
              src="/assets/pictograms/intelligence.svg"
              alt="State resolver and validator"
              width="42"
              height="42"
            />
            <div>
              <strong>Resolver & deterministic validator</strong>
              <p>LLM은 delta를 제안하고 서버가 schema·ID·정책으로 확정합니다.</p>
              <small>Gate: 미등록 intent·resource·slot 거부</small>
            </div>
          </li>
          <li>
            <span>04</span>
            <img
              src="/assets/pictograms/control-tower.svg"
              alt="Evidence and operation binding"
              width="42"
              height="42"
            />
            <div>
              <strong>Evidence & operation binding</strong>
              <p>live read, plan, approval, apply와 postcondition을 같은 턴에 연결합니다.</p>
              <small>Gate: 근거 없는 현재 사실·완료 주장 차단</small>
            </div>
          </li>
          <li>
            <span>05</span>
            <img
              src="/assets/pictograms/console.svg"
              alt="Console state inspection and evaluation"
              width="42"
              height="42"
            />
            <div>
              <strong>Console inspection & evaluation</strong>
              <p>운영자는 현재 intent·resource·evidence·operation을 대화에서 확인합니다.</p>
              <small>Gate: PFSS 기준 시나리오와 장애 시나리오 통과</small>
            </div>
          </li>
        </ol>

        <div class="acceptance-block">
          <div class="acceptance-heading">
            <img
              src="/assets/pictograms/ai-governance-lifecycle-factsheet.svg"
              alt="Acceptance test contract"
              width="52"
              height="52"
            />
            <div>
              <p class="eyebrow">Acceptance contract</p>
              <h3>R2D2 완성도는 실제 대화 결과로 판정합니다</h3>
            </div>
          </div>
          <div
            class="acceptance-table-wrap"
            tabindex="0"
            aria-label="Dialogue state acceptance scenarios"
          >
            <table class="acceptance-table">
              <thead>
                <tr>
                  <th scope="col">시나리오</th>
                  <th scope="col">반드시 유지할 상태</th>
                  <th scope="col">합격 판정</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">운영 인스턴스가 있는가?</th>
                  <td>pfss.postgresql · status</td>
                  <td>같은 턴의 Owner evidence로 대상·Ready·관측 시각 제시</td>
                </tr>
                <tr>
                  <th scope="row">삭제할 수 있나?</th>
                  <td>기존 resource 유지 · intent만 delete capability로 전환</td>
                  <td>보호·백업·권한을 별도 조회하고 plan 가능 여부를 판정</td>
                </tr>
                <tr>
                  <th scope="row">새 인스턴스 생성은?</th>
                  <td>domain 유지 · 기존 resource는 생성 대상에서 해제</td>
                  <td>create schema의 누락 slot만 질문하고 기존 장애를 복사하지 않음</td>
                </tr>
                <tr>
                  <th scope="row">Owner API 500</th>
                  <td>canonical resource reference 유지</td>
                  <td>“없음”이 아니라 “현재 관찰 불가능”으로 답변</td>
                </tr>
                <tr>
                  <th scope="row">변경 실행</th>
                  <td>planDigest · approval · operationRef</td>
                  <td>receipt와 postcondition 전에는 완료라고 답하지 않음</td>
                </tr>
                <tr>
                  <th scope="row">새 Owner capability 설치</th>
                  <td>새 schemaRef revision</td>
                  <td>LLM 재학습 없이 새로운 intent·slot을 해석</td>
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
  readonly exampleState = EXAMPLE_DIALOGUE_STATE;
}
