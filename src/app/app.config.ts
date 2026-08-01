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

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    provideAnimationsAsync(),
    // 부트스트랩 순서: ① 세션 초기화 → ② Shell first paint → ③ optional Registry/Consumer late load.
    // Registry/Consumer hang은 Main Shell bootstrap을 막지 않는다.
    provideAppInitializer(() => {
      const auth = inject(AuthService);
      auth.startInitialization();
    }),
  ],
};
