import { randomUUID } from 'node:crypto';
import { assertModelSpec } from './model-spec.js';

export const ERROR_CODES = new Set([
  'spawn_failed',
  'nonzero_exit',
  'timeout',
  'killed',
  'malformed_output',
  'resume_not_found',
  'resume_corrupt',
  'resume_busy',
  // Сторож брошенных ранов (async v2): владелец исчез / ран пережил дедлайн.
  'owner_gone',
  'deadline_exceeded',
  'model_not_found',
  'invalid_model',
]);

const VALID_STATUSES = new Set(['completed', 'need_input', 'error']);

/**
 * Validate envelope v1 shape.
 * @param {any} obj
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateEnvelope(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return { valid: false, reason: 'not an object' };
  if (obj.v !== 1) return { valid: false, reason: 'v must be 1' };
  if (typeof obj.runId !== 'string' || obj.runId.length === 0)
    return { valid: false, reason: 'runId must be non-empty string' };
  if (!(typeof obj.sessionId === 'string' || obj.sessionId === null))
    return { valid: false, reason: 'sessionId must be string|null' };
  if (!VALID_STATUSES.has(obj.status))
    return { valid: false, reason: `status must be one of ${[...VALID_STATUSES].join('|')}` };

  if (obj.status === 'completed') {
    if (typeof obj.result !== 'string') return { valid: false, reason: 'result must be string when completed' };
  }
  if (obj.status === 'need_input') {
    if (typeof obj.question !== 'string') return { valid: false, reason: 'question must be string when need_input' };
  }
  if (obj.status === 'error') {
    const e = obj.error;
    if (e === null || typeof e !== 'object' || Array.isArray(e))
      return { valid: false, reason: 'error must be object when status=error' };
    if (typeof e.code !== 'string' || !ERROR_CODES.has(e.code)) {
      // allow unknown codes but warn — spec lists known codes; we validate code is non-empty string
      if (typeof e.code !== 'string' || e.code.length === 0)
        return { valid: false, reason: 'error.code must be non-empty string' };
    }
    if (typeof e.message !== 'string') return { valid: false, reason: 'error.message must be string' };
    // exitCode is optional but if present must be number|null
  }
  if ('model' in obj) {
    try {
      assertModelSpec(obj.model);
    } catch (e) {
      return { valid: false, reason: `model: ${e.message}` };
    }
  }
  return { valid: true };
}

/**
 * Create a new envelope with defaults.
 */
export function makeEnvelope({ runId = randomUUID(), sessionId = null, status, result, question, error, model }) {
  const env = { v: 1, runId, sessionId, status };
  if (result !== undefined) env.result = result;
  if (question !== undefined) env.question = question;
  if (error !== undefined) env.error = error;
  if (model !== undefined) env.model = model;
  return env;
}

export function synthesizeCompleted(runId, stdoutText, sessionId = null) {
  // stdoutText is raw stdout of dsh. For phase-1, the final text is the whole stdout trimmed of trailing newline.
  // Keep content as-is but remove single trailing \n added by dsh runner.
  let result = stdoutText;
  // dsh headless does: io.stdout.write(outcome.text + "\n")
  // So strip exactly one trailing newline for result fidelity, preserve other whitespace
  if (result.endsWith('\n')) result = result.slice(0, -1);
  // If stdout is empty and exit 0, result is empty string (still completed)
  return makeEnvelope({ runId, sessionId, status: 'completed', result });
}

export function synthesizeError(runId, code, message, exitCode = null, sessionId = null) {
  return makeEnvelope({
    runId,
    sessionId,
    status: 'error',
    error: { code, message: String(message), exitCode },
  });
}

/**
 * Try to parse last non-empty line as envelope v1.
 * Returns { envelope } if last line is valid JSON with v===1, { malformed, raw } if parses but invalid,
 * or { none } if no JSON envelope present (legacy phase-1 output).
 */
export function tryParseEnvelopeFromStdout(stdoutText) {
  const lines = stdoutText.split('\n');
  // find last non-empty line (trimmed non-empty)
  let lastIdx = lines.length - 1;
  // trailing newline gives empty last entry; skip empty lines at end
  while (lastIdx >= 0 && lines[lastIdx].trim() === '') lastIdx--;
  if (lastIdx < 0) return { none: true };
  const lastLine = lines[lastIdx].trim();
  if (lastLine === '') return { none: true };
  let parsed;
  try {
    parsed = JSON.parse(lastLine);
  } catch {
    return { none: true };
  }
  if (parsed === null || typeof parsed !== 'object' || parsed.v !== 1) {
    return { none: true };
  }
  const validation = validateEnvelope(parsed);
  if (!validation.valid) {
    return { malformed: true, raw: lastLine, reason: validation.reason, parsed };
  }
  return { envelope: parsed, raw: lastLine, index: lastIdx };
}

export function envelopeToJsonLine(env) {
  return JSON.stringify(env);
}
