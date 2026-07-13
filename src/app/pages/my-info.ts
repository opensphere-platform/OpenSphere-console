import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ClarityModule } from '@clr/angular';
import { AuthService } from '../core/auth.service';
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
  createdAt: string;
  lastUsedAt: string | null;
  lastSessionExpiresAt: string | null;
  user: string;
}

interface ApiToken {
  jti: string;
  label: string;
  scope: string;
  status: 'active' | 'expired';
  createdAt: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  user: string;
}

interface MintedToken {
  token: string;
  jti: string;
  label: string;
  expiresAt: string;
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
 * 장치 키와 API 토큰은 같은 화면에 보이지만 용도가 다르다.
 * - 장치 키: 대화형 os 로그인, OS 보안 저장소의 private key + 15분 세션
 * - API 토큰: 비대화형 자동화 전용, 30일 만료 + 중앙 폐기
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
                  <div><dt>인증 방식</dt><dd>Kanidm · OIDC PKCE</dd></div>
                </dl>

                <h2>기능</h2>
                <dl class="kv-list compact">
                  <div><dt>콘솔 로그인</dt><dd>사용 가능</dd></div>
                  <div><dt>CLI 장치 키</dt><dd>{{ devices().length ? '사용 가능' : '등록 필요' }}</dd></div>
                  <div><dt>자동화 API 토큰</dt><dd>사용 가능</dd></div>
                  <div><dt>역할 기반 접근</dt><dd>{{ auth.groups().length ? '적용됨' : '없음' }}</dd></div>
                </dl>
              </section>

              <section>
                <h2>사용자 기본 설정</h2>
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
              <p class="section-lead">현재 Kanidm 신원 권위에서 평가된 접근 권한입니다. 권한 변경은 콘솔 역할 관리자의 승인을 거칩니다.</p>
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
                  <p class="section-lead">대화형 CLI 장치와 비대화형 자동화 토큰을 한곳에서 확인합니다. 비밀 원문은 서버에서 다시 조회할 수 없습니다.</p>
                </div>
                <div class="credential-summary" aria-label="자격 증명 요약">
                  <span class="label label-info">장치 {{ devices().length }}</span>
                  <span class="label label-success">활성 토큰 {{ activeTokenCount() }}</span>
                  @if (expiredTokenCount()) { <span class="label label-warning">만료 {{ expiredTokenCount() }}</span> }
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
                    <p class="section-lead"><code>os login</code>으로 등록한 대화형 장치입니다. 개인 키는 이 서버가 아닌 운영체제 보안 저장소에만 보관됩니다.</p>
                  </div>
                  <button class="btn btn-sm btn-outline" (click)="loadCredentials()" [disabled]="credentialsLoading()">새로고침</button>
                </div>
                <form class="credential-toolbar" (ngSubmit)="searchDevices()">
                  <clr-input-container class="credential-search">
                    <label>장치 검색</label>
                    <input clrInput [(ngModel)]="deviceSearchText" name="device-search" placeholder="장치 이름, ID 또는 지문" />
                  </clr-input-container>
                  <button class="btn btn-sm btn-outline" type="submit">검색</button>
                  <button class="btn btn-sm btn-link" type="button" (click)="clearDeviceSearch()" [disabled]="!deviceFilter() && !deviceSearchText">초기화</button>
                </form>
              <div class="credential-grid-scroll" tabindex="0" aria-label="CLI 신뢰 장치 표">
              <clr-datagrid [clrDgLoading]="credentialsLoading()">
                <clr-dg-column>장치</clr-dg-column><clr-dg-column>상태</clr-dg-column><clr-dg-column>지문</clr-dg-column><clr-dg-column>등록</clr-dg-column><clr-dg-column>마지막 사용</clr-dg-column><clr-dg-column>세션 만료</clr-dg-column><clr-dg-column>동작</clr-dg-column>
                @for (device of filteredDevices(); track device.id) {
                  <clr-dg-row>
                    <clr-dg-cell><strong>{{ device.label }}</strong><div class="os-mono">{{ device.id }}</div></clr-dg-cell>
                    <clr-dg-cell><span class="label label-success">신뢰됨</span></clr-dg-cell>
                    <clr-dg-cell class="os-mono">{{ device.fingerprint }}</clr-dg-cell>
                    <clr-dg-cell>{{ fmt(device.createdAt) }}</clr-dg-cell>
                    <clr-dg-cell>{{ fmt(device.lastUsedAt) }}</clr-dg-cell>
                    <clr-dg-cell>{{ fmt(device.lastSessionExpiresAt) }}</clr-dg-cell>
                    <clr-dg-cell><button class="btn btn-sm btn-danger-outline" (click)="openCredentialRevoke('device', device.id, device.label)" [disabled]="busy()">신뢰 해제</button></clr-dg-cell>
                  </clr-dg-row>
                }
                <clr-dg-placeholder>{{ deviceFilter() ? '검색 조건과 일치하는 장치가 없습니다' : '등록된 CLI 장치가 없습니다. 터미널에서 os login을 실행하세요.' }}</clr-dg-placeholder>
                <clr-dg-footer>{{ filteredDevices().length }}개 표시 · 전체 {{ devices().length }}개</clr-dg-footer>
              </clr-datagrid>
              </div>
              </article>

