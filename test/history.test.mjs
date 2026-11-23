import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareScans, deleteReading, listReadings, makePsaReading, makePsaScan, makeReading, rawExchangeFile, saveReading,
  scanBaselines, scanSummary, traceSession, trendFor,
} from '../dist/history.mjs';

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

test('saves zero-response scans and compares fault lists only when both scans read the same model', () => {
  const storage = memoryStorage();
  const ecu = { id: 'ABS', name: 'ABS/ESP', modelKeys: ['esp'], state: 'detected' };
  const details = { vehicle: 'B78', variant: 'Phase 2', variantId: 'phase2', adapter: 'ELM327', firmware: '1.5',
    time: 100, outcome: 'complete', total: 1, pinPair: '6/14', exchanges: [{ request: '22F0FE', response: 'NO DATA\r' }] };
  const noReply = makePsaScan({ ...details, ecus: [{ ...ecu, state: 'no-reply' }] });
  const withFault = makePsaScan({ ...details, time: 200, pinPair: '3/8', ecus: [{ ...ecu, faults: ['P0562-01'] }] });
  const withNoFault = makePsaScan({ ...details, ecus: [{ ...ecu, faults: [] }] });
  const untested = makePsaScan({ ...details, outcome: 'stopped', ecus: [] });
  saveReading(storage, noReply);
  assert.equal(scanSummary(listReadings(storage)[0]), '1 of 1 checked · 0 responded · 0 identified');
  const exported = JSON.parse(rawExchangeFile(listReadings(storage)[0]).contents);
  assert.equal(exported.pinPair, '6/14');
  assert.equal(exported.exchanges[0].response, 'NO DATA\r');
  assert.match(compareScans(noReply, withFault)[0].value, /No matching reply → Identification reply/);
  assert.match(compareScans(withFault, withNoFault)[0].value, /Faults absent on follow-up P0562-01/);
  assert.match(compareScans(withFault, untested)[0].value, /Identification reply → Not checked$/);
  assert.deepEqual(compareScans(withFault, { ...withNoFault, ecus: [{ ...ecu }] }), []);
  const { pinPair, ...newDetails } = details;
  const previous = makePsaScan({ ...newDetails, ecus: [] });
  const current = makePsaScan({ ...newDetails, time: 300, ecus: [] });
  assert.ok(current);
  assert.deepEqual(scanBaselines([current, withFault, noReply, previous], current), [previous]);
  assert.deepEqual(scanBaselines([withFault, noReply, previous], withFault), []);
});

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

test('PSA snapshots retain ECU context and decode details alongside existing generic readings', () => {
  const context = { vehicle: 'B78', variant: 'Phase 2', ecu: 'ABS', model: 'ESP90', protocol: 'UDS' };
  const explanations = [{ id: 'D42E', request: '22D42E', response: '62D42E60',
    fields: [{ label: 'Clutch pedal', value: '96 × 0.5 = 48 %' }] }];
  const snapshot = makePsaReading({ ...context, explanations }, [{ label: '$D42E', value: '48 %' }], 300);
  const storage = memoryStorage();
  const generic = liveReading(100, '1200 rpm');
  const genericKey = saveReading(storage, generic);
  const psaKey = saveReading(storage, snapshot);
  assert.deepEqual(listReadings(storage), [{ ...snapshot, key: psaKey }, { ...generic, key: genericKey }]);
  assert.deepEqual(listReadings(storage)[0].explanations, explanations);
  assert.equal(makePsaReading({ ...context, model: '' }, snapshot.rows, 300), null);
  assert.equal(trendFor(listReadings(storage), snapshot), null);
});

test('exports saved batch exchanges without changing raw response text or inventing older exchanges', async () => {
  const raw = '0100\rSEARCHING...\r41 00 80 00 00 00\r';
  const session = traceSession({
    async command(command) {
      if (command === '0100') return raw;
      throw new Error('Adapter timed out.');
    },
  });
  assert.equal(await session.command('0100'), raw);
  await assert.rejects(session.command('0101'), /timed out/);
  const reading = makeReading({ modeId: '01', readAll: true }, {
    protocol: 'CAN', rows: [{ label: '$01', value: 'Adapter timed out.' }], exchanges: session.exchanges,
  }, 300);
  const storage = memoryStorage();
  saveReading(storage, reading);
  const [saved] = listReadings(storage);
  assert.equal(saved.batch, true);
  const file = rawExchangeFile(saved);
  assert.match(file.name, /^autodiaghub-01-.*\.json$/);
  assert.deepEqual(JSON.parse(file.contents), {
    readAt: '1970-01-01T00:00:00.300Z', modeId: '01', protocol: 'CAN', batch: true,
    exchanges: [{ request: '0100', response: raw }, { request: '0101', error: 'Adapter timed out.' }],
  });
  assert.equal(rawExchangeFile(liveReading(100, '1200 rpm')), null);
});
