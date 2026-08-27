/**
 * Протокол вопроса к человеку.
 *
 * Envelope v1 умеет `status: "need_input"` с полем `question`, но DSH сам о
 * таком статусе не знает: модель, которой нужен ответ человека, штатно
 * завершает ход как `completed` с текстом-вопросом. Внутренний `blocked` — про
 * другое (шаг отклонён гейтом), поэтому опознать вопрос можно только по
 * договорённости с моделью.
 *
 * Договорённость могла бы жить в persona, но persona headless-профиля общая с
 * web и tui (`~/.dsh/cordis.patch.yml` применяется после профильного слоя и
 * перебивает его), а `--patch` overlay пришлось бы дублировать целиком —
 * значит, дрейфовать при каждой правке persona. Поэтому протокол
 * дописывается к самой задаче: он касается ровно того рана, который его
 * получил, и не трогает живую конфигурацию.
 *
 * Цена решения: бриф перестаёт быть дословным. Блок отделён и помечен, чтобы
 * его было видно и в логах, и модели.
 */
export const NEED_INPUT_PROTOCOL = [
  '---',
  'Answer protocol: if you need a human answer to continue, end your',
  'answer with a separate last line of the form',
  'NEED_INPUT: <your question>',
  'If there is no question, this line must not be present.',
].join('\n');

/**
 * Дописывает протокол к тексту задачи.
 *
 * По умолчанию ВЫКЛЮЧЕНО: дословная передача брифа — инвариант контракта v1,
 * и ядро bridge не вправе его нарушать само. Протокол включает слой тулов,
 * который умеет обработать need_input сам (в OMP-расширении вопрос уходит
 * директору и закрывается через dsh_answer).
 *
 * @param {string} task исходный бриф
 * @param {boolean} [enabled] true — дописать протокол
 * @returns {string}
 */
export function withAskProtocol(task, enabled = false) {
  if (enabled !== true) return task;
  if (typeof task !== 'string' || task.trim() === '') return task;
  // Повторная обёртка (например, retry поверх уже подготовленного текста) не
  // должна плодить копии протокола.
  if (task.includes('NEED_INPUT:')) return task;
  return `${task}\n\n${NEED_INPUT_PROTOCOL}`;
}
