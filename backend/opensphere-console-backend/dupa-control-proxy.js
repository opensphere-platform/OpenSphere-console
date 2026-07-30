'use strict';

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  const selected = Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
  return Math.min(maximum, Math.max(minimum, selected));
}

function isDeadlineError(error) {
  return error?.name === 'TimeoutError'
    || error?.name === 'AbortError'
    || error?.code === 'ABORT_ERR';
}

function proxyFailure(code, message, attempts, cause) {
  return Object.assign(new Error(message), { code, msg: message, attempts, cause });
}

/**
 * Executes one bounded DUPA request and retries only transport failures.
 *
 * The caller must decide whether the operation is safe to replay. Extension
 * install is replay-safe only when the same validated idempotency key and
 * byte-identical body are forwarded to the controller.
 */
async function fetchDupaWithRetry({
  fetchImpl = globalThis.fetch,
  url,
  method,
  headers,
  body,
  deadlineMs,
  maxAttempts = 1,
  retryDelayMs = 150,
  now = Date.now,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  signalFactory = (milliseconds) => AbortSignal.timeout(milliseconds),
}) {
  const boundedDeadlineMs = boundedInteger(deadlineMs, 15000, 1000, 300000);
  const boundedAttempts = boundedInteger(maxAttempts, 1, 1, 3);
  const startedAt = now();
  let lastError;

  for (let attempt = 1; attempt <= boundedAttempts; attempt += 1) {
    const remainingMs = boundedDeadlineMs - (now() - startedAt);
    if (remainingMs <= 0) {
      throw proxyFailure(
        504,
        `DUPA control request exceeded its bounded ${boundedDeadlineMs}ms deadline`,
        attempt - 1,
        lastError,
      );
    }

    try {
      const response = await fetchImpl(url, {
        method,
        headers,
        body,
        signal: signalFactory(Math.max(1, remainingMs)),
      });
      return { response, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (isDeadlineError(error) || now() - startedAt >= boundedDeadlineMs) {
        throw proxyFailure(
          504,
          `DUPA control request exceeded its bounded ${boundedDeadlineMs}ms deadline`,
          attempt,
          error,
        );
      }
      if (attempt >= boundedAttempts) {
        throw proxyFailure(503, 'DUPA control service unavailable', attempt, error);
      }
      const remainingAfterFailure = boundedDeadlineMs - (now() - startedAt);
      if (remainingAfterFailure <= 1) {
        throw proxyFailure(
          504,
          `DUPA control request exceeded its bounded ${boundedDeadlineMs}ms deadline`,
          attempt,
          error,
        );
      }
      await sleep(Math.min(boundedInteger(retryDelayMs, 150, 0, 1000), remainingAfterFailure - 1));
    }
  }

  throw proxyFailure(503, 'DUPA control service unavailable', boundedAttempts, lastError);
}

module.exports = {
  boundedInteger,
  fetchDupaWithRetry,
  isDeadlineError,
};
