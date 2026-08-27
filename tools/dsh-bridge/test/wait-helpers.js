/**
 * Ожидания в тестах моста: истечение бюджета должно ГОВОРИТЬ, а не молчать.
 *
 * Почему модуль вообще есть. `waitRun` по контракту не бросает: истёкший
 * бюджет — легитимный ответ «ещё не готово» (см. dsh-bridge-async-v2), и
 * возвращается тот же объект состояния, что при нормальном опросе. Для
 * ПРОДУКТА это правильно. Для ТЕСТА, которому завершение рана нужно как
 * предусловие, это ловушка: тест получает `state:"running"`, `envelope:null`,
 * шагает на следующую строку и падает там, где дефекта нет, — например
 * `assert.match(sid, …)` с `sid === undefined` или «The "string" argument must
 * be of type string». Диагноз приходится восстанавливать по остаткам.
 *
 * Ровно так набор и падал в CI (ubuntu-latest, 2 vCPU): имя упавшего теста
 * было, а причины — нет.
 *
 * Отсюда два правила, которые этот модуль делает механическими:
 *
 *  1. Ожидание, чьё истечение тест считает ОШИБКОЙ, обязано бросать и говорить:
 *     чего ждали, что увидели, сколько прождали  →  `waitRunSettled`.
 *  2. Где возврат по таймауту ЛЕГИТИМЕН (кейсы про «короткий waitMs не трогает
 *     живой ран»), тест обязан проверять состояние ЯВНО — такие кейсы этот
 *     модуль не трогают, они и так делают `assert.equal(r.state, 'running')`.
 *
 * Бюджеты здесь НЕ подняты намеренно. Замер на 2 vCPU (`taskset -c 0,1`,
 * 30 повторов): полный round-trip `startDsh → waitRun(терминальное)` для
 * `__FAKE_ENVELOPE_OK__` — p50 55 мс, max 65 мс. Против нынешних 3000 мс это
 * 46-кратный запас, то есть наблюдавшиеся падения — НЕ упор в бюджет: ран
 * успевал завершиться и приходил в состоянии `error`, а не `running`.
 * Поднимать бюджет здесь значило бы лечить не ту болезнь.
 */
import { waitRun } from '../src/async-run.js';

/**
 * Короткая сводка рана для сообщений об ошибке: главное — ПРИЧИНА из envelope,
 * иначе `expected 'completed', actual 'error'` не объясняет ничего.
 * @param {{state: string, exitCode: number|null, envelope: any}} r
 * @returns {string}
 */
export function describeRun(r) {
  const parts = [`state=${r.state}`, `exitCode=${r.exitCode}`];
  if (r.envelope === null || r.envelope === undefined) {
    parts.push('envelope=null');
  } else if (r.envelope.error) {
    parts.push(`envelope.status=${r.envelope.status}`);
    parts.push(`error.code=${r.envelope.error.code}`);
    parts.push(`error.message=${JSON.stringify(r.envelope.error.message ?? '')}`);
  } else {
    parts.push(`envelope.status=${r.envelope.status}`);
  }
  return parts.join(' ');
}

/**
 * `waitRun` для случаев, когда завершение рана — ПРЕДУСЛОВИЕ теста.
 * Истёкший бюджет здесь не «ещё не готово», а провал: бросаем с диагнозом.
 *
 * @param {string} runId
 * @param {{waitMs: number, registryPath?: string, signal?: AbortSignal}} opts
 * @returns {Promise<any>} состояние рана, гарантированно НЕ "running"
 */
export async function waitRunSettled(runId, opts) {
  const t0 = Date.now();
  const r = await waitRun(runId, opts);
  if (r.state === 'running') {
    throw new Error(
      `ран ${runId} не дошёл до терминального состояния за ${opts.waitMs}мс ` +
        `(фактически ждали ${Date.now() - t0}мс). Увидели: ${describeRun(r)}. ` +
        'Это истёкшее ожидание, а не дефект в следующей строке теста: ' +
        'waitRun по контракту не бросает, он вернул «ещё не готово».',
    );
  }
  return r;
}

/**
 * Дождаться терминального состояния И убедиться, что оно ожидаемое.
 * Обе неудачи — с причиной: истечение бюджета отличимо от «завершился не так».
 *
 * @param {string} runId
 * @param {string} expectedState ожидаемое терминальное состояние
 * @param {{waitMs: number, registryPath?: string, signal?: AbortSignal}} opts
 * @returns {Promise<any>}
 */
export async function waitRunInState(runId, expectedState, opts) {
  const r = await waitRunSettled(runId, opts);
  if (r.state !== expectedState) {
    throw new Error(`ран ${runId}: ожидали state="${expectedState}", получили ${describeRun(r)}`);
  }
  return r;
}
