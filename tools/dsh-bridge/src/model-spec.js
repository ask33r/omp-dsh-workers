export class ModelSpecError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ModelSpecError';
  }
}

export const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

function hasInvalidChars(s) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: класс управляющих символов здесь и есть предмет проверки — спеки с ними отбраковываются
  return /[\x00-\x1f\x7f]/.test(s) || /\s/.test(s);
}

export function assertModelSpec(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new ModelSpecError('ModelSpec must be an object');
  }
  const allowed = new Set(['provider', 'model', 'reasoningEffort']);
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) {
      throw new ModelSpecError(`unknown key: ${k}`);
    }
  }
  const { provider, model, reasoningEffort } = obj;
  if (typeof provider !== 'string' || provider.length === 0) {
    throw new ModelSpecError('provider must be non-empty string');
  }
  if (typeof model !== 'string' || model.length === 0) {
    throw new ModelSpecError('model must be non-empty string');
  }
  if (provider.length > 200) throw new ModelSpecError('provider length > 200');
  if (model.length > 200) throw new ModelSpecError('model length > 200');
  if (hasInvalidChars(provider)) throw new ModelSpecError('provider contains whitespace or control characters');
  if (hasInvalidChars(model)) throw new ModelSpecError('model contains whitespace or control characters');
  if (reasoningEffort !== undefined) {
    if (typeof reasoningEffort !== 'string') throw new ModelSpecError('reasoningEffort must be string');
    if (!THINKING_LEVELS.has(reasoningEffort)) {
      throw new ModelSpecError(`reasoningEffort must be one of ${[...THINKING_LEVELS].join(',')}`);
    }
  }
  const total = provider.length + 1 + model.length + (reasoningEffort !== undefined ? 1 + reasoningEffort.length : 0);
  if (total > 512) throw new ModelSpecError('ModelSpec total length > 512');
}

export function parseModelSpec(str) {
  if (typeof str !== 'string') throw new ModelSpecError('ModelSpec must be string');
  if (str.length === 0) throw new ModelSpecError('ModelSpec string must be non-empty');
  if (str.length > 512) throw new ModelSpecError('ModelSpec string length > 512');
  // biome-ignore lint/suspicious/noControlCharactersInRegex: контракт parseModelSpec — отвергать управляющие символы, поэтому они обязаны быть в шаблоне
  if (/[\x00-\x1f\x7f]/.test(str)) throw new ModelSpecError('ModelSpec contains control characters');
  if (/\s/.test(str)) throw new ModelSpecError('ModelSpec contains whitespace');
  const slashIdx = str.indexOf('/');
  if (slashIdx === -1) throw new ModelSpecError('ModelSpec must contain /');
  const provider = str.slice(0, slashIdx);
  const rest = str.slice(slashIdx + 1);
  if (provider.length === 0) throw new ModelSpecError('provider must be non-empty');
  if (rest.length === 0) throw new ModelSpecError('model must be non-empty');
  if (provider.length > 200) throw new ModelSpecError('provider length > 200');
  if (hasInvalidChars(provider)) throw new ModelSpecError('provider contains whitespace or control characters');

  const colonIdx = rest.lastIndexOf(':');
  let model;
  let reasoningEffort;
  if (colonIdx !== -1) {
    const suffix = rest.slice(colonIdx + 1);
    if (THINKING_LEVELS.has(suffix)) {
      const candidate = rest.slice(0, colonIdx);
      if (candidate.length === 0) throw new ModelSpecError('model must be non-empty');
      if (candidate.length > 200) throw new ModelSpecError('model length > 200');
      if (hasInvalidChars(candidate)) throw new ModelSpecError('model contains whitespace or control characters');
      model = candidate;
      reasoningEffort = suffix;
    } else {
      // ':' is part of model
      if (rest.length > 200) throw new ModelSpecError('model length > 200');
      if (hasInvalidChars(rest)) throw new ModelSpecError('model contains whitespace or control characters');
      model = rest;
    }
  } else {
    if (rest.length > 200) throw new ModelSpecError('model length > 200');
    if (hasInvalidChars(rest)) throw new ModelSpecError('model contains whitespace or control characters');
    model = rest;
  }

  const spec = reasoningEffort !== undefined ? { provider, model, reasoningEffort } : { provider, model };
  // final total check (already limited by components, but for completeness)
  const total = provider.length + 1 + model.length + (reasoningEffort ? 1 + reasoningEffort.length : 0);
  if (total > 512) throw new ModelSpecError('ModelSpec total length > 512');
  return spec;
}

export function formatModelSpec(spec) {
  assertModelSpec(spec);
  return spec.reasoningEffort !== undefined
    ? `${spec.provider}/${spec.model}:${spec.reasoningEffort}`
    : `${spec.provider}/${spec.model}`;
}
