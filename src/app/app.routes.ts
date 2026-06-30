import { Routes, UrlMatchResult, UrlSegment } from '@angular/router';
import { Landing } from './pages/landing';
import { Catalog } from './pages/catalog';
import { Apis } from './pages/apis';
import { PluginHost } from './pages/plugin-host';
import { AdminPlugins } from './pages/admin-plugins';
import { AdminRoles } from './pages/admin-roles';
import { MyInfo } from './pages/my-info';
import { ConsoleAdmins } from './pages/console-admins';
import { AdminBackbone } from './pages/admin-backbone';
import { AdminObservability } from './pages/admin-observability';
import { AdminLayout } from './pages/admin-layout';

// 감사 P2-3: 특정 plugin id('ai') 하드코딩 제거. 등록된 subShell/plugin의 clean deep link(/<id>/...)를
// 일반 위임 — 첫 세그먼트를 pluginId(:id)로 노출하고 PluginHost가 처리, 실제 등록 여부는 Extension Host
// (registry)가 판정(미등록이면 PluginHost가 '등록 안 됨' 안내). 예약 라우트 다음에 배치되므로
// me/catalog/apis/manage/p/:id 등은 먼저 매칭되고, 그 외 첫 세그먼트만 이 매처로 온다.
function cleanPluginRouteMatcher(segments: UrlSegment[]): UrlMatchResult | null {
  if (!segments.length) return null;
  return { consumed: segments, posParams: { id: new UrlSegment(segments[0].path, {}) } };
}

export const routes: Routes = [
  { path: '', component: Landing },
  { path: 'me', component: MyInfo },
  { path: 'catalog', component: Catalog },
  { path: 'apis', component: Apis },
  // Containers 섹션은 DUPA subShell(shell-template)로 이전됨 → 네이티브 라우트 제거. /p/shell-template 로 진입.

  // "콘솔 관리" 섹션 (Model A): 1단 진입 → AdminLayout이 2단 보조메뉴 + 자식 페이지를 렌더.
  // §3.2 Core≠Plugin: 셸 네이티브 컴포넌트. 백엔드는 console-identity-api(/api/identity 프록시).
  {
    path: 'manage',
    component: AdminLayout,
    children: [
      { path: '', redirectTo: 'console-admins', pathMatch: 'full' },
      { path: 'console-admins', component: ConsoleAdmins },
      { path: 'plugins', component: AdminPlugins },
      { path: 'roles', component: AdminRoles },
      { path: 'backbone', component: AdminBackbone },
      { path: 'observability', component: AdminObservability },
    ],
  },
  // 구 경로 하위호환 리다이렉트
  { path: 'console-admins', redirectTo: 'manage/console-admins' },
  { path: 'admin/plugins', redirectTo: 'manage/plugins' },
  { path: 'admin/roles', redirectTo: 'manage/roles' },

  // 등록된 플러그인(subShell·plugin)은 전부 `/p/<id>` 동적 호스트로 진입(§10). 실제 화면은 런타임 로드 모듈.
  { path: 'p/:id', component: PluginHost },
  // clean deep link(/<id>/...) 일반 위임 — 예약 라우트 다음에 위치(그 외 첫 세그먼트만 매칭). 미등록 id는
  // PluginHost가 '등록 안 됨' 안내. (특정 plugin 하드코딩 제거 — 감사 P2-3)
  { matcher: cleanPluginRouteMatcher, component: PluginHost },
];
