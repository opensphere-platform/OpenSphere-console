import { Injectable, inject } from '@angular/core';
import { AuthService } from './auth.service';
import { HttpService } from './http.service';

export interface ManualSource {
  id: string;
  type: string;
  name: string;
  authorityTier: number;
  documents: number;
  updatedAt: string;
}

export interface ManualDocument {
  id: string;
  namespace: string;
  sourceType: string;
  sourceId: string;
  title: string;
  version: string;
  updatedAt: string;
  chunkCount: number;
  summary: string;
  metadata: Record<string, unknown>;
  documentType: string;
  authorityTier: number | null;
  status: string;
  language: string;
  route: string;
  sourcePath: string;
  sourceUrl: string;
  sourceName: string;
  source: Record<string, unknown> | null;
  tags: string[];
  perspective: string[];
  component: string[];
}

export interface ManualSearchHit {
  documentId: string;
  sourceId: string;
  title: string;
  version: string;
  score: number;
  chunkIndex: number;
  excerpt: string;
  metadata: Record<string, unknown>;
  chunkMetadata: Record<string, unknown>;
  documentType: string;
  authorityTier: number | null;
  route: string;
  sourcePath: string;
  sourceUrl: string;
  sourceName: string;
}

export interface ManualChunk {
  chunkIndex: number;
  content: string;
  metadata: Record<string, unknown>;
}

export interface ManualActionBinding {
  id: string;
  sourceId: string;
  sectionId: string;
  toolId: string;
  intent: string;
  riskLevel: string;
  confirmation: string;
  spec: Record<string, unknown>;
}

export interface ManualDocumentDetail {
  item: ManualDocument;
  chunks: ManualChunk[];
  actionBindings: ManualActionBinding[];
}

@Injectable({ providedIn: 'root' })
export class ManualService {
  private auth = inject(AuthService);
  private http = inject(HttpService);

  private authHeaders(): Record<string, string> {
    return { authorization: 'Bearer ' + (this.auth.token() || '') };
  }

  private async getJson<T>(url: string): Promise<T> {
    const res = await this.http.request(url, { headers: this.authHeaders() });
    if (!res.ok) throw new Error(`manual: HTTP ${res.status}`);
    return res.json() as Promise<T>;
  }

  async sources(): Promise<ManualSource[]> {
    const body = await this.getJson<{ items: ManualSource[] }>('/api/manual/sources');
    return body.items || [];
  }

  async documents(q = '', source = '', limit = 60): Promise<ManualDocument[]> {
    const qs = new URLSearchParams();
    if (q.trim()) qs.set('q', q.trim());
    if (source.trim()) qs.set('source', source.trim());
    qs.set('limit', String(limit));
    const body = await this.getJson<{ items: ManualDocument[] }>(`/api/manual/documents?${qs}`);
    return body.items || [];
  }

  async search(q: string, limit = 8): Promise<ManualSearchHit[]> {
    const qs = new URLSearchParams({ q, limit: String(limit) });
    const body = await this.getJson<{ items: ManualSearchHit[] }>(`/api/manual/search?${qs}`);
    return body.items || [];
  }

  async document(sourceId: string): Promise<ManualDocumentDetail> {
    const qs = new URLSearchParams({ sourceId });
    const body = await this.getJson<ManualDocumentDetail>(`/api/manual/document?${qs}`);
    return {
      item: body.item,
      chunks: body.chunks || [],
      actionBindings: body.actionBindings || [],
    };
  }
}
