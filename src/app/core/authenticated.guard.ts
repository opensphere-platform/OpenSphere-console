import { inject } from '@angular/core';
import type { CanActivateFn } from '@angular/router';
import { AuthService } from './auth.service';

/**
 * Native management surfaces must never render with an absent or expired
 * management-plane id_token. The bootstrap initializer establishes the first
 * session; this guard also protects deep links and long-lived tabs.
 */
export const authenticatedGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(AuthService);
  auth.rememberNavigationIntent(state.url);
  const authorized = await auth.waitForInitialAuthorization();
  if (authorized) {
    auth.clearNavigationIntent(state.url);
    return true;
  }
  if (!auth.initializing() && !auth.autoRetryPending() && !auth.initError() && !auth.loginRequired()) {
    await auth.reAuthenticate();
  }
  return false;
};
