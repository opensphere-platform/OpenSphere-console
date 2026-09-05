// CON-FR-007/014/017 · C_WEB. Text/data only: never evaluate remote markup or code.
export const INDEX_RENDERER_CONTRACT = 'console-index-renderer/v1';
export const INDEX_MAX_BYTES = 1024 * 1024;
export interface ConsoleIndexData {
  schemaVersion: 1;
  rendererContract: string;
  version: string;
  sourceRevision: string;
  copy: Record<string, Record<string, string>>;
  models: Record<string, unknown>;
}
export interface ConsoleIndexEnvelope { sha256: string; data: ConsoleIndexData; }

// Generated from the reviewed renderer schema; content-only builds must not regenerate it.
const REQUIRED_COPY_KEY_DIGEST = '5b869332da29a63bb805344781d24ff87712bc603be7d89e26fd936c2a0c0c89';
const MODEL_SHAPE: unknown = {"type":"object","additionalProperties":false,"required":["SERVICE_REALIZATION_LAYERS","SERVICE_REALIZATION_ESTABLISHMENT_SEQUENCE","FOUNDATION_CONCEPT_TABS","SERVICE_STACKS","CBSS_COMPONENTS","PFSS_CAPABILITIES","DUPA_INSTALL_STAGES","DUPA_PLUGIN_ROLES","AGENT_RUNTIME_SPECTRUM","CONTROL_PILLARS","CONTROL_BEAMS","CONTROL_ENGINE_SURFACES","CONTROL_ENGINE_TARGETS","CONTROL_ENGINE_STAGES","CONTROL_ENGINE_PICTOGRAMS","AI_LIFECYCLE","MODEL_LOCATIONS","DIALOGUE_STATE_FIELDS","EXAMPLE_DIALOGUE_STATE","UPSTREAM_REFERENCES","PERSPECTIVES"],"properties":{"SERVICE_REALIZATION_LAYERS":{"type":"array","maxItems":128,"items":{"type":"object","additionalProperties":false,"required":["id","ordinal","name","short","scope","role","requires","establishes","evidence","authority","failurePolicy","objects"],"properties":{"id":{"type":"string","maxLength":20000},"ordinal":{"type":"number"},"name":{"type":"string","maxLength":20000},"short":{"type":"string","maxLength":20000},"scope":{"type":"string","maxLength":20000},"role":{"type":"string","maxLength":20000},"requires":{"type":"string","maxLength":20000},"establishes":{"type":"string","maxLength":20000},"evidence":{"type":"string","maxLength":20000},"authority":{"type":"string","maxLength":20000},"failurePolicy":{"type":"string","maxLength":20000},"objects":{"type":"array","maxItems":128,"items":{"type":"string","maxLength":20000}}}}},"SERVICE_REALIZATION_ESTABLISHMENT_SEQUENCE":{"type":"array","maxItems":128,"items":{"type":"string","maxLength":20000}},"FOUNDATION_CONCEPT_TABS":{"type":"array","maxItems":128,"items":{"type":"object","additionalProperties":false,"required":["id","label","eyebrow","summary","pictogram","pictogramAlt"],"properties":{"id":{"type":"string","maxLength":20000},"label":{"type":"string","maxLength":20000},"eyebrow":{"type":"string","maxLength":20000},"summary":{"type":"string","maxLength":20000},"pictogram":{"type":"string","maxLength":20000},"pictogramAlt":{"type":"string","maxLength":20000}}}},"SERVICE_STACKS":{"type":"array","maxItems":128,"items":{"type":"object","additionalProperties":false,"required":["id","name","role","owns","excludes","evidence"],"properties":{"id":{"type":"string","maxLength":20000},"name":{"type":"string","maxLength":20000},"role":{"type":"string","maxLength":20000},"owns":{"type":"array","maxItems":128,"items":{"type":"string","maxLength":20000}},"excludes":{"type":"array","maxItems":128,"items":{"type":"string","maxLength":20000}},"evidence":{"type":"string","maxLength":20000}}}},"CBSS_COMPONENTS":{"type":"array","maxItems":128,"items":{"type":"object","additionalProperties":false,"required":["id","name","role","owns","excludes","evidence","productLogo","productLogoAlt"],"properties":{"id":{"type":"string","maxLength":20000},"name":{"type":"string","maxLength":20000},"role":{"type":"string","maxLength":20000},"owns":{"type":"array","maxItems":128,"items":{"type":"string","maxLength":20000}},"excludes":{"type":"array","maxItems":128,"items":{"type":"string","maxLength":20000}},"evidence":{"type":"string","maxLength":20000},"productLogo":{"type":"string","maxLength":20000},"productLogoAlt":{"type":"string","maxLength":20000}}}},"PFSS_CAPABILITIES":{"type":"array","maxItems":128,"items":{"type":"object","additionalProperties":false,"required":["id","name","role","owns","excludes","evidence"],"properties":{"id":{"type":"string","maxLength":20000},"name":{"type":"string","maxLength":20000},"role":{"type":"string","maxLength":20000},"owns":{"type":"array","maxItems":128,"items":{"type":"string","maxLength":20000}},"excludes":{"type":"array","maxItems":128,"items":{"type":"string","maxLength":20000}},"evidence":{"type":"string","maxLength":20000}}}},"DUPA_INSTALL_STAGES":{"type":"array","maxItems":128,"items":{"type":"object","additionalProperties":false,"required":["step","title","owner","outcome","evidence"],"properties":{"step":{"type":"string","maxLength":20000},"title":{"type":"string","maxLength":20000},"owner":{"type":"string","maxLength":20000},"outcome":{"type":"string","maxLength":20000},"evidence":{"type":"string","maxLength":20000}}}},"DUPA_PLUGIN_ROLES":{"type":"array","maxItems":128,"items":{"type":"object","additionalProperties":false,"required":["id","name","role","owns","excludes","evidence"],"properties":{"id":{"type":"string","maxLength":20000},"name":{"type":"string","maxLength":20000},"role":{"type":"string","maxLength":20000},"owns":{"type":"array","maxItems":128,"items":{"type":"string","maxLength":20000}},"excludes":{"type":"array","maxItems":128,"items":{"type":"string","maxLength":20000}},"evidence":{"type":"string","maxLength":20000}}}},"AGENT_RUNTIME_SPECTRUM":{"type":"array","maxItems":128,"items":{"type":"object","additionalProperties":false,"required":["id","name","role","owns","excludes","evidence"],"properties":{"id":{"type":"string","maxLength":20000},"name":{"type":"string","maxLength":20000},"role":{"type":"string","maxLength":20000},"owns":{"type":"array","maxItems":128,"items":{"type":"string","maxLength":20000}},"excludes":{"type":"array","maxItems":128,"items":{"type":"string","maxLength":20000}},"evidence":{"type":"string","maxLength":20000}}}},"CONTROL_PILLARS":{"type":"array","maxItems":128,"items":{"type":"object","additionalProperties":false,"required":["id","name","role","owns","excludes","evidence"],"properties":{"id":{"type":"string","maxLength":20000},"name":{"type":"string","maxLength":20000},"role":{"type":"string","maxLength":20000},"owns":{"type":"array","maxItems":128,"items":{"type":"string","maxLength":20000}},"excludes":{"type":"array","maxItems":128,"items":{"type":"string","maxLength":20000}},"evidence":{"type":"string","maxLength":20000}}}},"CONTROL_BEAMS":{"type":"array","maxItems":128,"items":{"type":"object","additionalProperties":false,"required":["id","name","role","owns","excludes","evidence"],"properties":{"id":{"type":"string","maxLength":20000},"name":{"type":"string","maxLength":20000},"role":{"type":"string","maxLength":20000},"owns":{"type":"array","maxItems":128,"items":{"type":"string","maxLength":20000}},"excludes":{"type":"array","maxItems":128,"items":{"type":"string","maxLength":20000}},"evidence":{"type":"string","maxLength":20000}}}},"CONTROL_ENGINE_SURFACES":{"type":"array","maxItems":128,"items":{"type":"object","additionalProperties":false,"required":["id","name","role","boundary","pictogram","pictogramAlt"],"properties":{"id":{"type":"string","maxLength":20000},"name":{"type":"string","maxLength":20000},"role":{"type":"string","maxLength":20000},"boundary":{"type":"string","maxLength":20000},"pictogram":{"type":"string","maxLength":20000},"pictogramAlt":{"type":"string","maxLength":20000}}}},"CONTROL_ENGINE_TARGETS":{"type":"array","maxItems":128,"items":{"type":"object","additionalProperties":false,"required":["id","name","role","boundary","pictogram","pictogramAlt"],"properties":{"id":{"type":"string","maxLength":20000},"name":{"type":"string","maxLength":20000},"role":{"type":"string","maxLength":20000},"boundary":{"type":"string","maxLength":20000},"pictogram":{"type":"string","maxLength":20000},"pictogramAlt":{"type":"string","maxLength":20000}}}},"CONTROL_ENGINE_STAGES":{"type":"array","maxItems":128,"items":{"type":"object","additionalProperties":false,"required":["step","title","owner","outcome","evidence"],"properties":{"step":{"type":"string","maxLength":20000},"title":{"type":"string","maxLength":20000},"owner":{"type":"string","maxLength":20000},"outcome":{"type":"string","maxLength":20000},"evidence":{"type":"string","maxLength":20000}}}},"CONTROL_ENGINE_PICTOGRAMS":{"type":"object","additionalProperties":false,"required":["engine","api"],"properties":{"engine":{"type":"string","maxLength":20000},"api":{"type":"string","maxLength":20000}}},"AI_LIFECYCLE":{"type":"array","maxItems":128,"items":{"type":"object","additionalProperties":false,"required":["step","title","owner","outcome","evidence"],"properties":{"step":{"type":"string","maxLength":20000},"title":{"type":"string","maxLength":20000},"owner":{"type":"string","maxLength":20000},"outcome":{"type":"string","maxLength":20000},"evidence":{"type":"string","maxLength":20000}}}},"MODEL_LOCATIONS":{"type":"array","maxItems":128,"items":{"type":"object","additionalProperties":false,"required":["id","name","role","owns","excludes","evidence"],"properties":{"id":{"type":"string","maxLength":20000},"name":{"type":"string","maxLength":20000},"role":{"type":"string","maxLength":20000},"owns":{"type":"array","maxItems":128,"items":{"type":"string","maxLength":20000}},"excludes":{"type":"array","maxItems":128,"items":{"type":"string","maxLength":20000}},"evidence":{"type":"string","maxLength":20000}}}},"DIALOGUE_STATE_FIELDS":{"type":"array","maxItems":128,"items":{"type":"object","additionalProperties":false,"required":["name","meaning","example"],"properties":{"name":{"type":"string","maxLength":20000},"meaning":{"type":"string","maxLength":20000},"example":{"type":"string","maxLength":20000}}}},"EXAMPLE_DIALOGUE_STATE":{"type":"string","maxLength":20000},"UPSTREAM_REFERENCES":{"type":"array","maxItems":128,"items":{"type":"object","additionalProperties":false,"required":["name","contribution","decision","href"],"properties":{"name":{"type":"string","maxLength":20000},"contribution":{"type":"string","maxLength":20000},"decision":{"type":"string","maxLength":20000},"href":{"type":"string","maxLength":20000}}}},"PERSPECTIVES":{"type":"array","maxItems":128,"items":{"type":"object","additionalProperties":false,"required":["num","name","korean","band","question","pluginId"],"properties":{"num":{"type":"number"},"name":{"type":"string","maxLength":20000},"korean":{"type":"string","maxLength":20000},"band":{"type":"string","maxLength":20000},"question":{"type":"string","maxLength":20000},"pluginId":{"type":"string","maxLength":20000}}}}}};

