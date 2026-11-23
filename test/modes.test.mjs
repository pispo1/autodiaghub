import assert from 'node:assert/strict';
import test from 'node:test';
import { modes, readGeneralOBD } from '../dist/modes.mjs';

const adapterSettings = ['ATD', 'ATM0', 'ATE0', 'ATH0', 'ATCAF1', 'ATTP0'];

function vehicle(replies, protocol = 'A6') {
  const sent = [];
  return {
    sent,
    async command(command) {
      sent.push(command);
      if (adapterSettings.includes(command)) return 'OK';
      if (command === 'ATDPN') return protocol;
      if (command === 'ATDP') return 'Reported OBD protocol';
      assert.ok(Object.hasOwn(replies, command), 'Unexpected request ' + command);
      return replies[command];
    },
  };
}

const read = (session, modeId, identifier, extra) =>
  readGeneralOBD(session, { modeId, identifier, extra });

const discover = (session, modeId, extra) =>
  readGeneralOBD(session, { modeId, extra, discover: true });

test('describes all ten modes and blocks control and clearing before sending commands', async () => {
  assert.deepEqual(modes.map(({id}) => id), ['01', '02', '03', '04', '05', '06', '07', '08', '09', '0A']);
  const session = vehicle({});
  for (const mode of ['04', '08', '11', '03\r04']) {
    await assert.rejects(read(session, mode), /no read action/);
  }
  await assert.rejects(read(session, '01', '0C\r04'), /two-digit/);
  assert.deepEqual(session.sent, []);
});

test('discovers only advertised ranges and merges supported PIDs across replies', async () => {
  const session = vehicle({
    '0100': '41 00 80 10 00 01\r41 00 08 00 00 00',
    '0120': '41 20 20 00 00 00',
    '010C': '41 0C 1F 40',
  });
  assert.deepEqual((await discover(session, '01')).supported, [1, 5, 12, 35]);
  assert.deepEqual(session.sent.filter((command) => !command.startsWith('AT')), ['0100', '0120']);
  assert.deepEqual((await read(session, '01', '0C')).rows, [{ label: 'Engine speed', value: '2000 rpm' }]);
});

test('keeps confirmed IDs when a later range gets no reply', async () => {
  const result = await discover(vehicle({ '0100': '41 00 80 00 00 01', '0120': 'NO DATA' }), '01');
  assert.deepEqual(result.supported, [1]);
  assert.match(result.note, /range \$20/);
});

test('reads only advertised identifiers once in a selected mode and retains separate failures', async () => {
  const session = vehicle({
    '0100': '41 00 08 30 00 01',
    '0120': 'NO DATA',
    '0105': '41 05 50',
    '010B': 'NO DATA',
    '010C': '41 0C 1F 40',
  });
  const progress = [];
  const result = await readGeneralOBD(session, { modeId: '01', readAll: true },
    (done, total) => progress.push([done, total]));
  assert.deepEqual(result.supported, [5, 11, 12]);
  assert.equal(result.successful, 2);
  assert.deepEqual(result.rows.map(({ value }) => value), [
    '40 °C', 'No response for this request. Support could not be confirmed.', '2000 rpm',
  ]);
  assert.match(result.note, /range \$20/);
  assert.deepEqual(progress, [[1, 3], [2, 3], [3, 3]]);
  assert.deepEqual(session.sent.filter((command) => !command.startsWith('AT')),
    ['0100', '0120', '0105', '010B', '010C']);
});

test('batch reads preserve the selected freeze frame and reject informational modes', async () => {
  const session = vehicle({ '020001': '42 00 01 40 00 00 00', '020201': '42 02 01 01 33' });
  const result = await readGeneralOBD(session, { modeId: '02', extra: '01', readAll: true });
  assert.deepEqual(result.rows, [{ label: '$02 · Trouble code that triggered the freeze frame', value: 'P0133' }]);
  assert.deepEqual(session.sent.filter((command) => !command.startsWith('AT')), ['020001', '020201']);
  const unused = vehicle({});
  for (const modeId of ['04', '08']) {
    await assert.rejects(readGeneralOBD(unused, { modeId, readAll: true }), /no read action/);
  }
  assert.deepEqual(unused.sent, []);
});

