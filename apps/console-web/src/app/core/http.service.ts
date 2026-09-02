import { Injectable, inject, signal } from '@angular/core';
import { AuthService } from './auth.service';
import { requestWithStepUp } from './http-step-up';

const REQUEST_TIMEOUT_MS = 15000;

export interface OpenSphereRequestInit extends RequestInit {
  timeoutMs?: number;
}

export class HttpRequestTimeoutError extends Error {
  override readonly name = 'HttpRequestTimeoutError';

  constructor(readonly timeoutMs: number) {
    super(`request timed out after ${timeoutMs}ms`);
  }
}

@Injectable({ providedIn: 'root' })
export class HttpService {
  private readonly auth = inject(AuthService);
  readonly reauthRequired = signal(false);

  async request(input: RequestInfo | URL, init: OpenSphereRequestInit = {}): Promise<Response> {
    const { timeoutMs: requestedTimeoutMs, ...requestInit } = init;
    const timeoutMs = Math.max(1000, Math.min(180000, Number(requestedTimeoutMs ?? REQUEST_TIMEOUT_MS) || REQUEST_TIMEOUT_MS));
    const target = this.sameOrigin(input);
    const headers = new Headers(input instanceof Request ? input.headers : requestInit.headers);
    headers.delete('X-OpenSphere-User');
    headers.delete('X-OpenSphere-Actor');
		headers.delete('X-OS-Id-Token');
		headers.delete('Authorization');
		const correlationId = headers.get('X-OS-Correlation-ID');
		if (!correlationId || !/^[A-Za-z0-9._:-]{1,128}$/.test(correlationId)) {
			headers.set('X-OS-Correlation-ID', crypto.randomUUID());
		}
    const method = String(requestInit.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
		if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && !headers.has('X-OS-Idempotency-Key')) {
			headers.set('X-OS-Idempotency-Key', crypto.randomUUID());
		}
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && !headers.has('X-OS-CSRF-Token')) {
      const csrf = this.cookieValue('__Host-opensphere_csrf');
      if (csrf) headers.set('X-OS-CSRF-Token', csrf);
    }
    const fetchOnce = async (): Promise<Response> => {
      const controller = new AbortController();
      let timedOut = false;
      const abortFromCaller = () => controller.abort();
      const timeout = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      if (requestInit.signal) {
        if (requestInit.signal.aborted) controller.abort();
        else requestInit.signal.addEventListener('abort', abortFromCaller, { once: true });
      }
      try {
        const attemptTarget = target instanceof Request ? target.clone() : target;
        return await fetch(attemptTarget, { ...requestInit, headers, signal: controller.signal });
      } catch (error) {
        if (timedOut && (error as { name?: string })?.name === 'AbortError') {
          throw new HttpRequestTimeoutError(timeoutMs);
        }
        throw error;
      } finally {
        window.clearTimeout(timeout);
        requestInit.signal?.removeEventListener('abort', abortFromCaller);
      }
    };

    // Recent AAL2 is an approval phase of this command, not a failed command.
    // The helper waits for the shared modal, then replays exactly once with the
    // same correlation and idempotency keys prepared above.
    const response = await requestWithStepUp(
      fetchOnce,
      () => this.auth.requestStepUp(),
      () => Boolean(this.auth.subject()),
    );
    // A downstream 401 is not proof that the browser session ended. Confirm
    // the opaque cookie with the identity authority before showing login;
    // service routing or permission failures must not erase a valid session.
    if (response.status === 401 && this.auth.subject()) {
      this.reauthRequired.set(await this.auth.shouldReauthenticateAfterUnauthorized());
    }
    return response;
  }

  async json<T>(input: RequestInfo | URL, init: OpenSphereRequestInit = {}): Promise<T> {
    const response = await this.request(input, init);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json() as Promise<T>;
  }

  private sameOrigin(input: RequestInfo | URL): URL | Request {
    const target = input instanceof Request ? new URL(input.url) : new URL(String(input), window.location.origin);
    if (target.origin !== window.location.origin) throw new Error('cross-origin API request blocked by Console HTTP policy');
    return input instanceof Request ? input : target;
  }

  private cookieValue(name: string): string {
    const prefix = `${name}=`;
    const item = document.cookie.split(';').map((value) => value.trim()).find((value) => value.startsWith(prefix));
    return item ? decodeURIComponent(item.slice(prefix.length)) : '';
  }
}
