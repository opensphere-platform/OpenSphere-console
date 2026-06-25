import { Component, ChangeDetectionStrategy, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { PerspectiveService, type Workspace } from '../core/perspective.service';

interface Perspective {
  n: number;
  name: string;
  band: '운영' | '구축' | '전달';
  engine: string;
  link?: string;
}

/** 랜딩 — 헌법 §6의 10-perspective 지도를 제품의 첫 화면으로.
 *  레이아웃: Clarity grid(clr-row/clr-col) · 타일: Clarity card. */
@Component({
  selector: 'os-landing',
  imports: [RouterLink],
  template: `
    <h1>OpenSphere — 10 Perspectives</h1>
    <p class="os-sub">조직의 가치사슬 전체를 하나의 셸·하나의 신원·하나의 관문으로. (헌법 §6)</p>
    @for (band of visibleBands(); track band) {
      <h2 class="os-band-heading">{{ band }}</h2>
      <div class="clr-row">
        @for (p of byBand(band); track p.n) {
          <div class="clr-col-12 clr-col-sm-6 clr-col-lg-3">
            @if (p.link) {
              <a class="card clickable" [routerLink]="p.link">
                <div class="card-block">
                  <span class="badge badge-info">#{{ p.n }}</span>
                  <h4 class="card-title">{{ p.name }}</h4>
                  <p class="card-text os-engine">{{ p.engine }}</p>
                </div>
              </a>
            } @else {
              <div class="card os-dim">
                <div class="card-block">
                  <span class="badge">#{{ p.n }}</span>
                  <h4 class="card-title">{{ p.name }}</h4>
                  <p class="card-text os-engine">{{ p.engine }} · 예정</p>
                </div>
              </div>
            }
          </div>
        }
      </div>
    }
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
      /* 토큰 레벨 글루만 — 구조·컴포넌트는 전부 Clarity */
      .os-band-heading {
        font-size: 0.65rem;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: var(--os-muted);
        margin: 1rem 0 0.2rem;
      }
      .os-engine {
        color: var(--os-muted);
      }
      .os-dim {
        opacity: 0.55;
      }
      .card-title {
        margin-top: 0.3rem;
      }
      /* Clarity clickable card의 의도 복원 — 전역 a 밑줄이 카드 내부로 새는 것 차단 */
      a.card,
      a.card:hover {
        text-decoration: none;
      }
    `,
  ],
})
export class Landing {
  private psp = inject(PerspectiveService);
  /** landing 밴드(short) → 워크스페이스 매핑. 역할 게이트: 허용 워크스페이스의 밴드만 카드 노출. */
  private static readonly BAND_WS: Record<string, Workspace['id']> = { 운영: 'A', 구축: 'B', 전달: 'C' };
  readonly visibleBands = computed<string[]>(() =>
    ['운영', '구축', '전달'].filter((b) => this.psp.allowed().includes(Landing.BAND_WS[b])));

  /** 헌법 §6 표 그대로 — 각 perspective는 클린 라우트(/<slug>)로 진입(10개 모두 subShell 등록). */
  readonly perspectives: Perspective[] = [
    { n: 1, name: '기반 (Base)', band: '운영', engine: 'Cloud → Cluster·Fleet(M/C·M/C) → Node', link: '/os-level' },
    { n: 2, name: 'K8s Cluster + Ceph', band: '운영', engine: '단일 클러스터 내부 · OKD 코어', link: '/cluster' },
    { n: 3, name: 'User & Auth', band: '운영', engine: 'Samba AD 사원 · Keycloak 인증 · Syncope/SCIM', link: '/user' },
    { n: 4, name: 'Developer', band: '구축', engine: '카탈로그·프로비저닝', link: '/developer' },
    { n: 5, name: 'AI Level', band: '구축', engine: 'KServe·ODH', link: '/ai' },
    { n: 6, name: 'API = 정보 흐름', band: '구축', engine: 'Service·NetPol 합성', link: '/api' },
    { n: 7, name: 'Workspace', band: '전달', engine: '업무 앱 흡수', link: '/workspace' },
    { n: 8, name: 'Customer', band: '전달', engine: 'CIAM', link: '/customer' },
    { n: 9, name: '대외 웹서비스', band: '전달', engine: 'Ingress·TLS·프로브', link: '/edge' },
    { n: 10, name: 'WebSite', band: '전달', engine: 'Directus 계획', link: '/website' },
  ];

  byBand(band: string): Perspective[] {
    return this.perspectives.filter((p) => p.band === band);
  }
}
