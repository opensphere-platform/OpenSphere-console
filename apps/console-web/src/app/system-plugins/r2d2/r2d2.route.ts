import type { Route } from '@angular/router';
import { SystemPluginUnavailable } from '../system-plugin-unavailable';
import { clearStaleLazyChunkRetry, recoverStaleLazyChunkOnce } from '../system-plugin-lazy-recovery';
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
    .then((module) => {
      clearStaleLazyChunkRetry(R2D2_SYSTEM_PLUGIN.id);
      return module.AdminOsaa;
    })
    .catch((error: unknown) => {
      if (recoverStaleLazyChunkOnce(R2D2_SYSTEM_PLUGIN.id, error)) {
        console.warn('R2D2 lazy chunk belonged to an older Console revision; reloading once');
        return SystemPluginUnavailable;
      }
      console.error('R2D2 system plugin surface failed to load', error);
      return SystemPluginUnavailable;
    }),
  data: {
    systemPluginId: R2D2_SYSTEM_PLUGIN.id,
    systemPluginName: R2D2_SYSTEM_PLUGIN.displayName,
  },
};
