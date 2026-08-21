'use strict';

const MAX_DSML_CHARS = 48000;
const MAX_TOOL_CALLS = 8;
const MAX_TOOL_PARAMETERS = 48;
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,95}$/;

function attributeValue(attributes, name) {
  const match = String(attributes || '').match(new RegExp(`${name}\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)')`, 'i'));
  return match ? (match[1] ?? match[2] ?? '') : '';
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function parameterValue(rawValue, forceString) {
  const value = decodeEntities(rawValue).trim();
  if (forceString === 'true') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function parseDsmlToolCalls(content, idPrefix = 'dsml') {
  const original = String(content || '');
  if (!original || original.length > MAX_DSML_CHARS) return { toolCalls: [], detected: false, malformed: false };
  const normalized = original.replace(/｜/g, '|');
  const envelope = normalized.match(/<\|\|DSML\|\|tool_calls\b[^>]*>([\s\S]*?)<\/\|\|DSML\|\|tool_calls>/i);
  if (!envelope) {
    return {
      toolCalls: [],
      detected: /<\|\|DSML\|\|tool_calls\b/i.test(normalized),
      malformed: /<\|\|DSML\|\|tool_calls\b/i.test(normalized),
    };
  }

  const toolCalls = [];
  const invokeRe = /<\|\|DSML\|\|invoke\b([^>]*)>([\s\S]*?)<\/\|\|DSML\|\|invoke>/gi;
  let invoke;
  while (toolCalls.length < MAX_TOOL_CALLS && (invoke = invokeRe.exec(envelope[1]))) {
    const name = attributeValue(invoke[1], 'name').trim();
    if (!TOOL_NAME_RE.test(name)) continue;
    const args = Object.create(null);
    const parameterRe = /<\|\|DSML\|\|parameter\b([^>]*)>([\s\S]*?)<\/\|\|DSML\|\|parameter>/gi;
    let parameter;
    let parameterCount = 0;
    while (parameterCount < MAX_TOOL_PARAMETERS && (parameter = parameterRe.exec(invoke[2]))) {
      parameterCount += 1;
      const parameterName = attributeValue(parameter[1], 'name').trim();
      if (!/^[a-z][a-zA-Z0-9_]{0,95}$/.test(parameterName)) continue;
      if (['__proto__', 'prototype', 'constructor'].includes(parameterName)) continue;
      args[parameterName] = parameterValue(parameter[2], attributeValue(parameter[1], 'string').toLowerCase());
    }
    toolCalls.push({
      id: `${idPrefix}-${toolCalls.length + 1}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    });
  }
  return { toolCalls, detected: true, malformed: toolCalls.length === 0 };
}

function normalizeProviderToolCalls(message, idPrefix = 'dsml') {
  if (Array.isArray(message?.tool_calls) && message.tool_calls.length) {
    return { toolCalls: message.tool_calls.slice(0, MAX_TOOL_CALLS), encoding: 'openai-structured', malformed: false };
  }
  const parsed = parseDsmlToolCalls(message?.content, idPrefix);
  return {
    toolCalls: parsed.toolCalls,
    encoding: parsed.toolCalls.length ? 'deepseek-dsml' : 'none',
    malformed: parsed.malformed,
  };
}

module.exports = { normalizeProviderToolCalls, parseDsmlToolCalls };