              <article class="credential-section" aria-labelledby="api-token-title">
                <div class="section-heading">
                  <div>
                    <h2 id="api-token-title">자동화 API 토큰</h2>
                    <p class="section-lead">CI·무인 자동화 전용 장기 자격입니다. 사람의 <code>os</code> 로그인에는 사용하지 않습니다.</p>
                  </div>
                  <button class="btn btn-sm btn-primary" (click)="openTokenPanel()">API 토큰 생성</button>
                </div>
                <form class="credential-toolbar" (ngSubmit)="searchTokens()">
                  <clr-input-container class="credential-search">
                    <label>토큰 검색</label>
                    <input clrInput [(ngModel)]="tokenSearchText" name="token-search" placeholder="설명, 토큰 ID 또는 범위" />
                  </clr-input-container>
                  <button class="btn btn-sm btn-outline" type="submit">검색</button>
                  <button class="btn btn-sm btn-link" type="button" (click)="clearTokenSearch()" [disabled]="!tokenFilter() && !tokenSearchText">초기화</button>
                </form>
              <div class="credential-grid-scroll" tabindex="0" aria-label="자동화 API 토큰 표">
              <clr-datagrid [clrDgLoading]="credentialsLoading()">
                <clr-dg-column>설명</clr-dg-column><clr-dg-column>상태</clr-dg-column><clr-dg-column>범위</clr-dg-column><clr-dg-column>토큰 ID</clr-dg-column><clr-dg-column>생성</clr-dg-column><clr-dg-column>만료</clr-dg-column><clr-dg-column>마지막 사용</clr-dg-column><clr-dg-column>동작</clr-dg-column>
                @for (token of filteredApiTokens(); track token.jti) {
                  <clr-dg-row>
                    <clr-dg-cell><strong>{{ token.label || '(설명 없음)' }}</strong></clr-dg-cell>
                    <clr-dg-cell>
                      @if (token.status === 'active') { <span class="label label-success">활성</span> }
                      @else { <span class="label label-warning">만료</span> }
                    </clr-dg-cell>
                    <clr-dg-cell><code>{{ token.scope || 'admin:automation' }}</code></clr-dg-cell>
                    <clr-dg-cell class="os-mono">{{ token.jti }}</clr-dg-cell>
                    <clr-dg-cell>{{ fmt(token.createdAt) }}</clr-dg-cell>
                    <clr-dg-cell>{{ fmt(token.expiresAt) }}</clr-dg-cell>
                    <clr-dg-cell>{{ fmt(token.lastUsedAt) }}</clr-dg-cell>
                    <clr-dg-cell><button class="btn btn-sm btn-danger-outline" (click)="openCredentialRevoke('token', token.jti, token.label || token.jti)" [disabled]="busy() || token.status !== 'active'">폐기</button></clr-dg-cell>
                  </clr-dg-row>
                }
                <clr-dg-placeholder>{{ tokenFilter() ? '검색 조건과 일치하는 토큰이 없습니다' : '발급된 자동화 API 토큰이 없습니다' }}</clr-dg-placeholder>
                <clr-dg-footer>{{ filteredApiTokens().length }}개 표시 · 전체 {{ apiTokens().length }}개 · 기본 만료 30일</clr-dg-footer>
              </clr-datagrid>
              </div>
              </article>

