import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  clearPsaDtcs, decodePsaDtcs, decodePsaParameter, ecuIdentificationIds, parsePsaResponse,
  readPsaDtcs, readPsaParameters, scanPsaEcus,
} from '../dist/psa.mjs';
import { diagnosticPinout } from '../dist/psa-view.mjs';

const catalog = JSON.parse(readFileSync(new URL('../dist/psa/catalog.json', import.meta.url)));
const picasso2 = catalog.vehicles.find(({ code }) => code === 'B78');
const phase2 = picasso2.variants.find(({ id }) => id === 'phase2');
const abs = phase2.ecus.find(({ id }) => id === 'ABS');
const esp = catalog.models[abs.models[0].key];
const legacyBsi = catalog.models['diag/AEE2004.full/BSI/BSI'];

test('connector guidance follows the selected vehicle variant and architecture', () => {
  const picasso1 = catalog.vehicles.find(({ code }) => code === 'B58');
  const { text, source } = diagnosticPinout('B58', picasso1.variants[0]);
  assert.match(text, /pin 3 \(CAN High\).*pin 8 \(CAN Low\)/);
  assert.match(source, /id=94208/);
  assert.match(diagnosticPinout('B78', picasso2.variants[0]).source, /aee2010-full/);
  assert.match(diagnosticPinout('B78', phase2).text, /architecture-level guidance/);
  assert.match(diagnosticPinout('other', { architecture: 'NEA2020.full' }).text, /pin 6 .*pin 14 /);
  assert.equal(diagnosticPinout('other', { architecture: 'AEE2001.full' }).source, undefined);
});

function adapter(reads) {
  const commands = [];
  let currentHeader;
  return {
    commands,
    async command(command) {
      commands.push(command);
      if (command.startsWith('ATSH')) currentHeader = command.slice(4);
      if (command.startsWith('AT')) return 'OK';
      const reply = reads.get(currentHeader + '/' + command);
      return (Array.isArray(reply) ? reply.shift() : reply) || 'NO DATA';
    },
  };
}

test('bundles both Picasso generations and the exact ECU routes from a pinned revision', () => {
  assert.match(catalog.revision, /^[a-f0-9]{40}$/);
  assert.deepEqual(catalog.vehicles.filter(({ variants }) => variants.some(({ scanAvailable }) => scanAvailable))
    .map(({ code }) => code).sort(), ['B58', 'B78']);
  assert.deepEqual(picasso2.variants.map(({ id }) => id), ['phase1', 'phase1_eco', 'phase2']);
  for (const variant of catalog.vehicles.flatMap(({ variants }) => variants).filter(({ scanAvailable }) => scanAvailable)) {
    assert.ok(variant.ecus.some(({ id, models }) => id === 'ABS' && models.length), variant.id);
    assert.ok(variant.ecus.some(({ id, models }) => id === 'BSI' && models.length), variant.id);
    for (const ecu of variant.ecus) {
      for (const { name, key } of ecu.models) {
        const model = catalog.models[key];
        assert.ok(ecu.modelNames.includes(name));
        assert.match(model.probe, /^(22[0-9A-F]{4}|21[0-9A-F]{2})$/);
        assert.ok(model.parameters.every(({ kind }) => ['live', 'identification'].includes(kind)));
        assert.ok(!Object.hasOwn(model, 'security_access'));
      }
    }
  }
  assert.equal(esp.requestId, '6AD');
  assert.equal(esp.responseId, '68D');
});

