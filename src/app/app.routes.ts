import { Routes, UrlMatchResult, UrlSegment } from '@angular/router';
import { RccOverviewPage } from './pages/rcc-overview';
import { PluginHost } from './pages/plugin-host';
import { MyInfo } from './pages/my-info';
import { AdminLayout } from './pages/admin-layout';
import { ManualPage } from './pages/manual';
import { authenticatedGuard } from './core/authenticated.guard';
import { KubernetesConsolePage } from './features/kubernetes/kubernetes-console-page';

function kubernetesConsoleMatcher(segments: UrlSegment[]): UrlMatchResult | null {
  if (
    segments.length < 3
    || segments[0].path !== 'cc'
    || !/^[a-z0-9-]+$/.test(segments[1].path)
    || segments[2].path !== 'kubernetes'
  ) return null;
  return { consumed: segments, posParams: { ccId: segments[1] } };
}

/**
 * `/cc/<ccId>/hosts` 안정 별칭 — 화면은 전부 등록된 `linux-host-manager` subShell이 그린다.
 * 여기서는 두 번째 네이티브 구현을 만들지 않고 PluginHost에 pluginId만 넘긴다. subShell이
 * Registry에 없거나 DUPA 검증에 실패하면 PluginHost가 '등록 안 됨'을 안내하므로,
 * 이 URL이 존재한다는 사실이 기능이 설치되었다는 뜻이 되지는 않는다(fail-closed).
 */
function linuxHostAliasMatcher(segments: UrlSegment[]): UrlMatchResult | null {
  if (
    segments.length < 3
    || segments[0].path !== 'cc'
    || !/^[a-z0-9-]+$/.test(segments[1].path)
    || segments[2].path !== 'hosts'
  ) return null;
  return { consumed: segments, posParams: { ccId: segments[1] } };
}

/**
 * 플러그인 호스트 매처 — `/p/<id>` 그리고 그 아래 임의 깊이의 서브패스(`/p/<id>/a/b/...`)까지 전부
 * PluginHost(id)로 위임한다. subShell은 자체 Angular Router가 없으므로(§plugin-host.ts) 내부 탭/뷰 상태를
 * 이 서브패스에 실경로 세그먼트로 직접 쓴다(cluster-manager/os-level/shell-template/ai 공통 표준 —
 * pushState + popstate, PluginHost는 `id`만 보고 마운트하므로 서브패스가 바뀌어도 재마운트되지 않는다).
 * `path: 'p/:id'`(세그먼트 정확히 2개)만으로는 서브패스가 있는 URL에 안 걸리므로 매처로 직접 구현.
 *
 * ⚠️ 예전에 있던 "clean deep link"(`/<id>/...`, `/p/` 접두사 없이 첫 세그먼트를 그대로 plugin id로 위임)는
 * 제거했다 — 콘솔 네이티브 라우트와 플러그인 id가 같은 네임스페이스를 다투는 충돌 위험이 있었고
 * (예: 콘솔이 나중에 `/apps`라는 네이티브 페이지를 만들면 plugin id `apps`와 충돌), `/p/` 접두사가 있는
 * 라우트가 이미 그 문제를 구조적으로 막아준다. 모든 plugin 링크는 `routeForPlugin()`(perspectives.ts)이
 * `/p/<id>` 형태로만 생성하므로 콘솔 내부에서 bare 딥링크에 의존하는 곳은 없었다.
 */
function pluginHostMatcher(segments: UrlSegment[]): UrlMatchResult | null {
  if (segments.length < 2 || segments[0].path !== 'p') return null;
  return { consumed: segments, posParams: { id: segments[1] } };
}

