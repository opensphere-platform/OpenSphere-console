import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { AuthService } from '../../../core/auth.service';

/** 제네릭 K8s API 프록시 클라이언트. 백엔드 /api/k8s/<표준 K8s 경로>로 패스스루.
 *  Main Shell HttpInterceptor가 ctx.api.fetch로 인증을 중개하고, backend가 유효한 Console 신원만
 *  Cluster Manager의 고정된 읽기 권한에 연결한다. 범용 쓰기는 서버에서 차단되며 HIS 승인 경로를 사용한다.
 *  Consumer JavaScript는 raw token을 읽지 않는다. */
export interface K8sList<T = any> {
  kind?: string;
  apiVersion?: string;
  items: T[];
  metadata?: { resourceVersion?: string };
}

@Injectable({ providedIn: 'root' })
export class K8sService {
  private http = inject(HttpClient);
  private auth = inject(AuthService);

  private controlCenterId(): string {
    const match = window.location.pathname.match(/^\/cc\/([a-z0-9-]+)\/kubernetes(?:\/|$)/);
    return match?.[1] || 'cc2';
  }

  private base(): string {
    return `/api/control-centers/${this.controlCenterId()}/k8s`;
  }

  /** RCC Supabase 세션을 동일 출처 API 경계에 전달한다. */
  private hdr(extra?: Record<string, string>): { headers: Record<string, string> } {
    const token = this.auth.token();
    return {
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(extra || {}),
      },
    };
  }

  private url(path: string): string { return `${this.base()}${path}`; }

  /** path 예: /api/v1/pods, /apis/apps/v1/deployments (전 네임스페이스). 쿼리 추가 가능. */
  list<T = any>(path: string, query?: Record<string, string>): Observable<K8sList<T>> {
    const qs = query ? '?' + new URLSearchParams(query).toString() : '';
    return this.http.get<K8sList<T>>(this.url(path) + qs, this.hdr());
  }

  get<T = any>(path: string): Observable<T> {
    return this.http.get<T>(this.url(path), this.hdr());
  }

  /** 1차 RCC는 읽기 전용이며 exec 세션을 발급하지 않는다. */
  session(): Observable<any> {
    return this.http.get(`${this.base()}/session`, this.hdr());
  }

  /** 텍스트 응답 GET (예: pods/<name>/log — tail 방식). */
  getText(path: string, query?: Record<string, string>): Observable<string> {
    const qs = query ? '?' + new URLSearchParams(query).toString() : '';
    return this.http.get(this.url(path) + qs, { headers: this.hdr().headers, responseType: 'text' });
  }

  // ── 레거시 쓰기 클라이언트 ──
  // 서버 보안 계약상 범용 쓰기는 403이다. HIS 설치/삭제는 HisService의 승인 API만 사용한다.
  /** 전체 교체(PUT). Edit YAML 적용에 사용(resourceVersion 포함된 obj 필요). */
  replace<T = any>(path: string, obj: any): Observable<T> {
    return this.http.put<T>(this.url(path), obj, this.hdr());
  }
  /** merge-patch (예: spec.replicas 스케일). */
  patchMerge<T = any>(path: string, patch: any): Observable<T> {
    return this.http.patch<T>(this.url(path), patch, this.hdr({ 'content-type': 'application/merge-patch+json' }));
  }
  /** strategic-merge-patch (예: 템플릿 어노테이션 — 롤링 재시작). */
  patchStrategic<T = any>(path: string, patch: any): Observable<T> {
    return this.http.patch<T>(this.url(path), patch, this.hdr({ 'content-type': 'application/strategic-merge-patch+json' }));
  }
  remove<T = any>(path: string): Observable<T> {
    return this.http.delete<T>(this.url(path), this.hdr());
  }
  /** 생성/액션 POST (예: pods/<name>/eviction — drain). */
  post<T = any>(path: string, body: any): Observable<T> {
    return this.http.post<T>(this.url(path), body, this.hdr());
  }
}
