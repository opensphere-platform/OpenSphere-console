import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ClarityModule } from '@clr/angular';
import { AuthService, LinkedAvatarAccount, SessionDuration, TotpEnrollment } from '../core/auth.service';
import { HttpService } from '../core/http.service';
import { PerspectiveService } from '../core/perspective.service';
import { OsPanel } from '../os/os-panel';

type ProfileTab = 'details' | 'access' | 'requests' | 'resources' | 'credentials' | 'security' | 'activity';

interface IdUser {
  id: string;
  username: string;
  displayName?: string;
  email?: string;
  enabled: boolean;
  groups?: string[];
}

interface CliDevice {
  id: string;
  label: string;
  fingerprint: string;
  status: 'active' | 'revoked';
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  lastSessionExpiresAt: string | null;
  user: string;
}

interface Enrollment {
  enrollmentId: string;
  label: string;
  fingerprint: string;
  expiresAt: string;
  status: string;
  approvingUser: string;
}

interface AuthPolicy {
  totpEnabled: boolean;
  environment: string;
  enforced?: boolean;
  source?: string;
}

interface AuditEvent {
  time?: string;
  actor?: string;
  action?: string;
  target?: string;
  result?: string;
  reason?: string;
}

/**
 * 내 프로필 — 사람 중심의 Console 신원·권한·자격 증명 제어 표면.
 * 장치 키는 대화형 os 로그인에만 사용한다.
 * private key는 OS 보안 저장소에 남고 Console은 15분 세션만 교환한다.
 */
