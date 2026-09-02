'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { rootCertificates } = require('node:tls');
const {
  auditReason,
  compareSnapshots,
  credentialReplacement,
  normalizeTarget,
  tlsTrustReplacement,
} = require('./external-channel-api');
const {
  cipherJson,
  connectionSecretInput,
  credentialInput,
  customCaInput,
  decipherJson,
  s3Failure,
  signedS3Request,
  targetInput,
  tlsFailure,
} = require('../../recovery-owner/external-channel-server');

const read = (value) => fs.readFileSync(path.join(__dirname, value), 'utf8');

test('external backup and restore audit reasons have no minimum length requirement', () => {
  assert.equal(auditReason(''), '');
  assert.equal(auditReason(' 짧음 '), '짧음');
  assert.throws(() => auditReason('a'.repeat(241)), { code: 400 });
});

test('S3-compatible credentials accept provider formats and fail on their exact field', () => {
  const valid = {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    applicationKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  };
  assert.deepEqual(credentialInput(valid), valid);
  assert.throws(
    () => credentialInput({ ...valid, accessKeyId: 'x' }),
    (error) => error?.field === 'accessKeyId',
  );
  assert.throws(
    () => credentialInput({ ...valid, applicationKey: 'short' }),
    (error) => error?.field === 'applicationKey',
  );
});

test('backup target credential rotation is pairwise and optional only while editing', () => {
  assert.equal(credentialReplacement({}, { required: false }), null);
  assert.throws(
    () => credentialReplacement({ accessKeyId: '00512f95cf4dcf0000000004z' }),
    (error) => error?.field === 'applicationKey',
  );
  assert.throws(
    () => credentialReplacement({ applicationKey: 'K0041ZMxZEop4JkYUJqEei1ZSep14zz' }),
    (error) => error?.field === 'accessKeyId',
  );
  assert.throws(() => credentialReplacement({}, { required: true }), { code: 400 });
});

