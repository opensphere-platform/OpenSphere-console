import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./landing.ts', import.meta.url), 'utf8');
const realizationModel = fs.readFileSync(
  new URL('../architecture/service-realization.model.ts', import.meta.url),
  'utf8',
);
const foundationSource = fs.readFileSync(new URL('./landing-foundations.ts', import.meta.url), 'utf8');
const foundationModel = fs.readFileSync(
  new URL('../architecture/foundation-concepts.model.ts', import.meta.url),
  'utf8',
);
const shell = fs.readFileSync(new URL('../os/os-shell.ts', import.meta.url), 'utf8');
const search = fs.readFileSync(new URL('../core/search.service.ts', import.meta.url), 'utf8');

const perspectiveStart = source.indexOf('const PERSPECTIVES');
const componentStart = source.indexOf('@Component');
const perspectiveModel = source.slice(perspectiveStart, componentStart);

test('main index defines exactly ten horizontal Perspectives', () => {
  assert.equal((perspectiveModel.match(/\{ num: \d+/g) || []).length, 10);
  assert.doesNotMatch(perspectiveModel, /\{ num: 0,/);
  assert.match(source, /10 Perspectives/);
  assert.match(source, /Horizontal service lenses/);
});

test('main index defines exactly six vertical Service Realization Layers', () => {
  assert.equal((realizationModel.match(/id: 'SRL-L\d'/g) || []).length, 6);
  for (const name of [
    'Host Infrastructure Layer',
    'Console Backbone Layer',
    'Platform Control Layer',
    'Platform Support Layer',
    'Platform Foundation Layer',
    'Domain Service Layer',
  ]) {
    assert.match(realizationModel, new RegExp(name));
  }
  assert.match(source, /Vertical realization structure/);
});

test('Main Shell is a Platform Control object instead of Perspective zero', () => {
  const platformControl = realizationModel.slice(
    realizationModel.indexOf("name: 'Platform Control Layer'"),
    realizationModel.indexOf("name: 'Console Backbone Layer'"),
  );
  assert.match(platformControl, /'Main Shell'/);
  assert.doesNotMatch(perspectiveModel, /Main Shell/);
});

test('architecture index teaches coordinates, contracts, and evidence', () => {
  assert.match(source, /Service = Perspective × Layer/);
  assert.match(source, /Requires/);
  assert.match(source, /Establishes/);
  assert.match(source, /Ready evidence/);
  assert.match(source, /Lifecycle authority/);
  assert.match(source, /존재는 Ready의 증거가 아닙니다/);
  assert.match(source, /OpenSphere Ten-Perspective and Six-Layer/);
  assert.match(source, /Service Realization Architecture/);
});

test('layer model distinguishes persistent structure from bootstrap establishment order', () => {
  assert.match(realizationModel, /SERVICE_REALIZATION_ESTABLISHMENT_SEQUENCE/);
  assert.match(
    realizationModel,
    /'SRL-L1\.Bootstrap'[\s\S]+'SRL-L3\.MainShellAndClusterManagerReady'[\s\S]+'SRL-L1\.HISPreflightReady'/,
  );
  assert.match(realizationModel, /failurePolicy:/);
  assert.match(realizationModel, /authority:/);
  assert.match(realizationModel, /Observability Runtime & Control/);
  assert.match(realizationModel, /Observability Binding/);
});

test('architecture sections do not inherit the global Console header height', () => {
  assert.doesNotMatch(source, /<header class="architecture-hero"/);
  assert.doesNotMatch(source, /<header class="section-heading"/);
  assert.match(source, /<section class="architecture-hero"/);
  assert.match(source, /class="service-group-heading"/);
});

test('architecture body copy uses the enlarged readability step', () => {
  assert.match(source, /\.hero-lead[\s\S]{0,180}font-size: 1rem/);
  assert.match(source, /\.axis-definitions p[\s\S]{0,180}font-size: 0\.74rem/);
  assert.match(source, /\.layer-overview p[\s\S]{0,180}font-size: 0\.68rem/);
  assert.match(source, /\.layer-contract dd[\s\S]{0,180}font-size: 0\.62rem/);
  assert.match(source, /\.model-rules p[\s\S]{0,180}font-size: 0\.68rem/);
});

test('Perspective navigation remains Registry-derived and phantom-route free', () => {
  assert.match(source, /new Set\(this\.ext\.pages\(\)\.map/);
  assert.match(source, /routeForPlugin\(perspective\.pluginId\)/);
  assert.match(source, /registered\.has\(perspective\.pluginId\)/);
  assert.match(shell, /홈 · 10P × 6L/);
  assert.match(search, /홈 · 10P × 6L/);
});

test('main index adds exactly four foundation concept tabs with keyboard semantics', () => {
  assert.match(source, /<os-landing-foundations/);
  assert.equal((foundationModel.match(/id: '(?:service-stacks|dupa|control-pillars|ai-lifecycle)'/g) || []).length, 4);
  assert.match(foundationSource, /role="tablist"/);
  assert.match(foundationSource, /role="tab"/);
  assert.match(foundationSource, /role="tabpanel"/);
  assert.match(foundationSource, /aria-selected/);
  for (const key of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End']) {
    assert.match(foundationSource, new RegExp(key));
  }
});

test('foundation concepts remain readable and contained across viewport widths', () => {
  assert.match(foundationSource, /:host \{[^}]*min-width:0;[^}]*max-width:100%/);
  assert.match(foundationSource, /\.foundation-docs \{[^}]*max-width:100%;[^}]*overflow:hidden/);
  assert.match(
    foundationSource,
    /\.foundation-tabs \{[^}]*repeat\(auto-fit,minmax\(13rem,1fr\)\)/,
  );
  assert.match(
    foundationSource,
    /\.ai-pipeline \{[^}]*repeat\(auto-fit,minmax\(10\.5rem,1fr\)\)/,
  );
  assert.match(foundationSource, /\.document-intro \{[^}]*background:var\(--os-surface-1\)/);
  assert.doesNotMatch(foundationSource, /background:#161616|background:#393939/);
});

test('foundation concepts enlarge body copy without changing the title line', () => {
  assert.match(foundationSource, /<h2 id="foundation-docs-title">원자적 구성을 지탱하는 네 가지 설계 계약<\/h2>/);
  assert.match(
    foundationSource,
    /\.foundation-heading h2,\.section-title h3 \{[^}]*font-size:1\.28rem/,
  );
  assert.match(
    foundationSource,
    /\.foundation-heading>p,\.section-title>p \{[^}]*font-size:\.8rem/,
  );
  assert.match(
    foundationSource,
    /--fd-body:\.88rem; --fd-detail:\.8rem; --fd-label:\.68rem; --fd-card-title:\.94rem/,
  );
  assert.match(foundationSource, /\.definition-card>p \{[^}]*font-size:var\(--fd-body\)/);
  assert.match(foundationSource, /\.definition-card dd \{[^}]*font-size:var\(--fd-detail\)/);
});

test('foundation concepts use the approved local pictogram set without a runtime CDN dependency', () => {
  const pictograms = [
    'cloud-infrastructure-management.svg',
    'connected-ecosystem.svg',
    'control-tower.svg',
    'ai-governance-lifecycle-factsheet.svg',
  ];
  for (const pictogram of pictograms) {
    assert.match(foundationModel, new RegExp(`/assets/pictograms/${pictogram.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}`));
    assert.equal(
      fs.existsSync(new URL(`../../../public/assets/pictograms/${pictogram}`, import.meta.url)),
      true,
      `${pictogram} must ship with the Console image`,
    );
    const svg = fs.readFileSync(
      new URL(`../../../public/assets/pictograms/${pictogram}`, import.meta.url),
      'utf8',
    );
    assert.match(svg, /^<svg[^>]+viewBox="0 0 32 32"/);
    assert.doesNotMatch(svg, /<script|<foreignObject|\son\w+=|(?:href|src)=/i);
  }
  assert.equal((foundationSource.match(/class="tab-pictogram"/g) || []).length, 1);
  assert.equal((foundationSource.match(/class="section-pictogram"/g) || []).length, 4);
  assert.doesNotMatch(`${foundationSource}\n${foundationModel}`, /pictograms\.opl\.io\.kr|cdn\.statically\.io/);
  assert.doesNotMatch(foundationSource, /\.tab-pictogram,\.section-pictogram \{[^}]*background:/);
  assert.match(foundationSource, /class="tab-pictogram"[\s\S]{0,120}width="44" height="44"/);
  assert.equal((foundationSource.match(/class="section-pictogram"[\s\S]{0,160}width="70" height="70"/g) || []).length, 4);
});

test('CBSS products use their approved local product logos without decorative tiles or a runtime CDN', () => {
  const logos = [
    'supabase-icon.svg',
    'gitea.svg',
    'beszel-light.svg',
  ];
  for (const logo of logos) {
    assert.match(foundationModel, new RegExp(`/assets/product-logos/${logo.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}`));
    const logoPath = new URL(`../../../public/assets/product-logos/${logo}`, import.meta.url);
    assert.equal(fs.existsSync(logoPath), true, `${logo} must ship with the Console image`);
    const svg = fs.readFileSync(logoPath, 'utf8');
    assert.match(svg, /<svg[^>]+viewBox=/);
    assert.doesNotMatch(svg, /<script|<foreignObject|\son\w+=|<(?:image|use)[^>]+(?:href|src)=/i);
  }
  assert.equal((foundationModel.match(/productLogo: '\/assets\/product-logos\//g) || []).length, 3);
  assert.equal((foundationModel.match(/productLogoAlt: '[^']+ product logo'/g) || []).length, 3);
  assert.match(foundationSource, /@if \(component\.productLogo\)/);
  assert.match(foundationSource, /<img \[src\]="component\.productLogo" \[alt\]="component\.productLogoAlt \?\? component\.id" width="36" height="36" style="object-fit:contain"/);
  assert.doesNotMatch(`${foundationSource}\n${foundationModel}`, /logos\.opl\.io\.kr|cdn\.statically\.io/);
  assert.doesNotMatch(foundationSource, /product-logo[^}]*background:/);
  assert.match(foundationSource, /원자적 구성을 지탱하는 네 가지 설계 계약/);
});

test('Service Stack documentation defines HISS CBSS PFSS owners and hard boundaries', () => {
  for (const term of [
    'Host Infrastructure Service Stack',
    'Console Backbone Service Stack',
    'Platform Foundation Service Stack',
    'Supabase',
    'Gitea',
    'Beszel',
    'Operator',
  ]) {
    assert.match(`${foundationModel}\n${foundationSource}`, new RegExp(term));
  }
  assert.match(foundationSource, /왜 관리 도구와 대상 리소스를 완전히 분리하는가/);
  assert.match(foundationModel, /Main Shell의 직접 kubectl\/SQL 변경/);
  assert.match(foundationModel, /관측 결과를 근거로 한 무승인 자동 변경/);
});

test('DUPA documentation preserves host ownership and separates Runtime Units from plugins', () => {
  assert.match(foundationSource, /Dynamic UI Plugin Architecture/);
  assert.match(foundationSource, /서명된 신뢰 코드 실행/);
  assert.match(foundationSource, /hostRef=&lt;subShell&gt;/);
  assert.match(foundationSource, /기능적 유형/);
  assert.match(foundationSource, /설치 schema의 새로운 kind가 아닙니다/);
  assert.match(foundationModel, /OpenSphere Agent Runtime/);
  assert.match(foundationModel, /Runtime Unit/);
  assert.match(foundationModel, /Pod \/ KubeVirt Agent Playground/);
  assert.match(foundationModel, /요청 격리보다 약한 Driver로 자동 하향/);
});

test('control pillars use one capability owner and keep OAA CLI Shell as surfaces', () => {
  for (const term of [
    'OpenSphere AI Agent',
    'OpenSphere CLI',
    'OpenSphere OS Shell',
    'Capability & Owner API',
    'Plan · Approval · Operation',
    'Audit · Receipt · Recovery',
  ]) {
    assert.match(foundationModel, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(foundationSource, /표면은 authority가 아닙니다/);
  assert.match(foundationSource, /PFSS PostgreSQL plan → approval → durable apply → watch → receipt/);
  assert.match(foundationModel, /service account fallback/);
  assert.match(foundationModel, /raw kubectl\/SQL/);
});

test('AI lifecycle distinguishes current runtime from target model and playground contracts', () => {
  const aiLifecycle = foundationModel.slice(
    foundationModel.indexOf('export const AI_LIFECYCLE'),
    foundationModel.indexOf('export const MODEL_LOCATIONS'),
  );
  assert.equal((aiLifecycle.match(/step: '0[1-7]', title:/g) || []).length, 7);
  for (const term of [
    'Source & Curate',
    'Train & Adapt',
    'Evaluate & Admit',
    'Allocate & Serve',
    'Assign & Run',
    'Observe & Govern',
    'Replace & Retire',
  ]) {
    assert.match(foundationModel, new RegExp(term.replace('&', '&')));
  }
  assert.match(foundationSource, /R2D2 Native Runtime/);
  assert.match(foundationSource, /AgentRunRead v1/);
  assert.match(foundationSource, /DEFERRED/);
  assert.match(foundationSource, /No automatic downgrade/);
  assert.match(foundationSource, /AI-Workbench UI나 Agent workspace/);
});