@Component({
  selector: 'os-my-info',
  imports: [ClarityModule, FormsModule, RouterLink, OsPanel],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="profile-page">
      <header class="profile-hero">
        <a class="profile-back" routerLink="/">← OpenSphere</a>
        <div class="profile-title-row">
          <div>
            <h1>{{ auth.name() || auth.user() }}</h1>
            <p>내 프로필</p>
          </div>
          <div class="profile-actions">
            <button class="btn btn-sm btn-outline" (click)="refresh()" [disabled]="busy()">새로고침</button>
            <button class="btn btn-sm btn-primary" (click)="openEdit()" [disabled]="!identityUser()">내 프로필 편집</button>
          </div>
        </div>
      </header>

      @if (message(); as m) {
        <clr-alert [clrAlertType]="m.type" [clrAlertClosable]="true" (clrAlertClosedChange)="message.set(null)">
          <clr-alert-item><span class="alert-text">{{ m.text }}</span></clr-alert-item>
        </clr-alert>
      }

      @if (enrollment(); as request) {
        <clr-alert [clrAlertType]="'warning'" [clrAlertClosable]="false">
          <clr-alert-item>
            <span class="alert-text">
              <strong>{{ request.label }}</strong> 장치가 OpenSphere CLI 연결 승인을 요청했습니다.
              <span class="os-mono">{{ request.fingerprint }}</span>
              <button class="btn btn-sm btn-primary enrollment-action" (click)="approveEnrollment()" [disabled]="busy()">이 장치 승인</button>
              <button class="btn btn-sm btn-link" (click)="clearEnrollment()">거절</button>
            </span>
          </clr-alert-item>
        </clr-alert>
      }

      <clr-tabs>
        <clr-tab>
          <button clrTabLink (click)="selectTab('details')">상세</button>
          <clr-tab-content *clrIfActive="tab() === 'details'">
            <div class="details-grid">
              <section>
                <h2>사용자 정보</h2>
                <dl class="kv-list">
                  <div><dt>사용자명</dt><dd>{{ auth.user() }}</dd></div>
                  <div><dt>사용자 ID</dt><dd class="os-mono">{{ auth.subject() || '—' }} <button class="btn btn-sm btn-link" (click)="copy(auth.subject())">복사</button></dd></div>
                  <div><dt>표시 이름</dt><dd>{{ identityUser()?.displayName || auth.name() || '—' }}</dd></div>
                  <div><dt>이메일</dt><dd>{{ identityUser()?.email || auth.email() || '—' }}</dd></div>
                  <div><dt>상태</dt><dd><span class="label" [class.label-success]="identityUser()?.enabled !== false">{{ identityUser()?.enabled === false ? '비활성' : '활성' }}</span></dd></div>
                  <div><dt>인증 방식</dt><dd>Supabase Auth · Console RBAC</dd></div>
                </dl>

                <h2>기능</h2>
                <dl class="kv-list compact">
                  <div><dt>콘솔 로그인</dt><dd>사용 가능</dd></div>
                  <div><dt>CLI 장치 키</dt><dd>{{ activeDeviceCount() ? '사용 가능' : '등록 필요' }}</dd></div>
                  <div><dt>자동화 API 토큰</dt><dd>제공하지 않음</dd></div>
                  <div><dt>역할 기반 접근</dt><dd>{{ auth.groups().length ? '적용됨' : '없음' }}</dd></div>
                </dl>
              </section>

              <section>
                <h2>사용자 기본 설정</h2>
                <div class="avatar-preference">
                  <div class="avatar-preview" aria-label="현재 프로필 사진">
                    @if (auth.avatarUrl()) {
                      <img [src]="auth.avatarUrl()" alt="" referrerpolicy="no-referrer" (error)="auth.avatarImageFailed(auth.avatarUrl())" />
                    } @else {
                      <span>{{ avatarInitial() }}</span>
                    }
                  </div>
                  <div class="avatar-controls">
                    <strong>프로필 사진</strong>
                    <span class="avatar-source">{{ avatarSourceLabel() }}</span>
                    <div class="avatar-actions">
                      <input #avatarInput class="avatar-file" type="file" accept="image/png,image/jpeg,image/webp" (change)="changeAvatar($event)" />
                      <button class="btn btn-sm btn-outline" type="button" (click)="avatarInput.click()" [disabled]="busy()">사진 변경</button>
                      <button class="btn btn-sm btn-link" type="button" (click)="useInitialAvatar()" [disabled]="busy() || auth.profileAvatar().current.source === 'initial'">이니셜 사용</button>
                    </div>
                    <small>정사각형으로 자동 조정됩니다. PNG, JPEG, WebP · 최대 8MB</small>
                  </div>
                </div>
                @if (auth.profileAvatar().linkedAccounts.length) {
                  <div class="linked-avatars" aria-label="연결된 계정의 프로필 사진">
                    <span class="linked-label">연결된 계정 사진</span>
                    @for (account of auth.profileAvatar().linkedAccounts; track account.provider + ':' + account.url) {
                      <button type="button" class="linked-avatar" (click)="selectLinkedAvatar(account)" [disabled]="busy() || linkedAvatarSelected(account)" [title]="avatarProviderLabel(account.provider) + ' 계정 사진 사용'">
                        <img [src]="account.url" alt="" referrerpolicy="no-referrer" />
                        <span>{{ avatarProviderLabel(account.provider) }}</span>
                      </button>
                    }
                  </div>
                } @else {
                  <p class="avatar-empty">프로필 사진을 제공하는 연결 계정이 없습니다. 직접 사진을 올릴 수 있습니다.</p>
                }
                <dl class="kv-list">
                  <div><dt>시간대</dt><dd>{{ timeZone }}</dd></div>
                  <div><dt>기본 언어</dt><dd>{{ language }}</dd></div>
                  <div><dt>시작 화면</dt><dd>OpenSphere Console</dd></div>
                </dl>

                <h2>업무 정보</h2>
                <dl class="kv-list">
                  <div><dt>조직</dt><dd>—</dd></div>
                  <div><dt>부서</dt><dd>—</dd></div>
                  <div><dt>직책</dt><dd>—</dd></div>
                  <div><dt>직원 번호</dt><dd>—</dd></div>
                  <div><dt>비용 센터</dt><dd>—</dd></div>
                </dl>
              </section>
            </div>
          </clr-tab-content>
        </clr-tab>

        <clr-tab>
          <button clrTabLink (click)="selectTab('access')">그룹·역할</button>
          <clr-tab-content *clrIfActive="tab() === 'access'">
            <section class="tab-section">
              <h2>내 그룹과 역할</h2>
              <p class="section-lead">현재 Supabase Console 신원·역할 경계에서 평가된 접근 권한입니다. 권한 변경은 콘솔 역할 관리자의 승인을 거칩니다.</p>
              <clr-datagrid>
                <clr-dg-column>이름</clr-dg-column>
                <clr-dg-column>유형</clr-dg-column>
                <clr-dg-column>설명</clr-dg-column>
                @for (group of auth.groups(); track group) {
                  <clr-dg-row>
                    <clr-dg-cell><strong>{{ group }}</strong></clr-dg-cell>
                    <clr-dg-cell><span class="label label-info">그룹</span></clr-dg-cell>
                    <clr-dg-cell>{{ groupDescription(group) }}</clr-dg-cell>
                  </clr-dg-row>
                }
                @for (role of auth.roles(); track role) {
                  <clr-dg-row>
                    <clr-dg-cell><strong>{{ role }}</strong></clr-dg-cell>
                    <clr-dg-cell><span class="label">역할</span></clr-dg-cell>
                    <clr-dg-cell>OIDC 역할 클레임</clr-dg-cell>
                  </clr-dg-row>
                }
                <clr-dg-placeholder>부여된 그룹 또는 역할이 없습니다</clr-dg-placeholder>
                <clr-dg-footer>{{ auth.groups().length + auth.roles().length }}개 항목</clr-dg-footer>
              </clr-datagrid>
            </section>
          </clr-tab-content>
        </clr-tab>

        <clr-tab>
          <button clrTabLink (click)="selectTab('requests')">내 요청</button>
          <clr-tab-content *clrIfActive="tab() === 'requests'">
            <section class="tab-section">
              <h2>내 접근 요청</h2>
              <clr-datagrid>
                <clr-dg-column>요청</clr-dg-column><clr-dg-column>근거</clr-dg-column><clr-dg-column>생성</clr-dg-column><clr-dg-column>상태</clr-dg-column>
                <clr-dg-placeholder>진행 중인 접근 요청이 없습니다</clr-dg-placeholder>
                <clr-dg-footer>0개 요청</clr-dg-footer>
              </clr-datagrid>
            </section>
          </clr-tab-content>
        </clr-tab>

        <clr-tab>
          <button clrTabLink (click)="selectTab('resources')">내 리소스</button>
          <clr-tab-content *clrIfActive="tab() === 'resources'">
            <section class="tab-section">
              <h2>허용된 Workspace</h2>
              <clr-datagrid>
                <clr-dg-column>Workspace</clr-dg-column><clr-dg-column>정책 상태</clr-dg-column><clr-dg-column>설명</clr-dg-column>
                @for (workspace of psp.allowedWorkspaces(); track workspace.id) {
                  <clr-dg-row>
                    <clr-dg-cell><strong>{{ workspace.label }}</strong> <span class="os-mono">{{ workspace.id }}</span></clr-dg-cell>
                    <clr-dg-cell><span class="label" [class.label-success]="workspace.id === psp.active()">{{ workspace.id === psp.active() ? '현재' : '허용' }}</span></clr-dg-cell>
                    <clr-dg-cell>그룹 기반 정책으로 허용된 Console 작업 영역</clr-dg-cell>
                  </clr-dg-row>
                }
                <clr-dg-footer>{{ psp.allowedWorkspaces().length }}개 Workspace</clr-dg-footer>
              </clr-datagrid>
            </section>
          </clr-tab-content>
        </clr-tab>

        <clr-tab>
          <button clrTabLink (click)="selectTab('credentials')">자격 증명</button>
          <clr-tab-content *clrIfActive="tab() === 'credentials'">
            <section class="tab-section credential-page" aria-labelledby="credential-page-title">
              <div class="credential-intro">
                <div>
                  <h2 id="credential-page-title">내 자격 증명</h2>
                  <p class="section-lead">대화형 CLI 장치와 Console 로그인 세션을 확인합니다. CLI private key와 세션 원문은 서버에서 다시 조회할 수 없습니다.</p>
                </div>
                <div class="credential-summary" aria-label="자격 증명 요약">
                  <span class="label label-success">활성 장치 {{ activeDeviceCount() }}</span>
                  @if (revokedDeviceCount()) { <span class="label label-light-blue">폐기 이력 {{ revokedDeviceCount() }}</span> }
                </div>
              </div>

              @if (credentialError()) {
                <clr-alert [clrAlertType]="'danger'" [clrAlertClosable]="false">
                  <clr-alert-item>
                    <span class="alert-text">{{ credentialError() }}</span>
                    <div class="alert-actions"><button class="btn btn-sm btn-outline" (click)="loadCredentials()" [disabled]="credentialsLoading()">다시 시도</button></div>
                  </clr-alert-item>
                </clr-alert>
              }

              <article class="credential-section" aria-labelledby="device-credentials-title">
                <div class="section-heading">
                  <div>
                    <h2 id="device-credentials-title">CLI 신뢰 장치</h2>
                    <p class="section-lead"><code>os login</code>으로 등록한 활성 장치와 폐기 이력입니다. <code>os logout</code>한 장치는 즉시 인증이 차단되고 폐기됨으로 표시됩니다.</p>
                  </div>
                  <button class="btn btn-sm btn-outline" (click)="loadCredentials()" [disabled]="credentialsLoading()">새로고침</button>
                </div>
                <form class="credential-toolbar" (ngSubmit)="searchDevices()">
                  <clr-input-container class="credential-search">
                    <label>장치 검색</label>
                    <input clrInput [(ngModel)]="deviceSearchText" name="device-search" placeholder="장치 이름, ID 또는 지문" />
                  </clr-input-container>
                  <button class="btn btn-sm btn-outline" type="submit">검색</button>
                  <button class="btn btn-sm btn-link" type="button" (click)="clearDeviceSearch()" [disabled]="!deviceFilter() && !deviceSearchText">검색 초기화</button>
                </form>
              <div class="credential-grid-scroll" tabindex="0" aria-label="CLI 신뢰 장치 표">
              <clr-datagrid [clrDgLoading]="credentialsLoading()">
                <clr-dg-column>장치</clr-dg-column><clr-dg-column>상태</clr-dg-column><clr-dg-column>지문</clr-dg-column><clr-dg-column>등록</clr-dg-column><clr-dg-column>마지막 사용</clr-dg-column><clr-dg-column>세션 만료</clr-dg-column><clr-dg-column>동작</clr-dg-column>
                @for (device of filteredDevices(); track device.id) {
                  <clr-dg-row>
                    <clr-dg-cell><strong>{{ device.label }}</strong><div class="os-mono">{{ device.id }}</div></clr-dg-cell>
                    <clr-dg-cell>
                      @if (device.status === 'active') {
                        <span class="label label-success">신뢰됨</span>
                      } @else {
                        <span class="label label-danger">폐기됨</span>
                        <div class="credential-state-meta">{{ fmt(device.revokedAt) }}</div>
                      }
                    </clr-dg-cell>
                    <clr-dg-cell class="os-mono">{{ device.fingerprint }}</clr-dg-cell>
                    <clr-dg-cell>{{ fmt(device.createdAt) }}</clr-dg-cell>
                    <clr-dg-cell>{{ fmt(device.lastUsedAt) }}</clr-dg-cell>
                    <clr-dg-cell>{{ fmt(device.lastSessionExpiresAt) }}</clr-dg-cell>
                    <clr-dg-cell>
                      @if (device.status === 'active') {
                        <button class="btn btn-sm btn-danger-outline" (click)="openCredentialRevoke(device.id, device.label)" [disabled]="busy()">신뢰 해제</button>
                      } @else {
                        <span class="credential-state-meta">폐기 완료</span>
                      }
                    </clr-dg-cell>
                  </clr-dg-row>
                }
                <clr-dg-placeholder>{{ deviceFilter() ? '검색 조건과 일치하는 장치가 없습니다' : '등록된 CLI 장치가 없습니다. 터미널에서 os login을 실행하세요.' }}</clr-dg-placeholder>
                <clr-dg-footer>{{ filteredDevices().length }}개 표시 · 활성 {{ activeDeviceCount() }}개 · 폐기 {{ revokedDeviceCount() }}개</clr-dg-footer>
              </clr-datagrid>
              </div>
              </article>

              <article class="credential-section" aria-labelledby="session-credential-title">
                <div class="section-heading">
                  <div>
                    <h2 id="session-credential-title">Console 로그인 세션</h2>
                    <p class="section-lead">현재 계정으로 로그인된 브라우저를 확인하고 분실하거나 더 이상 사용하지 않는 세션을 즉시 종료합니다. Supabase 토큰 원문은 브라우저에 제공되지 않습니다.</p>
                  </div>
                  <button class="btn btn-sm btn-danger-outline" (click)="revokeAllSessions()" [disabled]="busy() || !auth.browserSessions().length">모든 세션 종료</button>
                </div>
                <div class="credential-grid-scroll" tabindex="0" aria-label="Console 로그인 세션 표">
                <clr-datagrid [clrDgLoading]="credentialsLoading()">
                  <clr-dg-column>세션</clr-dg-column><clr-dg-column>상태</clr-dg-column><clr-dg-column>로그인 유지</clr-dg-column><clr-dg-column>마지막 활동</clr-dg-column><clr-dg-column>자동 로그아웃</clr-dg-column><clr-dg-column>최대 만료</clr-dg-column><clr-dg-column>동작</clr-dg-column>
                  @for (session of auth.browserSessions(); track session.id) {
                    <clr-dg-row>
                      <clr-dg-cell>
                        <strong>{{ session.current ? '현재 브라우저' : '다른 브라우저' }}</strong>
                        <div class="os-mono">{{ session.id }}</div>
                      </clr-dg-cell>
                      <clr-dg-cell>
                        <span class="label" [class.label-success]="session.status === 'active'">{{ session.status === 'active' ? '활성' : '추가 인증 대기' }}</span>
                        @if (session.current) { <span class="label label-info">현재</span> }
                      </clr-dg-cell>
                      <clr-dg-cell>{{ persistenceLabel(session.persistence) }}</clr-dg-cell>
                      <clr-dg-cell>{{ fmt(session.lastSeenAt) }}</clr-dg-cell>
                      <clr-dg-cell>{{ fmt(session.idleExpiresAt) }}</clr-dg-cell>
                      <clr-dg-cell>{{ fmt(session.absoluteExpiresAt) }}</clr-dg-cell>
                      <clr-dg-cell><button class="btn btn-sm btn-danger-outline" (click)="revokeSession(session.id)" [disabled]="busy()">세션 종료</button></clr-dg-cell>
                    </clr-dg-row>
                  }
                  <clr-dg-placeholder>활성 브라우저 세션을 불러오지 못했거나 세션이 없습니다</clr-dg-placeholder>
                  <clr-dg-footer>{{ auth.browserSessions().length }}개 브라우저 세션 · 유휴 제한 12시간</clr-dg-footer>
                </clr-datagrid>
                </div>
              </article>

              <article class="credential-section" aria-labelledby="extension-credential-title">
                <div class="section-heading">
                  <div>
                    <h2 id="extension-credential-title">서비스 자격 증명과 OAuth 클라이언트</h2>
                    <p class="section-lead">기본 Console은 개인 사용자에게 서비스 비밀을 직접 발급하지 않습니다. 해당 자격 유형은 검증된 Extension 제공자가 설치된 경우에만 이곳에 추가됩니다.</p>
                  </div>
                </div>
                <div class="credential-empty" role="status">
                  <strong>사용 가능한 자격 제공자가 없습니다</strong>
                  <span>현재 기본 Main Shell에는 추가 서비스 자격 증명 또는 OAuth 클라이언트 제공자가 설치되지 않았습니다.</span>
                </div>
              </article>
            </section>
          </clr-tab-content>
        </clr-tab>

        <clr-tab>
          <button clrTabLink (click)="selectTab('security')">보안</button>
          <clr-tab-content *clrIfActive="tab() === 'security'">
            <section class="tab-section">
              <h2>현재 세션</h2>
              <dl class="kv-list security-list">
                <div><dt>인증 공급자</dt><dd>Supabase Auth · opensphere-console</dd></div>
                <div><dt>세션 만료</dt><dd>{{ expText() }}</dd></div>
                <div><dt>현재 인증 보증</dt><dd><span class="label" [class.label-success]="auth.assurance() === 'aal2'">{{ auth.assurance() }}</span> {{ auth.assurance() === 'aal2' ? '비밀번호와 TOTP 검증 완료' : '비밀번호 인증만 완료' }}</dd></div>
                <div><dt>TOTP 정책</dt><dd>관리자 변경 작업에 필수 <span class="label">Supabase Auth</span></dd></div>
                <div><dt>브라우저 자격 보관</dt><dd>Secure HttpOnly 불투명 세션 쿠키 · Supabase 토큰은 Backend 암호화 보관</dd></div>
                <div><dt>현재 세션 유지</dt><dd>{{ persistenceLabel(auth.currentSession()?.persistence || '24h') }} · 실제 사용자 활동 기준 유휴 12시간 제한</dd></div>
              </dl>
              <h2>다음 로그인 기본값</h2>
              <p class="section-lead">이 계정의 로그인 유지 방식을 저장합니다. 현재 열려 있는 세션은 바꾸지 않으며, 다음 로그인부터 모든 브라우저에 같은 정책이 적용됩니다.</p>
              <form class="session-preference" (ngSubmit)="saveSessionPreference()">
                <label for="session-persistence">로그인 유지 시간</label>
                <select id="session-persistence" name="session-persistence" [(ngModel)]="sessionDurationDraft" [disabled]="busy()">
                  <option value="browser">브라우저를 닫을 때까지</option>
                  <option value="1h">1시간</option>
                  <option value="4h">4시간</option>
                  <option value="8h">8시간</option>
                  <option value="12h">12시간</option>
                  <option value="24h">24시간 · 권장</option>
                  <option value="3d">3일 · 개인 장치</option>
                  <option value="7d">7일 · 신뢰하는 개인 장치</option>
                  <option value="14d">14일 · 신뢰하는 개인 장치</option>
                  <option value="30d">30일 · 장기 사용 개인 장치</option>
                </select>
                <button class="btn btn-sm btn-primary" type="submit" [disabled]="busy() || sessionDurationDraft === auth.sessionDurationPreference()">설정 저장</button>
              </form>
              <p class="session-preference-help">{{ sessionPreferenceHelp(sessionDurationDraft) }} 유휴 12시간 제한은 모든 선택에 공통 적용됩니다.</p>
              <h2>최근 세션 보안 이력</h2>
              <div class="credential-grid-scroll" tabindex="0" aria-label="최근 세션 보안 이력">
                <clr-datagrid>
                  <clr-dg-column>시각</clr-dg-column><clr-dg-column>동작</clr-dg-column><clr-dg-column>결과</clr-dg-column><clr-dg-column>세션</clr-dg-column>
                  @for (event of auth.sessionEvents(); track event.id) {
                    <clr-dg-row>
                      <clr-dg-cell>{{ fmt(event.occurred_at) }}</clr-dg-cell>
                      <clr-dg-cell>{{ sessionEventLabel(event.event) }}</clr-dg-cell>
                      <clr-dg-cell><span class="label" [class.label-success]="event.result === 'ok'" [class.label-warning]="event.result === 'pending'" [class.label-danger]="event.result === 'rejected' || event.result === 'error'">{{ event.result }}</span></clr-dg-cell>
                      <clr-dg-cell class="os-mono">{{ event.session_id || '정리됨' }}</clr-dg-cell>
                    </clr-dg-row>
                  }
                  <clr-dg-placeholder>기록된 세션 보안 이벤트가 없습니다.</clr-dg-placeholder>
                  <clr-dg-footer>최근 {{ auth.sessionEvents().length }}건 · 원문 IP와 토큰은 기록하지 않음</clr-dg-footer>
                </clr-datagrid>
              </div>
              <h2>인증 앱</h2>
              @if (auth.mfaEnrollmentRequired()) {
                <clr-alert [clrAlertType]="'warning'" [clrAlertClosable]="false">
                  <clr-alert-item><span class="alert-text"><strong>OTP 재등록이 필요합니다.</strong> 관리자가 기존 OTP 연결을 해제했습니다. 아래 QR 코드를 인증 앱으로 스캔하고 6자리 코드를 확인하세요.</span></clr-alert-item>
                </clr-alert>
              }
              @if (totpEnrollment(); as enrollment) {
                <p class="section-lead">Google Authenticator, Microsoft Authenticator, 1Password 같은 인증 앱으로 QR 코드를 스캔한 뒤, 앱에 표시되는 현재 6자리 코드를 입력해야 등록이 완료됩니다.</p>
                <div class="mfa-enrollment">
                  @if (enrollment.qrCode && !totpQrError()) {
                    <img [src]="enrollment.qrCode" alt="OpenSphere TOTP 등록 QR 코드" (error)="totpQrError.set(true)">
                  } @else {
                    <div class="qr-unavailable" role="status">QR 코드를 표시할 수 없습니다. 인증 앱에서 수동 등록 키를 입력하세요.</div>
                  }
                  <div>
                    <span class="setup-label">수동 등록 키</span>
                    <code>{{ enrollment.secret }}</code>
                    @if (enrollment.uri) { <span class="mfa-uri">{{ enrollment.uri }}</span> }
                  </div>
                </div>
                <form class="mfa-verify" clrForm clrLayout="vertical" (ngSubmit)="verifyTotp()">
                  <clr-input-container>
                    <label>6자리 인증 코드</label>
                    <input clrInput name="totp-code" [(ngModel)]="totpCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required>
                  </clr-input-container>
                  <button class="btn btn-sm btn-primary" type="submit" [disabled]="busy() || totpCode.length !== 6">TOTP 등록 완료</button>
                  <button class="btn btn-sm btn-outline" type="button" (click)="cancelTotpEnrollment()" [disabled]="busy()">취소</button>
                </form>
              } @else if (auth.assurance() === 'aal2') {
                <p class="section-lead">현재 세션은 등록된 TOTP factor로 추가 인증을 완료했습니다.</p>
                <span class="label label-success">보호됨</span>
              } @else {
                <p class="section-lead">현재 계정에는 검증된 TOTP가 없습니다. 등록 전에는 설정·자격 증명·선언 변경 작업이 차단됩니다.</p>
                <button class="btn btn-sm btn-primary" (click)="beginTotpEnrollment()" [disabled]="busy()">인증 앱 등록</button>
              }
              <h2>비밀번호</h2>
              <p class="section-lead">Supabase Auth의 안전한 회복 링크로 비밀번호를 설정합니다. 다른 MFA 자격 증명은 그대로 유지됩니다.</p>
              <button class="btn btn-sm btn-primary" (click)="openPasswordPanel()" [disabled]="busy()">비밀번호 변경</button>

              <h2>복구와 보호</h2>
              <p class="section-lead">passkey·TOTP 등록·재설정은 관리자 대리설정이 아닌 새 온보딩/자격 갱신 흐름으로 수행합니다.</p>
              <a class="btn btn-sm btn-outline" routerLink="/manage/console-admins">콘솔 관리자 보안 정책</a>
            </section>
          </clr-tab-content>
        </clr-tab>

        <clr-tab>
          <button clrTabLink (click)="selectTab('activity')">활동</button>
          <clr-tab-content *clrIfActive="tab() === 'activity'">
            <section class="tab-section">
              <h2>내 최근 관리 활동</h2>
              <p class="section-lead">Supabase 영구 감사에서 현재 사용자와 관련된 항목만 표시합니다.</p>
              <clr-datagrid [clrDgLoading]="activityLoading()">
                <clr-dg-column>시각</clr-dg-column><clr-dg-column>동작</clr-dg-column><clr-dg-column>대상</clr-dg-column><clr-dg-column>결과</clr-dg-column><clr-dg-column>사유</clr-dg-column>
                @for (event of activities(); track (event.time || '') + (event.action || '') + (event.target || '')) {
                  <clr-dg-row>
                    <clr-dg-cell>{{ fmt(event.time || null) }}</clr-dg-cell><clr-dg-cell><code>{{ event.action || '—' }}</code></clr-dg-cell><clr-dg-cell>{{ event.target || '—' }}</clr-dg-cell><clr-dg-cell><span class="label">{{ event.result || '—' }}</span></clr-dg-cell><clr-dg-cell>{{ event.reason || '—' }}</clr-dg-cell>
                  </clr-dg-row>
                }
                <clr-dg-placeholder>표시할 사용자 활동이 없습니다</clr-dg-placeholder>
                <clr-dg-footer>최근 {{ activities().length }}건</clr-dg-footer>
              </clr-datagrid>
            </section>
          </clr-tab-content>
        </clr-tab>
      </clr-tabs>
    </div>

    <os-panel [open]="editOpen()" title="내 프로필 편집" subtitle="Supabase Console Identity · 감사 사유 필수" (closed)="editOpen.set(false)">
      <form clrForm clrLayout="vertical">
        <clr-input-container>
          <label>표시 이름</label>
          <input clrInput [(ngModel)]="edit.displayName" name="display-name" required />
        </clr-input-container>
        <clr-input-container>
          <label>이메일</label>
          <input clrInput [(ngModel)]="edit.email" name="email" type="email" />
        </clr-input-container>
        <clr-textarea-container>
          <label>변경 사유</label>
          <textarea clrTextarea [(ngModel)]="edit.reason" name="reason" required></textarea>
        </clr-textarea-container>
      </form>
      <div class="panel-actions">
        <button class="btn btn-primary" (click)="saveProfile()" [disabled]="busy() || !edit.displayName.trim() || !edit.reason.trim()">저장</button>
        <button class="btn btn-outline" (click)="editOpen.set(false)" [disabled]="busy()">취소</button>
      </div>
    </os-panel>

    <os-panel [open]="credentialRevokeOpen()" title="CLI 장치 신뢰 해제" subtitle="즉시 효력 상실 · 영구 감사" (closed)="closeCredentialRevoke()">
      @if (pendingRevoke(); as credential) {
        <p><strong>{{ credential.label }}</strong> 장치의 신뢰를 해제합니다. 현재 CLI 세션을 포함해 해당 장치의 다음 요청부터 거부됩니다.</p>
        <form clrForm clrLayout="vertical">
          <clr-textarea-container><label>폐기 사유</label><textarea clrTextarea [(ngModel)]="revokeReason" name="revoke-reason" maxlength="240" required></textarea><clr-control-helper>영구 감사에 기록됩니다(8자 이상).</clr-control-helper></clr-textarea-container>
        </form>
        <div class="panel-actions"><button class="btn btn-danger" (click)="confirmCredentialRevoke()" [disabled]="busy() || revokeReason.trim().length < 8">폐기</button><button class="btn btn-outline" (click)="closeCredentialRevoke()" [disabled]="busy()">취소</button></div>
      }
    </os-panel>

    <os-panel [open]="passwordPanelOpen()" title="비밀번호 변경" subtitle="Supabase Auth 회복 링크" (closed)="closePasswordPanel()">
      @if (!passwordChanged()) {
        <clr-alert [clrAlertType]="'info'" [clrAlertClosable]="false">
          <clr-alert-item><span class="alert-text">현재 로그인한 계정(<strong>{{ auth.user() }}</strong>)의 비밀번호만 변경됩니다. TOTP·passkey 등 다른 자격 증명은 삭제하거나 재설정하지 않습니다.</span></clr-alert-item>
        </clr-alert>
        @if (passwordError()) {
          <clr-alert [clrAlertType]="'danger'" [clrAlertClosable]="false">
            <clr-alert-item><span class="alert-text">{{ passwordError() }}</span></clr-alert-item>
          </clr-alert>
        }
        <p class="section-lead">현재 비밀번호나 인증 코드를 이 화면에 입력하지 않습니다. Supabase Auth가 발급한 일회성 회복 링크에서 안전하게 설정합니다.</p>
        <div class="panel-actions">
          <button class="btn btn-primary" (click)="changePassword()" [disabled]="busy()">회복 링크 발급</button>
          <button class="btn btn-outline" (click)="closePasswordPanel()" [disabled]="busy()">취소</button>
        </div>
      } @else {
        <clr-alert [clrAlertType]="'success'" [clrAlertClosable]="false">
          <clr-alert-item><span class="alert-text"><strong>비밀번호를 변경했습니다.</strong> TOTP·passkey 등 다른 자격 증명은 그대로 유지됩니다. 보안을 위해 현재 세션을 종료합니다 — 잠시 후 자동으로 로그아웃되며, 새 비밀번호로 다시 로그인하세요.</span></clr-alert-item>
        </clr-alert>
        <div class="panel-actions">
          <button class="btn btn-primary" (click)="logoutNow()">지금 로그아웃</button>
        </div>
      }
    </os-panel>
  `,
  styles: [
    `
      :host { display: block; }
      .profile-page { background: var(--os-canvas); min-height: calc(100vh - 2.2rem); }
      .profile-hero { display: block; height: auto; background: var(--os-surface-1); border-bottom: 1px solid var(--os-hairline); padding: 0.8rem 1.4rem 0.9rem; }
      .profile-back { color: var(--os-ink); font-size: 0.68rem; text-decoration: none; }
      .profile-title-row { display: flex; align-items: flex-end; justify-content: space-between; gap: 1rem; margin-top: 0.55rem; }
      .profile-title-row > div:first-child { min-width: 0; max-width: 100%; }
      .profile-title-row h1 { font-size: 1.35rem; line-height: 1.2; margin: 0; }
      .profile-title-row p { color: var(--os-muted); font-size: 0.7rem; margin: 0.12rem 0 0; }
      .profile-actions { display: flex; align-items: center; gap: 0.35rem; }
      .details-grid { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 0.9fr); gap: 2rem; padding: 1rem 1.4rem 2rem; }
      h2 { font-size: 1rem; margin: 0.2rem 0 0.55rem; }
      .kv-list { margin: 0 0 1.25rem; }
      .kv-list > div { display: grid; grid-template-columns: minmax(8rem, 34%) minmax(0, 1fr); gap: 0.8rem; align-items: start; border-bottom: 1px solid var(--os-hairline); padding: 0.46rem 0; min-height: 1.8rem; }
      .kv-list dt { font-size: 0.68rem; font-weight: 600; color: var(--os-ink); }
      .kv-list dd { margin: 0; font-size: 0.7rem; color: var(--os-ink); }
      .kv-list.compact { max-width: 34rem; }
      .avatar-preference { display: flex; align-items: center; gap: .85rem; margin: .3rem 0 .65rem; }
      .avatar-preview { display: grid; place-items: center; flex: 0 0 auto; width: 4rem; height: 4rem; border-radius: .55rem; overflow: hidden; color: #fff; font-size: 1.35rem; font-weight: 650; background: linear-gradient(135deg, #6e3ff4, #8a3ffc 48%, #bb6bd9); }
      .avatar-preview img { width: 100%; height: 100%; object-fit: cover; }
      .avatar-controls { display: grid; gap: .18rem; min-width: 0; }
      .avatar-controls strong { font-size: .72rem; }
      .avatar-controls small, .avatar-source, .avatar-empty { color: var(--os-muted); font-size: .63rem; line-height: 1.4; }
      .avatar-actions { display: flex; align-items: center; flex-wrap: wrap; gap: .25rem; }
      .avatar-actions .btn { margin: 0; }
      .avatar-file { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; }
      .linked-avatars { display: flex; align-items: center; flex-wrap: wrap; gap: .35rem; margin: 0 0 .55rem; }
      .linked-label { flex-basis: 100%; color: var(--os-muted); font-size: .63rem; }
      .linked-avatar { display: inline-flex; align-items: center; gap: .35rem; padding: .25rem .45rem .25rem .25rem; border: 1px solid var(--os-hairline); border-radius: .3rem; background: var(--os-surface-0); color: var(--os-ink); font-size: .64rem; cursor: pointer; }
      .linked-avatar:hover:not(:disabled) { border-color: var(--os-accent); }
      .linked-avatar:disabled { opacity: .62; cursor: default; }
      .linked-avatar img { width: 1.55rem; height: 1.55rem; border-radius: .22rem; object-fit: cover; }
      .avatar-empty { margin: 0 0 .65rem; }
      .security-list { max-width: 58rem; }
      .session-preference { display: grid; grid-template-columns: minmax(8rem, 12rem) minmax(14rem, 22rem) auto; align-items: center; gap: .6rem; max-width: 52rem; margin: .65rem 0 .35rem; }
      .session-preference label { font-size: .7rem; font-weight: 600; }
      .session-preference select { min-height: 1.8rem; padding: .25rem .45rem; border: 1px solid var(--os-hairline); background: var(--os-surface-0); color: var(--os-ink); }
      .session-preference .btn { margin: 0; }
      .session-preference-help { max-width: 58rem; margin: 0 0 1.25rem; color: var(--os-muted); font-size: .66rem; line-height: 1.45; }
      .mfa-enrollment { display: flex; align-items: center; gap: 1rem; margin: .75rem 0; }
      .mfa-enrollment img { width: 11rem; height: 11rem; border: 1px solid var(--os-hairline); }
      .qr-unavailable { display: grid; place-items: center; width: 11rem; height: 11rem; padding: 1rem; border: 1px solid var(--os-hairline); color: var(--os-ink-muted); text-align: center; }
      .mfa-enrollment code { display: block; max-width: 24rem; margin-top: .3rem; padding: .55rem; background: var(--os-surface-1); word-break: break-all; user-select: all; }
      .mfa-uri { display: block; max-width: 36rem; margin-top: .4rem; color: var(--os-muted); font-size: .62rem; word-break: break-all; }
      .mfa-verify { max-width: 24rem; margin-bottom: 1.4rem; }
      .tab-section { padding: 1rem 1.4rem 2rem; }
      .section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
      .section-heading.separated { border-top: 1px solid var(--os-hairline); margin-top: 1.4rem; padding-top: 1rem; }
      .section-lead { color: var(--os-muted); font-size: 0.7rem; margin: -0.25rem 0 0.75rem; }
      .credential-page { display: flex; flex-direction: column; gap: 1.35rem; }
      .credential-intro { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; padding-bottom: .2rem; }
      .credential-intro h2 { font-size: 1.15rem; }
      .credential-summary { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: .25rem; padding-top: .15rem; }
      .credential-section { border-top: 1px solid var(--os-hairline); padding-top: 1rem; }
      .credential-toolbar { display: grid; grid-template-columns: minmax(16rem, 1fr) auto auto; align-items: end; gap: .35rem; margin: .2rem 0 .65rem; }
      .credential-search { margin: 0; width: 100%; }
      .credential-search input { width: 100%; min-width: 0; }
      .credential-toolbar .btn { margin-bottom: .05rem; }
      .credential-state-meta { margin-top: .2rem; color: var(--os-muted); font-size: .62rem; white-space: nowrap; }
      .credential-grid-scroll { max-width: 100%; overflow-x: auto; overscroll-behavior-inline: contain; }
      .credential-grid-scroll clr-datagrid { min-width: 58rem; }
      .credential-grid-scroll:focus-visible { outline: 2px solid var(--os-accent); outline-offset: 2px; }
      .credential-empty { display: flex; min-height: 6rem; flex-direction: column; align-items: center; justify-content: center; gap: .25rem; padding: 1rem; border: 1px solid var(--os-hairline); background: var(--os-surface-1); color: var(--os-muted); text-align: center; }
      .credential-empty strong { color: var(--os-ink); font-size: .76rem; }
      .credential-empty span { max-width: 46rem; font-size: .68rem; }
      .alert-actions { margin-top: .35rem; }
      .os-mono { font-family: var(--os-font-mono, monospace); font-size: 0.65rem; word-break: break-all; }
      .panel-actions { display: flex; gap: 0.45rem; margin-top: 0.8rem; }
      .enrollment-action { margin-left: 0.7rem; }
      @media (max-width: 900px) {
        .details-grid { grid-template-columns: 1fr; gap: 0.5rem; }
        .profile-title-row { align-items: flex-start; flex-direction: column; }
        .credential-intro { flex-direction: column; }
        .credential-summary { justify-content: flex-start; }
        .credential-toolbar { grid-template-columns: 1fr auto; }
        .credential-toolbar .btn-link { grid-column: 1 / -1; justify-self: start; }
      }
      @media (max-width: 600px) {
        .profile-hero { padding: .7rem .8rem .8rem; }
        .profile-title-row h1 { white-space: normal; overflow-wrap: anywhere; }
        .profile-actions { flex-wrap: wrap; }
        .tab-section { padding: .8rem .8rem 1.5rem; }
        .session-preference { grid-template-columns: 1fr; align-items: stretch; }
        .session-preference .btn { justify-self: start; }
        .credential-toolbar { grid-template-columns: 1fr; align-items: stretch; }
        .credential-toolbar .btn, .credential-toolbar .btn-link { grid-column: auto; justify-self: start; }
        ::ng-deep .profile-page clr-tabs > .nav { overflow-x: auto; flex-wrap: nowrap; scrollbar-width: thin; }
        ::ng-deep .profile-page clr-tabs > .nav .nav-item { flex: 0 0 auto; }
      }
    `,
  ],
})
export class MyInfo {
  readonly auth = inject(AuthService);
  readonly psp = inject(PerspectiveService);
  private readonly http = inject(HttpService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  readonly tab = signal<ProfileTab>('details');
  readonly identityUser = signal<IdUser | null>(null);
  readonly devices = signal<CliDevice[]>([]);
  readonly enrollment = signal<Enrollment | null>(null);
  readonly authPolicy = signal<AuthPolicy | null>(null);
  readonly activities = signal<AuditEvent[]>([]);
  readonly credentialsLoading = signal(false);
  readonly credentialError = signal('');
  readonly deviceFilter = signal('');
  readonly activityLoading = signal(false);
  readonly busy = signal(false);
  readonly editOpen = signal(false);
  readonly credentialRevokeOpen = signal(false);
  readonly pendingRevoke = signal<{ id: string; label: string } | null>(null);
  readonly message = signal<{ type: 'success' | 'danger' | 'info' | 'warning'; text: string } | null>(null);
  readonly passwordPanelOpen = signal(false);
  readonly passwordChanged = signal(false);
  readonly passwordError = signal('');
  readonly totpEnrollment = signal<TotpEnrollment | null>(null);
  readonly totpQrError = signal(false);

  edit = { displayName: '', email: '', reason: '' };
  revokeReason = '';
  totpCode = '';
  sessionDurationDraft: SessionDuration = '24h';
  private forcedTotpEnrollmentStarted = false;
  deviceSearchText = '';
  readonly timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || '—';
  readonly language = navigator.language || '—';
  readonly avatarInitial = computed(() => (this.auth.user()?.trim()?.[0] ?? '?').toUpperCase());

  readonly expText = computed(() => {
    const exp = this.auth.tokenExp();
    if (!exp) return '—';
    const minutes = Math.round((exp * 1000 - Date.now()) / 60000);
    return `${new Date(exp * 1000).toLocaleString()} (${minutes > 0 ? `${minutes}분 후` : '만료됨'})`;
  });

  readonly activeDeviceCount = computed(() => this.devices().filter((device) => device.status === 'active').length);
  readonly revokedDeviceCount = computed(() => this.devices().filter((device) => device.status === 'revoked').length);
  readonly filteredDevices = computed(() => {
    const query = this.deviceFilter();
    if (!query) return this.devices();
    return this.devices().filter((device) => [device.label, device.id, device.fingerprint, device.status]
      .some((value) => String(value || '').toLocaleLowerCase().includes(query)));
  });
  constructor() {
    this.route.queryParamMap.subscribe((params) => {
      const requested = params.get('tab') as ProfileTab | null;
      if (requested && this.validTab(requested)) this.tab.set(requested);
      if (params.get('enroll') === 'totp') {
        this.tab.set('security');
        if (!this.forcedTotpEnrollmentStarted) {
          this.forcedTotpEnrollmentStarted = true;
          queueMicrotask(() => void this.beginTotpEnrollment());
        }
      }
      const enrollmentId = params.get('cli_enrollment');
      const code = params.get('code');
      if (enrollmentId && code) {
        this.tab.set('credentials');
        void this.loadEnrollment(enrollmentId, code);
      }
    });
    void this.refresh();
  }

  selectTab(tab: ProfileTab): void {
    this.tab.set(tab);
    void this.router.navigate([], { relativeTo: this.route, queryParams: { tab }, queryParamsHandling: 'merge', replaceUrl: true });
    if (tab === 'credentials') void this.loadCredentials();
    if (tab === 'activity') void this.loadActivity();
  }

  async refresh(): Promise<void> {
    await Promise.all([this.loadIdentity(), this.loadCredentials(), this.auth.loadProfileAvatar(), this.auth.loadBrowserSessions(), this.auth.loadSessionEvents(), this.loadSessionPreference(), this.loadAuthPolicy(), this.loadActivity()]);
  }

  private async loadSessionPreference(): Promise<void> {
    try {
      const preference = await this.auth.loadSessionPreference();
      this.sessionDurationDraft = preference.duration;
    } catch (error) {
      this.message.set({ type: 'warning', text: `로그인 유지 설정을 불러오지 못했습니다: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  async saveSessionPreference(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      const preference = await this.auth.updateSessionPreference(this.sessionDurationDraft);
      this.sessionDurationDraft = preference.duration;
      this.message.set({ type: 'success', text: `로그인 유지 기본값을 ${this.persistenceLabel(preference.duration)}(으)로 저장했습니다. 다음 로그인부터 적용됩니다.` });
    } catch (error) {
      this.message.set({ type: 'danger', text: `로그인 유지 설정 저장 실패: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      this.busy.set(false);
    }
  }

  sessionPreferenceHelp(value: SessionDuration): string {
    switch (value) {
      case 'browser': return '공용 장치에 적합하며, 세션 쿠키를 영구 저장하지 않습니다.';
      case '1h': return '일회성 점검이나 짧은 지원 작업에 적합합니다.';
      case '4h': return '반일 이내의 관리 작업이나 공용 운영 장치에 적합합니다.';
      case '8h': return '한 번의 운영 교대에 적합합니다.';
      case '12h': return '긴 운영 교대나 하루 중 연속 작업에 적합합니다.';
      case '3d': return '주말을 넘기지 않는 개인 장치 작업에 적합합니다.';
      case '7d':
      case '14d':
      case '30d': return '신뢰하는 개인 장치에서만 사용하고, 분실 시 자격 증명 탭에서 세션을 종료하세요.';
      default: return '일반적인 개인 운영 장치에 권장하는 기본값입니다.';
    }
  }

  private async loadIdentity(): Promise<void> {
    try {
      const response = await this.http.request('/api/identity');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { users?: IdUser[] };
      const current = (body.users ?? []).find((user) => user.username === this.auth.user());
      this.identityUser.set(current ?? null);
    } catch (error) {
      this.message.set({ type: 'warning', text: `프로필 원본을 불러오지 못했습니다: ${String(error)}` });
    }
  }

  async loadCredentials(): Promise<void> {
    this.credentialsLoading.set(true);
    this.credentialError.set('');
    try {
      const deviceResponse = await this.http.request('/api/identity/cli/devices');
      if (!deviceResponse.ok) throw new Error(`장치 HTTP ${deviceResponse.status}`);
      const deviceBody = (await deviceResponse.json()) as { devices?: CliDevice[] };
      this.devices.set(deviceBody.devices ?? []);
      await this.auth.loadBrowserSessions();
    } catch (error) {
      this.devices.set([]);
      this.credentialError.set(`자격 증명 상태를 불러오지 못했습니다: ${String(error)}`);
    } finally {
      this.credentialsLoading.set(false);
    }
  }

  searchDevices(): void {
    this.deviceFilter.set(this.deviceSearchText.trim().toLocaleLowerCase());
  }

  clearDeviceSearch(): void {
    this.deviceSearchText = '';
    this.deviceFilter.set('');
  }

  private async loadAuthPolicy(): Promise<void> {
    try {
      // MFA policy belongs to Supabase Auth. The profile surface does not
      // expose a parallel identity-provider toggle.
      this.authPolicy.set(null);
    } catch {
      this.authPolicy.set(null);
    }
  }

  sessionEventLabel(value: string): string {
    return ({
      login: '로그인',
      refresh: '세션 갱신',
      lock: '유휴 잠금',
      unlock: '잠금 해제',
      step_up: '다중 인증 재확인',
      logout: '로그아웃',
      revoke: '세션 종료',
      revoke_all: '모든 세션 종료',
      reuse_detected: '갱신 자격 재사용 탐지',
      refresh_rejected: '세션 갱신 거부',
      expired_idle: '유휴 시간 만료',
      expired_absolute: '최대 유지 시간 만료',
      authority_unavailable: '인증 권위 일시 중단',
    } as Record<string, string>)[value] || value;
  }

  persistenceLabel(value: string): string {
    switch (value) {
      case 'browser': return '브라우저 종료 시';
      case '1h': return '1시간';
      case '4h': return '4시간';
      case '8h': return '8시간';
      case '12h': return '12시간';
      case '24h': return '24시간';
      case '3d': return '3일';
      case '7d': return '7일';
      case '14d': return '14일';
      case '30d': return '30일';
      default: return '24시간';
    }
  }

  avatarSourceLabel(): string {
    const current = this.auth.profileAvatar().current;
    if (current.source === 'upload') return '직접 올린 사진';
    if (current.source === 'linked') return `${this.avatarProviderLabel(current.provider || '')} 연결 계정`;
    return '기본 이니셜';
  }

  avatarProviderLabel(provider: string): string {
    const known: Record<string, string> = { github: 'GitHub', google: 'Google', azure: 'Microsoft', keycloak: 'Keycloak' };
    return known[provider] || provider;
  }

  linkedAvatarSelected(account: LinkedAvatarAccount): boolean {
    const current = this.auth.profileAvatar().current;
    return current.source === 'linked' && current.provider === account.provider && current.url === account.url;
  }

  async selectLinkedAvatar(account: LinkedAvatarAccount): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      await this.auth.selectLinkedAvatar(account);
      this.message.set({ type: 'success', text: `${this.avatarProviderLabel(account.provider)} 연결 계정 사진을 적용했습니다.` });
    } catch (error) {
      this.message.set({ type: 'danger', text: `연결 계정 사진 적용 실패: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      this.busy.set(false);
    }
  }

  async useInitialAvatar(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      await this.auth.useInitialAvatar();
      this.message.set({ type: 'success', text: '프로필 사진을 기본 이니셜로 변경했습니다.' });
    } catch (error) {
      this.message.set({ type: 'danger', text: `프로필 사진 초기화 실패: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      this.busy.set(false);
    }
  }

  async changeAvatar(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || this.busy()) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) {
      this.message.set({ type: 'danger', text: 'PNG, JPEG, WebP 사진만 선택할 수 있으며 원본은 8MB 이하여야 합니다.' });
      return;
    }
    this.busy.set(true);
    try {
      const dataBase64 = await this.squareAvatarBase64(file);
      await this.auth.uploadProfileAvatar('image/webp', dataBase64);
      this.message.set({ type: 'success', text: '새 프로필 사진을 저장했습니다.' });
    } catch (error) {
      this.message.set({ type: 'danger', text: `프로필 사진 저장 실패: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      this.busy.set(false);
    }
  }

  private async squareAvatarBase64(file: File): Promise<string> {
    const image = await createImageBitmap(file);
    try {
      if (!image.width || !image.height || image.width > 12000 || image.height > 12000) throw new Error('사진 크기가 올바르지 않습니다.');
      const size = 256;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('브라우저가 사진 편집을 지원하지 않습니다.');
      const crop = Math.min(image.width, image.height);
      context.drawImage(image, (image.width - crop) / 2, (image.height - crop) / 2, crop, crop, 0, 0, size, size);
      let blob: Blob | null = null;
      for (const quality of [.86, .72, .58]) {
        blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', quality));
        if (blob && blob.size <= 160 * 1024) break;
      }
      if (!blob || blob.type !== 'image/webp' || blob.size > 160 * 1024) throw new Error('사진을 안전한 크기로 변환하지 못했습니다.');
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('사진을 읽지 못했습니다.'));
        reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
        reader.readAsDataURL(blob);
      });
    } finally {
      image.close();
    }
  }

  async revokeSession(id: string): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      await this.auth.revokeBrowserSession(id);
      this.message.set({ type: 'success', text: '선택한 브라우저 세션을 종료했습니다.' });
    } catch (error) {
      this.message.set({ type: 'danger', text: `세션 종료 실패: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      this.busy.set(false);
    }
  }

  async revokeAllSessions(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      await this.auth.revokeAllBrowserSessions();
    } catch (error) {
      this.message.set({ type: 'danger', text: `전체 세션 종료 실패: ${error instanceof Error ? error.message : String(error)}` });
      this.busy.set(false);
    }
  }

  async beginTotpEnrollment(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.message.set(null);
    this.totpQrError.set(false);
    try {
      this.totpEnrollment.set(await this.auth.beginTotpEnrollment('OpenSphere Console administrator'));
      this.totpCode = '';
    } catch (error) {
      this.message.set({ type: 'danger', text: `TOTP 등록 시작 실패: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      this.busy.set(false);
    }
  }

  async verifyTotp(): Promise<void> {
    const enrollment = this.totpEnrollment();
    if (!enrollment || this.busy()) return;
    this.busy.set(true);
    this.message.set(null);
    try {
      await this.auth.verifyTotpEnrollment(enrollment.factorId, this.totpCode);
      this.totpEnrollment.set(null);
      this.totpCode = '';
      await this.router.navigate([], { relativeTo: this.route, queryParams: { tab: 'security', enroll: null }, queryParamsHandling: 'merge', replaceUrl: true });
      this.message.set({ type: 'success', text: 'TOTP 등록과 추가 인증을 완료했습니다. 관리자 변경 작업에 AAL2가 적용됩니다.' });
    } catch (error) {
      this.message.set({ type: 'danger', text: `TOTP 검증 실패: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      this.busy.set(false);
    }
  }

  cancelTotpEnrollment(): void {
    this.totpEnrollment.set(null);
    this.totpCode = '';
  }

  async loadActivity(): Promise<void> {
    this.activityLoading.set(true);
    try {
      const response = await this.http.request('/api/admin/plugins/events');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { items?: AuditEvent[] };
      const username = this.auth.user();
      this.activities.set((body.items ?? []).filter((event) => event.actor === username || String(event.target || '').includes(username)).slice(0, 50));
    } catch {
      this.activities.set([]);
    } finally {
      this.activityLoading.set(false);
    }
  }

  openEdit(): void {
    const user = this.identityUser();
    if (!user) return;
    this.edit = { displayName: user.displayName || this.auth.name(), email: user.email || this.auth.email(), reason: '' };
    this.editOpen.set(true);
  }

  async saveProfile(): Promise<void> {
    const user = this.identityUser();
    if (!user || this.busy()) return;
    this.busy.set(true);
    try {
      const response = await this.http.request(`/api/identity/users/${encodeURIComponent(user.id)}/attrs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: this.edit.displayName.trim(), email: this.edit.email.trim(), reason: this.edit.reason.trim() }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      await this.loadIdentity();
      this.editOpen.set(false);
      this.message.set({ type: 'success', text: '프로필을 갱신하고 영구 감사에 기록했습니다.' });
    } catch (error) {
      this.message.set({ type: 'danger', text: `프로필 저장 실패: ${String(error)}` });
    } finally {
      this.busy.set(false);
    }
  }

  private async loadEnrollment(enrollmentId: string, code: string): Promise<void> {
    try {
      const response = await this.http.request(`/api/identity/cli/enrollments/${encodeURIComponent(enrollmentId)}?code=${encodeURIComponent(code)}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.enrollment.set((await response.json()) as Enrollment);
    } catch (error) {
      this.message.set({ type: 'danger', text: `CLI 장치 승인 요청이 만료되었거나 유효하지 않습니다: ${String(error)}` });
      this.clearEnrollment();
    }
  }

  async approveEnrollment(): Promise<void> {
    const request = this.enrollment();
    const code = this.route.snapshot.queryParamMap.get('code');
    if (!request || !code || this.busy()) return;
    this.busy.set(true);
    try {
      const response = await this.http.request(`/api/identity/cli/enrollments/${encodeURIComponent(request.enrollmentId)}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userCode: code }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.enrollment.set(null);
      await this.loadCredentials();
      await this.router.navigate([], { relativeTo: this.route, queryParams: { tab: 'credentials' }, replaceUrl: true });
      this.message.set({ type: 'success', text: 'CLI 장치를 승인했습니다. 터미널이 짧은 세션을 발급받아 로그인을 완료합니다.' });
    } catch (error) {
      this.message.set({ type: 'danger', text: `장치 승인 실패: ${String(error)}` });
    } finally {
      this.busy.set(false);
    }
  }

  clearEnrollment(): void {
    this.enrollment.set(null);
    void this.router.navigate([], { relativeTo: this.route, queryParams: { tab: 'credentials' }, replaceUrl: true });
  }

  openCredentialRevoke(id: string, label: string): void {
    this.pendingRevoke.set({ id, label });
    this.revokeReason = '';
    this.credentialRevokeOpen.set(true);
  }

  closeCredentialRevoke(): void {
    this.credentialRevokeOpen.set(false);
    this.pendingRevoke.set(null);
    this.revokeReason = '';
  }

  async confirmCredentialRevoke(): Promise<void> {
    const credential = this.pendingRevoke();
    if (!credential || this.revokeReason.trim().length < 8) return;
    this.busy.set(true);
    try {
      const response = await this.http.request(`/api/identity/cli/devices/${encodeURIComponent(credential.id)}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: this.revokeReason.trim() }),
      });
      if (!response.ok && response.status !== 404) throw new Error(`HTTP ${response.status}`);
      await this.loadCredentials();
      this.message.set({ type: 'success', text: 'CLI 장치 신뢰를 해제했습니다.' });
      this.closeCredentialRevoke();
    } catch (error) {
      this.message.set({ type: 'danger', text: `자격 증명 폐기 실패: ${String(error)}` });
    } finally {
      this.busy.set(false);
    }
  }

  openPasswordPanel(): void {
    this.passwordChanged.set(false);
    this.passwordError.set('');
    this.passwordPanelOpen.set(true);
  }

  closePasswordPanel(): void {
    this.passwordPanelOpen.set(false);
    this.passwordChanged.set(false);
    this.passwordError.set('');
  }

  async changePassword(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.passwordError.set('');
    // 서버는 현재 Supabase 세션의 subject만 대상으로 회복 링크를 발급한다.
    try {
      const response = await this.http.request('/api/identity/me/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'self-service password change' }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string; ok?: boolean; resetUrl?: string };
      if (!response.ok || !body.ok) {
        this.passwordError.set(this.passwordErrorText(body.error, response.status));
        return;
      }
      this.passwordChanged.set(true);
      this.message.set({ type: 'success', text: 'Supabase 비밀번호 설정 링크를 발급했습니다. 링크로 이동합니다.' });
      if (body.resetUrl) window.location.assign(body.resetUrl);
    } catch {
      this.passwordError.set('비밀번호 변경 요청을 보내지 못했습니다. 네트워크를 확인하고 다시 시도하세요.');
    } finally {
      this.busy.set(false);
    }
  }

  private passwordErrorText(code: string | undefined, status: number): string {
    switch (code) {
      case 'current_password_required': return '현재 비밀번호를 입력하세요.';
      case 'new_password_required': return '새 비밀번호를 입력하세요.';
      case 'new_password_too_short': return '새 비밀번호는 8자 이상이어야 합니다.';
      case 'password_confirmation_mismatch': return '새 비밀번호와 확인 값이 일치하지 않습니다.';
      case 'password_unchanged': return '현재 비밀번호와 다른 새 비밀번호를 사용하세요.';
      case 'reauth_failed': return '현재 비밀번호 재인증에 실패했습니다. 값을 다시 확인하세요.';
      case 'mfa_required': return '이 계정 정책은 MFA를 요구합니다. 인증 앱 코드를 확인하세요.';
      case 'password_policy_rejected': return '새 비밀번호가 정책에 의해 거부되었습니다. 더 강력한 비밀번호를 사용하세요.';
      case 'credential_update_unavailable':
      case 'credential_commit_failed': return '비밀번호 변경 서비스를 일시적으로 사용할 수 없습니다. 잠시 후 다시 시도하세요.';
      case 'credential_store_unavailable': return '감사 저장소를 사용할 수 없어 변경이 차단되었습니다. 잠시 후 다시 시도하세요.';
      case 'unauthorized': return '세션이 만료되었습니다. 다시 로그인한 뒤 시도하세요.';
      case 'invalid_json': return '요청 형식이 올바르지 않습니다.';
      default: return status === 503 ? '서비스를 일시적으로 사용할 수 없습니다. 잠시 후 다시 시도하세요.' : '비밀번호를 변경하지 못했습니다.';
    }
  }

  /**
   * 서버가 비밀번호 commit 전에 Supabase Auth session epoch를 회전해 기존 id_token을 즉시
   * 무효화한다. 클라이언트도 로컬 OIDC 상태를 지워 새 자격으로 재로그인하게 한다
   * (서버 응답 reloginRequired=true와 일치). 확인 문구를 잠깐 보여준 뒤 자동 로그아웃한다.
   */
  private scheduleForcedLogout(): void {
    window.setTimeout(() => { void this.auth.logout(); }, 3000);
  }

  async logoutNow(): Promise<void> {
    await this.auth.logout();
  }

  async copy(value: string): Promise<void> {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      this.message.set({ type: 'info', text: '클립보드에 복사했습니다.' });
    } catch {
      this.message.set({ type: 'danger', text: '클립보드 복사에 실패했습니다.' });
    }
  }

  groupDescription(group: string): string {
    if (group === 'opensphere-console-admins') return 'Console 전역 관리자';
    if (group === 'opensphere-console-operators') return '운영 작업 수행';
    if (group === 'opensphere-console-viewers') return '읽기 전용 접근';
    return 'Supabase Console 역할 기반 접근';
  }

  fmt(iso: string | null): string {
    if (!iso) return '—';
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
  }

  private validTab(tab: string): tab is ProfileTab {
    return ['details', 'access', 'requests', 'resources', 'credentials', 'security', 'activity'].includes(tab);
  }
}
