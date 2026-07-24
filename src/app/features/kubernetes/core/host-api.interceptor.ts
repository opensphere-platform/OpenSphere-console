import {
  HttpErrorResponse,
  HttpHeaders,
  HttpInterceptorFn,
  HttpResponse,
} from '@angular/common/http';
import { from, mergeMap } from 'rxjs';

type HostFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export const hostApiInterceptor: HttpInterceptorFn = (request, next) => {
  const w = window as Window & {
    __OPENSPHERE_HOST_CONTEXTS__?: Record<string, { api?: { fetch?: HostFetch } }>;
  };
  const mediated = w.__OPENSPHERE_HOST_CONTEXTS__?.['cluster-manager']?.api?.fetch;
  if (!mediated) return next(request);

  const headers = Object.fromEntries(request.headers.keys().map((name) => [name, request.headers.get(name) || '']));
  const body = request.body == null
    ? undefined
    : typeof request.body === 'string' || request.body instanceof Blob || request.body instanceof FormData
      ? request.body
      : JSON.stringify(request.body);

  return from(mediated(request.urlWithParams, {
    method: request.method,
    headers,
    body: body as BodyInit | undefined,
  })).pipe(mergeMap(async (response) => {
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => { responseHeaders[name] = value; });
    const text = await response.text();
    let payload: unknown = text;
    if (request.responseType === 'json') {
      try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
    }
    if (!response.ok) {
      throw new HttpErrorResponse({
        error: payload,
        headers: new HttpHeaders(responseHeaders),
        status: response.status,
        statusText: response.statusText,
        url: response.url || request.urlWithParams,
      });
    }
    return new HttpResponse({
      body: payload,
      headers: new HttpHeaders(responseHeaders),
      status: response.status,
      statusText: response.statusText,
      url: response.url || request.urlWithParams,
    });
  }));
};