test('bundles all pinned PSA-RE vehicle files and variants without widening live scan coverage', () => {
  assert.equal(new Set(catalog.vehicles.map(({ source }) => source)).size, 118);
  assert.equal(new Set(catalog.vehicles.map(({ code }) => code)).size, catalog.vehicles.length);
  const variants = catalog.vehicles.flatMap(({ variants }) => variants);
  assert.equal(variants.length, 155);
  assert.equal(variants.filter(({ scanAvailable }) => scanAvailable).length, 4);
  assert.ok(variants.filter(({ scanAvailable }) => !scanAvailable).every(({ ecus }) =>
    ecus.every(({ models }) => models.length === 0)));
  const berlingo = catalog.vehicles.find(({ code }) => code === 'K9');
  assert.ok(berlingo.aliases.includes('Toyota Proace City'));
  assert.ok(berlingo.variants[0].ecus.some(({ id }) => id === 'BSI'));
  assert.equal(catalog.vehicles.find(({ code }) => code === 'TPV').variants[0].ecus.length, 0);
});

test('reassembles addressed CAN frames and rejects incomplete or wrong-address replies', () => {
  assert.deepEqual(parsePsaResponse('68D 04 62 D4 2E 60 00 00 00', '22D42E', '68D'), { data: [0x60] });
  assert.deepEqual(parsePsaResponse([
    '68D 03 7F 22 78 00 00 00 00',
    '68D 10 09 62 F0 FE 01 02 03',
    '68D 21 04 05 06 00 00 00 00',
  ].join('\r'), '22F0FE', '68D'), { data: [1, 2, 3, 4, 5, 6] });
  assert.throws(() => parsePsaResponse('688 04 62 D4 2E 60', '22D42E', '68D'), { kind: 'unconfirmed' });
  assert.throws(() => parsePsaResponse('68D 10 09 62 F0 FE 01 02 03', '22F0FE', '68D'), { kind: 'invalid' });
  assert.throws(() => parsePsaResponse('68D 10 09 62 F0 FE 01 02 03\r68D 22 04 05 06', '22F0FE', '68D'),
    { kind: 'invalid' });
});

test('scans documented ECUs, shares identical probes, and keeps distinct outcomes', async () => {
  const model = (requestId, responseId) => ({ ...esp, requestId, responseId });
  const models = { a: esp, duplicate: esp, b: model('6A8', '688'), c: model('6B5', '695'),
    d: model('752', '652') };
  const variant = {
    ecus: [
      { id: 'ABS', models: [{ key: 'a' }, { key: 'duplicate' }] },
      { id: 'CMM', models: [{ key: 'b' }] },
      { id: 'DAE', models: [{ key: 'c' }] },
      { id: 'BSI', models: [{ key: 'd' }] },
      { id: 'CATALOG', models: [] },
    ],
  };
  const session = adapter(new Map([
    ['6AD/22F0FE', '68D 04 62 F0 FE 01'],
    ['6A8/22F0FE', '688 03 7F 22 31'],
    ['6B5/22F0FE', '695 10 09 62 F0 FE 01 02 03'],
  ]));
  const results = new Map();
  await scanPsaEcus(session, variant, models, (id, result) => results.set(id, result));
  assert.deepEqual([...results.values()].map(({ state }) => state), ['detected', 'rejected', 'invalid', 'no-reply']);
  assert.deepEqual(results.get('ABS').modelKeys, ['a', 'duplicate']);
  assert.equal(session.commands.filter((command) => command === '22F0FE').length, 4);
  assert.ok(session.commands.includes('ATFCSH6AD'));
  assert.ok(session.commands.includes('ATCRA68D'));
  assert.equal(session.commands.at(-1), 'ATTP0');
});

