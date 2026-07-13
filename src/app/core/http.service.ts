import { Injectable, inject, signal } from '@angular/core';
import { AuthService } from './auth.service';

const REQUEST_TIMEOUT_MS = 15000;

@Injectable({ providedIn: 'root' })
export class HttpService {
  private readonly auth = inject(AuthService);
  readonly reauthRequired = signal(false);

  async request(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const target = this.sameOrigin(input);
    const headers = new Headers(input instanceof Request ? input.headers : init.headers);
    headers.delete('X-OpenSphere-User');
    headers.delete('X-OpenSphere-Actor');
		headers.delete('X-OS-Id-Token');
		headers.delete('Authorization');
    const token = this.auth.token();
    if (token) headers.set('Authorization', `Bearer ${token}`);
		const correlationId = headers.get('X-OS-Correlation-ID');
		if (!correlationId || !/^[A-Za-z0-9._:-]{1,128}$/.test(correlationId)) {
			headers.set('X-OS-Correlation-ID', crypto.randomUUID());
		}
		const method = String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
		if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && !headers.has('X-OS-Idempotency-Key')) {
			headers.set('X-OS-Idempotency-Key', crypto.randomUUID());
		}
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    if (init.signal) {
      if (init.signal.aborted) controller.abort();
      else init.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    try {
      const response = await fetch(target, { ...init, headers, signal: controller.signal });
      // A freshly reinstalled Console has a new Kanidm signing key. A token from
      // the previous installation can still be locally unexpired while every
      // server correctly rejects it. HTTP 401 is therefore authoritative: do
      // not gate reauthentication on the client-side exp claim.
      if (response.status === 401 && token) {
        this.reauthRequired.set(true);
        void this.auth.reAuthenticate();
      }
      return response;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async json<T>(input: RequestInfo | URL, init: RequestInit = {}): Promise<T> {
    const response = await this.request(input, init);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json() as Promise<T>;
  }

  private sameOrigin(input: RequestInfo | URL): URL | Request {
    const target = input instanceof Request ? new URL(input.url) : new URL(String(input), window.location.origin);
    if (target.origin !== window.location.origin) throw new Error('cross-origin API request blocked by Console HTTP policy');
    return input instanceof Request ? input : target;
  }
}