              <article class="credential-section" aria-labelledby="session-credential-title">
                <div class="section-heading">
                  <div>
                    <h2 id="session-credential-title">현재 Console 세션</h2>
                    <p class="section-lead">브라우저 로그인 자격은 내보내거나 다운로드할 수 없습니다. Console이 현재 탭에서만 안전하게 사용합니다.</p>
                  </div>
                </div>
                <div class="credential-grid-scroll" tabindex="0" aria-label="현재 Console 세션 표">
                <clr-datagrid>
                  <clr-dg-column>자격</clr-dg-column><clr-dg-column>상태</clr-dg-column><clr-dg-column>인증 방식</clr-dg-column><clr-dg-column>만료</clr-dg-column><clr-dg-column>보관</clr-dg-column><clr-dg-column>내보내기</clr-dg-column>
                  <clr-dg-row>
                    <clr-dg-cell><strong>OpenSphere Console 세션</strong><div class="os-mono">{{ auth.subject() || auth.user() }}</div></clr-dg-cell>
                    <clr-dg-cell><span class="label" [class.label-success]="!auth.isTokenExpired()">{{ auth.isTokenExpired() ? '만료' : '활성' }}</span></clr-dg-cell>
                    <clr-dg-cell>Kanidm · OIDC PKCE</clr-dg-cell>
                    <clr-dg-cell>{{ expText() }}</clr-dg-cell>
                    <clr-dg-cell>sessionStorage · 현재 탭</clr-dg-cell>
                    <clr-dg-cell><span class="label">내보내기 금지</span></clr-dg-cell>
                  </clr-dg-row>
                  <clr-dg-footer>1개 브라우저 세션</clr-dg-footer>
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
                <div><dt>인증 공급자</dt><dd>Kanidm · opensphere-console</dd></div>
                <div><dt>세션 만료</dt><dd>{{ expText() }}</dd></div>
                <div><dt>TOTP 정책</dt><dd>{{ authPolicy()?.totpEnabled ? '활성' : '개발 중 비활성' }} <span class="label">{{ authPolicy()?.environment || 'unknown' }}</span></dd></div>
                <div><dt>브라우저 토큰 보관</dt><dd>sessionStorage · 브라우저 종료 시 삭제</dd></div>
              </dl>
              <h2>복구와 보호</h2>
              <p class="section-lead">비밀번호·passkey·TOTP 변경은 관리자 대리설정이 아닌 새 온보딩/자격 갱신 흐름으로 수행합니다.</p>
              <a class="btn btn-sm btn-outline" routerLink="/manage/console-admins">콘솔 관리자 보안 정책</a>
            </section>
          </clr-tab-content>
        </clr-tab>

        <clr-tab>
          <button clrTabLink (click)="selectTab('activity')">활동</button>
          <clr-tab-content *clrIfActive="tab() === 'activity'">
            <section class="tab-section">
              <h2>내 최근 관리 활동</h2>
              <p class="section-lead">Backbone 영구 감사에서 현재 사용자와 관련된 항목만 표시합니다.</p>
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

    <os-panel [open]="editOpen()" title="내 프로필 편집" subtitle="Kanidm IGA · 감사 사유 필수" (closed)="editOpen.set(false)">
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

