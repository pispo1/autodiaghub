import assert from 'node:assert/strict';
import test from 'node:test';
import { deleteReading, listReadings, makePsaReading, makeReading, saveReading, trendFor } from '../dist/history.mjs';

function memoryStorage() {
  const entries = new Map();
  return {
    get length() { return entries.size; },
    key: (index) => Array.from(entries.keys())[index] ?? null,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: (key) => entries.delete(key),
  };
}

function liveReading(time, value, identifier = '0C', protocol = 'CAN', label = 'Engine speed') {
  return makeReading({ modeId: '01', identifier }, { protocol, rows: [{ label, value }] }, time);
}

test('persists readings separately, reloads newest first, and deletes only the chosen reading', () => {
  const storage = memoryStorage();
  storage.setItem('unrelated', 'keep');
  const first = liveReading(100, '1100 rpm');
  const second = makeReading({ modeId: '03' }, { protocol: 'CAN', codes: [] }, 200);
  const firstKey = saveReading(storage, first);
  const secondKey = saveReading(storage, second);
  storage.setItem('autodiaghub:reading:v1:corrupt', '{');
  assert.deepEqual(listReadings(storage), [{ ...second, key: secondKey }, { ...first, key: firstKey }]);
  deleteReading(storage, firstKey);
  deleteReading(storage, 'unrelated');
  assert.deepEqual(listReadings(storage), [{ ...second, key: secondKey }]);
  assert.equal(storage.getItem('unrelated'), 'keep');
});

test('keeps freeze-frame and sensor context and excludes support maps from history', () => {
  const result = { protocol: 'CAN', rows: [{ label: 'Temperature', value: '80 °C' }] };
  const freeze = makeReading({ modeId: '02', identifier: '05', extra: '01' }, result, 100);
  const sensor = makeReading({ modeId: '05', identifier: '01', extra: '04' }, result, 200);
  assert.equal(freeze.extra, '01');
  assert.equal(sensor.extra, '04');
  assert.equal(makeReading({ modeId: '01' }, { protocol: 'CAN', supported: [5] }, 300), null);
  assert.equal(makeReading({ modeId: '04' }, { protocol: 'CAN', codes: [] }, 400), null);
});

test('trends matching single-value live samples in timestamp order', () => {
  const selected = liveReading(300, '2000 rpm');
  const earlier = liveReading(100, '1200 rpm');
  const excluded = [
    liveReading(200, '42 rpm', '0D'),
    liveReading(210, '42 rpm', '0C', 'KWP'),
    liveReading(220, '42 km/h'),
    liveReading(230, '12 AB', '0C', 'CAN', 'Raw PID data'),
    makeReading({ modeId: '02', identifier: '0C', extra: '00' },
      { protocol: 'CAN', rows: [{ label: 'Engine speed', value: '600 rpm' }] }, 240),
  ];
  assert.equal(trendFor([selected, ...excluded], selected), null);
  assert.deepEqual(trendFor([selected, ...excluded, earlier], selected), {
    label: 'Engine speed', unit: 'rpm', points: [{ time: 100, value: 1200 }, { time: 300, value: 2000 }],
  });
});

test('PSA snapshots retain ECU context and coexist with existing generic readings', () => {
  const context = { vehicle: 'B78', variant: 'Phase 2', ecu: 'ABS', model: 'ESP90', protocol: 'UDS' };
  const snapshot = makePsaReading(context, [{ label: '$D42E', value: '48 %' }], 300);
  const storage = memoryStorage();
  const generic = liveReading(100, '1200 rpm');
  const genericKey = saveReading(storage, generic);
  const psaKey = saveReading(storage, snapshot);
  assert.deepEqual(listReadings(storage), [{ ...snapshot, key: psaKey }, { ...generic, key: genericKey }]);
  assert.equal(makePsaReading({ ...context, model: '' }, snapshot.rows, 300), null);
  assert.equal(trendFor(listReadings(storage), snapshot), null);
});