export async function indexRendererSignature(): Promise<string> {
  return indexSha256(JSON.stringify({contract:INDEX_RENDERER_CONTRACT,copyKeys:REQUIRED_COPY_KEY_DIGEST,models:MODEL_SHAPE}));
}

type Shape = { type?: string; const?: unknown; pattern?: string; maxLength?: number;
  maxItems?: number; items?: Shape; anyOf?: Shape[]; required?: string[];
  properties?: Record<string, Shape>; additionalProperties?: boolean; };
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function matches(value: unknown, shape: Shape): boolean {
  if(shape.anyOf) return shape.anyOf.some(s => matches(value,s));
  if(shape.type === 'string') return typeof value === 'string' && value.length <= (shape.maxLength ?? 20000);
  if(shape.type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if(shape.type === 'boolean') return typeof value === 'boolean';
  if(shape.type === 'array') return Array.isArray(value) && value.length <= (shape.maxItems ?? 128) && value.every(v => matches(v,shape.items!));
  if(shape.type === 'object') return record(value) && (shape.required ?? []).every(k => Object.hasOwn(value,k))
    && Object.keys(value).every(k => Object.hasOwn(shape.properties ?? {},k) && matches(value[k],shape.properties![k]!));
  return false;
}
export async function indexSha256(text: string): Promise<string> {
  const bytes = await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes),b => b.toString(16).padStart(2,'0')).join('');
}
function validateLinks(value: unknown, key = ''): void {
  if(Array.isArray(value)) { value.forEach(v => validateLinks(v,key)); return; }
  if(record(value)) { Object.entries(value).forEach(([k,v]) => validateLinks(v,k)); return; }
  if(typeof value !== 'string') return;
  if(['href','pictogram','productLogo','engine','api'].includes(key)) {
    if(!/^https:\/\/[^\s\\]+$/.test(value) && !/^\/assets\/[a-zA-Z0-9/_.-]+$/.test(value)) throw Error('index_content_link_invalid');
    if(value.includes('/../')) throw Error('index_content_link_invalid');
  }
}
export async function validateConsoleIndexEnvelope(value: unknown): Promise<ConsoleIndexEnvelope> {
  if(!record(value)||Object.keys(value).sort().join(',')!=='data,sha256'||!record(value['data'])) throw Error('index_content_invalid');
  const data=value['data'];
  if(Object.keys(data).sort().join(',')!=='copy,models,rendererContract,schemaVersion,sourceRevision,version'
    ||data['schemaVersion']!==1||data['rendererContract']!==INDEX_RENDERER_CONTRACT
    ||typeof data['version']!=='string'||!/^\d{12}$/.test(data['version'])
    ||typeof data['sourceRevision']!=='string'||! /^[a-f0-9]{40}$/.test(data['sourceRevision'])
    ||!record(data['copy'])||!record(data['models'])) throw Error('index_content_incompatible');
  const keys:string[]=[];
  for(const [group,entries] of Object.entries(data['copy'])) {
    if(!record(entries)) throw Error('index_content_invalid');
    for(const [key,text] of Object.entries(entries)) {
      if(typeof text!=='string'||text.length>20000) throw Error('index_content_invalid');
      keys.push(`${group}/${key}`);
    }
  }
  if(await indexSha256(keys.sort().join('\n'))!==REQUIRED_COPY_KEY_DIGEST) throw Error('index_renderer_keys_incompatible');
  if(!matches(data['models'],MODEL_SHAPE as Shape)) throw Error('index_models_incompatible');
  validateLinks(data['models']);
  // The coordinate IDs remain fixed; explanatory content cannot create authority/navigation.
  const perspectives=data['models']['PERSPECTIVES'] as {num:number;pluginId:string}[];
  const allowed=['os','cluster-manager','identity','developer','ai','api','workspace','customer','edge','website'];
  if(perspectives.length!==10||perspectives.some((p,i)=>p.num!==i+1||p.pluginId!==allowed[i])) throw Error('index_perspective_identity_invalid');
  const tabs=data['models']['FOUNDATION_CONCEPT_TABS'] as {id:string}[];
  if(tabs.map(t=>t.id).join(',')!=='service-stacks,dupa,control-pillars,control-engine,ai-lifecycle') throw Error('index_tab_identity_invalid');
  const layers=data['models']['SERVICE_REALIZATION_LAYERS'] as {id:string;ordinal:number}[];
  if(layers.length!==6||layers.some((l,i)=>l.id!==`SRL-L${6-i}`||l.ordinal!==6-i)) throw Error('index_layer_identity_invalid');
  if(typeof value['sha256']!=='string'||await indexSha256(JSON.stringify(data))!==value['sha256']) throw Error('index_content_digest_mismatch');
  return value as unknown as ConsoleIndexEnvelope;
}
