'use strict';

const { execFileSync } = require('node:child_process');

const RUNTIME_PROBES = Object.freeze([
  Object.freeze({
    tool: 'node',
    command: process.execPath,
    args: ['--version'],
  }),
  Object.freeze({
    tool: 'pwsh',
    command: 'pwsh',
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'],
  }),
  Object.freeze({
    tool: 'gh',
    command: 'gh',
    args: ['--version'],
  }),
  Object.freeze({
    tool: 'kubectl',
    command: 'kubectl',
    args: ['version', '--client', '--output=json'],
  }),
]);

class ExecutorRuntimeUnavailable extends Error {
  constructor(tool, cause) {
    const detail = String(cause?.message || cause || 'runtime probe failed').slice(0, 500);
    super(`Platform Release executor runtime unavailable: ${tool} (${detail})`);
    this.name = 'ExecutorRuntimeUnavailable';
    this.code = 'ExecutorRuntimeUnavailable';
    this.evidence = {
      stage: 'runtime-preflight',
      tool,
      detail,
    };
  }
}

function verifyExecutorRuntime(run = execFileSync) {
  const inventory = {};
  for (const probe of RUNTIME_PROBES) {
    try {
      const output = run(probe.command, probe.args, {
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      });
      inventory[probe.tool] = String(output || '').trim().split(/\r?\n/, 1)[0] || 'available';
    } catch (error) {
      throw new ExecutorRuntimeUnavailable(probe.tool, error);
    }
  }
  return inventory;
}

module.exports = {
  ExecutorRuntimeUnavailable,
  RUNTIME_PROBES,
  verifyExecutorRuntime,
};
