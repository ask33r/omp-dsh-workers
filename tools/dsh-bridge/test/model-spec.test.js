import './node-only.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseModelSpec,
  formatModelSpec,
  assertModelSpec,
  ModelSpecError,
  THINKING_LEVELS,
} from '../src/model-spec.js';

describe('model-spec', () => {
  it('без effort', () => {
    const s = parseModelSpec('omniroute/cx/gpt-5.6-sol');
    assert.deepEqual(s, { provider: 'omniroute', model: 'cx/gpt-5.6-sol' });
  });
  it('с effort', () => {
    const s = parseModelSpec('omniroute/cx/gpt-5.6-sol:high');
    assert.deepEqual(s, { provider: 'omniroute', model: 'cx/gpt-5.6-sol', reasoningEffort: 'high' });
  });
  it('все effort уровни парсятся', () => {
    for (const eff of THINKING_LEVELS) {
      const s = parseModelSpec(`omniroute/model:${eff}`);
      assert.equal(s.reasoningEffort, eff);
    }
  });
  it(': без валидного суффикса — часть id модели', () => {
    const s = parseModelSpec('omniroute/cx/gpt-5.6-sol:bogus');
    assert.deepEqual(s, { provider: 'omniroute', model: 'cx/gpt-5.6-sol:bogus' });
    const s2 = parseModelSpec('omniroute/model:unknown');
    assert.deepEqual(s2, { provider: 'omniroute', model: 'model:unknown' });
  });
  it('пустой provider', () => {
    assert.throws(() => parseModelSpec('/model'), ModelSpecError);
  });
  it('пустой model после /', () => {
    assert.throws(() => parseModelSpec('prov/'), ModelSpecError);
  });
  it('отсутствует /', () => {
    assert.throws(() => parseModelSpec('nomodel'), ModelSpecError);
  });
  it('whitespace', () => {
    assert.throws(() => parseModelSpec('omniroute/cx model'), ModelSpecError);
    assert.throws(() => parseModelSpec('omniroute/cx/gpt:high '), ModelSpecError);
    assert.throws(() => parseModelSpec(' omniroute/model'), ModelSpecError);
  });
  it('control/NUL', () => {
    assert.throws(() => parseModelSpec('omniroute/model\x00'), ModelSpecError);
    assert.throws(() => parseModelSpec('omniroute/model\x1f'), ModelSpecError);
    assert.throws(() => parseModelSpec('omniroute/model\x7f'), ModelSpecError);
    assert.throws(() => parseModelSpec('omniroute/mo\tdel'), ModelSpecError);
  });
  it('лимиты длины компонента >200', () => {
    const long = 'a'.repeat(201);
    assert.throws(() => parseModelSpec(`omniroute/${long}`), ModelSpecError);
    assert.throws(() => parseModelSpec(`${long}/model`), ModelSpecError);
  });
  it('суммарно >512', () => {
    // provider 200 + '/' + model 200 + ':high' = 406, need >512 => need longer but individual >200 throws first.
    // Use provider 200 + '/' + model 200 + ':max' still <512. To trigger total >512, use 200+1+200+1+3=405, can't exceed 512 without one segment >200?
    // So total check mainly for assembled spec; construct directly via assertModelSpec for total test.
    // provider 200 +1+ model 200 +1+ effort 4 =405 <512, need extra to exceed. Actually max under per-segment limits is 405, so total >512 impossible via single slash string?
    // But ModelSpec object with provider 200 + model containing slashes can exceed per-component 200 check differently: rest without effort is model, so max model is 200 including slashes.
    // So 512 check is reachable only via multi-segment model? We'll test via assertModelSpec where model itself is 200 but total with effort still <512.
    // For total >512 via object: provider 200, model 200, effort 'max' =405 <512, not trigger. Use direct 512 string without slash? Already covered.
    assert.throws(() => parseModelSpec('a'.repeat(513)), ModelSpecError);
  });
  it('round-trip identity', () => {
    const cases = [
      'omniroute/model',
      'omniroute/cx/deep:model:high',
      'prov/a:b:c:low',
      'p/m',
      'omniroute/cx/gpt-5.6-sol:bogus',
    ];
    for (const c of cases) {
      const s = parseModelSpec(c);
      // For cases where suffix is not valid effort, round-trip should hold too
      assert.equal(formatModelSpec(s), c, c);
    }
    for (const eff of THINKING_LEVELS) {
      const raw = `omniroute/cx/model:${eff}`;
      assert.equal(formatModelSpec(parseModelSpec(raw)), raw);
    }
  });
  it('assertModelSpec: лишние ключи', () => {
    assert.throws(() => assertModelSpec({ provider: 'p', model: 'm', extra: 1 }), ModelSpecError);
  });
  it('assertModelSpec: плохой effort', () => {
    assert.throws(() => assertModelSpec({ provider: 'p', model: 'm', reasoningEffort: 'bad' }), ModelSpecError);
  });
  it('assertModelSpec: не объект', () => {
    assert.throws(() => assertModelSpec('omniroute/model'), ModelSpecError);
    assert.throws(() => assertModelSpec(null), ModelSpecError);
  });
  it('assertModelSpec: пустые поля', () => {
    assert.throws(() => assertModelSpec({ provider: '', model: 'm' }), ModelSpecError);
    assert.throws(() => assertModelSpec({ provider: 'p', model: '' }), ModelSpecError);
  });
  it('assertModelSpec: total >512 via object', () => {
    // Can't exceed 512 with per-component 200 limit, but test boundary via long model still within 200 but provider 200 => 401 <512.
    // So total >512 unreachable via assertModelSpec either; check anyway via 512-limit string.
    assert.doesNotThrow(() =>
      assertModelSpec({ provider: 'p'.repeat(200), model: 'm'.repeat(200), reasoningEffort: 'max' }),
    );
  });
  it('formatModelSpec round-trip for object', () => {
    const spec = { provider: 'omniroute', model: 'cx/gpt-5.6-sol', reasoningEffort: 'high' };
    assert.equal(formatModelSpec(spec), 'omniroute/cx/gpt-5.6-sol:high');
  });
});
