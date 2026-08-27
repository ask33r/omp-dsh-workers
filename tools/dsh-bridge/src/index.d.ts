// Типы публичного API bridge-core по контракту v1
// (docs/contracts/dsh-bridge-contract-v1.md). Реализация — index.js (Node/ESM, stdlib).

export type EnvelopeStatus = "completed" | "need_input" | "error";

export type EnvelopeErrorCode =
  | "spawn_failed"
  | "nonzero_exit"
  | "timeout"
  | "killed"
  | "malformed_output"
  | "resume_not_found"
  | "resume_corrupt"
  | "resume_busy"
  // Сторож брошенных ранов (async v2): владелец исчез / ран пережил дедлайн.
  | "owner_gone"
  | "deadline_exceeded"
  | "model_not_found"
  | "invalid_model";

// ModelSpec и его хелперы объявлены в model-spec.d.ts — рядом с реализацией,
// которую часть кода импортирует напрямую, минуя index.js.
import type { ModelSpec } from "./model-spec.js";
export type { ModelSpec };
export { ModelSpecError, parseModelSpec, formatModelSpec, assertModelSpec, THINKING_LEVELS } from "./model-spec.js";

export interface Envelope {
  v: 1;
  runId: string;
  sessionId: string | null;
  status: EnvelopeStatus;
  result?: string;
  question?: string;
  error?: { code: EnvelopeErrorCode; message: string; exitCode?: number };
  model?: ModelSpec;
}

export interface RunDshOptions {
  /** Бриф читается из файла, НИКОГДА из argv-строки. */
  taskFile: string;
  resumeSessionId?: string;
  cwd: string;
  /** Передаётся поверх минимального белого списка env. */
  env?: Record<string, string>;
  /** Дефолт 1800000. */
  timeoutMs?: number;
  onStdout?: (chunk: string) => void;
  /** Отмена → SIGTERM всей process group. */
  signal?: AbortSignal;
  /** Путь к реестру ранов; по умолчанию var/runs.json рядом с bridge. */
  registryPath?: string;
  /** Дописывает протокол NEED_INPUT: к задаче; по умолчанию выключено (см. task-protocol.js). */
  askProtocol?: boolean;
  model?: ModelSpec;
}

export function runDsh(opts: RunDshOptions): Promise<Envelope>;

export interface RunEntry {
  pid: number;
  pgid: number;
  dshSessionId: string | null;
  ompAgentId?: string;
  state: string;
  startedAt: string;
  cwd?: string;
  /** абсолютный путь; stdout+stderr рана (merged) — только у записей v2 (startDsh) */
  logFile?: string;
  /** путь к envelope-файлу рана — только у записей v2 */
  envelopeFile?: string;
  /** путь к steer-каналу рана — только у записей v2 */
  steerFile?: string;
  exitCode?: number | null;
  /** startedAt + timeoutMs; null = без дедлайна */
  deadlineAt?: string | null;
  /** до какого момента ран считается нужным владельцу — только у записей v2 */
  leaseUntil?: string | null;
  /** метка рана для dsh_list — только у записей v2 (startDsh) */
  label?: string | null;
  /**
   * поле 22 из /proc/<pid>/stat в момент спавна; identity против
   * переиспользования PID (P1 п.3, раунд 2 кросс-ревью). Пишут ОБА пути —
   * v1 (runDsh) и v2 (startDsh); раньше писал только v2.
   */
  procStarttime?: string | null;
  /** claim reapExpiredRuns'а (P0 п.2, раунд 2): ран забран, kill уже в процессе */
  reapClaimAt?: string;
  model?: ModelSpec;
}

export function getRegistryPath(override?: string): string;
/** Алиас getRegistryPath (index.js реэкспортирует его под этим именем). */
export function getRegistryFile(override?: string): string;
export function readRegistry(registryPath?: string): Promise<Record<string, RunEntry>>;
// writeRegistry больше не публичный API (P0 п.1, раунд 2): это сырая запись
// поверх реестра без withRegistryLock — index.js её больше не реэкспортирует,
// поэтому не объявляем и здесь (типы должны отражать реальные экспорты).
export function listRuns(registryPath?: string): Promise<Record<string, RunEntry>>;
export function getRun(runId: string, registryPath?: string): Promise<RunEntry | null>;
export function putRun(runId: string, entry: RunEntry, registryPath?: string): Promise<RunEntry>;
export function updateRun(runId: string, patch: Partial<RunEntry>, registryPath?: string): Promise<RunEntry | null>;
export function removeRun(runId: string, registryPath?: string): Promise<boolean>;
export function reapOrphans(registryPath?: string): Promise<{ removed: string[]; killed: string[] }>;
export function isPidAlive(pid: unknown): boolean;
export function isPgidAlive(pgid: unknown): boolean;

/** `reason` заполнен только когда `valid: false` — единственная строка-объяснение, не список. */
export function validateEnvelope(value: unknown): { valid: boolean; reason?: string };

