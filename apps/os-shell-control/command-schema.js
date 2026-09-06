'use strict';

// A bounded data-only schema subset. No remote refs, executable validators or
// owner-supplied regular expressions are admitted by the control plane.
const FORMATS = Object.freeze({
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  sha256: /^sha256:[a-f0-9]{64}$/,
  'git-revision': /^[a-f0-9]{40}$/,
  'dns-name': /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/,
  semver: /^v?\d+\.\d+\.\d+$/,
});
const own = (v, k) => Object.prototype.hasOwnProperty.call(v, k);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
function invalid(message, contract = false) {
  throw Object.assign(new Error(message), {
    status: contract ? 503 : 400,
    code: contract ? 'CommandProviderUnavailable' : 'ValidationFailed', sideEffect: 'none',
  });
}
function closed(value, fields) {
  return object(value) && Object.keys(value).every(k => fields.includes(k));
}

function validateSchema(schema, depth = 0, budget = { nodes: 0 }) {
  if (++budget.nodes > 256 || depth > 6 || !object(schema)) invalid('Command schema exceeds its bounds', true);
  const common = ['type', 'description', 'enum'];
  const fields = {
    string: ['minLength', 'maxLength', 'format'], integer: ['minimum', 'maximum'], number: ['minimum', 'maximum'],
    boolean: [], object: ['properties', 'required', 'additionalProperties'], array: ['items', 'minItems', 'maxItems'],
  }[schema.type];
  if (!fields || !closed(schema, [...common, ...fields])) invalid('Unsupported command schema', true);
  if (schema.description !== undefined && (typeof schema.description !== 'string' || schema.description.length > 500)) invalid('Invalid schema description', true);
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length || schema.enum.length > 64
    || schema.enum.some(v => v === null || !['string', 'number', 'boolean'].includes(typeof v))
    || new Set(schema.enum).size !== schema.enum.length)) invalid('Invalid schema enum', true);
  if (schema.type === 'object') {
    if (schema.additionalProperties !== false || !object(schema.properties) || Object.keys(schema.properties).length > 32
      || !Array.isArray(schema.required) || new Set(schema.required).size !== schema.required.length
      || schema.required.some(k => typeof k !== 'string' || !own(schema.properties, k))) invalid('Objects must have closed named fields', true);
    for (const [name, child] of Object.entries(schema.properties)) {
      if (!/^[a-z][a-zA-Z0-9]{0,47}$/.test(name) || ['constructor', 'prototype', '__proto__'].includes(name)) invalid('Unsafe schema field', true);
      validateSchema(child, depth + 1, budget);
    }
  } else if (schema.type === 'array') {
    if (!Number.isSafeInteger(schema.maxItems) || schema.maxItems < 0 || schema.maxItems > 64
      || (schema.minItems !== undefined && (!Number.isSafeInteger(schema.minItems) || schema.minItems < 0 || schema.minItems > schema.maxItems))) invalid('Arrays must be bounded', true);
    validateSchema(schema.items, depth + 1, budget);
  } else if (schema.type === 'string') {
    if (!Number.isSafeInteger(schema.maxLength) || schema.maxLength < 1 || schema.maxLength > 4096
      || (schema.minLength !== undefined && (!Number.isSafeInteger(schema.minLength) || schema.minLength < 0 || schema.minLength > schema.maxLength))
      || (schema.format !== undefined && !own(FORMATS, schema.format))) invalid('Strings must be bounded', true);
  } else if (schema.type === 'integer' || schema.type === 'number') {
    if (!Number.isFinite(schema.minimum) || !Number.isFinite(schema.maximum) || schema.minimum > schema.maximum
      || Math.abs(schema.minimum) > Number.MAX_SAFE_INTEGER || Math.abs(schema.maximum) > Number.MAX_SAFE_INTEGER) invalid('Numbers must be bounded', true);
  }
  if (schema.enum) for (const value of schema.enum) {
    try { validateValue({ ...schema, enum: undefined }, value, 'enum'); }
    catch { invalid('Enum does not conform to its declared type', true); }
  }
  return schema;
}

function validateValue(schema, value, path = 'arguments') {
  if (schema.enum && !schema.enum.includes(value)) invalid(`${path}: value is not in the command contract`);
  switch (schema.type) {
    case 'object':
      if (!object(value) || Object.keys(value).some(k => !own(schema.properties, k)) || schema.required.some(k => !own(value, k))) invalid(`${path}: unexpected or missing field`);
      for (const [k, v] of Object.entries(value)) validateValue(schema.properties[k], v, `${path}.${k}`);
      break;
    case 'array':
      if (!Array.isArray(value) || value.length < (schema.minItems || 0) || value.length > schema.maxItems) invalid(`${path}: invalid array`);
      value.forEach((v, i) => validateValue(schema.items, v, `${path}[${i}]`));
      break;
    case 'string':
      if (typeof value !== 'string' || value.length < (schema.minLength || 0) || value.length > schema.maxLength
        || (schema.format && !FORMATS[schema.format].test(value))) invalid(`${path}: invalid string`);
      break;
    case 'integer': case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isSafeInteger(value))
        || value < schema.minimum || value > schema.maximum) invalid(`${path}: invalid number`);
      break;
    case 'boolean': if (typeof value !== 'boolean') invalid(`${path}: invalid boolean`); break;
    default: invalid('Unsupported command schema', true);
  }
}

module.exports = { validateSchema, validateValue, FORMATS };
