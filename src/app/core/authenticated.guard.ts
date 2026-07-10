import { inject } from '@angular/core';
import type { CanActivateFn } from '@angular/router';
import { AuthService } from './auth.service';

/**
 * Native management surfaces must never render with an absent or expired
 * management-plane id_token. The bootstrap initializer establishes the first
 * session; this guard also protects deep links and long-lived tabs.
 */
export const authenticatedGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  if (auth.hasValidToken()) return true;
  void auth.reAuthenticate();
  return false;
};