export const routes: Routes = [
  { path: '', component: RccOverviewPage, canActivate: [authenticatedGuard] },
  { path: 'me', component: MyInfo },
  {
    matcher: kubernetesConsoleMatcher,
    component: KubernetesConsolePage,
    canActivate: [authenticatedGuard],
  },
  {
    matcher: linuxHostAliasMatcher,
    component: PluginHost,
    canActivate: [authenticatedGuard],
    data: { pluginId: 'linux-host-manager' },
  },
  // Manual — Main Shell 네이티브 페이지(subShell/plugin/Consumer 아님). OAA Manual Registry
  // (/api/manual/*)를 ManualService로 직접 소비. 딥링크 `/manual?doc=<sourceId>`.
  { path: 'manual', component: ManualPage, canActivate: [authenticatedGuard] },
  // Containers 섹션은 DUPA subShell(shell-template)로 이전됨 → 네이티브 라우트 제거. /p/shell-template 로 진입.

  // "콘솔 관리" 섹션 (Model A): 1단 진입 → AdminLayout이 2단 보조메뉴 + 자식 페이지를 렌더.
  // §3.2 Core≠Plugin: 셸 네이티브 컴포넌트. 백엔드는 Console Backend(`/api/identity` 프록시).
  {
    path: 'manage',
    component: AdminLayout,
    canActivate: [authenticatedGuard],
    children: [
      {
        path: '',
        loadComponent: () => import('./pages/admin-overview').then((module) => module.AdminOverview),
      },
      {
        path: 'bbss',
        loadComponent: () => import('./pages/admin-bbss').then((module) => module.AdminBbss),
      },
      {
        path: 'bbss/supabase',
        loadComponent: () => import('./pages/admin-bbss-service').then((module) => module.AdminBbssService),
        data: { bbssService: 'supabase' },
      },
      {
        path: 'bbss/gitea',
        loadComponent: () => import('./pages/admin-bbss-service').then((module) => module.AdminBbssService),
        data: { bbssService: 'gitea' },
      },
      {
        path: 'bbss/beszel',
        loadComponent: () => import('./pages/admin-bbss-service').then((module) => module.AdminBbssService),
        data: { bbssService: 'beszel' },
      },
      {
        path: 'catalog',
        loadComponent: () => import('./pages/catalog').then((module) => module.Catalog),
      },
      {
        path: 'apis',
        loadComponent: () => import('./pages/apis').then((module) => module.Apis),
      },
      {
        path: 'cli',
        loadComponent: () => import('./pages/admin-cli').then((module) => module.AdminCli),
      },
      {
        path: 'console-admins',
        loadComponent: () => import('./pages/console-admins').then((module) => module.ConsoleAdmins),
      },
      {
        path: 'extensions',
        loadComponent: () => import('./pages/admin-plugins').then((module) => module.AdminPlugins),
      },
      {
        path: 'roles',
        loadComponent: () => import('./pages/admin-roles').then((module) => module.AdminRoles),
      },
      {
        path: 'platform-control',
        loadComponent: () => import('./pages/admin-platform-control').then((module) => module.AdminPlatformControl),
      },
      {
        path: 'data-identity',
        loadComponent: () => import('./pages/admin-data-identity').then((module) => module.AdminDataIdentity),
      },
      {
        path: 'change-control',
        loadComponent: () => import('./pages/admin-change-control').then((module) => module.AdminChangeControl),
      },
      // Platform readiness is now part of the integrated Control Plane view.
      // Preserve controller links and old bookmarks without reviving a parallel page.
      { path: 'platform-readiness', redirectTo: 'platform-control', pathMatch: 'full' },
      // Permanent compatibility path. Preserve old bookmarks without exposing
      // the former screen in current Console navigation.
      { path: 'backbone', redirectTo: 'data-identity', pathMatch: 'full' },
      // OAA Core is Main Shell native; its data/audit authority is Supabase and
      // every applied operation follows the Gitea declarative change chain.
      {
        path: 'oaa',
        loadComponent: () => import('./pages/admin-oaa').then((module) => module.AdminOaa),
      },
      {
        path: 'observability',
        loadComponent: () => import('./pages/admin-observability').then((module) => module.AdminObservability),
      },
      {
        path: 'notifications',
        loadComponent: () => import('./pages/admin-notifications').then((module) => module.AdminNotifications),
      },
      {
        path: 'external-channels',
        loadComponent: () => import('./pages/admin-external-channels').then((module) => module.AdminExternalChannels),
      },
      { path: 'notification-channels', redirectTo: 'external-channels', pathMatch: 'full' },
      {
        path: 'audit',
        loadComponent: () => import('./pages/admin-audit').then((module) => module.AdminAudit),
      },
      // An invalid management deep link must never leave the layout with an
      // empty router outlet.  Return to the live management overview while
      // preserving the authenticated /manage boundary.
      { path: '**', redirectTo: '', pathMatch: 'full' },
    ],
  },
  // 등록된 플러그인(subShell·plugin)은 전부 `/p/<id>[/서브패스]` 동적 호스트로 진입(§10). 실제 화면은
  // 런타임 로드 모듈. 미등록 id는 PluginHost가 '등록 안 됨' 안내.
  { matcher: pluginHostMatcher, component: PluginHost },
];
