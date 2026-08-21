import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TLS_INITIALIZER_PROFILE,
  initializePlatformReleaseTls,
} from './platform-release-tls-initializer.mjs';

test('one-shot initializer accepts only its explicit versioned profile and exact authority set', async () => {
  const previous = process.env.PLATFORM_RELEASE_TLS_INITIALIZER_PROFILE;
  try {
    delete process.env.PLATFORM_RELEASE_TLS_INITIALIZER_PROFILE;
    await assert.rejects(initializePlatformReleaseTls({ ensure: async () => ({}) }), /profile is unavailable/);
    process.env.PLATFORM_RELEASE_TLS_INITIALIZER_PROFILE = TLS_INITIALIZER_PROFILE;
    const result = await initializePlatformReleaseTls({ ensure: async () => ({
      secret: { metadata: { name: 'opensphere-platform-release-authority-tls' } },
      configMap: { metadata: { name: 'opensphere-platform-release-control-ca' } },
      service: { metadata: { name: 'opensphere-platform-release-authority' } },
    }) });
    assert.equal(result.contract, TLS_INITIALIZER_PROFILE);
    await assert.rejects(initializePlatformReleaseTls({ ensure: async () => ({
      secret: { metadata: { name: 'wrong' } }, configMap: { metadata: { name: 'wrong' } },
      service: { metadata: { name: 'wrong' } },
    }) }), /exact durable authority set/);
  } finally {
    if (previous === undefined) delete process.env.PLATFORM_RELEASE_TLS_INITIALIZER_PROFILE;
    else process.env.PLATFORM_RELEASE_TLS_INITIALIZER_PROFILE = previous;
  }
});
