import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./landing.ts', import.meta.url), 'utf8');
const realizationModel = fs.readFileSync(
  new URL('../architecture/service-realization.model.ts', import.meta.url),
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
