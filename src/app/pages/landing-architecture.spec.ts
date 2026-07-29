import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./landing.ts', import.meta.url), 'utf8');
const shell = fs.readFileSync(new URL('../os/os-shell.ts', import.meta.url), 'utf8');
const search = fs.readFileSync(new URL('../core/search.service.ts', import.meta.url), 'utf8');

const perspectiveStart = source.indexOf('const PERSPECTIVES');
const layerStart = source.indexOf('const LAYERS');
const componentStart = source.indexOf('@Component');
const perspectiveModel = source.slice(perspectiveStart, layerStart);
const layerModel = source.slice(layerStart, componentStart);

test('main index defines exactly ten horizontal Perspectives', () => {
  assert.equal((perspectiveModel.match(/\{ num: \d+/g) || []).length, 10);
  assert.doesNotMatch(perspectiveModel, /\{ num: 0,/);
  assert.match(source, /10 Perspectives/);
  assert.match(source, /Horizontal service lenses/);
});

test('main index defines exactly six vertical Service Realization Layers', () => {
  assert.equal((layerModel.match(/\n\s+num: \d,/g) || []).length, 6);
  for (const name of [
    'Host Infrastructure Layer',
    'Console Backbone Layer',
    'Platform Control Layer',
    'Platform Support Layer',
    'Platform Foundation Layer',
    'Domain Service Layer',
  ]) {
    assert.match(layerModel, new RegExp(name));
  }
  assert.match(source, /Vertical realization structure/);
});

test('Main Shell is a Platform Control object instead of Perspective zero', () => {
  const platformControl = layerModel.slice(
    layerModel.indexOf("name: 'Platform Control Layer'"),
    layerModel.indexOf("name: 'Console Backbone Layer'"),
  );
  assert.match(platformControl, /'Main Shell'/);
  assert.doesNotMatch(perspectiveModel, /Main Shell/);
});

test('architecture index teaches coordinates, contracts, and evidence', () => {
  assert.match(source, /Service = Perspective × Layer/);
  assert.match(source, /Requires/);
  assert.match(source, /Establishes/);
  assert.match(source, /Ready evidence/);
  assert.match(source, /존재는 Ready의 증거가 아닙니다/);
  assert.match(source, /OpenSphere Ten-Perspective and Six-Layer/);
  assert.match(source, /Service Realization Architecture/);
});

test('architecture sections do not inherit the global Console header height', () => {
  assert.doesNotMatch(source, /<header class="architecture-hero"/);
  assert.doesNotMatch(source, /<header class="section-heading"/);
  assert.match(source, /<section class="architecture-hero"/);
  assert.match(source, /class="service-group-heading"/);
});

test('Perspective navigation remains Registry-derived and phantom-route free', () => {
  assert.match(source, /new Set\(this\.ext\.pages\(\)\.map/);
  assert.match(source, /routeForPlugin\(perspective\.pluginId\)/);
  assert.match(source, /registered\.has\(perspective\.pluginId\)/);
  assert.match(shell, /홈 · 10P × 6L/);
  assert.match(search, /홈 · 10P × 6L/);
});
