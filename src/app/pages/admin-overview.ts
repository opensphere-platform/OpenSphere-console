import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { OsPageHeader } from '../os/os-page-header';

interface ServiceMapNode {
  name: string;
  label: string;
  description: string;
  route?: string;
}

interface ServiceMapLayer {
  step: string;
  label: string;
  title: string;
  pictogram: string;
  pictogramAlt: string;
  nodes: ServiceMapNode[];
}

interface ServicePortfolio {
  label: string;
  title: string;
  description: string;
  pictogram: string;
  pictogramAlt: string;
  services: Array<{ name: string; route: string; state: 'serving' | 'evolving' }>;
}

@Component({
  selector: 'os-admin-overview',
  imports: [RouterLink, OsPageHeader],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="os-page manage-dashboard">
      <os-page-header title="Console Service Dashboard" tag="CBSS · Service plane" />

      <section class="dashboard-hero" aria-labelledby="console-service-question">
        <div>
          <span class="eyebrow">WHAT THE CONSOLE SERVES</span>
          <h2 id="console-service-question">OpenSphere를 제어하기 위해 Console은 무엇을 서비스하는가?</h2>
          <p>
            Main Shell은 단순한 관리 페이지 모음이 아닙니다. 네 개의 제어 표면을 OSCE와 OSDST에
            연결하고, 그 아래의 운영 서비스를 CBSS 자원과 각 Owner 권위로 실행 가능한 상태로
            제공합니다.
          </p>
        </div>
        <dl class="dashboard-summary">
          <div><dt>Control surfaces</dt><dd>4</dd><small>Console · OSS · OSC · OSAA</small></div>
          <div><dt>CBSS Core Services</dt><dd>2</dd><small>OSCE · OSDST</small></div>
          <div><dt>Service domains</dt><dd>12</dd><small>현재·목표 기능 전체</small></div>
          <div><dt>Projection</dt><dd>Preview</dd><small>Owner live evidence 연계 전</small></div>
        </dl>
      </section>

      <section class="service-map" aria-labelledby="service-map-title">
        <div class="section-heading">
          <div>
            <span class="eyebrow">CONSOLE SERVICE PLANE</span>
            <h2 id="service-map-title">표면에서 자원 권위까지 하나의 서비스 흐름</h2>
          </div>
          <p>각 열은 앞 열을 작동시키지만 서로의 책임과 현재 상태 권위를 흡수하지 않습니다.</p>
        </div>
        <div class="service-map-grid">
          @for (layer of serviceMap; track layer.step) {
            <article class="service-layer">
              <header>
                <span>{{ layer.step }}</span>
                <img [src]="layer.pictogram" [alt]="layer.pictogramAlt" width="54" height="54" />
                <div><small>{{ layer.label }}</small><h3>{{ layer.title }}</h3></div>
              </header>
              <div class="service-node-list">
                @for (node of layer.nodes; track node.name) {
                  @if (node.route) {
                    <a [routerLink]="node.route">
                      <span>{{ node.label }}</span><strong>{{ node.name }}</strong><small>{{ node.description }}</small>
                    </a>
                  } @else {
                    <div>
                      <span>{{ node.label }}</span><strong>{{ node.name }}</strong><small>{{ node.description }}</small>
                    </div>
                  }
                }
              </div>
            </article>
          }
        </div>
      </section>

      <section class="core-services" aria-labelledby="core-service-title">
        <div class="section-heading">
          <div><span class="eyebrow">CBSS CORE SERVICES</span><h2 id="core-service-title">Console 제어를 실제 기능으로 만드는 두 엔진</h2></div>
          <p>두 엔진은 Extension Registry 대상이 아니라 Console과 함께 배포되는 Platform core component입니다.</p>
        </div>
        <div class="core-service-grid">
          <a routerLink="/manage/platform-control" class="core-service-card">
            <img src="/assets/pictograms/control-tower.svg" alt="Central control engine" width="78" height="78" />
            <div><span>OSCE</span><h3>OpenSphere Control Engine</h3><p>계획·권한·실행·검증·복구를 하나의 operation으로 닫고 각 component Owner를 지휘합니다.</p></div>
            <small>CBSS Core Service · Platform Control Core Engine</small>
          </a>
          <a routerLink="/manage/osaa" class="core-service-card">
            <img src="/assets/pictograms/intelligence.svg" alt="Dialogue state connected to system evidence" width="78" height="78" />
            <div><span>OSDST</span><h3>OSAA Dialogue State Tracker</h3><p>대화의 의도·대상·권위·근거를 구조화해 R2D2가 현재 시스템 사실과 작업 문맥을 유지하게 합니다.</p></div>
            <small>CBSS Core Service · Agent Core Engine</small>
          </a>
        </div>
      </section>

      <section class="portfolio" aria-labelledby="portfolio-title">
        <div class="section-heading">
          <div><span class="eyebrow">SERVICE PORTFOLIO</span><h2 id="portfolio-title">Console이 제공하거나 제공하게 될 운영 서비스</h2></div>
          <p>링크가 있는 항목은 현재 관리 화면으로 연결되며, 상태 표시는 서비스 건강이 아니라 구현 범위를 뜻합니다.</p>
        </div>
        <div class="portfolio-grid">
          @for (group of portfolio; track group.label) {
            <article>
              <header>
                <img [src]="group.pictogram" [alt]="group.pictogramAlt" width="58" height="58" />
                <div><span>{{ group.label }}</span><h3>{{ group.title }}</h3><p>{{ group.description }}</p></div>
              </header>
              <ul>
                @for (service of group.services; track service.name) {
                  <li><a [routerLink]="service.route"><strong>{{ service.name }}</strong><span [class]="service.state">{{ service.state === 'serving' ? '관리 화면 제공' : '구현 확장 중' }}</span></a></li>
                }
              </ul>
            </article>
          }
        </div>
      </section>

      <section class="resource-authorities" aria-labelledby="resource-authorities-title">
        <div class="section-heading">
          <div><span class="eyebrow">RESOURCE AUTHORITIES</span><h2 id="resource-authorities-title">서비스를 지속시키는 CBSS와 외부 권위</h2></div>
          <a routerLink="/manage/foundation-services">실시간 자원 상태 보기</a>
        </div>
        <div class="resource-strip">
          @for (resource of resources; track resource.name) {
            <div><img [src]="resource.logo" [alt]="resource.name + ' logo'" /><span>{{ resource.owner }}</span><strong>{{ resource.name }}</strong><small>{{ resource.role }}</small></div>
          }
        </div>
      </section>

      <aside class="prototype-note" aria-label="Dashboard projection status">
        <strong>현재 구현 범위</strong>
        <p>이 화면은 합의된 서비스 구조와 존재하는 관리 경로를 이용한 1차 projection입니다. 다음 단계에서 각 Owner API의 상태·신선도·blocker를 연결해 실제 운영 판정으로 전환합니다.</p>
      </aside>
    </div>
  `,
  styles: [`
    .manage-dashboard{max-width:none;min-width:0}.eyebrow{display:block;color:var(--os-accent);font-size:.65rem;font-weight:700;letter-spacing:.11em;text-transform:uppercase}
    .dashboard-hero{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(34rem,.75fr);gap:2rem;margin:.4rem 0 1.25rem;padding:1.5rem;border-left:4px solid var(--os-accent);background:var(--os-canvas)}
    .dashboard-hero h2,.section-heading h2{margin:.35rem 0 0;color:var(--os-ink);font-size:1.35rem;font-weight:550;line-height:1.25}.dashboard-hero p,.section-heading p{max-width:58rem;margin:.65rem 0 0;color:var(--os-ink-muted);font-size:.8rem;line-height:1.6}
    .dashboard-summary{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));margin:0;border:1px solid var(--os-hairline)}.dashboard-summary>div{display:grid;padding:.85rem 1rem;border-right:1px solid var(--os-hairline);border-bottom:1px solid var(--os-hairline)}.dashboard-summary>div:nth-child(2n){border-right:0}.dashboard-summary>div:nth-last-child(-n+2){border-bottom:0}.dashboard-summary dt{color:var(--os-ink-muted);font-size:.64rem}.dashboard-summary dd{margin:.2rem 0;color:var(--os-ink);font-size:1.18rem;font-weight:650}.dashboard-summary small{color:var(--os-ink-subtle);font-size:.61rem}
    .service-map,.core-services,.portfolio,.resource-authorities{margin-top:1.4rem}.section-heading{display:flex;justify-content:space-between;align-items:end;gap:2rem;margin-bottom:.75rem}.section-heading>p{max-width:42rem;margin:0;text-align:right}.section-heading>a{color:var(--os-accent);font-size:.72rem;font-weight:650}
    .service-map-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border:1px solid var(--os-hairline);background:var(--os-canvas)}.service-layer{min-width:0;border-right:1px solid var(--os-hairline)}.service-layer:last-child{border-right:0}.service-layer>header{display:grid;grid-template-columns:auto 3.4rem minmax(0,1fr);align-items:center;gap:.65rem;min-height:5.9rem;padding:.9rem;border-bottom:1px solid var(--os-hairline);background:var(--os-surface-1)}.service-layer>header>span{align-self:start;color:var(--os-accent);font:700 .65rem var(--os-font-mono)}.service-layer header small,.portfolio header span{color:var(--os-ink-muted);font-size:.59rem;font-weight:700;letter-spacing:.08em}.service-layer h3,.portfolio h3,.core-service-card h3{margin:.2rem 0 0;font-size:.9rem;line-height:1.25}
    .service-node-list>a,.service-node-list>div{display:grid;grid-template-columns:4.8rem minmax(0,1fr);gap:.2rem .55rem;min-height:4.3rem;padding:.7rem .9rem;border-bottom:1px solid var(--os-hairline);color:inherit;text-decoration:none}.service-node-list>*:last-child{border-bottom:0}.service-node-list a:hover{background:var(--os-surface-1)}.service-node-list span{color:var(--os-accent);font:700 .59rem var(--os-font-mono)}.service-node-list strong{font-size:.72rem}.service-node-list small{grid-column:2;color:var(--os-ink-muted);font-size:.62rem;line-height:1.35}
    .core-service-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.8rem}.core-service-card{display:grid;grid-template-columns:5rem minmax(0,1fr);gap:.3rem 1rem;padding:1.1rem;border:1px solid var(--os-hairline);border-top:3px solid var(--os-accent);background:var(--os-canvas);color:inherit;text-decoration:none}.core-service-card:hover{background:var(--os-surface-1)}.core-service-card>img{grid-row:1/3}.core-service-card div>span{color:var(--os-accent);font:700 .72rem var(--os-font-mono)}.core-service-card p{margin:.45rem 0 0;color:var(--os-ink-muted);font-size:.7rem;line-height:1.5}.core-service-card>small{grid-column:2;color:var(--os-ink-subtle);font-size:.61rem}
    .portfolio-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border:1px solid var(--os-hairline);background:var(--os-canvas)}.portfolio-grid>article{min-width:0;padding:1rem;border-right:1px solid var(--os-hairline)}.portfolio-grid>article:last-child{border-right:0}.portfolio header{display:grid;grid-template-columns:3.7rem minmax(0,1fr);gap:.7rem;min-height:5.4rem}.portfolio header p{margin:.3rem 0 0;color:var(--os-ink-muted);font-size:.63rem;line-height:1.4}.portfolio ul{list-style:none;margin:.75rem 0 0;padding:0;border-top:1px solid var(--os-hairline)}.portfolio li{border-bottom:1px solid var(--os-hairline)}.portfolio li a{display:flex;justify-content:space-between;gap:.6rem;padding:.58rem .1rem;color:inherit;text-decoration:none}.portfolio li strong{font-size:.68rem}.portfolio li span{font-size:.58rem;white-space:nowrap}.serving{color:#0e6027}.evolving{color:#8e6a00}
    .resource-strip{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));border:1px solid var(--os-hairline);background:var(--os-canvas)}.resource-strip>div{display:grid;grid-template-columns:2.5rem minmax(0,1fr);gap:.15rem .7rem;padding:.85rem;border-right:1px solid var(--os-hairline)}.resource-strip>div:last-child{border-right:0}.resource-strip img{grid-row:1/4;width:2.4rem;height:2.1rem;object-fit:contain}.resource-strip span{color:var(--os-accent);font-size:.56rem;font-weight:700}.resource-strip strong{font-size:.68rem}.resource-strip small{color:var(--os-ink-muted);font-size:.58rem;line-height:1.3}
    .prototype-note{display:grid;grid-template-columns:10rem minmax(0,1fr);gap:1rem;margin-top:1rem;padding:.85rem 1rem;border-left:3px solid #f1c21b;background:#fff8e1}.prototype-note strong{color:#684e00;font-size:.7rem}.prototype-note p{margin:0;color:#525252;font-size:.66rem;line-height:1.5}
    @media(max-width:82rem){.dashboard-hero{grid-template-columns:1fr}.service-map-grid,.portfolio-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.service-layer:nth-child(2),.portfolio-grid>article:nth-child(2){border-right:0}.service-layer:nth-child(-n+2),.portfolio-grid>article:nth-child(-n+2){border-bottom:1px solid var(--os-hairline)}.resource-strip{grid-template-columns:repeat(3,minmax(0,1fr))}.resource-strip>div:nth-child(3n){border-right:0}.resource-strip>div:nth-child(-n+3){border-bottom:1px solid var(--os-hairline)}}
    @media(max-width:48rem){.section-heading{display:grid}.section-heading>p{text-align:left}.service-map-grid,.core-service-grid,.portfolio-grid,.resource-strip{grid-template-columns:1fr}.service-layer,.portfolio-grid>article,.resource-strip>div{border-right:0;border-bottom:1px solid var(--os-hairline)}.service-layer:last-child,.portfolio-grid>article:last-child,.resource-strip>div:last-child{border-bottom:0}.dashboard-summary{grid-template-columns:1fr}.dashboard-summary>div{border-right:0;border-bottom:1px solid var(--os-hairline)}.dashboard-summary>div:nth-last-child(2){border-bottom:1px solid var(--os-hairline)}.core-service-card{grid-template-columns:1fr}.core-service-card>img{grid-row:auto}.core-service-card>small{grid-column:auto}.prototype-note{grid-template-columns:1fr}}
  `],
})
export class AdminOverview {
  readonly serviceMap: ServiceMapLayer[] = [
    {
      step: '01', label: 'CONSUME', title: 'Control Surfaces', pictogram: '/assets/pictograms/console.svg', pictogramAlt: 'Console control surfaces',
      nodes: [
        { label: 'CONSOLE', name: 'Main Shell', description: '시각적 운영·관리 표면', route: '/' },
        { label: 'OSS', name: 'OpenSphere Shell', description: 'Console 내 감사 가능한 작업 환경' },
        { label: 'OSC', name: 'OpenSphere CLI', description: '사람·자동화·AI 공통 명령 채널', route: '/manage/cli' },
        { label: 'OSAA', name: 'R2D2', description: '자연어 운영 지능', route: '/manage/osaa' },
      ],
    },
    {
      step: '02', label: 'REASON & CONTROL', title: 'CBSS Core Services', pictogram: '/assets/pictograms/control-tower.svg', pictogramAlt: 'Core control engine',
      nodes: [
        { label: 'OSCE', name: 'Control Engine', description: 'Plan · Authorize · Execute · Verify', route: '/manage/platform-control' },
        { label: 'OSDST', name: 'Dialogue State', description: 'Intent · Resource · Authority · Evidence', route: '/manage/osaa' },
      ],
    },
    {
      step: '03', label: 'DELIVER', title: 'Operational Services', pictogram: '/assets/pictograms/microservices.svg', pictogramAlt: 'Operational services',
      nodes: [
        { label: 'IDENTITY', name: 'Identity & Session', description: '인증·역할·사용자 정책', route: '/manage/data-identity' },
        { label: 'CHANGE', name: 'State Change', description: '선언·승인·적용 영수증', route: '/manage/state-changes' },
        { label: 'COMPOSE', name: 'DUPA Lifecycle', description: 'SubShell·Plugin 구성', route: '/manage/extensions' },
        { label: 'OPERATE', name: 'Evidence & Recovery', description: '관측·감사·알림·복구', route: '/manage/audit' },
      ],
    },
    {
      step: '04', label: 'SUSTAIN', title: 'Resource Authorities', pictogram: '/assets/pictograms/systems.svg', pictogramAlt: 'Service resource authorities',
      nodes: [
        { label: 'CBSS', name: 'Supabase', description: 'Identity · Data · Audit · Object' },
        { label: 'CBSS', name: 'Gitea', description: 'Declarative change authority' },
        { label: 'RUNTIME', name: 'Kubernetes API', description: '실행 상태 정본' },
        { label: 'EVIDENCE', name: 'HISS Observability', description: 'Metrics · Logs · Traces', route: '/manage/observability' },
      ],
    },
  ];

  readonly portfolio: ServicePortfolio[] = [
    {
      label: 'TRUST', title: 'Identity & Data', description: '사람과 시스템의 신원, 세션, 데이터 권위를 제공합니다.', pictogram: '/assets/pictograms/systems.svg', pictogramAlt: 'Identity and data systems',
      services: [
        { name: 'Identity & Session', route: '/manage/data-identity', state: 'serving' },
        { name: 'Roles & Administration', route: '/manage/roles', state: 'serving' },
        { name: 'Data · Storage · Audit', route: '/manage/data-identity', state: 'serving' },
      ],
    },
    {
      label: 'COMPOSE', title: 'Composition & Delivery', description: '원자적 구성요소를 검증하고 독립 배포합니다.', pictogram: '/assets/pictograms/connected-ecosystem.svg', pictogramAlt: 'Composable service delivery',
      services: [
        { name: 'DUPA Extension Lifecycle', route: '/manage/extensions', state: 'serving' },
        { name: 'Platform Release', route: '/manage/platform-release', state: 'serving' },
        { name: 'Catalog · APIs · CLI', route: '/manage/catalog', state: 'serving' },
      ],
    },
    {
      label: 'CONTROL', title: 'AI & Control', description: '현재 사실을 이해하고 승인된 operation으로 닫습니다.', pictogram: '/assets/pictograms/intelligence.svg', pictogramAlt: 'AI and control engine',
      services: [
        { name: 'OSCE Operations', route: '/manage/platform-control', state: 'evolving' },
        { name: 'OSDST Dialogue State', route: '/manage/osaa', state: 'evolving' },
        { name: 'OSAA · R2D2', route: '/manage/osaa', state: 'serving' },
      ],
    },
    {
      label: 'OPERATE', title: 'Operations & Evidence', description: '이벤트, 관측, 복구와 운영 지식을 연결합니다.', pictogram: '/assets/pictograms/cloud-infrastructure-management.svg', pictogramAlt: 'Operational evidence and recovery',
      services: [
        { name: 'Monitoring & Observability', route: '/manage/infrastructure-monitoring', state: 'serving' },
        { name: 'Notification & Channels', route: '/manage/notifications', state: 'serving' },
        { name: 'Recovery · Audit · Manual', route: '/manage/audit', state: 'evolving' },
      ],
    },
  ];

  readonly resources = [
    { owner: 'CBSS', name: 'Supabase', role: 'Identity · Data · Audit', logo: '/assets/product-logos/supabase-icon.svg' },
    { owner: 'CBSS', name: 'Gitea', role: 'Change authority', logo: '/assets/product-logos/gitea.svg' },
    { owner: 'RUNTIME', name: 'Kubernetes', role: 'Runtime truth', logo: '/assets/pictograms/cloud-infrastructure-management.svg' },
    { owner: 'HISS', name: 'Beszel', role: 'Node telemetry', logo: '/assets/product-logos/beszel-light.svg' },
    { owner: 'HISS', name: 'Observability', role: 'Metrics · Logs · Traces', logo: '/assets/pictograms/connected-ecosystem.svg' },
    { owner: 'REGISTRY', name: 'GHCR', role: 'Immutable artifacts', logo: '/assets/pictograms/microservices.svg' },
  ];
}
