// Типы model-spec.js. Модуль импортируют напрямую — и из bridge-core, и из
// extensions/dsh-task (TS), — поэтому декларация лежит рядом с реализацией, а
// index.d.ts её реэкспортирует ровно так же, как index.js реэкспортирует сам модуль.

export interface ModelSpec {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export class ModelSpecError extends Error {}
export function parseModelSpec(spec: string): ModelSpec;
export function formatModelSpec(spec: ModelSpec): string;
export function assertModelSpec(spec: unknown): void;
export const THINKING_LEVELS: ReadonlySet<string>;
