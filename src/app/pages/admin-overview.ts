import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { OsPageHeader } from '../os/os-page-header';

interface OverviewLink {
  label: string;
  description: string;
  route: string;
}

interface OverviewSection {
  label: string;
  description: string;
  links: OverviewLink[];
}

@Component({
  selector: 'os-admin-overview',
  imports: [RouterLink, OsPageHeader],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="os-page manage-overview">
      <os-page-header title="콘솔 관리" tag="Overview · Core Admin" />
      <div class="manage-page-lead">
        <p>
          Console의 자산, 접근 권한, 플랫폼 제어와 운영 기록을 책임 영역별로 시작하는 관리
          인덱스입니다.
        </p>
        <span>4개 관리 영역 · Extensions 독립 관리</span>
      </div>

      <div class="overview-sections">
        @for (section of sections; track section.label) {
          <section class="overview-section" [attr.aria-labelledby]="'manage-' + $index">
            <div class="overview-section-heading">
              <h2 [id]="'manage-' + $index">{{ section.label }}</h2>
              <p>{{ section.description }}</p>
            </div>
            <ul>
              @for (item of section.links; track item.route) {
                <li>
                  <a [routerLink]="item.route">
                    <strong>{{ item.label }}</strong>
                    <span>{{ item.description }}</span>
                  </a>
                </li>
              }
            </ul>
          </section>
        }
      </div>

      <section class="extension-entry" aria-labelledby="manage-extensions-title">
        <div>
          <h2 id="manage-extensions-title">Console Extensions</h2>
          <p>
            subShell, plugin, binding의 설치 상태와 Console 메뉴 연동을 별도의 수명주기로
            관리합니다.
          </p>
        </div>
        <a class="btn btn-primary" routerLink="/manage/extensions">Extensions 열기</a>
      </section>
    </div>
  `,
  styles: [
    `
      .manage-overview {
        max-width: 88rem;
      }
      .overview-sections {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        border-top: 1px solid var(--os-hairline);
        border-left: 1px solid var(--os-hairline);
        background: var(--os-canvas);
      }
      .overview-section {
        min-width: 0;
        padding: 1.15rem 1.25rem 1.25rem;
        border-right: 1px solid var(--os-hairline);
        border-bottom: 1px solid var(--os-hairline);
      }
      .overview-section-heading {
        min-height: 4rem;
      }
      .overview-section h2,
      .extension-entry h2 {
        margin: 0;
        color: var(--os-ink);
        font-size: 1rem;
        font-weight: 600;
      }
      .overview-section-heading p,
      .extension-entry p {
        margin: 0.3rem 0 0;
        color: var(--os-ink-muted);
        font-size: 0.78rem;
        line-height: 1.45;
      }
      .overview-section ul {
        list-style: none;
        margin: 0.8rem 0 0;
        padding: 0;
      }
      .overview-section li + li {
        border-top: 1px solid var(--os-hairline);
      }
      .overview-section a {
        display: grid;
        grid-template-columns: minmax(8rem, 10rem) minmax(0, 1fr);
        gap: 0.8rem;
        padding: 0.65rem 0.25rem;
        color: inherit;
        text-decoration: none;
      }
      .overview-section a:hover {
        background: var(--os-surface-1);
      }
      .overview-section a:focus-visible {
        outline: 2px solid var(--os-accent);
        outline-offset: 1px;
      }
      .overview-section a strong {
        color: var(--os-link, #0f62fe);
        font-size: 0.78rem;
      }
      .overview-section a span {
        color: var(--os-ink-muted);
        font-size: 0.72rem;
        line-height: 1.4;
      }
      .extension-entry {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1.5rem;
        margin-top: 1rem;
        padding: 1rem 1.25rem;
        border-left: 3px solid var(--os-accent);
        background: var(--os-canvas);
      }
      .extension-entry .btn {
        flex: 0 0 auto;
        margin: 0;
      }
      @media (max-width: 72rem) {
        .overview-sections {
          grid-template-columns: minmax(0, 1fr);
        }
      }
      @media (max-width: 44rem) {
        .overview-section a {
          grid-template-columns: minmax(0, 1fr);
          gap: 0.2rem;
        }
        .extension-entry {
          align-items: flex-start;
          flex-direction: column;
        }
      }
    `,
  ],
})
export class AdminOverview {
  readonly sections: OverviewSection[] = [
    {
      label: '개발 자산',
      description: '개발 자산과 API 계약, Console CLI 배포물을 조회합니다.',
      links: [
        {
          label: 'Developer Catalog',
          description: '서비스·컴포넌트와 runtime evidence',
          route: '/manage/catalog',
        },
        { label: 'APIs', description: '등록된 API 계약과 소유 관계', route: '/manage/apis' },
        { label: 'Console CLI', description: 'os CLI 다운로드와 인증 절차', route: '/manage/cli' },
      ],
    },
    {
      label: '신원 및 접근',
      description: 'Console 관리자와 역할 부여 상태를 관리합니다.',
      links: [
        {
          label: '콘솔 관리자',
          description: '관리자 계정과 인증 보안 정책',
          route: '/manage/console-admins',
        },
        { label: '역할', description: 'Console 역할 정의와 사용자 부여', route: '/manage/roles' },
      ],
    },
    {
      label: '플랫폼 제어',
      description: '데이터 권위, 상태 변경, AI 운영과 관측 연결을 관리합니다.',
      links: [
        {
          label: 'Control Plane',
          description: '플랫폼 운영 상태와 변경 흐름',
          route: '/manage/platform-control',
        },
        {
          label: 'Data & Identity',
          description: 'Supabase 데이터·신원 권위',
          route: '/manage/data-identity',
        },
        {
          label: '상태 변경 관리',
          description: '승인·적용·실측 증거 연결',
          route: '/manage/state-changes',
        },
        { label: 'R2D2', description: 'Console 내장 AI 제어 표면', route: '/manage/osaa' },
        {
          label: '인프라 모니터링',
          description: '노드와 Kubernetes 기초 관측',
          route: '/manage/infrastructure-monitoring',
        },
        {
          label: 'HISS Observability',
          description: '외부 관측 스택의 binding 상태',
          route: '/manage/observability',
        },
      ],
    },
    {
      label: '운영 및 증거',
      description: '운영 이벤트 전달과 변경 증거를 확인합니다.',
      links: [
        { label: '알림', description: 'Console 운영 알림 인박스', route: '/manage/notifications' },
        {
          label: '외부 채널',
          description: 'Email·SMS·Slack·Discord 전달 구성',
          route: '/manage/external-channels',
        },
        { label: '감사 로그', description: 'append-only 운영 감사 기록', route: '/manage/audit' },
      ],
    },
  ];
}