    <os-panel [open]="tokenPanelOpen()" title="자동화 API 토큰 생성" subtitle="비대화형 작업 전용 · 30일" (closed)="closeTokenPanel()">
      @if (!mintedToken()) {
        <clr-alert [clrAlertType]="'warning'" [clrAlertClosable]="false">
          <clr-alert-item><span class="alert-text">이 토큰은 CI와 무인 자동화 전용입니다. 사람의 CLI 로그인에는 <code>os login</code> 장치 등록을 사용하세요.</span></clr-alert-item>
        </clr-alert>
        <form clrForm clrLayout="vertical">
          <clr-input-container><label>설명</label><input clrInput [(ngModel)]="tokenLabel" name="token-label" maxlength="64" placeholder="예: nightly-backup" /></clr-input-container>
          <clr-textarea-container><label>발급 사유</label><textarea clrTextarea [(ngModel)]="tokenReason" name="token-reason" maxlength="240" required></textarea><clr-control-helper>영구 감사에 기록됩니다(8자 이상).</clr-control-helper></clr-textarea-container>
        </form>
        <div class="panel-actions"><button class="btn btn-primary" (click)="mintToken()" [disabled]="busy() || !tokenLabel.trim() || tokenReason.trim().length < 8">생성</button><button class="btn btn-outline" (click)="closeTokenPanel()">취소</button></div>
      } @else {
        <clr-alert [clrAlertType]="'success'" [clrAlertClosable]="false">
          <clr-alert-item><span class="alert-text"><strong>토큰이 생성되었습니다.</strong> 이 값은 지금 한 번만 표시됩니다. 닫기 전에 운영체제 보안 저장소나 CI 비밀 저장소에 보관하세요.</span></clr-alert-item>
        </clr-alert>
        <dl class="token-metadata">
          <div><dt>설명</dt><dd>{{ mintedToken()?.label }}</dd></div>
          <div><dt>토큰 ID</dt><dd class="os-mono">{{ mintedToken()?.jti }}</dd></div>
          <div><dt>만료</dt><dd>{{ fmt(mintedToken()?.expiresAt || null) }}</dd></div>
        </dl>
        <textarea class="token-output" readonly [value]="mintedToken()?.token"></textarea>
        <div class="panel-actions"><button class="btn btn-primary" (click)="copy(mintedToken()?.token || '')">복사</button><button class="btn btn-outline" (click)="closeTokenPanel()">닫기</button></div>
      }
    </os-panel>

