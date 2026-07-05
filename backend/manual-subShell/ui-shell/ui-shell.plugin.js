const TAG = 'osp-manual-shell';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}[c]));

function authToken() {
  try {
    return (window.__OS_AUTH__ && window.__OS_AUTH__.token && window.__OS_AUTH__.token()) || '';
  } catch {
    return '';
  }
}

function queryParams() {
  return new URLSearchParams(window.location.search || '');
}

function updateQuery(params) {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === '') url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  window.history.replaceState({}, '', url.pathname + url.search + url.hash);
}

async function manualJson(path) {
  const token = authToken();
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const res = await fetch(path, { headers, cache: 'no-store' });
  if (!res.ok) throw new Error(`manual HTTP ${res.status}`);
  return res.json();
}

class ManualShellElement extends HTMLElement {
  connectedCallback() {
    const params = queryParams();
    this.state = {
      sources: [],
      documents: [],
      hits: [],
      selected: null,
      error: '',
      loading: false,
      q: params.get('q') || '',
      source: params.get('source') || '',
      doc: params.get('doc') || '',
    };
    this.render();
    this.load();
  }

  setState(next) {
    this.state = { ...this.state, ...next };
    this.render();
  }

  async load() {
    this.setState({ loading: true, error: '' });
    try {
      const qs = new URLSearchParams();
      if (this.state.q.trim()) qs.set('q', this.state.q.trim());
      if (this.state.source) qs.set('source', this.state.source);
      qs.set('limit', '80');
      const [sources, documents] = await Promise.all([
        manualJson('/api/manual/sources').then((body) => body.items || []),
        manualJson(`/api/manual/documents?${qs.toString()}`).then((body) => body.items || []),
      ]);
      let hits = [];
      if (this.state.q.trim()) {
        const hitQs = new URLSearchParams({ q: this.state.q.trim(), limit: '12' });
        hits = await manualJson(`/api/manual/search?${hitQs.toString()}`).then((body) => body.items || []);
      }
      this.setState({ sources, documents, hits });
      const target = this.state.doc || (this.state.selected && this.state.selected.item.sourceId) || (documents[0] && documents[0].sourceId) || '';
      if (target) await this.selectDocument(target, false);
      else this.setState({ selected: null });
    } catch (err) {
      this.setState({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.setState({ loading: false });
    }
  }

  async search() {
    updateQuery({
      q: this.state.q.trim(),
      source: this.state.source,
      doc: '',
    });
    this.setState({ doc: '' });
    await this.load();
  }

  async selectSource(source) {
    this.setState({ source: this.state.source === source ? '' : source });
    await this.search();
  }

  async selectDocument(sourceId, update = true) {
    if (!sourceId) return;
    try {
      const qs = new URLSearchParams({ sourceId });
      const detail = await manualJson(`/api/manual/document?${qs.toString()}`);
      this.setState({ selected: detail, doc: sourceId, error: '' });
      if (update) updateQuery({ doc: sourceId, q: this.state.q.trim(), source: this.state.source });
    } catch (err) {
      this.setState({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  tier(doc) {
    return doc && doc.authorityTier != null ? String(doc.authorityTier) : '-';
  }

  score(value) {
    return Number(value || 0).toFixed(2);
  }

  render() {
    const s = this.state || {};
    this.innerHTML = `<style>
      ${TAG}{display:block;height:100%;min-height:calc(100vh - 3rem);background:#f5f7fb;color:#182236}
      ${TAG} *{box-sizing:border-box}
      .manual-shell{display:grid;grid-template-columns:18rem minmax(0,1fr);gap:1rem;height:calc(100vh - 3rem);min-height:38rem;padding:1rem;overflow:hidden}
      .manual-side,.manual-main{min-width:0;border:1px solid #d8dee8;border-radius:8px;background:#fff;overflow:hidden}
      .manual-side{padding:1rem;display:flex;flex-direction:column}
      .manual-side-head,.manual-toolbar,.manual-doc-head{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem}
      h1,h2,h3,h4,p{margin:0} h1{font-size:1.2rem} h2{margin-top:.15rem;font-size:1.45rem} h3{font-size:1rem} h4{font-size:.85rem}
      button,input,select{font:inherit}.btn{border:1px solid #9bb6e6;background:#fff;color:#0f5ea8;border-radius:4px;padding:.28rem .55rem;cursor:pointer}.btn-primary{background:#4169e1;color:#fff;border-color:#4169e1}.btn:disabled{opacity:.55;cursor:not-allowed}
      .manual-eyebrow{color:#63708a;font-size:.72rem;font-weight:700;text-transform:uppercase}.manual-search{display:grid;gap:.35rem;margin-top:1rem;font-size:.75rem;color:#4b5873}.manual-search input,.manual-search select{width:100%;border:1px solid #b9c4d6;border-radius:4px;padding:.45rem .5rem;background:#fff}
      .manual-source-list{display:grid;gap:.45rem;margin-top:1rem;min-height:0;overflow:auto}.manual-source,.manual-doc,.manual-result{display:grid;gap:.25rem;width:100%;padding:.65rem .7rem;border:1px solid #e2e7f0;border-radius:6px;background:#fff;text-align:left;cursor:pointer}
      .manual-source:hover,.manual-doc:hover,.manual-result:hover{border-color:#4c6fff;background:#f7f9ff}.manual-source.active,.manual-doc.active{border-color:#4c6fff;box-shadow:inset 3px 0 0 #4c6fff}
      .manual-source span,.manual-doc strong,.manual-result strong{color:#172033;font-size:.78rem}.manual-source small,.manual-doc span,.manual-doc small,.manual-result span,.manual-result small{color:#69758f;font-size:.7rem;line-height:1.35}
      .manual-main{padding:1rem;display:flex;flex-direction:column}.manual-alert{margin-top:1rem;border:1px solid #f0b4b4;background:#fff1f1;color:#8a1f1f;border-radius:6px;padding:.65rem .8rem;font-size:.78rem}.manual-results{margin-top:1rem}.manual-result-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.6rem;margin-top:.6rem}
      .manual-layout{display:grid;grid-template-columns:minmax(16rem,24rem) minmax(0,1fr);gap:1rem;margin-top:1rem;min-height:0;flex:1 1 auto}.manual-docs{min-width:0;overflow:auto;padding-right:.2rem}.manual-docs h3{display:flex;justify-content:space-between;margin-bottom:.55rem}.manual-docs h3 span{color:#63708a;font-weight:500}
      .manual-doc-view{min-width:0;overflow:auto;border:1px solid #e2e7f0;border-radius:8px;background:#fbfcff}.manual-doc-head{padding:1rem;border-bottom:1px solid #e2e7f0;background:#fff}.manual-doc-head p{margin-top:.45rem;color:#596782;font-size:.78rem;line-height:1.5}
      .manual-meta{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:.35rem}.manual-meta span,.manual-tags span{border:1px solid #d8dee8;border-radius:999px;padding:.12rem .45rem;background:#fff;color:#4b5873;font-size:.65rem;white-space:nowrap}.manual-tags{display:flex;flex-wrap:wrap;gap:.35rem;padding:.75rem 1rem 0}
      .manual-actions{margin:1rem;padding:.8rem;border:1px solid #c8d8ff;border-radius:6px;background:#f4f7ff}.manual-action{display:grid;gap:.2rem;margin-top:.55rem}.manual-action span{color:#596782;font-size:.72rem}.manual-body{display:grid;gap:.8rem;padding:1rem}.manual-chunk{display:grid;grid-template-columns:2rem minmax(0,1fr);gap:.75rem;padding:.8rem;border:1px solid #e2e7f0;border-radius:6px;background:#fff}.manual-chunk-index{color:#63708a;font-size:.72rem;font-weight:700}.manual-chunk p{color:#243047;font-size:.82rem;line-height:1.55;white-space:pre-wrap}.manual-empty,.manual-placeholder{padding:1rem;color:#69758f;font-size:.78rem}
      @media(max-width:1100px){.manual-shell,.manual-layout{grid-template-columns:1fr}.manual-result-grid{grid-template-columns:1fr}.manual-shell{height:auto;overflow:auto}}
    </style>
    <section class="manual-shell">
      <aside class="manual-side" aria-label="Manual navigation">
        <div class="manual-side-head">
          <h1>Manual</h1>
          <button class="btn" data-action="reload" ${s.loading ? 'disabled' : ''}>Refresh</button>
        </div>
        <label class="manual-search"><span>Search manuals</span><input name="manual-q" value="${esc(s.q)}" placeholder="10 perspective, OAA, Backbone..." /></label>
        <label class="manual-search"><span>Source</span><select name="manual-source">
          <option value="">All sources</option>
          ${(s.sources || []).map((source) => `<option value="${esc(source.id)}" ${s.source === source.id ? 'selected' : ''}>${esc(source.name)} (${esc(source.documents)})</option>`).join('')}
        </select></label>
        <div class="manual-source-list">
          ${(s.sources || []).map((source) => `<button class="manual-source ${s.source === source.id ? 'active' : ''}" data-source="${esc(source.id)}"><span>${esc(source.name)}</span><small>tier ${esc(source.authorityTier)} / ${esc(source.documents)} docs</small></button>`).join('') || '<div class="manual-empty">No manual sources.</div>'}
        </div>
      </aside>
      <main class="manual-main">
        <div class="manual-toolbar"><div><div class="manual-eyebrow">OpenSphere Console Manual</div><h2>${esc((s.selected && s.selected.item && s.selected.item.title) || 'Manual Registry')}</h2></div><button class="btn btn-primary" data-action="search" ${s.loading ? 'disabled' : ''}>Search</button></div>
        ${s.error ? `<div class="manual-alert" role="alert">${esc(s.error)}</div>` : ''}
        ${(s.hits || []).length ? `<section class="manual-results" aria-label="Manual search results"><h3>Search Results</h3><div class="manual-result-grid">${s.hits.map((hit) => `<button class="manual-result" data-doc="${esc(hit.sourceId)}"><strong>${esc(hit.title)}</strong><span>${esc(hit.excerpt)}</span><small>${esc(hit.sourcePath || hit.sourceName || hit.sourceId)} / score ${this.score(hit.score)}</small></button>`).join('')}</div></section>` : ''}
        <section class="manual-layout">
          <nav class="manual-docs" aria-label="Manual documents"><h3>Documents <span>${esc((s.documents || []).length)}</span></h3>
            ${(s.documents || []).map((doc) => `<button class="manual-doc ${(s.selected && s.selected.item && s.selected.item.sourceId === doc.sourceId) ? 'active' : ''}" data-doc="${esc(doc.sourceId)}"><strong>${esc(doc.title)}</strong><span>${esc(doc.sourcePath || doc.sourceId)}</span><small>tier ${this.tier(doc)} / ${esc(doc.chunkCount)} chunks</small></button>`).join('') || '<div class="manual-empty">No manual documents.</div>'}
          </nav>
          ${this.renderDocument()}
        </section>
      </main>
    </section>`;

    const input = this.querySelector('input[name="manual-q"]');
    const select = this.querySelector('select[name="manual-source"]');
    if (input) {
      input.addEventListener('input', () => this.setState({ q: input.value }));
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') this.search();
      });
    }
    if (select) select.addEventListener('change', () => {
      this.setState({ source: select.value });
      this.search();
    });
    this.querySelectorAll('[data-action="reload"]').forEach((el) => el.addEventListener('click', () => this.load()));
    this.querySelectorAll('[data-action="search"]').forEach((el) => el.addEventListener('click', () => this.search()));
    this.querySelectorAll('[data-source]').forEach((el) => el.addEventListener('click', () => this.selectSource(el.getAttribute('data-source'))));
    this.querySelectorAll('[data-doc]').forEach((el) => el.addEventListener('click', () => this.selectDocument(el.getAttribute('data-doc'))));
  }

  renderDocument() {
    const detail = this.state && this.state.selected;
    if (!detail) {
      return '<article class="manual-doc-view"><div class="manual-placeholder"><h3>Select a manual document</h3><p>Manual Registry is available to the console, top search, and OAA.</p></div></article>';
    }
    const item = detail.item || {};
    return `<article class="manual-doc-view">
      <header class="manual-doc-head">
        <div><div class="manual-eyebrow">${esc(item.sourceName || item.sourceId)}</div><h3>${esc(item.title)}</h3><p>${esc(item.summary)}</p></div>
        <div class="manual-meta"><span>tier ${this.tier(item)}</span><span>${esc(item.documentType || 'reference')}</span><span>${esc(item.status || 'active')}</span></div>
      </header>
      <div class="manual-tags">${[...(item.tags || []), ...(item.perspective || [])].map((tag) => `<span>${esc(tag)}</span>`).join('')}</div>
      ${(detail.actionBindings || []).length ? `<section class="manual-actions"><h4>Manual-backed actions</h4>${detail.actionBindings.map((a) => `<div class="manual-action"><strong>${esc(a.intent || a.id)}</strong><span>${esc(a.toolId)} / ${esc(a.riskLevel)} / ${esc(a.confirmation)}</span></div>`).join('')}</section>` : ''}
      <section class="manual-body">${(detail.chunks || []).map((chunk) => `<div class="manual-chunk"><div class="manual-chunk-index">#${Number(chunk.chunkIndex || 0) + 1}</div><p>${esc(chunk.content)}</p></div>`).join('')}</section>
    </article>`;
  }
}

export function activate(ctx) {
  if (!customElements.get(TAG)) customElements.define(TAG, ManualShellElement);
  ctx.extensions.registerPage({ id: 'manual', title: 'Manual', navBand: '구축 Build', elementTag: TAG });
  ctx.extensions.manual?.contribute?.({
    sourceId: 'plugin:manual',
    name: 'Manual subShell',
    authorityTier: 2,
    language: 'mixed',
    documents: [{
      id: 'overview',
      title: 'Manual subShell Overview',
      route: '/p/manual',
      sourcePath: 'backend/manual-subShell',
      documentType: 'subshell',
      tags: ['manual', 'oaa', 'subshell'],
      content: 'The Manual subShell is a registered OpenSphere UIPluginPackage. It reads canonical Manual Registry data from /api/manual/*, exposes documentation results through the top header search path /p/manual, and allows OAA to cite the same OpenSphere manual knowledge that operators inspect in the console.',
    }],
  });
}

export function deactivate() {}
