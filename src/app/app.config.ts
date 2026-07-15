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
    // 부트스트랩 순서: ① 세션 초기화 → ② Shell first paint → ③ optional Registry/Consumer late load.
    // Registry/Consumer hang은 Main Shell bootstrap을 막지 않는다.
    provideAppInitializer(async () => {
      const auth = inject(AuthService);
      const ext = inject(ExtensionHostService);
      try {
        await auth.init();
      } catch (error) {
        auth.setInitError(error);
      }
      if (!auth.setupRequired()) void ext.load().catch((error) => console.warn('[extension-host] optional bootstrap load failed:', error));
    }),
  ],
};
