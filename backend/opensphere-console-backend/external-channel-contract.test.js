'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  compareSnapshots,
  normalizeTarget,
} = require('./external-channel-api');
const {
  cipherJson,
  decipherJson,
  signedS3Request,
  targetInput,
} = require('../notification-dispatcher/external-backup-server');

const read = (value) => fs.readFileSync(path.join(__dirname, value), 'utf8');

test('Backblaze target is fixed to the configured HTTPS region and rejects alternate origins', () => {
  const target = normalizeTarget({
    endpoint: 'https://s3.us-east-005.backblazeb2.com',
    region: 'us-east-005',
    bucketName: 'opensphere-console-backup',
    bucketId: '68be7936e6cd8ee39ff5091f',
  });
  assert.equal(target.endpoint, 'https://s3.us-east-005.backblazeb2.com');
  assert.equal(target.bucket_private, true);
  assert.throws(() => normalizeTarget({
    endpoint: 'https://127.0.0.1',
    region: 'us-east-005',
    bucketName: 'opensphere-console-backup',
  }), (error) => /endpoint must be/.test(error?.msg || ''));
  assert.throws(
    () => targetInput({ ...target, endpoint: 'http://s3.us-east-005.backblazeb2.com' }),
    (error) => /exactly match/.test(error?.msg || ''),
  );
});

test('credential and backup payload encryption is authenticated and key-separated', () => {
  process.env.EXTERNAL_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  process.env.EXTERNAL_BACKUP_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString('base64');
  const encrypted = cipherJson({ accessKeyId: 'application-key-id', applicationKey: 'application-secret-key' }, 'EXTERNAL_CREDENTIAL_ENCRYPTION_KEY');
  assert.doesNotMatch(encrypted.ciphertext, /application-secret/);
  assert.deepEqual(
    decipherJson(encrypted, 'EXTERNAL_CREDENTIAL_ENCRYPTION_KEY').value,
    { accessKeyId: 'application-key-id', applicationKey: 'application-secret-key' },
  );
  assert.throws(() => decipherJson(encrypted, 'EXTERNAL_BACKUP_ENCRYPTION_KEY'));
});

test('S3 requests use path style, SigV4 and never place credentials in URL', () => {
  const signed = signedS3Request({
    target: {
      endpoint: 'https://s3.us-east-005.backblazeb2.com',
      region: 'us-east-005',
      bucket_name: 'opensphere-console-backup',
    },
    credential: {
      accessKeyId: 'key-id-for-test',
      applicationKey: 'secret-application-key-for-test',
    },
    method: 'PUT',
    objectKey: 'opensphere-console/configuration/backup.json.enc',
    body: Buffer.from('encrypted'),
  });
  assert.equal(signed.url, 'https://s3.us-east-005.backblazeb2.com/opensphere-console-backup/opensphere-console/configuration/backup.json.enc');
  assert.match(signed.options.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=key-id-for-test\//);
  assert.doesNotMatch(signed.url, /key-id-for-test|secret-application-key/);
  assert.doesNotMatch(signed.options.headers.Authorization, /secret-application-key/);
});

test('restore preview reports additions and changes without destructive deletion', () => {
  const current = {
    configuration: {
      roles: [{ code: 'console-admins', description: 'old' }],
      permissions: [],
      rolePermissions: [],
      pluginMeta: [],
      consumerContracts: [],
      observabilityClaims: [],
      notificationChannels: [],
      notificationRules: [],
      notificationRuleChannels: [],
      notificationDeliveryControl: { paused: false, reason: '' },
    },
  };
  const incoming = structuredClone(current);
  incoming.configuration.roles = [
    { code: 'console-admins', description: 'new' },
    { code: 'console-viewers', description: 'read' },
  ];
  const preview = compareSnapshots(current, incoming);
  assert.equal(preview.roles.changes, 1);
  assert.equal(preview.roles.additions, 1);
  assert.equal(preview.totals.incoming, 3);
  assert.equal(Object.hasOwn(preview, 'deletions'), false);
});

test('migration isolates secrets and restore scope from browser identities', () => {
  const migration = read('../supabase/migrations/0025_external_channels_backup.sql');
  assert.match(migration, /CREATE ROLE opensphere_external_channel_executor NOLOGIN NOINHERIT/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS console\.external_backup_secret/);
  assert.match(migration, /REVOKE ALL ON FUNCTION console\.external_backup_read_secret\(uuid\) FROM PUBLIC/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION console\.external_backup_read_secret\(uuid\)[\s\S]+opensphere_external_channel_executor/);
  assert.match(migration, /FUNCTION console\.restore_configuration_snapshot/);
  assert.match(migration, /allowlisted merge restore/i);
  assert.doesNotMatch(migration, /GRANT SELECT[\s\S]{0,120}external_backup_secret TO opensphere_console_backend/);
});

test('External Channels UI and compatibility redirect expose backup and restore', () => {
  const source = read('../../src/app/pages/admin-external-channels.ts');
  const routes = read('../../src/app/app.routes.ts');
  const nginx = read('../../nginx/default.conf.template');
  assert.match(source, /백업 대상/);
  assert.match(source, /백업 및 복원/);
  assert.match(source, /AES-256-GCM/);
  assert.match(source, /RESTORE /);
  assert.match(routes, /path: 'external-channels'/);
  assert.match(routes, /path: 'notification-channels', redirectTo: 'external-channels'/);
  assert.match(nginx, /location \/api\/external-channels\//);
  assert.match(nginx, /proxy_pass http:\/\/\$console_backend_upstream:8080\$request_uri/);
});