test('per-target TLS trust requires a validated custom CA without permitting verification bypass', () => {
  assert.deepEqual(tlsTrustReplacement({ tlsTrustMode: 'system' }), {
    mode: 'system',
    customCaCertificatePem: '',
  });
  assert.throws(
    () => tlsTrustReplacement({ tlsTrustMode: 'custom-ca' }),
    (error) => error?.field === 'customCaCertificatePem',
  );
  const customCa = customCaInput(rootCertificates[0]);
  assert.match(customCa.fingerprint, /^SHA-256 ([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  const connection = connectionSecretInput({
    accessKeyId: 'key-id-for-test',
    applicationKey: 'secret-application-key-for-test',
    tlsTrustMode: 'custom-ca',
    customCaCertificatePem: rootCertificates[0],
  });
  assert.equal(connection.secret.tlsTrustMode, 'custom-ca');
  assert.equal(connection.metadata.subject.length > 0, true);
  assert.equal(tlsFailure({ code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }, false).field, 'tlsTrustMode');
  assert.equal(tlsFailure({ code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }, true).field, 'customCaCertificatePem');
});

test('S3-compatible failures identify the actionable configuration field', () => {
  assert.deepEqual(s3Failure('InvalidAccessKeyId', 403), {
    field: 'accessKeyId',
    message: 'S3 저장소가 Access key ID를 인식하지 못했습니다.',
  });
  assert.equal(s3Failure('SignatureDoesNotMatch', 403).field, 'applicationKey');
  assert.equal(s3Failure('NoSuchBucket', 404).field, 'bucketName');
  assert.equal(s3Failure('AuthorizationHeaderMalformed', 400).field, 'region');
});

test('S3 target profiles are helpers while arbitrary valid HTTPS origins remain supported', () => {
  const backblaze = normalizeTarget({
    vendor: 'backblaze-b2',
    endpoint: 'https://s3.us-east-005.backblazeb2.com',
    region: 'us-east-005',
    bucketName: 'opensphere-console-backup',
    bucketId: '68be7936e6cd8ee39ff5091f',
  });
  assert.equal(backblaze.endpoint, 'https://s3.us-east-005.backblazeb2.com');
  assert.equal(backblaze.vendor, 'backblaze-b2');
  assert.equal(backblaze.bucket_private, true);
  const minio = normalizeTarget({
    vendor: 'minio',
    endpoint: 'https://minio.storage.example:9000',
    region: 'us-east-1',
    bucketName: 'opensphere-console-backup',
  });
  assert.equal(minio.endpoint, 'https://minio.storage.example:9000');
  assert.equal(targetInput(minio).vendor, 'minio');
  assert.throws(
    () => targetInput({ ...minio, endpoint: 'http://minio.storage.example:9000' }),
    (error) => error?.field === 'endpoint',
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
  const migration = read('../../../backend/supabase/migrations/0025_external_channels_backup.sql');
  const s3ProfilesMigration = read('../../../backend/supabase/migrations/0043_external_backup_s3_compatible_profiles.sql');
  const tlsTrustMigration = read('../../../backend/supabase/migrations/0044_external_backup_target_tls_trust.sql');
  const reasonPolicy = read('../../../backend/supabase/migrations/0027_external_channel_reason_policy.sql');
  assert.match(migration, /CREATE ROLE opensphere_external_channel_executor NOLOGIN NOINHERIT/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS console\.external_backup_secret/);
  assert.match(migration, /REVOKE ALL ON FUNCTION console\.external_backup_read_secret\(uuid\) FROM PUBLIC/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION console\.external_backup_read_secret\(uuid\)[\s\S]+opensphere_external_channel_executor/);
  assert.match(migration, /FUNCTION console\.restore_configuration_snapshot/);
  assert.match(migration, /allowlisted merge restore/i);
  assert.doesNotMatch(migration, /GRANT SELECT[\s\S]{0,120}external_backup_secret TO opensphere_console_backend/);
  assert.match(reasonPolicy, /DROP CONSTRAINT IF EXISTS configuration_restore_reason_check/);
  assert.doesNotMatch(reasonPolicy, /length\s*\(\s*btrim\s*\(\s*reason\s*\)\s*\)\s*>=\s*8/i);
  assert.match(s3ProfilesMigration, /ALTER COLUMN vendor SET DEFAULT 's3-compatible'/);
  assert.match(s3ProfilesMigration, /external_backup_target_endpoint_check/);
  assert.doesNotMatch(s3ProfilesMigration, /vendor\s*=\s*'backblaze-b2'/);
  assert.match(tlsTrustMigration, /tls_trust_mode IN \('system', 'custom-ca'\)/);
  assert.match(tlsTrustMigration, /encrypted external_backup_secret envelope/);
  assert.doesNotMatch(tlsTrustMigration, /rejectUnauthorized\s*=\s*false|NODE_TLS_REJECT_UNAUTHORIZED/);
});

test('External Channels UI and compatibility redirect expose backup and restore', () => {
  const source = read('../../console-web/src/app/pages/admin-external-channels.ts');
  const server = read('./server.js');
  const routes = read('../../console-web/src/app/app.routes.ts');
  const nginx = read('../../console-web/nginx/target-api-routes.conf');
  assert.match(source, /백업 대상/);
  assert.match(source, /백업 및 복원/);
  assert.match(source, /AES-256-GCM/);
  assert.match(source, /RESTORE /);
  assert.match(source, /panelError/);
  assert.match(source, /backupTargetFormValid/);
  assert.match(source, /editBackupTarget/);
  assert.match(source, /toggleBackupTarget/);
  assert.match(source, /removeBackupTarget/);
  assert.match(source, /필요한 수만큼 대상을 추가할 수 있습니다/);
  assert.match(source, /S3 endpoint/);
  for (const profile of ['사용자 지정 S3 호환', 'Amazon S3', 'Backblaze B2', 'Cloudflare R2', 'MinIO', 'Ceph Object Gateway (RGW)']) assert.ok(source.includes(profile));
  assert.match(source, /backupTargetSubmitAttempted/);
  assert.match(source, /markAllAsTouched/);
  assert.match(source, /focusBackupTargetField/);
  assert.match(source, /editingBackupTargetCredentialConfigured\(\) \? '\*\*\*\*\*\*\*\*' : ''/);
  assert.match(source, /기존 값 저장됨 · \*\*\*\*\*\*\*\*/);
  assert.match(source, /class="target-brand__logo"/);
  assert.doesNotMatch(source, /target-brand__mark/);
  assert.doesNotMatch(source, /지금 백업|backupNow\(/);
  assert.doesNotMatch(source, /\.backup-form-section\s*\{[^}]*border-bottom:/);
  assert.match(source, /<legend><span>버킷 정책 확인<\/span><small>외부 저장소에 설정된 현재 정책을 기록합니다\. Console이 이 값을 변경하지는 않습니다\.<\/small><\/legend>/);
  assert.match(source, /<legend><span>TLS 신뢰<\/span><small>/);
  assert.match(source, /name="backup-tls-trust-mode"/);
  assert.match(source, /name="backup-custom-ca"/);
  assert.doesNotMatch(source, /인증서 검증 안 함|verify\s*=\s*false/);
  assert.match(source, /s3ProfileLogo\(target\.vendor\)/);
  for (const logo of ['s3-compatible', 'amazon-s3', 'backblaze-b2', 'cloudflare-r2', 'minio', 'ceph-rgw']) {
    assert.ok(fs.existsSync(path.join(__dirname, `../../console-web/public/brand/storage/${logo}.svg`)), `${logo} logo must be packaged locally`);
  }
  assert.doesNotMatch(source, /logo:\s*'https?:\/\//);
  assert.equal(source.match(/<clr-control-error>/g)?.length, 9);
  assert.doesNotMatch(source, /class="field-error"/);
  assert.match(source, /\[disabled\]="busy\(\)" \(click\)="saveBackupTarget\(\)"/);
  assert.doesNotMatch(source, /필수 항목을 입력하면 저장할 수 있습니다/);
  assert.doesNotMatch(source, /Region과 일치하는 Backblaze HTTPS S3 endpoint만 허용/);
  assert.doesNotMatch(source, /name="backup-(?:region|endpoint|bucket-id)"[^>]+readonly/);
  assert.doesNotMatch(source, /변경을 완료하지 못했습니다/);
  assert.match(server, /\['PUT', 'DELETE'\]\.includes\(req\.method\)/);
  assert.match(server, /\(test\|backup\|enable\|disable\)/);
  assert.match(routes, /path: 'external-channels'/);
  assert.match(routes, /path: 'notification-channels', redirectTo: 'external-channels'/);
  assert.match(nginx, /location \/api\/external-channels\//);
  assert.match(nginx, /auth_request \/_external_channel_authn/);
  assert.match(nginx, /opensphere-external-channel-executor\.opensphere-console\.svc\.cluster\.local/);
  assert.match(nginx, /proxy_set_header Cookie ""/);
  assert.doesNotMatch(nginx, /console_backend_upstream/);
});
