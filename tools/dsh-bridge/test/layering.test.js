import './node-only.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const SRC = join(import.meta.dirname, '..', 'src');

/**
 * Направление зависимостей между путями спавна.
 *
 * `run.js` — замороженный контракт v1. Он может быть зависимостью для чего
 * угодно (стабильное API — хорошая зависимость), но сам не должен тянуть
 * развивающийся v2 (`async-run.js`): так уже возник цикл импортов, который
 * ESM терпит до первого top-level обращения, а потом ломается невнятным
 * «undefined is not a function».
 *
 * Если этот тест упал — значит v1 понадобился общий с v2 код. Правильный ход:
 * вынести этот код в отдельный модуль (например `run-files.js`), от которого
 * зависят оба пути, а не импортировать v2 в v1.
 */
describe('layering', () => {
  it('run.js (v1, frozen) не импортирует async-run.js (v2)', async () => {
    const src = await readFile(join(SRC, 'run.js'), 'utf8');
    const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    assert.ok(
      !imports.some((s) => s.includes('async-run')),
      'run.js потянул async-run.js: общий код выносить в отдельный модуль, а не v2 в v1',
    );
  });
});