export function makeEnvelope(opts: {
  runId?: string;
  sessionId?: string | null;
  status: EnvelopeStatus;
  result?: string;
  question?: string;
  error?: { code: string; message: string; exitCode?: number | null };
  model?: ModelSpec;
}): Envelope;

/** completed envelope из сырого stdout (обрезает ровно один хвостовой \n). */
export function synthesizeCompleted(runId: string, stdoutText: string, sessionId?: string | null): Envelope;

/** error envelope с указанным кодом (не обязан входить в ERROR_CODES — известные коды не enforce'ятся строго). */
export function synthesizeError(
  runId: string,
  code: string,
  message: string,
  exitCode?: number | null,
  sessionId?: string | null,
): Envelope;

export type ParsedEnvelopeResult =
  | { envelope: Envelope; raw: string; index: number }
  | { malformed: true; raw: string; reason?: string; parsed: unknown }
  | { none: true };

/** Ищет последней НЕПУСТОЙ строкой валидный envelope v1; не бросает на мусорном/отсутствующем выводе. */
export function tryParseEnvelopeFromStdout(stdout: string): ParsedEnvelopeResult;
export function envelopeToJsonLine(envelope: Envelope): string;
export const ERROR_CODES: ReadonlySet<EnvelopeErrorCode>;

/**
 * Протокол вопроса к человеку (see task-protocol.js): дописывается к брифу,
 * когда его включает вызывающий слой, умеющий обработать need_input (в
 * OMP-расширении вопрос уходит директору и закрывается через dsh_answer).
 * По умолчанию ВЫКЛЮЧЕНО — дословная передача брифа обязательна для ядра bridge.
 */
export const NEED_INPUT_PROTOCOL: string;
/** enabled должен быть строго `true` — любое другое truthy-значение НЕ включает протокол. */
export function withAskProtocol(task: string, enabled?: boolean): string;

// ---------------------------------------------------------------------------
// Неблокирующий API v2 (docs/contracts/dsh-bridge-async-v2.md)
// Envelope v1 не меняется; runDsh() выше остаётся как есть.
// ---------------------------------------------------------------------------

export type RunState = "running" | "completed" | "need_input" | "error";

export interface RunHandle {
  /** uuid */
  runId: string;
  pid: number;
  pgid: number;
  /** абсолютный путь; stdout+stderr рана (merged) */
  logFile: string;
  /** ISO */
  startedAt: string;
}

export interface StartDshOptions {
  /** как в v1: бриф только файлом */
  taskFile: string;
  resumeSessionId?: string;
  /**
   * Продолжить сессию ПРЕДЫДУЩЕГО РАНА по его runId — bridge сам находит
   * sessionId через sessionIdOfRun. Слабее явного resumeSessionId. Бросает,
   * если у указанного рана ещё нет сессии (не завершён / без envelope).
   */
  resumeFromRunId?: string;
  cwd: string;
  env?: Record<string, string>;
  /** дефолт 1800000; сторожит сам bridge */
  timeoutMs?: number;
  registryPath?: string;
  /** метка рана для dsh_list — только кросс-агентный поиск, на спавн не влияет */
  label?: string;
  /** дописывает протокол NEED_INPUT: к задаче; по умолчанию выключено */
  askProtocol?: boolean;
  /** дефолт DEFAULT_LEASE_MS */
  leaseMs?: number;
  model?: ModelSpec;
}

/** Стартует ран и возвращает управление СРАЗУ, не дожидаясь завершения. */
export function startDsh(opts: StartDshOptions): Promise<RunHandle>;

export interface PollRunResult {
  runId: string;
  state: RunState;
  /** не null только когда state !== "running" */
  envelope: Envelope | null;
  exitCode: number | null;
}

/** Неблокирующий снимок состояния. Никогда не ждёт. */
export function pollRun(runId: string, opts?: { registryPath?: string }): Promise<PollRunResult>;

export interface WaitRunOptions {
  /** обязателен; 0 = как pollRun */
  waitMs: number;
  registryPath?: string;
  /** отменяет ОЖИДАНИЕ, не ран */
  signal?: AbortSignal;
  /** ожидание продлевает аренду владельца; дефолт DEFAULT_LEASE_MS */
  leaseMs?: number;
}

/**
 * Ждёт завершения не дольше waitMs. Таймаут ожидания — НЕ ошибка рана:
 * возвращает state:"running" и envelope:null, ран продолжает жить.
 */
export function waitRun(runId: string, opts: WaitRunOptions): Promise<PollRunResult>;

export interface KillRunOptions {
  signal?: "SIGTERM" | "SIGKILL";
  /** дефолт 2000 */
  graceMs?: number;
  registryPath?: string;
  /** дефолт 'killed'; сторож просроченных ранов передаёт свою причину (owner_gone/deadline_exceeded) */
  reasonCode?: EnvelopeErrorCode | string;
  reasonMessage?: string;
}

export interface KillRunResult {
  runId: string;
  killed: boolean;
  state: RunState;
}

/** SIGTERM всей группе, затем SIGKILL после grace. Идемпотентен. */
export function killRun(runId: string, opts?: KillRunOptions): Promise<KillRunResult>;

