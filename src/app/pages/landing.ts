import { Component, ChangeDetectionStrategy, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ExtensionHostService } from '../core/extension-host.service';
import { PerspectiveService } from '../core/perspective.service';
import { routeForPlugin } from '../core/perspectives';

interface Card {
  path: string;
  title: string;
  sub: string;
}

interface PerspectiveDef {
  num: number;
  name: string;
  band: string;
  desc: string;
  pluginId: string | null; // null = Perspective 0(Main Shell, 플러그인이 아니라 콘솔 자체)
  status: string; // 헌법(§6) 표기 그대로 — 제품 관점 lens 검증 상태(구현 완성도 아님)
}

/**
 * OpenSphere 10 Perspective(§6, CONSTITUTION-0000) — 정적 참조 데이터.
 * 링크 가능 여부는 여기서 하드코딩하지 않고 ext.pages() 실제 등록 여부로만 판정(ADR-UI-003 §3.3:
 * 미등록 plugin phantom 라우트 금지). 아직 등록 안 된 perspective는 카드만 보이고 클릭은 비활성.
 */
const PERSPECTIVES: PerspectiveDef[] = [
  { num: 0, name: 'Main Shell', band: '프레임·전역', desc: '콘솔 자체 운영 — 제어 표면(GUI+CLI) · Extension Host · 콘솔 운영자 · 횡단 서비스', pluginId: null, status: 'live(GUI)' },
  { num: 1, name: '기반 (Base/Substrate)', band: '운영', desc: '클라우드/리전 → 클러스터·Fleet → 노드·OS. 무엇 위에서 도는가', pluginId: 'os', status: 'live(노드)·보유(fleet)' },
  { num: 2, name: 'K8s Cluster + Ceph', band: '운영', desc: '단일 클러스터 내부 운영 — 제어평면·etcd·스토리지·VM·리소스 탐색', pluginId: 'cluster-manager', status: '보유' },
  { num: 3, name: 'User', band: '운영', desc: '직원 신원·그룹, workforce IGA', pluginId: 'identity', status: 'placeholder(W5)' },
  { num: 4, name: 'Developer', band: '구축', desc: '카탈로그(선언) x 클러스터(현실) 결합 + 골든패스', pluginId: 'developer', status: 'live(299 엔티티)' },
  { num: 5, name: 'AI Level', band: '구축', desc: '모델 서빙·노트북·큐', pluginId: 'ai', status: 'live(ollama)' },
  { num: 6, name: 'API = 정보 흐름', band: '구축', desc: '무엇을 받고 내보내는가, 계약·상태', pluginId: 'api', status: 'live(도구 검증)' },
  { num: 7, name: 'Workspace (내부)', band: '전달', desc: '직원들이 쓰는 사내 업무 앱 전체를 서비스', pluginId: 'workspace', status: 'live(Odoo)' },
  { num: 8, name: 'Customer', band: '전달', desc: '고객 대면 서비스·포털, customer audience', pluginId: 'customer', status: 'placeholder(W5)' },
  { num: 9, name: '대외 웹서비스', band: '전달', desc: 'Ingress·TLS·엔드포인트 + 실프로브', pluginId: 'edge', status: 'live(도구 검증)' },
  { num: 10, name: 'WebSite', band: '전달', desc: '홈페이지, 조직의 얼굴', pluginId: 'website', status: 'live(PoC)' },
];

/**
 * 랜딩(메인 인덱스 /) — Overview 페이지 (containers/overview식: 배경 그라데이션 + 히어로 SVG 일러스트).
 * 메뉴 출처는 ADR-UI-003 §3.3: ① native Core Console ② 등록된 DUPA 확장(ext.pages()).
 */