    <os-panel [open]="credentialRevokeOpen()" title="자격 증명 폐기" subtitle="즉시 효력 상실 · 영구 감사" (closed)="closeCredentialRevoke()">
      @if (pendingRevoke(); as credential) {
        <p><strong>{{ credential.label }}</strong> 자격 증명을 폐기합니다. 폐기 후 해당 장치 또는 토큰의 다음 요청부터 거부됩니다.</p>
        <form clrForm clrLayout="vertical">
          <clr-textarea-container><label>폐기 사유</label><textarea clrTextarea [(ngModel)]="revokeReason" name="revoke-reason" maxlength="240" required></textarea><clr-control-helper>영구 감사에 기록됩니다(8자 이상).</clr-control-helper></clr-textarea-container>
        </form>
        <div class="panel-actions"><button class="btn btn-danger" (click)="confirmCredentialRevoke()" [disabled]="busy() || revokeReason.trim().length < 8">폐기</button><button class="btn btn-outline" (click)="closeCredentialRevoke()" [disabled]="busy()">취소</button></div>
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
      .security-list { max-width: 58rem; }
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
      .credential-grid-scroll { max-width: 100%; overflow-x: auto; overscroll-behavior-inline: contain; }
      .credential-grid-scroll clr-datagrid { min-width: 58rem; }
      .credential-grid-scroll:focus-visible { outline: 2px solid var(--os-accent); outline-offset: 2px; }
      .credential-empty { display: flex; min-height: 6rem; flex-direction: column; align-items: center; justify-content: center; gap: .25rem; padding: 1rem; border: 1px solid var(--os-hairline); background: var(--os-surface-1); color: var(--os-muted); text-align: center; }
      .credential-empty strong { color: var(--os-ink); font-size: .76rem; }
      .credential-empty span { max-width: 46rem; font-size: .68rem; }
      .alert-actions { margin-top: .35rem; }
      .os-mono { font-family: var(--os-font-mono, monospace); font-size: 0.65rem; word-break: break-all; }
      .panel-actions { display: flex; gap: 0.45rem; margin-top: 0.8rem; }
      .token-metadata { display: grid; gap: .3rem; margin: .8rem 0; }
      .token-metadata div { display: grid; grid-template-columns: 5rem minmax(0, 1fr); gap: .5rem; padding-bottom: .3rem; border-bottom: 1px solid var(--os-hairline); }
      .token-metadata dt { color: var(--os-muted); font-size: .65rem; font-weight: 600; }
      .token-metadata dd { margin: 0; font-size: .68rem; }
      .token-output { width: 100%; min-height: 8rem; font-family: var(--os-font-mono, monospace); font-size: 0.65rem; overflow-wrap: anywhere; }
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
        .profile-title-row h1 { overflow-wrap: anywhere; }
        .profile-actions { flex-wrap: wrap; }
        .tab-section { padding: .8rem .8rem 1.5rem; }
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
  readonly apiTokens = signal<ApiToken[]>([]);
  readonly enrollment = signal<Enrollment | null>(null);
  readonly authPolicy = signal<AuthPolicy | null>(null);
  readonly activities = signal<AuditEvent[]>([]);
  readonly credentialsLoading = signal(false);
  readonly credentialError = signal('');
  readonly deviceFilter = signal('');
  readonly tokenFilter = signal('');
  readonly activityLoading = signal(false);
  readonly busy = signal(false);
  readonly editOpen = signal(false);
  readonly tokenPanelOpen = signal(false);
  readonly mintedToken = signal<MintedToken | null>(null);
  readonly credentialRevokeOpen = signal(false);
  readonly pendingRevoke = signal<{ kind: 'device' | 'token'; id: string; label: string } | null>(null);
  readonly message = signal<{ type: 'success' | 'danger' | 'info' | 'warning'; text: string } | null>(null);

  edit = { displayName: '', email: '', reason: '' };
  tokenLabel = '';
  tokenReason = '';
  revokeReason = '';
  deviceSearchText = '';
  tokenSearchText = '';
  readonly timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || '—';
  readonly language = navigator.language || '—';

  readonly expText = computed(() => {
    const exp = this.auth.tokenExp();
    if (!exp) return '—';
    const minutes = Math.round((exp * 1000 - Date.now()) / 60000);
    return `${new Date(exp * 1000).toLocaleString()} (${minutes > 0 ? `${minutes}분 후` : '만료됨'})`;
  });

  readonly activeTokenCount = computed(() => this.apiTokens().filter((token) => token.status === 'active').length);
  readonly expiredTokenCount = computed(() => this.apiTokens().filter((token) => token.status === 'expired').length);
  readonly filteredDevices = computed(() => {
    const query = this.deviceFilter();
    if (!query) return this.devices();
    return this.devices().filter((device) => [device.label, device.id, device.fingerprint]
      .some((value) => String(value || '').toLocaleLowerCase().includes(query)));
  });
  readonly filteredApiTokens = computed(() => {
    const query = this.tokenFilter();
    if (!query) return this.apiTokens();
    return this.apiTokens().filter((token) => [token.label, token.jti, token.scope, token.status]
      .some((value) => String(value || '').toLocaleLowerCase().includes(query)));
  });

  constructor() {
    this.route.queryParamMap.subscribe((params) => {
      const requested = params.get('tab') as ProfileTab | null;
      if (requested && this.validTab(requested)) this.tab.set(requested);
      const enrollmentId = params.get('enrollment');
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
    await Promise.all([this.loadIdentity(), this.loadCredentials(), this.loadAuthPolicy(), this.loadActivity()]);
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
      const [deviceResponse, tokenResponse] = await Promise.all([
        this.http.request('/bff/cli/devices'),
        this.http.request('/bff/pat'),
      ]);
      if (!deviceResponse.ok) throw new Error(`장치 HTTP ${deviceResponse.status}`);
      if (!tokenResponse.ok) throw new Error(`API 토큰 HTTP ${tokenResponse.status}`);
      const deviceBody = (await deviceResponse.json()) as { devices?: CliDevice[] };
      const tokenBody = (await tokenResponse.json()) as { pats?: ApiToken[] };
      this.devices.set(deviceBody.devices ?? []);
      this.apiTokens.set(tokenBody.pats ?? []);
    } catch (error) {
      this.devices.set([]);
      this.apiTokens.set([]);
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

  searchTokens(): void {
    this.tokenFilter.set(this.tokenSearchText.trim().toLocaleLowerCase());
  }

  clearTokenSearch(): void {
    this.tokenSearchText = '';
    this.tokenFilter.set('');
  }

  private async loadAuthPolicy(): Promise<void> {
    try {
      this.authPolicy.set(await this.http.json<AuthPolicy>('/bff/auth-policy'));
    } catch {
      this.authPolicy.set(null);
    }
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
      const response = await this.http.request(`/bff/cli/enrollments/${encodeURIComponent(enrollmentId)}?code=${encodeURIComponent(code)}`);
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
      const response = await this.http.request(`/bff/cli/enrollments/${encodeURIComponent(request.enrollmentId)}/approve`, {
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

  openTokenPanel(): void {
    this.tokenLabel = '';
    this.tokenReason = '';
    this.mintedToken.set(null);
    this.tokenPanelOpen.set(true);
  }

  closeTokenPanel(): void {
    this.tokenPanelOpen.set(false);
    this.mintedToken.set(null);
  }

  async mintToken(): Promise<void> {
    if (!this.tokenLabel.trim() || this.busy()) return;
    this.busy.set(true);
    try {
      const response = await this.http.request('/bff/pat', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ label: this.tokenLabel.trim(), reason: this.tokenReason.trim() }).toString(),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.mintedToken.set((await response.json()) as MintedToken);
      await this.loadCredentials();
    } catch (error) {
      this.message.set({ type: 'danger', text: `API 토큰 생성 실패: ${String(error)}` });
    } finally {
      this.busy.set(false);
    }
  }

  openCredentialRevoke(kind: 'device' | 'token', id: string, label: string): void {
    this.pendingRevoke.set({ kind, id, label });
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
    const path = credential.kind === 'device'
      ? `/bff/cli/devices/${encodeURIComponent(credential.id)}`
      : `/bff/pat/${encodeURIComponent(credential.id)}`;
    const success = credential.kind === 'device' ? 'CLI 장치 신뢰를 해제했습니다.' : '자동화 API 토큰을 폐기했습니다.';
    await this.deleteCredential(path, success, this.revokeReason.trim());
  }

  private async deleteCredential(path: string, success: string, reason: string): Promise<void> {
    this.busy.set(true);
    try {
      const response = await this.http.request(path, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason }) });
      if (!response.ok && response.status !== 404) throw new Error(`HTTP ${response.status}`);
      await this.loadCredentials();
      this.message.set({ type: 'success', text: success });
      this.closeCredentialRevoke();
    } catch (error) {
      this.message.set({ type: 'danger', text: `자격 증명 폐기 실패: ${String(error)}` });
    } finally {
      this.busy.set(false);
    }
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
    return 'Kanidm 그룹 기반 접근';
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
