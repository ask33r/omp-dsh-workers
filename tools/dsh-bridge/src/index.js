export { runDsh, getRegistryPath } from './run.js';
// writeRegistry НЕ реэкспортируем (P0 п.1, раунд 2 кросс-ревью): это сырая
// запись поверх реестра БЕЗ withRegistryLock — публичный API обязан ходить
// через putRun/updateRun/removeRun/clearRegistry, которые лок берут сами.
// Внутри registry.js остаётся как есть — putRun и другие мутации зовут его
// сами, уже держа лок.
export {
  readRegistry,
  listRuns,
  getRun,
  putRun,
  updateRun,
  removeRun,
  reapOrphans,
  isPidAlive,
  isPgidAlive,
  getRegistryPath as getRegistryFile,
} from './registry.js';
export {
  validateEnvelope,
  makeEnvelope,
  synthesizeCompleted,
  synthesizeError,
  tryParseEnvelopeFromStdout,
  envelopeToJsonLine,
  ERROR_CODES,
} from './envelope.js';
// Неблокирующий API v2 (docs/contracts/dsh-bridge-async-v2.md)
export {
  startDsh,
  pollRun,
  waitRun,
  killRun,
  readRunOutput,
  sendToRun,
  reapExpiredRuns,
  sweepRuns,
  sessionIdOfRun,
  renewLease,
  expiryReasonOf,
  DEFAULT_LEASE_MS,
  ownRunIds,
} from './async-run.js';
export { NEED_INPUT_PROTOCOL, withAskProtocol } from './task-protocol.js';
export { ModelSpecError, parseModelSpec, formatModelSpec, assertModelSpec, THINKING_LEVELS } from './model-spec.js';