test('decodes readiness and reads the selected freeze-frame number', async () => {
  const session = vehicle({
    '0101': '41 01 81 29 41 40',
    '020201': '42 02 01 01 33',
    '020500': '42 05 01 52',
    '020000': '42 00 00 48 00 00 00',
  });
  const result = await read(session, '01', '01');
  const readiness = Object.fromEntries(result.rows.map(({ label, value }) => [label, value]));
  assert.deepEqual(readiness, {
    'Check-engine light': 'On', 'Stored code count': '1', 'Misfire': 'Complete',
    'NMHC catalyst': 'Complete', 'Particulate filter': 'Incomplete',
  });
  assert.deepEqual((await discover(session, '02', '00')).supported, [2, 5]);
  assert.equal((await read(session, '02', '02', '01')).rows[0].value, 'P0133');
  await assert.rejects(read(session, '02', '05', '00'), /unexpected identifier/);
});

test('handles oxygen sensor service on legacy protocols and points CAN vehicles to mode 06', async () => {
  const legacy = vehicle({ '0100': '41 00 80 00 00 00', '050101': '45 01 01 5A' }, 'A3');
  assert.equal((await read(legacy, '05', '01', '01')).rows[0].value, '0.45 V');
  const can = vehicle({ '0100': '41 00 80 00 00 00' });
  await assert.rejects(read(can, '05', '01', '01'), { kind: 'unsupported' });
  assert.deepEqual(can.sent.filter((command) => !command.startsWith('AT')), ['0100']);
});

test('discovers and reads CAN and legacy monitor tests', async () => {
  const can = vehicle({
    '0600': '46 00 80 00 00 00',
    '0601': '00A\r0: 46 01 87 2E 00 64\r1: 00 01 00 FF',
    '0602': '00A\r0: 46 02 01 0B 00 64\r1: 00 01 00 FF',
  });
  assert.deepEqual((await discover(can, '06')).supported, [1]);
  const monitor = await read(can, '06', '01');
  assert.equal(monitor.rows[0].value, '$2E');
  assert.equal(monitor.rows[1].value, '$0064');
  assert.equal((await read(can, '06', '02')).rows[1].value, '0.1 V');
  const legacy = vehicle({ '0600': '46 00 FF 40 00 00 00', '0602': '46 02 84 00 10 00 00' }, 'A3');
  assert.deepEqual((await discover(legacy, '06')).supported, [2]);
  assert.equal((await read(legacy, '06', '02')).rows[2].label, 'Minimum limit');
});

test('reads vehicle information and shows raw bytes for identifiers without a decoder', async () => {
  const session = vehicle({
    '0900': '49 00 54 00 00 00',
    '0906': '00B\r0: 49 06 02 17 91 BC\r1: 82 16 E0 62 BE',
    '01A5': '41 A5 DE AD',
  });
  assert.deepEqual((await discover(session, '09')).supported, [2, 4, 6]);
  assert.deepEqual((await read(session, '09', '06')).rows.map(({ value }) => value), ['1791BC82', '16E062BE']);
  assert.equal((await read(session, '01', 'A5')).rows[0].value, 'DE AD');
});

test('separates an empty DTC list, no response, an unsupported reply, and an invalid reply', async () => {
  const session = vehicle({ '03': '43 00', '07': '47 01 01 33', '0A': '4A 01 C1 23' });
  assert.deepEqual((await read(session, '03')).codes, []);
  assert.deepEqual((await read(session, '07')).codes, ['P0133']);
  assert.deepEqual((await read(session, '0A')).codes, ['U0123']);
  await assert.rejects(read(vehicle({ '07': 'NO DATA' }), '07'), { kind: 'unconfirmed' });
  await assert.rejects(read(vehicle({ '07': '7F 07 11' }), '07'), { kind: 'unsupported' });
  await assert.rejects(read(vehicle({ '07': '47 02 01 33' }), '07'), /invalid trouble-code reply/);
});
