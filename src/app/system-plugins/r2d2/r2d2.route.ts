import type { Route } from '@angular/router';
import { SystemPluginUnavailable } from '../system-plugin-unavailable';
import { R2D2_SYSTEM_PLUGIN } from './r2d2.descriptor';

const ADMIN_PREFIX = '/manage/';

function adminChildPath(route: `/${string}`): string {
  if (!route.startsWith(ADMIN_PREFIX) || route.slice(ADMIN_PREFIX.length).includes('/')) {
    throw new Error('R2D2 system plugin route must be one direct /manage child');
  }
  return route.slice(ADMIN_PREFIX.length);
}

/** Lazy loading keeps an R2D2 UI failure inside its Console-owned surface. */
export const R2D2_ADMIN_ROUTE: Route = {
  path: adminChildPath(R2D2_SYSTEM_PLUGIN.route),
  loadComponent: () => import('../../pages/admin-osaa')
    .then((module) => module.AdminOsaa)
    .catch((error: unknown) => {
      console.error('R2D2 system plugin surface failed to load', error);
      return SystemPluginUnavailable;
    }),
  data: {
    systemPluginId: R2D2_SYSTEM_PLUGIN.id,
    systemPluginName: R2D2_SYSTEM_PLUGIN.displayName,
  },
};
