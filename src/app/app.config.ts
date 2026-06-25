import {
  ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
  provideZoneChangeDetection,
} from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';

import { routes } from './app.routes';
import { AuthService } from './core/auth.service';
import { ExtensionHostService } from './core/extension-host.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    provideAnimationsAsync(),
    // 부트스트랩 순서: ① Keycloak 로그인 강제(통합안 §4.1) → ② 플러그인 로드(§5.2)
    provideAppInitializer(() => {
      const auth = inject(AuthService);
      const ext = inject(ExtensionHostService);
      return auth.init().then(() => ext.load());
    }),
  ],
};