test('reads one documented parameter, keeps raw bytes, and reads only UDS active or confirmed codes', async () => {
  const session = adapter(new Map([
    ['6AD/22D42E', '68D 04 62 D4 2E 60 00'],
    ['6AD/190209', '68D 07 59 02 FF 05 62 01 09'],
  ]));
  const [{ rows, explanation }] = await readPsaParameters(session, esp, ['D42E']);
  assert.equal(rows[0].value, '48 %');
  assert.deepEqual(rows.at(-1), { label: 'Raw data', value: '60' });
  assert.deepEqual([explanation.request, explanation.response], ['22D42E', '62D42E60']);
  assert.match(explanation.fields[0].value, /Bits 1\.7-1\.0 · 0x60 represents 96\. 96 × 0\.5 = 48 %/);
  assert.deepEqual(await readPsaDtcs(session, esp), [
    { code: 'P0562-01', description: 'ESP ECU electrical supply', status: '09', flags: ['Test failed', 'Confirmed'] },
  ]);
  assert.deepEqual(decodePsaDtcs([0xff], {}), []);
  assert.throws(() => decodePsaDtcs([0xff, 0x01], {}), /incomplete/);
  assert.deepEqual(decodePsaParameter({ length: 2, fields: [] }, [1]), [{ label: 'Raw data', value: '01' }]);
  const sent = [...session.commands];
  await assert.rejects(readPsaParameters(session, esp, ['0000']), /Choose read parameters/);
  await assert.rejects(readPsaDtcs(session, { ...esp, protocol: 'KWP2000' }), /no supported DTC read/);
  assert.deepEqual(session.commands, sent);
  assert.deepEqual(sent.filter((command) => !command.startsWith('AT')), ['22D42E', '190209']);
});

test('identifies a supported ECU from documented identity reads and reports incomplete definitions', async () => {
  const session = adapter(new Map([
    ['6AD/22F080', '68D 10 0F 62 F0 80 12 34 56\r68D 21 78 90 00 03 98 76 54\r68D 22 32 10'],
    ['6AD/22F0FE', '68D 04 62 F0 FE 01'],
  ]));
  const ids = ecuIdentificationIds(esp);
  assert.deepEqual(ids, ['F080', 'F0FE']);
  const [identity, short] = await readPsaParameters(session, esp, ids);
  assert.deepEqual(identity.rows.slice(0, 2), [
    { label: 'Equipment part number', value: '1234567890' },
    { label: 'Name supplier', value: 'BOSCH' },
  ]);
  assert.match(identity.explanation.fields[1].value, /maps to BOSCH/);
  assert.equal(short.explanation.note, 'Expected 24 data bytes. ECU returned 1.');
  assert.deepEqual(session.commands.filter(command => !command.startsWith('AT')), ['22F080', '22F0FE']);
  assert.deepEqual(ecuIdentificationIds(legacyBsi), ['80']);
});

test('optional scan fault reads require a unique model and stopping restores adapter settings', async () => {
  const session = adapter(new Map([
    ['6AD/22F0FE', '68D 04 62 F0 FE 01'],
    ['6AD/190209', '68D 07 59 02 FF 05 62 01 09'],
  ]));
  const variant = { ecus: [
    { id: 'ambiguous', models: [{ key: 'a' }, { key: 'b' }] },
    { id: 'unique', models: [{ key: 'a' }] },
    { id: 'unchecked', models: [{ key: 'a' }] },
  ] };
  const results = new Map();
  await scanPsaEcus(session, variant, { a: esp, b: esp }, (id, result) => results.set(id, result),
    { shouldStop: () => results.size === 2, includeFaults: true });
  assert.equal(results.get('ambiguous').faults, undefined);
  assert.deepEqual(results.get('unique').faults, ['P0562-01']);
  assert.equal(results.has('unchecked'), false);
  assert.deepEqual(session.commands.filter(command => !command.startsWith('AT')), ['22F0FE', '22F0FE', '190209']);
  assert.equal(session.commands.at(-1), 'ATTP0');
});

test('restores general OBD settings if a PSA request is rejected', async () => {
  const session = adapter(new Map([['6AD/190209', '68D 03 7F 19 22']]));
  await assert.rejects(readPsaDtcs(session, esp), /NRC \$22/);
  assert.equal(session.commands.at(-1), 'ATTP0');
});

