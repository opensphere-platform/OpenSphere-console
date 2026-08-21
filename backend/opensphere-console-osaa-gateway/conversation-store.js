'use strict';

const { randomUUID } = require('crypto');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TITLE = 160;
const MAX_MESSAGE = 200000;
const MAX_CONTEXT_MESSAGES = 80;
const MAX_CONTEXT_CHARS = 60000;

function failure(code, msg, errorCode = '') {
  const error = Object.assign(new Error(msg), { code, msg });
  if (errorCode) error.errorCode = errorCode;
  return error;
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
  if (content.length > MAX_MESSAGE) throw failure(400, `message exceeds ${MAX_MESSAGE} characters`);
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
    if (output.length && characters + content.length > MAX_CONTEXT_CHARS) break;
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

function createConversationStore(pool) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('OSAA conversation store requires a pg Pool');
  }

  async function list(actor, options = {}) {
    const owner = ownerId(actor);
    const limit = normalizeLimit(options.limit);
    const result = await pool.query(`
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
  }

  async function get(actor, value) {
    const owner = ownerId(actor);
    const id = conversationId(value);
    const conversation = await pool.query(`
      SELECT * FROM osaa.conversation
      WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL
    `, [id, owner]);
    if (!conversation.rows[0]) throw failure(404, 'conversation not found');
    const messages = await pool.query(`
      SELECT * FROM osaa.conversation_message
      WHERE conversation_id=$1 AND status='completed'
      ORDER BY sequence
    `, [id]);
    return { ...rowConversation(conversation.rows[0]), messages: messages.rows.map(rowMessage) };
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
    const result = await pool.query(`
      UPDATE osaa.conversation
      SET title=COALESCE($3,title), status=COALESCE($4,status), updated_at=clock_timestamp()
      WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL
      RETURNING *
    `, [id, owner, nextTitle, nextStatus]);
    if (!result.rows[0]) throw failure(404, 'conversation not found');
    return rowConversation(result.rows[0]);
  }

  async function remove(actor, value) {
    const owner = ownerId(actor);
    const id = conversationId(value);
    const result = await pool.query(`
      UPDATE osaa.conversation
      SET status='archived', deleted_at=clock_timestamp(), updated_at=clock_timestamp()
      WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL
      RETURNING id
    `, [id, owner]);
    if (!result.rows[0]) throw failure(404, 'conversation not found');
    return { deleted: true, id };
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

      const concurrent = await client.query(`
        SELECT turn_request_id FROM osaa.conversation_message
        WHERE conversation_id=$1 AND role='user' AND status='pending'
          AND turn_request_id<>$2
        LIMIT 1
      `, [conversation.id, clientRequestId]);
      if (concurrent.rows[0]) {
        throw failure(409, 'another conversation turn is still in progress', 'conversation_turn_in_progress');
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
        throw failure(409, 'conversation turn is still in progress', 'conversation_turn_in_progress');
      }

      if (existing.rows[0]) {
        await client.query(`
          UPDATE osaa.conversation_message
          SET status='pending', completed_at=NULL
          WHERE id=$1
        `, [existing.rows[0].id]);
      } else {
        const sequence = await client.query(`
          SELECT COALESCE(max(sequence),0)+1 AS next_sequence
          FROM osaa.conversation_message WHERE conversation_id=$1
        `, [conversation.id]);
        await client.query(`
          INSERT INTO osaa.conversation_message(
            conversation_id,sequence,turn_request_id,role,content,model_id,status
          ) VALUES($1,$2,$3,'user',$4,$5,'pending')
        `, [conversation.id, sequence.rows[0].next_sequence, clientRequestId, content, modelId]);
      }

      const history = await client.query(`
        SELECT role,content,status,sequence
        FROM osaa.conversation_message
        WHERE conversation_id=$1 AND status='completed'
        ORDER BY sequence DESC LIMIT $2
      `, [conversation.id, MAX_CONTEXT_MESSAGES]);
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
      const locked = await client.query(`
        SELECT * FROM osaa.conversation
        WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL
        FOR UPDATE
      `, [turn.conversationId, owner]);
      if (!locked.rows[0]) throw failure(404, 'conversation not found');
      const sequence = await client.query(`
        SELECT COALESCE(max(sequence),0)+1 AS next_sequence
        FROM osaa.conversation_message WHERE conversation_id=$1
      `, [turn.conversationId]);
      const metadata = {
        response: Object.fromEntries(Object.entries(response || {}).filter(([key]) => key !== 'message')),
        sources: Array.isArray(response?.sources) ? response.sources : [],
        concepts: response?.concepts?.concepts || [],
        actions: Array.isArray(response?.suggestedActions) ? response.suggestedActions : [],
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
        SET status='completed', completed_at=clock_timestamp()
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
    await pool.query(`
      UPDATE osaa.conversation_message m
      SET status='failed', completed_at=clock_timestamp()
      FROM osaa.conversation c
      WHERE m.conversation_id=c.id AND c.id=$1 AND c.owner_id=$2
        AND m.turn_request_id=$3 AND m.role='user' AND m.status='pending'
    `, [turn.conversationId, owner, turn.clientRequestId]);
  }

  return { list, get, update, remove, beginTurn, completeTurn, failTurn };
}

module.exports = {
  MAX_CONTEXT_CHARS,
  MAX_CONTEXT_MESSAGES,
  contextWindow,
  conversationId,
  createConversationStore,
  firstTurnTitle,
  messageContent,
  ownerId,
  requestId,
  title,
};