export interface ReadRunOutputOptions {
  /** байтовый offset, дефолт 0 */
  offset?: number;
  /** дефолт 65536 */
  maxBytes?: number;
  registryPath?: string;
}

export interface ReadRunOutputResult {
  chunk: string;
  nextOffset: number;
  eof: boolean;
}

/** Инкрементальное чтение вывода для стриминга в UI. */
export function readRunOutput(runId: string, opts?: ReadRunOutputOptions): Promise<ReadRunOutputResult>;

export interface SendToRunOptions {
  registryPath?: string;
  /** steering продлевает аренду владельца; дефолт DEFAULT_LEASE_MS */
  leaseMs?: number;
}

/**
 * Трёхзначный статус доставки (P1 п.4, раунд 2 кросс-ревью). Раньше был один
 * boolean delivered, и delivered:false смешивал "ран мёртв, сообщение
 * потеряно навсегда" с "ран жив, просто канал ещё не вычитан, подтверждения
 * чтения нет (это не гарантия доставки)" — вызывающему нужно РАЗНОЕ действие
 * в этих случаях (см. SendToRunResult).
 */
export type SendToRunStatus = "delivered" | "pending" | "undeliverable";

export interface SendToRunResult {
  /**
   * true — ТОЛЬКО когда status === "delivered" (раннер реально вычитал
   * записанную строку в течение окна ожидания). Оставлено для обратной
   * совместимости; для различения pending/undeliverable смотри `status`.
   */
  delivered: boolean;
  /**
   * "delivered" — раннер подтвердил чтение (offset догнал конец записи).
   * "pending" — запись в канал успешно завершилась, ран был жив при повторной
   * проверке, но подтверждения ЧТЕНИЯ нет — это не гарантия последующей
   * доставки. Не повод повторять отправку или дублировать другим маршрутом:
   * двойной steering остаётся реальным риском, а сообщение с высокой
   * вероятностью будет прочитано.
   * "undeliverable" — ран в терминальном состоянии, подтверждения не будет
   * никогда (включая случай, когда ран уже был не running ДО отправки —
   * запись в канал даже не делалась).
   */
  status: SendToRunStatus;
  steerFile: string;
  /** Байты, которые раннер ещё не вычитал (по его же <steerFile>.offset), на момент возврата. */
  pendingBytes: number;
  /** Сколько реально ждали подтверждения чтения, мс; 0 = ран уже был не running, ждать не пришлось. */
  waitedMs: number;
}

/** Дописать сообщение в steer-канал идущего рана. Контракт: dsh-bridge-async-v2.md (раздел dsh_send/steer). */
export function sendToRun(runId: string, text: string, opts?: SendToRunOptions): Promise<SendToRunResult>;

/**
 * Идентификатор сессии DSH, порождённой раном, или null (ран ещё не
 * завершён, не оставил envelope, либо runId неизвестен — исключения не бросает).
 */
export function sessionIdOfRun(runId: string, registryPath?: string): Promise<string | null>;

/** Дефолт аренды владельца: 5 минут тишины (`dsh_wait` не звали) — и ран считается брошенным. */
export const DEFAULT_LEASE_MS: number;

export interface RenewLeaseOptions {
  leaseMs?: number;
  registryPath?: string;
}

/** Продлить аренду владельца. Возвращает новый leaseUntil (ISO) или null при ошибке (best-effort). */
export function renewLease(runId: string, opts?: RenewLeaseOptions): Promise<string | null>;

/** Причина, по которой ран пора забрать, или null (в т.ч. для записей без сроков и не-running). */
export function expiryReasonOf(
  entry: RunEntry | null | undefined,
  now?: number,
): "owner_gone" | "deadline_exceeded" | null;

export interface ReapExpiredRunsOptions {
  /** для тестов: подменить текущее время (мс) */
  now?: number;
  graceMs?: number;
}

export interface ReapExpiredRunsResult {
  killed: string[];
  /** runId -> 'owner_gone' | 'deadline_exceeded' */
  reasons: Record<string, string>;
}

/** Сторож брошенных ранов: добивает раны с истёкшим дедлайном или арендой. */
export function reapExpiredRuns(registryPath?: string, opts?: ReapExpiredRunsOptions): Promise<ReapExpiredRunsResult>;

export interface SweepRunsResult {
  /** runId рана, добитого reapExpiredRuns */
  expired: string[];
  reasons: Record<string, string>;
  /** записи, вычищенные следующим за этим reapOrphans */
  removed: string[];
  killed: string[];
}

/** Полное обслуживание реестра одним вызовом: reapExpiredRuns, затем reapOrphans. */
export function sweepRuns(registryPath?: string, opts?: ReapExpiredRunsOptions): Promise<SweepRunsResult>;

/**
 * Раны этого процесса — единственные, которые выход сессии вправе убить; чужие
 * сессии видны только через реестр и остаются на сторожа. Возвращает runId из
 * activeRuns, у которых !flags.closed && !flags.spawnError.
 */
export function ownRunIds(): string[];
