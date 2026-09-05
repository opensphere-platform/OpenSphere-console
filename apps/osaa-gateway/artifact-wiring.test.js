'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const root = join(__dirname, '..', '..');
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');

test('OSDST can revalidate the current caller at C_API without widening namespace access', () => {
  const yaml = require('js-yaml');
  const policy = yaml.loadAll(read('apps','console-api','deploy.yaml'))
    .find(d=>d.kind==='NetworkPolicy' && d.metadata.name==='opensphere-console-api');
  const ingress = policy.spec.ingress.find(rule=>rule.from.some(peer=>peer.podSelector?.matchLabels?.app==='opensphere-osdst'));
  assert.ok(ingress);
  assert.deepEqual(ingress.ports, [{protocol:'TCP',port:8080}]);
  assert.ok(ingress.from.every(peer=>!peer.namespaceSelector && Object.keys(peer.podSelector.matchLabels).length===1));
});

test('C_AI manifest uses the canonical OSAA gateway release artifact', () => {
  const manifest = read('apps', 'osaa-gateway', 'deploy.yaml');
  const dockerfile = read('apps', 'osaa-gateway', 'Dockerfile');
  const matrix = read('scripts', 'release-artifact-matrix.test.mjs');
  const publisher = read('scripts', 'Publish-LocalEdge.ps1');

  assert.equal((manifest.match(/__OPENSPHERE_OSAA_GATEWAY_IMAGE__/gu) || []).length, 1);
  assert.doesNotMatch(manifest, /opensphere-console-osaa-gateway@sha256:/u);
  assert.match(manifest, /podSelector: \{ matchLabels: \{ app[.]kubernetes[.]io\/name: opensphere-console-api \} \}/u);
  assert.doesNotMatch(manifest, /namespaceSelector|podSelector: \{\}/u);
  assert.match(dockerfile, /COPY console-identity-client[.]js \/app\/console-identity-client[.]js/u);
  assert.match(matrix, /\['osaaGateway', 'opensphere-console-osaa-gateway', 'apps\/osaa-gateway\/Dockerfile'\]/u);
  assert.match(publisher, /Key = 'osaaGateway'; Image = 'opensphere-console-osaa-gateway'/u);
  assert.match(manifest,
    /OPENSPHERE_RELEASE_CHANNEL, value: "__OPENSPHERE_RELEASE_CHANNEL__"[\s\S]+OPENSPHERE_AUTH_ENVIRONMENT, value: "__OPENSPHERE_AUTH_ENVIRONMENT__"[\s\S]+OPENSPHERE_CONSOLE_ORIGIN, value: "__OPENSPHERE_CONSOLE_URL__"/u);
});

test('C_AI credential custody is namespace-limited while general mutation stays closed', () => {
  const manifest = read('apps', 'osaa-gateway', 'deploy.yaml');

  assert.match(manifest,
    /name: opensphere-console-osaa-gateway-credentials, namespace: opensphere-osaa-credentials[\s\S]+resources: \[secrets\], verbs: \[get, list, create, patch, delete\]/u);
  assert.match(manifest,
    /name: OSAA_MUTATION_ENABLED, value: "false"[\s\S]+name: OSAA_LLM_CREDENTIAL_MUTATION_ENABLED, value: "true"[\s\S]+name: OSAA_LLM_CREDENTIAL_DELETION_ENABLED, value: "true"/u);
  assert.match(manifest,
    /name: OSAA_PG_USER, valueFrom: \{ secretKeyRef: \{ name: opensphere-osaa-gateway-db, key: username \} \}[\s\S]+name: OSAA_PG_PASSWORD, valueFrom: \{ secretKeyRef: \{ name: opensphere-osaa-gateway-db, key: password \} \}/u);
  assert.doesNotMatch(manifest,
    /name: OSAA_PG_(?:USER|PASSWORD)[^\n]+opensphere-osaa-runtime/u);
  assert.doesNotMatch(manifest,
    /metadata: \{ name: opensphere-console-osaa-gateway-(?:recovery-)?reader, namespace: opensphere-(?:console-recovery|foundation) \}/u);
  assert.doesNotMatch(manifest,
    /name: opensphere-console-osaa-gateway-credentials[\s\S]{0,500}verbs: \[[^\]]*(?:\*|update)[^\]]*\]/u);
});

test('local edge development MFA exception reaches the durable C_AI audit boundary', () => {
  const server = read('apps', 'osaa-gateway', 'server.js');
  const migration = read('migrations', 'versions', '0034_local_edge_development_mfa_audit.sql');

  assert.match(server, /const C_AI_RUNTIME_PROFILE = Object[.]freeze\(\{[\s\S]+OPENSPHERE_RELEASE_CHANNEL[\s\S]+OPENSPHERE_AUTH_ENVIRONMENT[\s\S]+R2D2_CLUSTER_ID[\s\S]+OPENSPHERE_CONSOLE_ORIGIN/u);
  assert.match(server, /developmentUserMfaDisabled\(C_AI_RUNTIME_PROFILE\)/u);
  assert.match(server, /\$10::text,\$11::boolean[\s\S]+C_AI_DEVELOPMENT_USER_MFA_DISABLED/u);
  assert.match(server, /runtimeProfile: C_AI_RUNTIME_PROFILE/u);

  assert.match(migration, /p_allow_development_user_aal1 boolean/u);
  assert.match(migration, /assert_current_actor\([\s\S]+NOT p_allow_development_user_aal1/u);
  assert.match(migration, /developmentUserMfaDisabled',p_allow_development_user_aal1/u);
  assert.match(migration, /REVOKE ALL ON FUNCTION[\s\S]+FROM PUBLIC,anon,authenticated,service_role/u);
  assert.doesNotMatch(migration, /GRANT EXECUTE[\s\S]+TO (?:PUBLIC|anon|authenticated|service_role)/u);
});
