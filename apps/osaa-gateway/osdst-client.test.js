'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createOsdstClient } = require('./osdst-client');

test('OSDST owner calls bind the bearer to the OSAA Gateway admission marker', async () => {
  const previousFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ conversations: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    await createOsdstClient().list({ bearerToken: 'synthetic-owner-token' });
  } finally {
    global.fetch = previousFetch;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.authorization, 'Bearer synthetic-owner-token');
  assert.equal(calls[0].options.headers['x-os-owner-admission'], 'osaa-gateway-v1');
});
