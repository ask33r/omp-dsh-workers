import './node-only.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { assertNodeOnlyRuntime, NODE_ONLY_MESSAGE } from './node-only.js';

const TEST_DIR = import.meta.dirname;
const REPO_ROOT = resolve(TEST_DIR, '..', '..', '..');

/**
 * Два независимых слоя защиты от голого `bun test`, каждый закрывает дыру
 * другого:
 *   1) bunfig.toml сужает область поиска bun-тестов до extensions/** — bare
 *      `bun test` физически не находит node-тесты моста;
 *   2) node-only.js — рантайм-гард: даже явный `bun test ./tools/...`
 *      (такая форма обходит [test].root, проверено) падает на импорте, до того
 *      как хоть один it() зарегистрируется.
 * Без (1) ошибку легко совершить; без (2) её всё ещё можно совершить руками.
 */
describe('защита от голого `bun test` (смешивание mock.module с node-тестами моста)', () => {
  it('assertNodeOnlyRuntime падает под bun и объясняет, чем запускать', () => {
    assert.throws(
      () => assertNodeOnlyRuntime(true),
      (err) => {
        assert.match(err.message, /bun run test:bridge/, 'сообщение обязано назвать правильную команду');
        assert.match(err.message, /mock\.module/, 'и причину — утечку глобального мока');
        return true;
      },
    );
  });

  it('под node гард пропускает (иначе test:bridge вообще не запустился бы)', () => {
    assert.doesNotThrow(() => assertNodeOnlyRuntime(false));
    assert.ok(NODE_ONLY_MESSAGE.length > 0);
  });

  it('bunfig.toml сужает область bun-тестов до extensions', () => {
    const bunfig = readFileSync(join(REPO_ROOT, 'bunfig.toml'), 'utf8');
    assert.match(bunfig, /\[test\]/, 'нужна секция [test]');
    assert.match(
      bunfig,
      /^\s*root\s*=\s*"extensions"\s*$/m,
      'root обязан указывать на extensions — иначе bare `bun test` снова подхватит tools/**',
    );
  });

  it('каждый node-тест моста импортирует гард первым', () => {
    const files = readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.js'));
    assert.ok(files.length >= 14, `sanity: тестов моста должно быть много, найдено ${files.length}`);
    for (const file of files) {
      const src = readFileSync(join(TEST_DIR, file), 'utf8');
      const firstImport = src.split('\n').find((line) => line.trimStart().startsWith('import'));
      assert.match(
        firstImport ?? '',
        /['"]\.\/node-only\.js['"]/,
        `${file}: гард обязан быть ПЕРВЫМ импортом — ESM выполняет импорты по порядку, ` +
          'и только так throw случится раньше загрузки ../src/index.js',
      );
    }
  });

  it('ни один тест моста не зовёт process.kill напрямую', () => {
    // Инвариант, а не разовая правка: новый тест с прямым process.kill —
    // это новый кандидат на kill(-1) broadcast. Сигналы идут через
    // killTestProcess/killPgid, пробы живости — через isPidAlive/isPgidAlive.
    // Комментарии вырезаем: про process.kill в этих файлах как раз и написано,
    // почему его звать нельзя — ловим только настоящий вызов.
    const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const offenders = readdirSync(TEST_DIR)
      .filter((f) => f.endsWith('.test.js'))
      .filter((f) => /process\.kill\s*\(/.test(stripComments(readFileSync(join(TEST_DIR, f), 'utf8'))));
    assert.deepEqual(offenders, [], 'используйте killTestProcess из ./kill-safe.js или isPidAlive');
  });

  it('настоящий bun действительно отказывается загружать node-only модуль', () => {
    const guardPath = join(TEST_DIR, 'node-only.js');
    const res = spawnSync('bun', ['-e', `await import(${JSON.stringify(guardPath)})`], {
      encoding: 'utf8',
      timeout: 20000,
    });
    if (res.error && res.error.code === 'ENOENT') {
      // bun не обязан быть на PATH там, где гоняют только node --test.
      return;
    }
    assert.notEqual(res.status, 0, 'bun обязан завершиться ненулевым кодом');
    assert.match(`${res.stderr}${res.stdout}`, /bun run test:bridge/);
  });
});
