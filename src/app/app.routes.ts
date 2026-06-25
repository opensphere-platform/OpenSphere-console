import { Routes } from '@angular/router';
import { Landing } from './pages/landing';
import { Catalog } from './pages/catalog';
import { Apis } from './pages/apis';
import { PluginHost } from './pages/plugin-host';
import { AdminPlugins } from './pages/admin-plugins';
import { AdminRoles } from './pages/admin-roles';
import { ConsoleAdmins } from './pages/console-admins';
import { MyInfo } from './pages/my-info';
import { PERSPECTIVE_SLUGS } from './core/perspectives';

export const routes: Routes = [
  { path: '', component: Landing },
  { path: 'me', component: MyInfo },
  { path: 'catalog', component: Catalog },
  { path: 'apis', component: Apis },
  // Main Shell 관리 영역 — 콘솔 운영관리자(Kanidm). **CORE 내장**(이전 console-identity DUPA 플러그인 → native).
  // 콘솔 자기관리는 플러그인 시스템에 의존하면 안 됨(chicken-egg) → 셸에 내장. perspective 아님.
  { path: 'console-admins', component: ConsoleAdmins },
  // 10 perspective 클린 라우트(`/user` 등) — PluginHost가 data.pluginId로 슬러그=id를 수신
  ...PERSPECTIVE_SLUGS.map((slug) => ({
    path: slug,
    component: PluginHost,
    data: { pluginId: slug },
  })),
  // §10: 플러그인 페이지 — 정적 등록은 호스트 1개뿐, 실제 화면은 런타임 로드 모듈
  { path: 'p/:id', component: PluginHost },
  // Admin Control (검토 §B.3: 4번째 밴드 대신 헤더 진입 — 헌법 §6 3밴드 보존)
  { path: 'admin/plugins', component: AdminPlugins },
  // 역할 정의·부여 (Phase 3) — 콘솔 역할 그룹 멤버십 관리(admin)
  { path: 'admin/roles', component: AdminRoles },
  { path: '**', redirectTo: '' },
];