@Component({
  selector: 'os-landing',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="home-ov">
      <section class="home-hero">
        <div class="home-hero__copy">
          <h1 class="home-title">OpenSphere <span class="os-thin">Console</span></h1>
          <p class="home-lead">하나의 셸 · 하나의 신원 · 하나의 관문.</p>
        </div>
        <div class="home-hero__art" aria-hidden="true">
          <img src="/ibm-assets/observability-pillar-overview-header.svg" alt="" />
        </div>
      </section>

      <section class="home-sec">
        <h2 class="os-band-heading">OpenSphere Perspectives <span class="os-count">0–10</span></h2>
        <p class="os-persp-lead">공유 객체 그래프를 10개 서로 다른 렌즈로 읽는다 — Perspective는 데이터를 복제하지 않는다(§6, CONSTITUTION-0000).</p>
        <div class="persp-grid">
          @for (p of perspectiveCards(); track p.num) {
            @if (p.live) {
              <a class="persp-card persp-live" [routerLink]="p.path">
                <span class="persp-num">{{ p.num }}</span>
                <span class="persp-body">
                  <span class="persp-name">{{ p.name }}</span>
                  <span class="persp-desc">{{ p.desc }}</span>
                  <span class="persp-meta"><span class="persp-band">{{ p.band }}</span><span class="persp-status persp-status-live">{{ p.status }}</span></span>
                </span>
              </a>
            } @else {
              <div class="persp-card persp-placeholder">
                <span class="persp-num">{{ p.num }}</span>
                <span class="persp-body">
                  <span class="persp-name">{{ p.name }}</span>
                  <span class="persp-desc">{{ p.desc }}</span>
                  <span class="persp-meta"><span class="persp-band">{{ p.band }}</span><span class="persp-status">{{ p.status }}</span></span>
                </span>
              </div>
            }
          }
        </div>
      </section>

      <section class="home-sec">
        <h2 class="os-band-heading">Core Console</h2>
        <div class="clr-row">
          @for (c of coreCards(); track c.path) {
            <div class="clr-col-12 clr-col-sm-6 clr-col-lg-3">
              <a class="card clickable" [routerLink]="c.path">
                <div class="card-block">
                  <h4 class="card-title">{{ c.title }}</h4>
                  <p class="card-text os-engine">{{ c.sub }}</p>
                </div>
              </a>
            </div>
          }
        </div>
      </section>

      <section class="home-sec">
        <h2 class="os-band-heading">Extensions <span class="os-count">{{ extCards().length }}</span></h2>
        @if (extCards().length) {
          <div class="clr-row">
            @for (c of extCards(); track c.path) {
              <div class="clr-col-12 clr-col-sm-6 clr-col-lg-3">
                <a class="card clickable" [routerLink]="c.path">
                  <div class="card-block">
                    <h4 class="card-title">{{ c.title }}</h4>
                    <p class="card-text os-engine">{{ c.sub }}</p>
                  </div>
                </a>
              </div>
            }
          </div>
        } @else {
          <p class="os-empty">
            등록된 확장이 없습니다. subShell·plugin을 DUPA로 등록하면(서명 manifest + UIPluginPackage)
            여기와 좌측 내비에 자동으로 나타납니다.
          </p>
        }
      </section>
    </div>
  `,
  styles: [
    `
      /* content-area 패딩(1.5rem) 상쇄 → 풀블리드 Overview. 배경 그라데이션(containers overview식). */
      .home-ov {
        margin: -1.5rem; min-height: calc(100% + 3rem); padding: 1.5rem 2rem;
        /* overview 공통 배경 토큰(규약: 모든 /overview 동일 배경) */
        background: var(--os-overview-bg);
      }
      .home-hero {
        display: grid; grid-template-columns: minmax(0, 1fr) 24rem; align-items: center; gap: 1rem;
        min-height: 13rem; padding: 0.5rem 0 2rem; max-width: 90rem;
      }
      .home-title { margin: 0; font-size: clamp(2.5rem, 4vw, 3.75rem); font-weight: 300; letter-spacing: -0.03em; line-height: 1.05; color: var(--os-ink); }
      .home-lead { margin: 1rem 0 0; color: var(--os-ink-muted); font-size: 1.05rem; }
      .home-hero__art { height: 12rem; }
      .home-hero__art img { display: block; height: 100%; width: 100%; object-fit: contain; object-position: right center; }

      .home-sec { max-width: 90rem; }
      .os-band-heading { font-size: 0.65rem; letter-spacing: 0.12em; text-transform: uppercase; color: var(--os-ink-muted); margin: 1.4rem 0 0.5rem; }
      .os-count { opacity: 0.6; margin-left: 0.3rem; }
      .os-engine { color: var(--os-muted); }
      .os-empty { color: var(--os-muted); font-size: 0.85rem; max-width: 40rem; }
      .os-persp-lead { margin: 0 0 0.75rem; color: var(--os-ink-muted); font-size: 0.8rem; max-width: 48rem; }

      .persp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(15.5rem, 1fr)); gap: 0.6rem; }
      .persp-card {
        display: flex; align-items: flex-start; gap: 0.6rem;
        padding: 0.7rem 0.8rem; border-radius: 4px;
        border: 1px solid var(--os-hairline, #e0e0e0); background: var(--os-canvas, #fff);
        text-decoration: none; color: inherit;
      }
      .persp-live { cursor: pointer; }
      .persp-live:hover { border-color: var(--os-accent, #4c6fff); box-shadow: 0 1px 4px rgba(0,0,0,.06); }
      .persp-placeholder { opacity: 0.55; }
      .persp-num {
        flex: 0 0 auto; width: 1.6rem; height: 1.6rem; border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        font-size: 0.72rem; font-weight: 700; color: var(--os-ink-muted);
        background: var(--os-overview-bg, #f4f4f4); border: 1px solid var(--os-hairline, #e0e0e0);
      }
      .persp-live .persp-num { color: #fff; background: var(--os-accent, #4c6fff); border-color: transparent; }
      .persp-body { display: flex; flex-direction: column; gap: 0.15rem; min-width: 0; }
      .persp-name { font-size: 0.82rem; font-weight: 600; color: var(--os-ink); }
      .persp-desc { font-size: 0.68rem; color: var(--os-ink-muted); line-height: 1.35; }
      .persp-meta { display: flex; gap: 0.4rem; align-items: center; margin-top: 0.15rem; }
      .persp-band { font-size: 0.6rem; color: var(--os-ink-muted); padding: 0.05rem 0.35rem; border: 1px solid var(--os-hairline, #e0e0e0); border-radius: 3px; }
      .persp-status { font-size: 0.6rem; color: var(--os-ink-muted); }
      .persp-status-live { color: var(--os-success, #24a148); font-weight: 600; }
      .os-thin { font-weight: 200; opacity: 0.85; }
      .card-title { margin-top: 0.3rem; }
      a.card, a.card:hover { text-decoration: none; }

      @media screen and (max-width: 66rem) {
        .home-hero { grid-template-columns: 1fr; }
        .home-hero__art { display: none; }
      }
    `,
  ],
})
export class Landing {
  private ext = inject(ExtensionHostService);
  private psp = inject(PerspectiveService);

  /** ① native Core Console 기능 — admin 카드는 운영관리자에게만 노출. */
  readonly coreCards = computed<Card[]>(() => {
    const base: Card[] = [
      { path: '/manage/catalog', title: 'Developer Catalog', sub: '관리 · 자산 및 확장' },
      { path: '/manage/apis', title: 'APIs', sub: '관리 · 자산 및 확장' },
      { path: '/me', title: '내 정보', sub: 'My Info' },
    ];
    if (this.psp.isAdmin()) {
      base.push(
        { path: '/manage/console-admins', title: '콘솔 관리자', sub: 'Supabase Identity' },
        { path: '/manage/extensions', title: 'Console Extensions', sub: 'subShell·plugin·binding' },
        { path: '/manage/roles', title: '역할', sub: '역할 정의·부여' },
      );
    }
    return base;
  });

  /** ② 등록된 DUPA 확장 — 레지스트리 기반. */
  readonly extCards = computed<Card[]>(() =>
    this.ext.pages().map((p) => ({ path: routeForPlugin(p.id), title: p.title, sub: p.navBand })),
  );

  /**
   * ③ 10 Perspective(§6) 정적 참조 — 클릭 가능 여부는 ext.pages() 실제 등록 여부로만 판정
   * (하드코딩 phantom 라우트 금지, ADR-UI-003 §3.3). Perspective 0은 콘솔 자체라 링크 없음.
   */
  readonly perspectiveCards = computed(() => {
    const registered = new Set(this.ext.pages().map((p) => p.id));
    return PERSPECTIVES.map((p) => ({
      ...p,
      live: p.pluginId !== null && registered.has(p.pluginId),
      path: p.pluginId ? routeForPlugin(p.pluginId) : '',
    }));
  });
}
