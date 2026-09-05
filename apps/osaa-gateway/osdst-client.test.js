'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

test('OSDST owner calls bind the bearer to the OSAA Gateway admission marker', async () => {
  const previousFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ conversations: [] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  try { await require('./osdst-client').createOsdstClient().list({ bearerToken: 'synthetic-owner-token' }); }
  finally { global.fetch = previousFetch; }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.authorization, 'Bearer synthetic-owner-token');
  assert.equal(calls[0].options.headers['x-os-owner-admission'], 'osaa-gateway-v1');
});

test('maintenance readiness calls the OSDST owner without forwarding a user credential', async (t) => {
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/readyz');
    assert.equal(req.headers.authorization, undefined);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({service:'opensphere-osdst',ready:true,maintenance:{ready:true}}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const previous = process.env.OSDST_URL;
  process.env.OSDST_URL = `http://127.0.0.1:${server.address().port}`;
  const modulePath = require.resolve('./osdst-client');
  delete require.cache[modulePath];
  t.after(() => { server.close(); delete require.cache[modulePath]; if(previous===undefined) delete process.env.OSDST_URL; else process.env.OSDST_URL=previous; });
  assert.equal((await require('./osdst-client').createOsdstClient().maintenanceReadiness()).maintenance.ready, true);
});

test('chat rejects wrong-owner, unavailable, or incomplete maintenance readiness', async () => {
  const source = readFileSync(require.resolve('./server'), 'utf8');
  const start = source.indexOf('async function requireDialogueMaintenanceCapability(');
  const end = source.indexOf('\nasync function sourceCatalogRead(', start);
  const cases = [
    {service:'opensphere-console-api',ready:true,maintenance:{ready:true}},
    {service:'opensphere-osdst',ready:false,maintenance:{ready:true}},
    {service:'opensphere-osdst',ready:true,maintenance:{ready:false}},
    {service:'opensphere-osdst',ready:true},
    new Error('timeout'),
  ];
  for (const result of cases) {
    const check = vm.runInNewContext(source.slice(start,end)+';requireDialogueMaintenanceCapability', {
      getConversationStore: () => ({maintenanceReadiness: async () => {if(result instanceof Error) throw result; return result;}}),
    });
    await assert.rejects(check({bearerToken:'must-not-be-forwarded'}), error => error.code===503 && error.errorCode==='conversation_turn_maintenance_unavailable');
  }
});
