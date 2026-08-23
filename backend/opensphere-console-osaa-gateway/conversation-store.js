'use strict';

const { randomUUID } = require('crypto');
const { buildTransition } = require('./dialogue-state');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TITLE = 160;
const MAX_CONTEXT_MESSAGES = 24;
const MAX_CONTEXT_CHARS = 24000;
const MAX_MESSAGE = MAX_CONTEXT_CHARS;
const TURN_LEASE_SECONDS = 120;

function failure(code, msg, errorCode = '', retryAfterSeconds = 0) {
  const error = Object.assign(new Error(msg), { code, msg });
  if (errorCode) error.errorCode = errorCode;
  if (retryAfterSeconds > 0) error.retryAfterSeconds = Math.ceil(retryAfterSeconds);
  return error;
}

function retryAfter(leaseExpiresAt) {
  const remaining = new Date(leaseExpiresAt || 0).getTime() - Date.now();
  return Math.max(1, Math.ceil(remaining / 1000));
}

function ownerId(actor) {
  const value = String(actor?.subject || '').trim();
  if (!value || value.length > 200) throw failure(401, 'authenticated OSAA subject is required');
  return value;
}

function conversationId(value, { optional = false } = {}) {
  const id = String(value || '').trim().toLowerCase();
  if (!id && optional) return '';
  if (!UUID_RE.test(id)) throw failure(400, 'conversationId must be a UUID');
  return id;
}

function requestId(value) {
  const id = String(value || '').trim().toLowerCase();
  if (!UUID_RE.test(id)) throw failure(400, 'clientRequestId must be a UUID');
  return id;
}

function messageContent(value) {
  const content = String(value || '').trim();
  if (!content) throw failure(400, 'message is required');
  if (content.length > MAX_MESSAGE) {
    throw failure(413, `message exceeds the ${MAX_MESSAGE} character provider boundary`, 'osaa_context_too_large');
  }
  return content;
}

function title(value, fallback = '새 대화') {
  const normalized = String(value || fallback).replace(/\s+/g, ' ').trim();
  if (!normalized) throw failure(400, 'conversation title is required');
  return normalized.slice(0, MAX_TITLE);
}

function firstTurnTitle(content) {
  const firstLine = String(content || '').split(/\r?\n/, 1)[0];
  return title(firstLine, '새 대화').slice(0, 72);
}

function normalizeLimit(value, fallback = 40, maximum = 100) {
  const parsed = Number(value || fallback);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw failure(400, `limit must be an integer from 1 to ${maximum}`);
  }
  return parsed;
}

function rowConversation(row) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    modelId: row.model_id || '',
    summary: row.summary || '',
    retentionDays: row.retention_days ?? null,
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    preview: row.preview || '',
  };
}

function rowMessage(row) {
  const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
    ? row.metadata : {};
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    modelId: row.model_id || '',
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at || null,
    ...metadata,
  };
}

function contextWindow(rows, currentUserContent = '') {
  const ordered = [...rows]
    .filter((row) => ['user', 'assistant'].includes(row.role) && row.status === 'completed')
    .sort((a, b) => Number(a.sequence) - Number(b.sequence));
  const output = [];
  let characters = String(currentUserContent || '').length;
  for (let index = ordered.length - 1; index >= 0 && output.length < MAX_CONTEXT_MESSAGES - 1; index -= 1) {
    const content = String(ordered[index].content || '');
    if (characters + content.length > MAX_CONTEXT_CHARS) break;
    characters += content.length;
    output.unshift({ role: ordered[index].role, content });
  }
  if (currentUserContent) output.push({ role: 'user', content: String(currentUserContent) });
  return output;
}

function responseFromAssistant(row) {
  const message = rowMessage(row);
  const response = message.response && typeof message.response === 'object' ? message.response : {};
  delete message.response;
  return { ...response, message: message.content, conversationId: row.conversation_id, assistantMessage: message };
}

function rowDialogueContext(row, conversation) {
  if (!row) return {
    conversationId: conversation, domain: null, intent: null, phase: 'idle',
    capabilityRef: null, operationRef: null, revision: 0, stateDigest: null,
  };
  return {
    conversationId: conversation,
    domain: row.domain || null,
    intent: row.intent || null,
    phase: row.phase || 'idle',
    capabilityRef: row.capability_ref || null,
    operationRef: row.operation_ref || null,
    revision: Number(row.revision || 0),
    stateDigest: row.state_digest || null,
  };
}

