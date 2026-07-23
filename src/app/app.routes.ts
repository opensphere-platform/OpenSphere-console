import { Routes, UrlMatchResult, UrlSegment } from '@angular/router';
import { Landing } from './pages/landing';
import { Catalog } from './pages/catalog';
import { Apis } from './pages/apis';
import { PluginHost } from './pages/plugin-host';
import { AdminPlugins } from './pages/admin-plugins';
import { AdminRoles } from './pages/admin-roles';
import { MyInfo } from './pages/my-info';
import { ConsoleAdmins } from './pages/console-admins';
import { AdminDataIdentity } from './pages/admin-data-identity';
import { AdminChangeControl } from './pages/admin-change-control';
import { AdminOaa } from './pages/admin-oaa';
import { AdminObservability } from './pages/admin-observability';
import { AdminPlatformControl } from './pages/admin-platform-control';
import { AdminNotifications } from './pages/admin-notifications';
import { AdminExternalChannels } from './pages/admin-external-channels';
import { AdminAudit } from './pages/admin-audit';
import { AdminCli } from './pages/admin-cli';
import { AdminLayout } from './pages/admin-layout';
import { ManualPage } from './pages/manual';
import { authenticatedGuard } from './core/authenticated.guard';

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
  { path: '', component: Landing },
  { path: 'me', component: MyInfo },
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
      { path: '', redirectTo: 'catalog', pathMatch: 'full' },
      { path: 'catalog', component: Catalog },
      { path: 'apis', component: Apis },
      { path: 'cli', component: AdminCli },
      { path: 'console-admins', component: ConsoleAdmins },
      { path: 'extensions', component: AdminPlugins },
      { path: 'roles', component: AdminRoles },
      { path: 'platform-control', component: AdminPlatformControl },
      { path: 'data-identity', component: AdminDataIdentity },
      { path: 'change-control', component: AdminChangeControl },
      // Platform readiness is now part of the integrated Control Plane view.
      // Preserve controller links and old bookmarks without reviving a parallel page.
      { path: 'platform-readiness', redirectTo: 'platform-control', pathMatch: 'full' },
      // Permanent compatibility path. Preserve old bookmarks without exposing
      // the former screen in current Console navigation.
      { path: 'backbone', redirectTo: 'data-identity', pathMatch: 'full' },
      // OAA Core is Main Shell native; its data/audit authority is Supabase and
      // every applied operation follows the Gitea declarative change chain.
      { path: 'oaa', component: AdminOaa },
      { path: 'observability', component: AdminObservability },
      { path: 'notifications', component: AdminNotifications },
      { path: 'external-channels', component: AdminExternalChannels },
      { path: 'notification-channels', redirectTo: 'external-channels', pathMatch: 'full' },
      { path: 'audit', component: AdminAudit },
    ],
  },
  // 등록된 플러그인(subShell·plugin)은 전부 `/p/<id>[/서브패스]` 동적 호스트로 진입(§10). 실제 화면은
  // 런타임 로드 모듈. 미등록 id는 PluginHost가 '등록 안 됨' 안내.
  { matcher: pluginHostMatcher, component: PluginHost },
];
