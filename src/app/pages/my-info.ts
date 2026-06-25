import { Component, computed, inject, ChangeDetectionStrategy } from '@angular/core';
import { ClarityModule } from '@clr/angular';
import { AuthService } from '../core/auth.service';
import { PerspectiveService } from '../core/perspective.service';

/** My Info — 현재 사용자 프로필/세션. 셸 네이티브(토큰 claim 표시, 추가 백엔드 0). */
@Component({
  selector: 'os-my-info',
  imports: [ClarityModule],
  template: `
    <h1>My Info <span class="badge badge-info">내 정보</span></h1>
    <p class="os-sub">
      현재 세션의 신원·권한·만료. 인증 권위 = Kanidm(콘솔 break-glass IdP). 자격증명 관리는 Kanidm 셀프서비스에서.
    </p>

    <div class="clr-row">
      <div class="clr-col-12 clr-col-lg-6">
        <div class="card">
          <div class="card-header">신원 (Identity)</div>
          <div class="card-block">
            <table class="table os-kv">
              <tbody>
                <tr>
                  <td>사용자</td>
                  <td>
                    <strong>{{ auth.user() }}</strong>
                  </td>
                </tr>
                <tr>
                  <td>이름</td>
                  <td>{{ auth.name() || '—' }}</td>
                </tr>
                <tr>
                  <td>이메일</td>
                  <td>{{ auth.email() || '—' }}</td>
                </tr>
                <tr>
                  <td>Subject</td>
                  <td class="os-mono">{{ auth.subject() || '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="clr-col-12 clr-col-lg-6">
        <div class="card">
          <div class="card-header">세션 (Session)</div>
          <div class="card-block">
            <table class="table os-kv">
              <tbody>
                <tr>
                  <td>토큰 만료</td>
                  <td>{{ expText() }}</td>
                </tr>
                <tr>
                  <td>IdP</td>
                  <td>Kanidm · opensphere-console</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">자격증명 관리 (Credentials)</div>
      <div class="card-block">
        <p class="os-sub">
          비밀번호·passkey·TOTP는 Kanidm 셀프서비스에서 직접 관리합니다(관리자 대리설정 불가 — 자가설정 강제).
        </p>
        <a class="btn btn-sm btn-primary" [href]="auth.accountUrl()" target="_blank" rel="noopener">
          Kanidm 계정 관리 열기
        </a>
      </div>
    </div>

    <div class="card">
      <div class="card-header">권한 (Authorization)</div>
      <div class="card-block">
        <p class="os-kv-label">그룹 (Groups)</p>
        <p>
          @for (g of auth.groups(); track g) {
            <span class="label">{{ g }}</span>
          } @empty {
            <span class="os-sub">없음</span>
          }
        </p>
        <p class="os-kv-label">역할 (Roles)</p>
        <p>
          @for (r of auth.roles(); track r) {
            <span class="label">{{ r }}</span>
          } @empty {
            <span class="os-sub">없음</span>
          }
        </p>
        <p class="os-kv-label">허용 Workspace (정책 게이트)</p>
        <p>
          @for (w of psp.allowedWorkspaces(); track w.id) {
            <span class="label" [class.label-success]="w.id === psp.active()"
              >{{ w.id }} {{ w.label }}</span
            >
          }
        </p>
        <p class="os-sub">정책: opensphere-console-admins → A/B/C · 그 외 → B/C. (OPA 이관 대상)</p>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
      .os-sub {
        color: #8a93ab;
        font-size: 0.8rem;
      }
      .os-mono {
        font-family: monospace;
        font-size: 0.72rem;
        word-break: break-all;
      }
      .os-kv td:first-child {
        color: #6b7280;
        width: 32%;
      }
      .os-kv-label {
        font-size: 0.7rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: #6b7280;
        margin: 0.6rem 0 0.2rem;
      }
      .label {
        margin-right: 0.3rem;
      }
    `,
  ],
})
export class MyInfo {
  readonly auth = inject(AuthService);
  readonly psp = inject(PerspectiveService);

  readonly expText = computed(() => {
    const e = this.auth.tokenExp();
    if (!e) return '—';
    const d = new Date(e * 1000);
    const mins = Math.round((e * 1000 - Date.now()) / 60000);
    return `${d.toLocaleString()} (${mins > 0 ? mins + '분 후' : '만료됨'})`;
  });
}
