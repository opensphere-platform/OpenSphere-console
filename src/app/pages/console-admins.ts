import { Component, inject, computed, ChangeDetectionStrategy } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ClarityModule } from '@clr/angular';
import { AuthService } from '../core/auth.service';

/**
 * 콘솔 관리자 (Kanidm) — Main Shell 운영관리자 자기관리 홈. **CORE 내장 컴포넌트**.
 *
 * 이전엔 `console-identity` DUPA 플러그인이었으나(별도 컨테이너·"미등록" 가능), 콘솔이 자기 자신
 * (접근·신원·플러그인)을 관리하는 영역은 **플러그인이 아니라 셸에 내장**한다 — 플러그인 시스템을
 * 플러그인으로 관리할 수 없다(chicken-egg). 운영자 신원은 auth.service(Kanidm id_token)에서 직접
 * 읽고, 멤버십 부여/회수·플러그인 설치는 내장 admin-roles·admin-plugins로 위임한다. perspective 아님.
 */
@Component({
  selector: 'os-console-admins',
  imports: [ClarityModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>콘솔 관리자 <span class="os-engine">Console Admin · Kanidm</span></h1>
    <p class="os-sub">
      Main Shell 운영관리자 자기관리. 콘솔 접근·신원·플러그인은 <strong>셸 내장 CORE</strong>(플러그인 아님).
    </p>

    <div class="clr-row">
      <div class="clr-col-lg-6 clr-col-12">
        <div class="card">
          <div class="card-header">현재 운영자</div>
          <div class="card-block">
            <table class="table table-compact table-vertical">
              <tbody>
                <tr><th>사용자</th><td>{{ user() || '—' }}</td></tr>
                <tr><th>이메일</th><td>{{ email() || '—' }}</td></tr>
                <tr><th>subject</th><td><code>{{ subject() || '—' }}</code></td></tr>
                <tr>
                  <th>그룹</th>
                  <td>
                    @for (g of groups(); track g) {
                      <span class="label">{{ g }}</span>
                    }
                    @if (!groups().length) { — }
                  </td>
                </tr>
                <tr>
                  <th>콘솔 관리자</th>
                  <td>
                    @if (isAdmin()) {
                      <span class="label label-success">예 · opensphere-console-admins</span>
                    } @else {
                      <span class="label label-warning">아니오</span>
                    }
                  </td>
                </tr>
                <tr><th>토큰 만료</th><td>{{ expDate() }}</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="clr-col-lg-6 clr-col-12">
        <div class="card">
          <div class="card-header">관리 작업</div>
          <div class="card-block">
            <p>콘솔 운영관리 영역(전부 셸 내장 CORE — DUPA 플러그인 의존 없음):</p>
            <ul class="list">
              <li>역할 = Kanidm 그룹(opensphere-console-*) 멤버십 부여/회수</li>
              <li>플러그인 = DUPA 확장 설치·enable/disable</li>
              <li>계정 self-service = 비밀번호·passkey·TOTP(Kanidm)</li>
            </ul>
          </div>
          <div class="card-footer">
            <a routerLink="/admin/roles" class="btn btn-sm btn-link">역할 정의·부여</a>
            <a routerLink="/admin/plugins" class="btn btn-sm btn-link">플러그인 관리</a>
            <a [href]="accountUrl" target="_blank" rel="noopener" class="btn btn-sm btn-link">계정 self-service</a>
          </div>
        </div>
      </div>
    </div>
  `,
})
export class ConsoleAdmins {
  private auth = inject(AuthService);
  readonly user = this.auth.user;
  readonly email = this.auth.email;
  readonly groups = this.auth.groups;
  readonly subject = this.auth.subject;
  readonly accountUrl = this.auth.accountUrl();
  readonly isAdmin = computed(() => this.auth.groups().includes('opensphere-console-admins'));
  readonly expDate = computed(() =>
    this.auth.tokenExp() ? new Date(this.auth.tokenExp() * 1000).toLocaleString() : '—',
  );
}
