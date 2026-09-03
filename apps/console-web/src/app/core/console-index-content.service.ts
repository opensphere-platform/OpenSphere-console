import { Injectable, signal } from '@angular/core';
import { ConsoleIndexData, INDEX_MAX_BYTES, validateConsoleIndexEnvelope } from '../../../../../packages/contracts/src/console-index-content';

/** One atomic response avoids old/new Pod manifest-versus-payload races during rollout. */
@Injectable({providedIn:'root'})
export class ConsoleIndexContentService {
  readonly state = signal<'loading'|'ready'|'error'>('loading');
  readonly version = signal('');
  private data: ConsoleIndexData | null = null;
  private pending: Promise<void> | null = null;

  load(): Promise<void> {
    if(this.pending) return this.pending;
    if(this.state()==='ready') return Promise.resolve();
    this.state.set('loading');
    this.pending=this.fetchContent().finally(()=>{this.pending=null;});
    return this.pending;
  }
  private async fetchContent(): Promise<void> {
    try {
      const response=await fetch('/console-index/content.json',{
        cache:'no-store',credentials:'omit',redirect:'error',signal:AbortSignal.timeout(10000),
      });
      if(!response.ok||!response.headers.get('content-type')?.includes('application/json')) throw Error('index_content_unavailable');
      const reader=response.body?.getReader();
      if(!reader) throw Error('index_content_unavailable');
      const chunks:Uint8Array[]=[];let size=0;
      try {
        while(true) {
          const part=await reader.read();if(part.done)break;
          size+=part.value.byteLength;
          if(size>INDEX_MAX_BYTES) throw Error('index_content_too_large');
          chunks.push(part.value);
        }
      } finally { await reader.cancel(); }
      const bytes=new Uint8Array(size);let offset=0;
      for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
      const envelope=await validateConsoleIndexEnvelope(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
      this.data=envelope.data;
      this.version.set(envelope.data.version);
      this.state.set('ready');
    } catch {
      // Never silently display compiled fallback or treat this as service-health evidence.
      this.data=null;this.version.set('');this.state.set('error');
    }
  }
  text(group:string,key:string):string {
    const value=this.data?.copy[group]?.[key];
    if(value===undefined) throw Error('index_renderer_text_missing');
    return value;
  }
  model<T>(name:string):T {
    const value=this.data?.models[name];
    if(value===undefined) throw Error('index_renderer_model_missing');
    return value as T;
  }
}