async function commitDialogueTransition(client, owner, turn, candidate) {
  if (!candidate) return null;
  const current = await client.query(`
    SELECT * FROM osaa.dialogue_state_projection
    WHERE conversation_id=$1 AND owner_id=$2
    FOR UPDATE
  `, [turn.conversationId, owner]);
  const transition = buildTransition(candidate, {
    conversationId: turn.conversationId,
    ownerId: owner,
  }, current.rows[0] || null);
  const state = transition.material;
  await client.query(`
    INSERT INTO osaa.dialogue_state_transition(
      conversation_id,owner_id,turn_request_id,base_revision,next_revision,
      prev_state_digest,state_digest,delta,capability_ref,evidence_refs,operation_ref
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11::uuid)
  `, [turn.conversationId, owner, turn.clientRequestId,
    transition.baseRevision, transition.nextRevision, transition.previousDigest,
    transition.stateDigest, JSON.stringify(transition.delta), state.capabilityRef,
    JSON.stringify(state.evidenceRefs), state.operationRef]);
  const projected = await client.query(`
    INSERT INTO osaa.dialogue_state_projection(
      conversation_id,owner_id,domain,intent,phase,target_ref,slots,missing_slots,
      capability_ref,evidence_refs,operation_ref,revision,last_turn_request_id,state_digest
    ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::text[],$9,$10::jsonb,$11::uuid,$12,$13,$14)
    ON CONFLICT (conversation_id) DO UPDATE SET
      domain=EXCLUDED.domain,intent=EXCLUDED.intent,phase=EXCLUDED.phase,
      target_ref=EXCLUDED.target_ref,slots=EXCLUDED.slots,missing_slots=EXCLUDED.missing_slots,
      capability_ref=EXCLUDED.capability_ref,evidence_refs=EXCLUDED.evidence_refs,
      operation_ref=EXCLUDED.operation_ref,revision=EXCLUDED.revision,
      last_turn_request_id=EXCLUDED.last_turn_request_id,state_digest=EXCLUDED.state_digest,
      updated_at=clock_timestamp()
    WHERE osaa.dialogue_state_projection.owner_id=EXCLUDED.owner_id
      AND osaa.dialogue_state_projection.revision=$12-1
    RETURNING revision
  `, [turn.conversationId, owner, state.domain, state.intent, state.phase,
    JSON.stringify(state.targetRef), JSON.stringify(state.slots), state.missingSlots,
    state.capabilityRef, JSON.stringify(state.evidenceRefs), state.operationRef,
    transition.nextRevision, turn.clientRequestId, transition.stateDigest]);
  if (!projected.rows[0] || Number(projected.rows[0].revision) !== transition.nextRevision) {
    throw failure(409, 'dialogue state revision changed during this turn', 'osaa_dialogue_revision_conflict');
  }
  return {
    domain: state.domain,
    intent: state.intent,
    phase: state.phase,
    missingSlots: state.missingSlots,
    contextStatus: 'validated',
    revision: transition.nextRevision,
  };
}

