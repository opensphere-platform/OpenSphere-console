import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { authorizeOperation } from '../authz/src/authorize-operation.mjs';
import { planOperation, transitionOperation } from '../operation-receipt/src/operation-receipt.mjs';

const now = new Date('2026-09-01T00:00:00.000Z');
const session = {
  subjectId: 'operator:alice',
  expiresAt: '2026-09-01T01:00:00.000Z',
  revokedAt: null,
  authorityFresh: true,
  permissions: ['operation:create'],
  permissionRevision: '42',
  aal: 'aal2',
};

test('current permission, reason and AAL2 authorize a high-risk operation', () => {
  const authorization = authorizeOperation({ session, permission: 'operation:create', risk: 'R2', reason: 'rotate compromised credential', now });
  assert.equal(authorization.actorRef, session.subjectId);
  assert.equal(authorization.permissionRevision, '42');
});

test('revocation, stale authority, missing permission, reason and AAL2 all fail closed', () => {
  assert.throws(() => authorizeOperation({ session: { ...session, revokedAt: now.toISOString() }, permission: 'operation:create', risk: 'R0', now }), /active session/);
  assert.throws(() => authorizeOperation({ session: { ...session, authorityFresh: false }, permission: 'operation:create', risk: 'R0', now }), /authority is unavailable/);
  assert.throws(() => authorizeOperation({ session, permission: 'operation:delete', risk: 'R0', now }), /permission denied/);
  assert.throws(() => authorizeOperation({ session, permission: 'operation:create', risk: 'R1', reason: '', now }), /reason is required/);
  assert.throws(() => authorizeOperation({ session: { ...session, aal: 'aal1' }, permission: 'operation:create', risk: 'R2', reason: 'required', now }), /aal2/);
});

test('operation receipt binds canonical payload and permits only explicit state transitions', () => {
  const input = {
    actionId: 'console.registry.connection.rotate', actionVersion: '1', actorRef: session.subjectId,
    targetRef: 'registry-connection:opensphere-ghcr', payload: { b: 2, a: 1 }, risk: 'R2', aal: 'aal2',
    reason: 'rotate compromised credential', planRevision: 'plan-1', idempotencyKey: 'idem-1', correlationId: 'corr-1',
  };
  const first = planOperation(input, () => now);
  const replay = planOperation({ ...input, payload: { a: 1, b: 2 }, operationId: first.operationId }, () => now);
  assert.equal(first.payloadDigest, replay.payloadDigest);
  const authorized = transitionOperation(first, 'Authorized', { approvalRevision: 'approval-1' }, () => now);
  assert.equal(authorized.state, 'Authorized');
  assert.throws(() => transitionOperation(authorized, 'Verified', {}, () => now), /not allowed/);
});

test('baseline migration declares separated authority schemas, RLS and append-only audit denial', async () => {
  const sql = await readFile(new URL('../../migrations/baseline/0001_console_authority.sql', import.meta.url), 'utf8');
  for (const schema of ['console_identity', 'console_operation', 'console_audit']) assert.match(sql, new RegExp(`CREATE SCHEMA ${schema}`, 'i'));
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/i);
  assert.match(sql, /CREATE POLICY browser_session_self_read/i);
  assert.match(sql, /CREATE TABLE console_identity\.subject_authority/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_identity\.resolve_browser_session/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_identity\.revoke_browser_session/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_identity\.get_supabase_status/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_operation\.accept_operation/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION console_operation\.accept_operation/i);
  assert.match(sql, /CREATE TABLE console_operation\.approval/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_operation\.approve_operation/i);
  assert.match(sql, /DETAIL = 'SelfApprovalDenied'/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION console_operation\.approve_operation/i);
  assert.match(sql, /CREATE TABLE console_operation\.verification_receipt/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_operation\.verify_extension_operation/i);
  assert.match(sql, /DETAIL = 'ObservationMismatch'/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION console_operation\.verify_extension_operation/i);
  assert.match(sql, /CREATE ROLE console_extension_controller NOLOGIN NOINHERIT NOBYPASSRLS/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_operation\.claim_owner_operation/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_operation\.renew_owner_claim/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_extension\.apply_revocation/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_extension\.apply_remove_registration/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_extension\.record_remove_observation/i);
  assert.match(sql, /CREATE TABLE console_extension\.registry_connection/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_extension\.get_registry_connection/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_extension\.record_execution_failure/i);
  assert.match(sql, /DETAIL = 'StaleClaim'/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_audit\.append_event_internal/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_audit\.list_events/i);
  assert.match(sql, /CREATE TRIGGER audit_event_immutable/i);
  assert.match(sql, /CREATE TRIGGER audit_event_no_truncate/i);
  assert.doesNotMatch(sql, /service_role/i);
});

test('fresh-start browser authentication has no readable refresh-token adoption path', async () => {
  const auth = await readFile(new URL('../../src/app/core/auth.service.ts', import.meta.url), 'utf8');
  const broker = await readFile(new URL('../../backend/opensphere-console-backend/browser-session.js', import.meta.url), 'utf8');
  const server = await readFile(new URL('../../backend/opensphere-console-backend/server.js', import.meta.url), 'utf8');
  for (const source of [auth, broker, server]) {
    assert.doesNotMatch(source, /adoptLegacySession|adoptLegacy|\/api\/identity\/session\/adopt|opensphere\.supabase\.session/);
  }
});
