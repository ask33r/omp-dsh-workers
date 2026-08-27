/**
 * Рантайм-гард для node-only тестов моста.
 *
 * ПОЧЕМУ он существует: `mock.module()` в bun — ГЛОБАЛЬНЫЙ на весь процесс и не
 * откатывается между тест-файлами. Голый `bun test` прогоняет весь репозиторий
 * одним процессом, extensions/** идут раньше tools/** по алфавиту — и к моменту
 * запуска тестов моста `../src/index.js` подменён моком из extensions-тестов.
 * Дальше `startDsh` отдаёт фикстуру `{ pid: 1, pgid: 1 }`, cleanup бьёт по этой
 * «группе», и `kill(-1)` оказывается broadcast-сигналом всем процессам
 * пользователя — в контейнере это убивает PID 1-обвязку и всю сессию.
 *
 * bunfig.toml ([test].root = "extensions") убирает эти файлы из области поиска
 * bare `bun test`, но явный `bun test ./tools/...` root игнорирует. Этот модуль
 * закрывает и такой запуск: его импортируют ПЕРВЫМ, поэтому throw случается
 * раньше, чем ESM успеет выполнить импорт `../src/index.js` и зарегистрировать
 * хоть один it().
 */
export const NODE_ONLY_MESSAGE = [
  'Bridge tests are node-only: run them with `bun run test:bridge` (node --test), not `bun test`.',
  'Bare `bun test` runs the whole repo in one process, where mock.module() from the',
  'extensions tests leaks into these files and turns cleanup kills into kill(-1) broadcasts.',
].join(' ');

/** Отдельная функция, чтобы гард был проверяем тестом без запуска bun. */
export function assertNodeOnlyRuntime(isBun) {
  if (isBun) throw new Error(NODE_ONLY_MESSAGE);
}

assertNodeOnlyRuntime(typeof Bun !== 'undefined');
