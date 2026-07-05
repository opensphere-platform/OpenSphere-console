const TAG = 'osp-manual-shell';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}[c]));

const ICONS = {
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.7 5a5.7 5.7 0 0 1 4.55 9.14l3.3 3.3-1.42 1.42-3.3-3.3A5.7 5.7 0 1 1 10.7 5Zm0 2a3.7 3.7 0 1 0 0 7.4 3.7 3.7 0 0 0 0-7.4Z"/></svg>',
  docs: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h9l4 4v14H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm8 1.8V8h3.2L14 4.8ZM7 12h9v1.6H7V12Zm0 4h7v1.6H7V16Z"/></svg>',
  graph: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5a3 3 0 0 1 5.83 1h2.34A3 3 0 1 1 18 10.83v2.34A3 3 0 1 1 13.17 16h-2.34A3 3 0 1 1 6 13.17v-2.34A3 3 0 0 1 7 5Zm3 3a1 1 0 1 0-2 0 1 1 0 0 0 2 0Zm9 0a1 1 0 1 0-2 0 1 1 0 0 0 2 0ZM8 17a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm9 1a1 1 0 1 0 2 0 1 1 0 0 0-2 0Zm-6.17-10A3 3 0 0 1 8 10.83v2.34A3 3 0 0 1 10.83 16h2.34A3 3 0 0 1 16 13.17v-2.34A3 3 0 0 1 15.17 8h-4.34Z"/></svg>',
  action: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2 7 4v6c0 4.7-3 8.9-7 10-4-1.1-7-5.3-7-10V6l7-4Zm0 2.3L7 7.1V12c0 3.5 2 6.6 5 7.7 3-1.1 5-4.2 5-7.7V7.1l-5-2.8Zm1 3.7v4h3l-5 5v-4H8l5-5Z"/></svg>',
  source: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5Zm9 0v4h4l-4-4ZM7 12h10v1.6H7V12Zm0 3h10v1.6H7V15Zm0 3h6v1.6H7V18Z"/></svg>',
};

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
  if (!res.ok) throw new Error(`Manual Registry HTTP ${res.status}`);
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
      this.setState({ error: err instanceof Error ? err.message : String(err), selected: null });
    } finally {
      this.setState({ loading: false });
    }
  }

  async search() {
    updateQuery({ q: this.state.q.trim(), source: this.state.source, doc: '' });
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

  cards() {
    const documents = this.state.documents || [];
    const sources = this.state.sources || [];
    const selected = this.state.selected;
    return [
      {
        icon: ICONS.docs,
        title: 'Manual Documents',
        meta: `${documents.length} documents`,
        body: 'Authoritative guides, architecture notes, policies, and runbooks.',
        accent: 'teal',
      },
      {
        icon: ICONS.source,
        title: 'Manual Sources',
        meta: `${sources.length} sources`,
        body: 'Constitution, architecture, product manual, implementation notes, and imported references.',
        accent: 'ochre',
      },
      {
        icon: ICONS.graph,
        title: 'Concept Graph',
        meta: selected ? (selected.item && selected.item.documentType) || 'reference' : 'OAA context',
        body: 'OpenSphere-specific terms such as the 10 Perspectives are linked for OAA retrieval.',
        accent: 'blue',
      },
      {
        icon: ICONS.action,
        title: 'Manual-backed Actions',
        meta: selected ? `${(selected.actionBindings || []).length} actions` : 'guarded',
        body: 'Executable operations stay tied to manual evidence, permission, confirmation, and audit.',
        accent: 'plum',
      },
    ];
  }

  render() {
    const s = this.state || {};
    this.innerHTML = `<style>
      ${TAG}{display:block;height:100%;min-height:calc(100vh - 3rem);background:#f3f4f6;color:#1d252d;font-family:var(--clr-font, "Oracle Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif)}
      ${TAG} *{box-sizing:border-box}
      ${TAG} svg{width:1.2rem;height:1.2rem;fill:currentColor;flex:0 0 auto}
      .manual-page{height:calc(100vh - 3rem);overflow:auto;background:#f3f4f6}
      .manual-shell-hero{max-width:87rem;display:grid;align-items:center;min-height:15rem;grid-template-columns:minmax(0,1fr) 22rem;padding:.5rem 0 2rem}
      .manual-shell-hero__copy h1{max-width:43rem;margin:0;font-size:clamp(2.5rem,4vw,3.5rem);font-weight:300;letter-spacing:-.03em;line-height:1.05;color:#161616}
      .manual-shell-hero__copy p{max-width:42rem;margin:1.1rem 0 0;color:#525252;font-size:1.05rem;line-height:1.45}
      .manual-shell-hero__art{height:13rem;transform:scale(.85);transform-origin:center right}
      .manual-shell-hero__art img{display:block;height:100%;width:100%;object-fit:contain;object-position:right center}
      .manual-searchbar{margin:0 0 1.2rem;height:3rem;display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:.75rem;padding:0 .75rem 0 1rem;background:#fff;border:1px solid #d9dee5;border-radius:4px;box-shadow:0 .0625rem .18rem rgba(15,23,42,.08);color:#1d252d}
      .manual-searchbar input{width:100%;border:0;outline:0;font:inherit;font-size:.95rem;background:transparent;color:#1d252d}.manual-searchbar input::placeholder{color:#6d7378}
      .manual-searchbar button,.manual-button{border:0;border-radius:3px;background:#312d2a;color:#fff;padding:.55rem .85rem;font-weight:700;font-size:.72rem;letter-spacing:.02em;cursor:pointer}.manual-searchbar button:disabled,.manual-button:disabled{opacity:.55;cursor:not-allowed}
      .manual-main{max-width:87rem;margin:0 auto;padding:1.25rem 1.4rem 3rem;position:relative}
      .manual-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(21rem,28rem);gap:1.2rem;align-items:start}
      .manual-card-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem}
      .manual-card,.manual-panel,.manual-doc-view,.manual-banner{background:#fff;border:1px solid #dedbd5;border-radius:4px;box-shadow:0 .12rem .45rem rgba(28,25,23,.1)}
      .manual-card{min-height:10.2rem;padding:1.35rem 1.45rem;display:grid;grid-template-columns:auto minmax(0,1fr);gap:1rem;position:relative;overflow:hidden}
      .manual-card::after{content:"";position:absolute;right:-2rem;top:-2rem;width:8rem;height:8rem;border-radius:999px;opacity:.12;background:#507a7b}
      .manual-card.ochre::after{background:#c9914b}.manual-card.blue::after{background:#3a6ea5}.manual-card.plum::after{background:#7a4055}
      .manual-card-icon{color:#312d2a;margin-top:.15rem}.manual-card h2{margin:0;font-size:1.08rem;line-height:1.25}.manual-card p{margin:.7rem 0 0;color:#424a50;font-size:.84rem;line-height:1.45}.manual-card small{display:block;margin-top:.4rem;color:#77706a;font-size:.72rem}
      .manual-panel{padding:1.2rem}.manual-panel-head{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-bottom:.9rem}.manual-panel h2{margin:0;font-size:1.05rem}.manual-panel-count{color:#716b64;font-size:.85rem}
      .manual-source-list,.manual-doc-list,.manual-result-list{display:grid;gap:.55rem;max-height:20rem;overflow:auto}
      .manual-source,.manual-doc,.manual-result{width:100%;border:1px solid #e4e0da;background:#fff;border-radius:4px;padding:.72rem .82rem;text-align:left;cursor:pointer;display:grid;gap:.25rem}
      .manual-source:hover,.manual-doc:hover,.manual-result:hover{border-color:#8c7b65;background:#fbfaf8}.manual-source.active,.manual-doc.active{border-color:#312d2a;box-shadow:inset .2rem 0 0 #c74634}
      .manual-source strong,.manual-doc strong,.manual-result strong{font-size:.82rem;color:#1d252d}.manual-source span,.manual-doc span,.manual-result span{font-size:.74rem;line-height:1.35;color:#5f676e}.manual-source small,.manual-doc small,.manual-result small{font-size:.68rem;color:#7d756e}
      .manual-content{margin-top:1.2rem;display:grid;grid-template-columns:minmax(18rem,24rem) minmax(0,1fr);gap:1.2rem;align-items:start}
      .manual-doc-view{min-height:28rem;overflow:hidden}.manual-doc-head{padding:1.35rem 1.5rem;border-bottom:1px solid #e4e0da;background:#fff}.manual-eyebrow{color:#746b61;font-size:.72rem;font-weight:800;text-transform:uppercase}.manual-doc-head h2{margin:.25rem 0 0;font-size:1.45rem;line-height:1.18}.manual-doc-head p{margin:.6rem 0 0;color:#4d555c;font-size:.86rem;line-height:1.5}
      .manual-meta{display:flex;flex-wrap:wrap;gap:.35rem;margin-top:.9rem}.manual-meta span,.manual-tags span{border:1px solid #dad5cd;border-radius:999px;padding:.16rem .5rem;background:#fff;color:#4c555c;font-size:.68rem;white-space:nowrap}
      .manual-tags{display:flex;flex-wrap:wrap;gap:.35rem;padding:1rem 1.5rem 0}.manual-actions{margin:1rem 1.5rem;padding:.9rem;border-left:.22rem solid #c74634;background:#fff8f5}.manual-actions h3{margin:0;font-size:.92rem}.manual-action{display:grid;gap:.18rem;margin-top:.6rem}.manual-action strong{font-size:.8rem}.manual-action span{font-size:.72rem;color:#60686f}
      .manual-body{display:grid;gap:.8rem;padding:1rem 1.5rem 1.5rem}.manual-chunk{display:grid;grid-template-columns:2.2rem minmax(0,1fr);gap:.75rem;padding:.85rem;border:1px solid #e4e0da;border-radius:4px;background:#fff}.manual-chunk-index{color:#746b61;font-size:.72rem;font-weight:800}.manual-chunk p{margin:0;color:#263038;font-size:.84rem;line-height:1.6;white-space:pre-wrap}
      .manual-empty{padding:1rem;color:#6d7378;font-size:.82rem}.manual-banner{margin-top:1rem;padding:1rem 1.15rem;border-color:#f1d7ad;background:#fff3dc;color:#4f3b1e}.manual-banner strong{display:block;font-size:.9rem}.manual-banner span{display:block;margin-top:.35rem;font-size:.78rem;line-height:1.45}
      @media(max-width:1100px){.manual-shell-hero{grid-template-columns:1fr;min-height:auto}.manual-shell-hero__art{display:none}.manual-grid,.manual-content{grid-template-columns:1fr}.manual-card-grid{grid-template-columns:1fr}}
    </style>
    <div class="manual-page">
      <main class="manual-main">
        <section class="manual-shell-hero">
          <div class="manual-shell-hero__copy">
            <h1>Search and manage OpenSphere manuals</h1>
            <p>Find OpenSphere manuals, 10 Perspective knowledge, OAA action bindings, and implementation runbooks from one place.</p>
          </div>
          <div aria-hidden="true" class="manual-shell-hero__art">
            <img src="/ibm-assets/containers-pillar-overview-header.svg" alt="" />
          </div>
        </section>
        <div class="manual-searchbar">
          ${ICONS.search}
          <input name="manual-q" value="${esc(s.q)}" placeholder="Search manuals, 10 Perspective, OAA Gateway, Backbone..." />
          <button data-action="search" ${s.loading ? 'disabled' : ''}>Search</button>
        </div>
        <section class="manual-grid">
          <div>
            <div class="manual-card-grid">
              ${this.cards().map((card) => `<article class="manual-card ${esc(card.accent)}"><div class="manual-card-icon">${card.icon}</div><div><h2>${esc(card.title)}</h2><small>${esc(card.meta)}</small><p>${esc(card.body)}</p></div></article>`).join('')}
            </div>
            ${s.error ? `<div class="manual-banner"><strong>Manual Registry is temporarily unavailable.</strong><span>${esc(s.error)}. The portal shell is ready; retry after the OAA manual API recovers.</span></div>` : ''}
          </div>
          <aside class="manual-panel">
            <div class="manual-panel-head"><h2>Sources</h2><button class="manual-button" data-action="reload" ${s.loading ? 'disabled' : ''}>Refresh</button></div>
            <div class="manual-source-list">
              ${(s.sources || []).map((source) => `<button class="manual-source ${s.source === source.id ? 'active' : ''}" data-source="${esc(source.id)}"><strong>${esc(source.name)}</strong><span>${esc(source.type || 'manual source')}</span><small>tier ${esc(source.authorityTier)} / ${esc(source.documents)} docs</small></button>`).join('') || '<div class="manual-empty">No manual sources.</div>'}
            </div>
          </aside>
        </section>
        ${(s.hits || []).length ? `<section class="manual-panel" style="margin-top:1.2rem"><div class="manual-panel-head"><h2>Search Results</h2><span class="manual-panel-count">${esc(s.hits.length)}</span></div><div class="manual-result-list">${s.hits.map((hit) => `<button class="manual-result" data-doc="${esc(hit.sourceId)}"><strong>${esc(hit.title)}</strong><span>${esc(hit.excerpt)}</span><small>${esc(hit.sourcePath || hit.sourceName || hit.sourceId)} / score ${this.score(hit.score)}</small></button>`).join('')}</div></section>` : ''}
        <section class="manual-content">
          <nav class="manual-panel" aria-label="Manual documents">
            <div class="manual-panel-head"><h2>Documents</h2><span class="manual-panel-count">${esc((s.documents || []).length)}</span></div>
            <div class="manual-doc-list">
              ${(s.documents || []).map((doc) => `<button class="manual-doc ${(s.selected && s.selected.item && s.selected.item.sourceId === doc.sourceId) ? 'active' : ''}" data-doc="${esc(doc.sourceId)}"><strong>${esc(doc.title)}</strong><span>${esc(doc.sourcePath || doc.sourceId)}</span><small>tier ${this.tier(doc)} / ${esc(doc.chunkCount)} chunks</small></button>`).join('') || '<div class="manual-empty">No manual documents.</div>'}
            </div>
          </nav>
          ${this.renderDocument()}
        </section>
      </main>
    </div>`;

    const input = this.querySelector('input[name="manual-q"]');
    if (input) {
      input.addEventListener('input', () => this.setState({ q: input.value }));
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') this.search();
      });
    }
    this.querySelectorAll('[data-action="reload"]').forEach((el) => el.addEventListener('click', () => this.load()));
    this.querySelectorAll('[data-action="search"]').forEach((el) => el.addEventListener('click', () => this.search()));
    this.querySelectorAll('[data-source]').forEach((el) => el.addEventListener('click', () => this.selectSource(el.getAttribute('data-source'))));
    this.querySelectorAll('[data-doc]').forEach((el) => el.addEventListener('click', () => this.selectDocument(el.getAttribute('data-doc'))));
  }

  renderDocument() {
    const detail = this.state && this.state.selected;
    if (!detail) {
      return '<article class="manual-doc-view"><div class="manual-doc-head"><div class="manual-eyebrow">OpenSphere Console Manual</div><h2>Select a manual document</h2><p>Manual Registry is available to the console, top search, and OAA. Use the search box above or choose a source when the registry is available.</p></div></article>';
    }
    const item = detail.item || {};
    return `<article class="manual-doc-view">
      <header class="manual-doc-head">
        <div class="manual-eyebrow">${esc(item.sourceName || item.sourceId)}</div>
        <h2>${esc(item.title)}</h2>
        <p>${esc(item.summary)}</p>
        <div class="manual-meta"><span>tier ${this.tier(item)}</span><span>${esc(item.documentType || 'reference')}</span><span>${esc(item.status || 'active')}</span></div>
      </header>
      <div class="manual-tags">${[...(item.tags || []), ...(item.perspective || [])].map((tag) => `<span>${esc(tag)}</span>`).join('')}</div>
      ${(detail.actionBindings || []).length ? `<section class="manual-actions"><h3>Manual-backed actions</h3>${detail.actionBindings.map((a) => `<div class="manual-action"><strong>${esc(a.intent || a.id)}</strong><span>${esc(a.toolId)} / ${esc(a.riskLevel)} / ${esc(a.confirmation)}</span></div>`).join('')}</section>` : ''}
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