test('reads selected parameters once per ID on one route and keeps per-parameter failures', async () => {
  const session = adapter(new Map([
    ['6AD/22D42E', '68D 04 62 D4 2E 60 00'],
    ['6AD/22D43A', '68D 03 7F 22 31'],
  ]));
  const progress = [];
  const results = await readPsaParameters(session, esp, ['D42E', 'D43A', 'D42E'],
    (done, total) => progress.push([done, total]));
  assert.equal(results.find(({ parameter }) => parameter.id === 'D42E').rows[0].value, '48 %');
  assert.match(results.find(({ parameter }) => parameter.id === 'D43A').error, /NRC \$31/);
  assert.deepEqual(progress, [[1, 2], [2, 2]]);
  assert.equal(session.commands.filter((command) => command === 'ATSH6AD').length, 1);
  assert.equal(session.commands.at(-1), 'ATTP0');
  const [fault] = decodePsaDtcs([0x89, 0x05, 0x62, 0x01, 0x8f], {});
  assert.deepEqual(fault.flags, ['Test failed', 'Confirmed', 'Warning indicator requested']);
  assert.equal(fault.status, '8F');
});

test('reads legacy PSA KWP codes and verifies the addressed ECU after clearing', async () => {
  assert.equal(legacyBsi.clearDtcs, true);
  const session = adapter(new Map([
    ['752/17FF00', ['652 05 57 01 05 62 09', '652 05 57 01 05 62 09', '652 02 57 00']],
    ['752/14FF00', '652 03 54 FF 00'],
  ]));
  assert.deepEqual(await readPsaDtcs(session, legacyBsi), [
    { code: 'P0562', description: undefined, status: '09' },
  ]);
  assert.deepEqual(await clearPsaDtcs(session, legacyBsi), { state: 'acknowledged', faults: [] });
  assert.deepEqual(session.commands.filter((command) => !command.startsWith('AT')),
    ['17FF00', '17FF00', '14FF00', '17FF00']);
  assert.ok(session.commands.includes('ATCRA652'));
});

test('UDS clear is sent once and verified with a fresh read on the same ECU', async () => {
  assert.equal(esp.clearDtcs, true);
  const session = adapter(new Map([
    ['6AD/190209', ['68D 07 59 02 FF 05 62 01 09', '68D 03 59 02 FF']],
    ['6AD/14FFFFFF', '68D 01 54'],
  ]));
  assert.deepEqual(await clearPsaDtcs(session, esp), { state: 'acknowledged', faults: [] });
  assert.deepEqual(session.commands.filter((command) => !command.startsWith('AT')),
    ['190209', '14FFFFFF', '190209']);
  assert.equal(session.commands.filter((command) => command === 'ATSH6AD').length, 1);
});

test('blocks undocumented or unreachable targets and reports unconfirmed clears without retrying', async () => {
  const unreachable = adapter(new Map());
  await assert.rejects(clearPsaDtcs(unreachable, { ...esp, clearDtcs: false }), /no documented DTC clear/);
  assert.deepEqual(unreachable.commands, []);
  await assert.rejects(clearPsaDtcs(unreachable, esp), { kind: 'unconfirmed' });
  assert.ok(!unreachable.commands.includes('14FFFFFF'));

  const unconfirmed = adapter(new Map([
    ['6AD/190209', ['68D 03 59 02 FF', '68D 03 59 02 FF']],
    ['6AD/14FFFFFF', '688 01 54'],
  ]));
  assert.deepEqual(await clearPsaDtcs(unconfirmed, esp), { state: 'unconfirmed', faults: [] });
  assert.equal(unconfirmed.commands.filter((command) => command === '14FFFFFF').length, 1);

  const refused = adapter(new Map([
    ['6AD/190209', ['68D 03 59 02 FF']],
    ['6AD/14FFFFFF', '68D 03 7F 14 22'],
  ]));
  assert.deepEqual(await clearPsaDtcs(refused, esp), { state: 'rejected', reason: 'NRC $22' });
});
