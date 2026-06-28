import { Routes } from '@angular/router';
import { Landing } from './pages/landing';
import { Catalog } from './pages/catalog';
import { Apis } from './pages/apis';
import { PluginHost } from './pages/plugin-host';
import { AdminPlugins } from './pages/admin-plugins';
import { AdminRoles } from './pages/admin-roles';
import { MyInfo } from './pages/my-info';
import { ConsoleAdmins } from './pages/console-admins';
import { AdminLayout } from './pages/admin-layout';

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
    ],
  },
  // 구 경로 하위호환 리다이렉트
  { path: 'console-admins', redirectTo: 'manage/console-admins' },
  { path: 'admin/plugins', redirectTo: 'manage/plugins' },
  { path: 'admin/roles', redirectTo: 'manage/roles' },

  // 등록된 플러그인(subShell·plugin)은 전부 `/p/<id>` 동적 호스트로 진입(§10). 실제 화면은 런타임 로드 모듈.
  { path: 'p/:id', component: PluginHost },
  { path: '**', redirectTo: '' },
];