function createConversationStore(pool) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('OSAA conversation store requires a pg Pool');
  }

  async function withActor(owner, work) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('opensphere.actor_id',$1,true)", [owner]);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async function list(actor, options = {}) {
    const owner = ownerId(actor);
    const limit = normalizeLimit(options.limit);
    return withActor(owner, async (client) => {
      const result = await client.query(`
        SELECT c.*,
          COALESCE((
            SELECT left(m.content, 180)
            FROM osaa.conversation_message m
            WHERE m.conversation_id=c.id AND m.status='completed'
            ORDER BY m.sequence DESC LIMIT 1
          ), '') AS preview
        FROM osaa.conversation c
        WHERE c.owner_id=$1 AND c.deleted_at IS NULL
          AND ($2::text IS NULL OR c.status=$2)
        ORDER BY c.last_message_at DESC, c.id
        LIMIT $3
      `, [owner, options.status === 'archived' ? 'archived' : (options.status === 'active' ? 'active' : null), limit]);
      return result.rows.map(rowConversation);
    });
  }

  async function get(actor, value) {
    const owner = ownerId(actor);
    const id = conversationId(value);
    return withActor(owner, async (client) => {
      const conversation = await client.query(`
        SELECT * FROM osaa.conversation
        WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL
      `, [id, owner]);
      if (!conversation.rows[0]) throw failure(404, 'conversation not found');
      const messages = await client.query(`
        SELECT * FROM osaa.conversation_message
        WHERE conversation_id=$1 AND status='completed'
        ORDER BY sequence
      `, [id]);
      return { ...rowConversation(conversation.rows[0]), messages: messages.rows.map(rowMessage) };
    });
  }

  async function update(actor, value, patch = {}) {
    const owner = ownerId(actor);
    const id = conversationId(value);
    const allowed = ['title', 'status'];
    const extra = Object.keys(patch || {}).filter((key) => !allowed.includes(key));
    if (extra.length) throw failure(400, `unsupported conversation fields: ${extra.join(', ')}`);
    const nextTitle = patch.title === undefined ? null : title(patch.title);
    const nextStatus = patch.status === undefined ? null : String(patch.status || '').trim();
    if (nextStatus !== null && !['active', 'archived'].includes(nextStatus)) throw failure(400, 'status must be active or archived');
    if (nextTitle === null && nextStatus === null) throw failure(400, 'title or status is required');
    return withActor(owner, async (client) => {
      const result = await client.query(`
        UPDATE osaa.conversation
        SET title=COALESCE($3,title), status=COALESCE($4,status), updated_at=clock_timestamp()
        WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL
        RETURNING *
      `, [id, owner, nextTitle, nextStatus]);
      if (!result.rows[0]) throw failure(404, 'conversation not found');
      return rowConversation(result.rows[0]);
    });
  }

  async function remove(actor, value) {
    const owner = ownerId(actor);
    const id = conversationId(value);
    return withActor(owner, async (client) => {
      const result = await client.query(`
        UPDATE osaa.conversation
        SET status='archived', deleted_at=clock_timestamp(), updated_at=clock_timestamp()
        WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL
        RETURNING id
      `, [id, owner]);
      if (!result.rows[0]) throw failure(404, 'conversation not found');
      return { deleted: true, id };
    });
  }

  async function beginTurn(actor, body = {}) {
    const owner = ownerId(actor);
    const clientRequestId = requestId(body.clientRequestId);
    const content = messageContent(body.message);
    const requestedConversationId = conversationId(body.conversationId, { optional: true });
    const modelId = String(body.model || '').trim().slice(0, 120) || null;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('opensphere.actor_id',$1,true)", [owner]);
      let conversation;
      if (requestedConversationId) {
        const found = await client.query(`
          SELECT * FROM osaa.conversation
          WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL
          FOR UPDATE
        `, [requestedConversationId, owner]);
        conversation = found.rows[0];
        if (!conversation) throw failure(404, 'conversation not found');
        if (conversation.status !== 'active') throw failure(409, 'archived conversation is read-only');
      } else {
        const created = await client.query(`
          INSERT INTO osaa.conversation(id,owner_id,title,model_id)
          VALUES($1,$2,$3,$4)
          RETURNING *
        `, [randomUUID(), owner, firstTurnTitle(content), modelId]);
        conversation = created.rows[0];
      }

      await client.query(`
        UPDATE osaa.conversation_message
        SET status='failed', completed_at=clock_timestamp(),
            lease_owner=NULL, lease_expires_at=NULL, heartbeat_at=NULL,
            metadata=metadata || '{"recovery":"lease-expired"}'::jsonb
        WHERE conversation_id=$1 AND role='user' AND status='pending'
          AND lease_expires_at IS NOT NULL AND lease_expires_at<=clock_timestamp()
      `, [conversation.id]);

      const concurrent = await client.query(`
        SELECT turn_request_id,lease_expires_at FROM osaa.conversation_message
        WHERE conversation_id=$1 AND role='user' AND status='pending'
          AND turn_request_id<>$2 AND lease_expires_at>clock_timestamp()
        LIMIT 1
      `, [conversation.id, clientRequestId]);
      if (concurrent.rows[0]) {
        throw failure(409, 'another conversation turn is still in progress',
          'conversation_turn_in_progress', retryAfter(concurrent.rows[0].lease_expires_at));
      }

      const replay = await client.query(`
        SELECT * FROM osaa.conversation_message
        WHERE conversation_id=$1 AND turn_request_id=$2 AND role='assistant' AND status='completed'
      `, [conversation.id, clientRequestId]);
      if (replay.rows[0]) {
        await client.query('COMMIT');
        return { replay: true, response: responseFromAssistant(replay.rows[0]) };
      }

      const existing = await client.query(`
        SELECT * FROM osaa.conversation_message
        WHERE conversation_id=$1 AND turn_request_id=$2 AND role='user'
      `, [conversation.id, clientRequestId]);
      if (existing.rows[0] && existing.rows[0].content !== content) {
        throw failure(409, 'clientRequestId was already used with different content', 'conversation_request_conflict');
      }
      if (existing.rows[0]?.status === 'pending') {
        throw failure(409, 'conversation turn is still in progress',
          'conversation_turn_in_progress', retryAfter(existing.rows[0].lease_expires_at));
      }

      if (existing.rows[0]) {
        await client.query(`
          UPDATE osaa.conversation_message
          SET status='pending', completed_at=NULL, lease_owner=$2,
              lease_expires_at=clock_timestamp()+make_interval(secs=>$3),
              heartbeat_at=clock_timestamp(), attempt=attempt+1
          WHERE id=$1
        `, [existing.rows[0].id, clientRequestId, TURN_LEASE_SECONDS]);
      } else {
        const sequence = await client.query(`
          SELECT COALESCE(max(sequence),0)+1 AS next_sequence
          FROM osaa.conversation_message WHERE conversation_id=$1
        `, [conversation.id]);
        await client.query(`
          INSERT INTO osaa.conversation_message(
            conversation_id,sequence,turn_request_id,role,content,model_id,status,
            lease_owner,lease_expires_at,heartbeat_at,attempt
          ) VALUES($1,$2,$3,'user',$4,$5,'pending',$3,
            clock_timestamp()+make_interval(secs=>$6),clock_timestamp(),1)
        `, [conversation.id, sequence.rows[0].next_sequence, clientRequestId, content, modelId, TURN_LEASE_SECONDS]);
      }

      const history = await client.query(`
        SELECT role,content,status,sequence
        FROM osaa.conversation_message
        WHERE conversation_id=$1 AND status='completed'
        ORDER BY sequence DESC LIMIT $2
      `, [conversation.id, MAX_CONTEXT_MESSAGES]);
      const dialogue = await client.query(`
        SELECT domain,intent,phase,capability_ref,operation_ref,revision,state_digest
        FROM osaa.dialogue_state_projection
        WHERE conversation_id=$1 AND owner_id=$2
      `, [conversation.id, owner]);
      await client.query(`
        UPDATE osaa.conversation
        SET model_id=COALESCE($2,model_id), last_message_at=clock_timestamp(), updated_at=clock_timestamp()
        WHERE id=$1
      `, [conversation.id, modelId]);
      await client.query('COMMIT');
      return {
        replay: false,
        conversation: rowConversation(conversation),
        conversationId: conversation.id,
        clientRequestId,
        messages: contextWindow(history.rows, content),
        dialogueContext: rowDialogueContext(dialogue.rows[0] || null, conversation.id),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async function completeTurn(actor, turn, response) {
    const owner = ownerId(actor);
    const providerModelId = response?.modelAuthority === 'provider'
      ? String(response?.model || '').trim().slice(0, 120) || null
      : null;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('opensphere.actor_id',$1,true)", [owner]);
      const locked = await client.query(`
        SELECT * FROM osaa.conversation
        WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL
        FOR UPDATE
      `, [turn.conversationId, owner]);
      if (!locked.rows[0]) throw failure(404, 'conversation not found');
      const lease = await client.query(`
        SELECT id FROM osaa.conversation_message
        WHERE conversation_id=$1 AND turn_request_id=$2 AND role='user'
          AND status='pending' AND lease_owner=$2
          AND lease_expires_at>clock_timestamp()
        FOR UPDATE
      `, [turn.conversationId, turn.clientRequestId]);
      if (!lease.rows[0]) {
        throw failure(409, 'conversation turn lease was lost before completion', 'conversation_turn_lease_lost');
      }
      const dialogue = await commitDialogueTransition(
        client, owner, turn, response?.dialogueTransition || null,
      );
      const sequence = await client.query(`
        SELECT COALESCE(max(sequence),0)+1 AS next_sequence
        FROM osaa.conversation_message WHERE conversation_id=$1
      `, [turn.conversationId]);
      const metadata = {
        response: {
          ...Object.fromEntries(Object.entries(response || {}).filter(
            ([key]) => !['message', 'dialogueTransition'].includes(key),
          )),
          ...(dialogue ? { dialogue } : {}),
        },
        sources: Array.isArray(response?.sources) ? response.sources : [],
        concepts: response?.concepts?.concepts || [],
        usage: response?.usage || null,
      };
      const inserted = await client.query(`
        INSERT INTO osaa.conversation_message(
          conversation_id,sequence,turn_request_id,role,content,model_id,metadata,status,completed_at
        ) VALUES($1,$2,$3,'assistant',$4,$5,$6::jsonb,'completed',clock_timestamp())
        ON CONFLICT (conversation_id,turn_request_id,role) DO UPDATE
          SET content=EXCLUDED.content, model_id=EXCLUDED.model_id, metadata=EXCLUDED.metadata,
              status='completed', completed_at=clock_timestamp()
        RETURNING *
      `, [turn.conversationId, sequence.rows[0].next_sequence, turn.clientRequestId,
        messageContent(response?.message), String(response?.model || '').slice(0, 120) || null,
        JSON.stringify(metadata)]);
      await client.query(`
        UPDATE osaa.conversation_message
        SET status='completed', completed_at=clock_timestamp(),
            lease_owner=NULL, lease_expires_at=NULL, heartbeat_at=NULL
        WHERE conversation_id=$1 AND turn_request_id=$2 AND role='user'
      `, [turn.conversationId, turn.clientRequestId]);
      await client.query(`
        UPDATE osaa.conversation
        SET model_id=COALESCE($2,model_id),
            last_message_at=clock_timestamp(), updated_at=clock_timestamp()
        WHERE id=$1
      `, [turn.conversationId, providerModelId]);
      await client.query('COMMIT');
      return responseFromAssistant(inserted.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async function failTurn(actor, turn) {
    const owner = ownerId(actor);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('opensphere.actor_id',$1,true)", [owner]);
      await client.query(`
        UPDATE osaa.conversation_message m
        SET status='failed', completed_at=clock_timestamp(),
            lease_owner=NULL, lease_expires_at=NULL, heartbeat_at=NULL
        FROM osaa.conversation c
        WHERE m.conversation_id=c.id AND c.id=$1 AND c.owner_id=$2
          AND m.turn_request_id=$3 AND m.role='user' AND m.status='pending'
          AND m.lease_owner=$3
      `, [turn.conversationId, owner, turn.clientRequestId]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async function heartbeatTurn(actor, turn) {
    const owner = ownerId(actor);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('opensphere.actor_id',$1,true)", [owner]);
      const result = await client.query(`
        UPDATE osaa.conversation_message m
        SET heartbeat_at=clock_timestamp(),
            lease_expires_at=clock_timestamp()+make_interval(secs=>$4)
        FROM osaa.conversation c
        WHERE m.conversation_id=c.id AND c.id=$1 AND c.owner_id=$2
          AND m.turn_request_id=$3 AND m.role='user' AND m.status='pending'
          AND m.lease_owner=$3 AND m.lease_expires_at>clock_timestamp()
        RETURNING m.lease_expires_at
      `, [turn.conversationId, owner, turn.clientRequestId, TURN_LEASE_SECONDS]);
      if (!result.rows[0]) {
        throw failure(409, 'conversation turn lease is no longer active', 'conversation_turn_lease_lost');
      }
      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async function dialogueContext(actor, value) {
    const owner = ownerId(actor);
    const id = conversationId(value);
    return withActor(owner, async (client) => {
      const conversation = await client.query(`
        SELECT id FROM osaa.conversation
        WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL
      `, [id, owner]);
      if (!conversation.rows[0]) throw failure(404, 'conversation not found');
      const result = await client.query(`
        SELECT domain,intent,phase,capability_ref,revision,state_digest
        FROM osaa.dialogue_state_projection
        WHERE conversation_id=$1 AND owner_id=$2
      `, [id, owner]);
      return rowDialogueContext(result.rows[0] || null, id);
    });
  }

  async function reapExpiredTurns(limit = 100, recoveredBy = 'osaa-gateway') {
    const bounded = Math.max(1, Math.min(1000, Number(limit) || 100));
    const result = await pool.query(
      'SELECT * FROM osaa.reap_expired_dialogue_turns($1,$2)',
      [bounded, String(recoveredBy || 'osaa-gateway').slice(0, 200)],
    );
    return result.rows;
  }

  async function recoverTurn(actor, value, turnValue, reason) {
    const recoveredBy = ownerId(actor);
    const id = conversationId(value);
    const turnRequestId = requestId(turnValue);
    const recoveryReason = String(reason || '').trim();
    if (recoveryReason.length < 8 || recoveryReason.length > 500) {
      throw failure(400, 'recovery reason must contain 8 to 500 characters');
    }
    const result = await pool.query(
      'SELECT * FROM osaa.recover_dialogue_turn($1,$2,$3,$4)',
      [id, turnRequestId, recoveredBy, recoveryReason],
    );
    if (!result.rows[0]) throw failure(404, 'pending conversation turn not found');
    return result.rows[0];
  }

  return {
    list, get, update, remove, beginTurn, completeTurn, failTurn,
    heartbeatTurn, dialogueContext, reapExpiredTurns, recoverTurn,
  };
}

module.exports = {
  MAX_CONTEXT_CHARS,
  MAX_CONTEXT_MESSAGES,
  TURN_LEASE_SECONDS,
  contextWindow,
  conversationId,
  createConversationStore,
  firstTurnTitle,
  messageContent,
  ownerId,
  requestId,
  title,
};
