import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseAdapter, openAdapter } from '../dist/ble.mjs';
import { decodeMode03, readAdapterHealth, readVehicleHealth } from '../dist/obd.mjs';
import { readGeneralOBD } from '../dist/modes.mjs';

test('decodes legacy, CAN, multiline CAN, and empty replies', () => {
  assert.deepEqual(decodeMode03('03\r43 01 33 00 00 00 00', '3'), ['P0133']);
  assert.deepEqual(decodeMode03('SEARCHING...\r43 02 01 33 C1 23\r43010133', '6'), ['P0133', 'U0123']);
  assert.deepEqual(decodeMode03('00A\r0: 43 04 01 71 03 00\r1: 81 23 41 23', '8'),
    ['P0171', 'P0300', 'B0123', 'C0123']);
  assert.deepEqual(decodeMode03('43 00', '6'), []);
  assert.deepEqual(decodeMode03('43 00 00 00 00 00 00', '3'), []);
});

test('rejects no response, negative replies, bad counts and incomplete frames', () => {
  for (const raw of ['NO DATA', '7F 03 11', '43 01', '43 01 00 00', '43 00 01 33',
    '00A\r0: 43 04 01 71 03 00', '00A\r1: 43 04 01 71 03 00', '43 00\rCAN ERROR']) {
    assert.throws(() => decodeMode03(raw, '6'), Error, raw);
  }
});

function mockAdapter(replies, onDisconnect) {
  const uuid = '0000fff0-0000-1000-8000-00805f9b34fb';
  const commands = [];
  const device = new EventTarget();
  const reader = new EventTarget();
  reader.properties = { notify: true };
  reader.startNotifications = async () => {};
  const writer = {
    properties: { write: true },
    async writeValueWithResponse(data) {
      const command = new TextDecoder().decode(data).trim();
      commands.push(command);
      for (const fragment of replies[command] ?? []) {
        reader.value = new DataView(new TextEncoder().encode(fragment).buffer);
        reader.dispatchEvent(new Event('characteristicvaluechanged'));
      }
    },
  };
  device.gatt = {
    connected: false,
    async connect() { this.connected = true; return this; },
    async getPrimaryService(address) {
      assert.equal(address, uuid);
      return { getCharacteristics: async () => [writer, reader] };
    },
    disconnect() {
      this.connected = false;
      device.dispatchEvent(new Event('gattserverdisconnected'));
    },
  };
  const bluetooth = {
    async requestDevice({ optionalServices }) {
      assert.deepEqual(optionalServices, [uuid]);
      return device;
    },
  };
  const session = chooseAdapter(bluetooth, 'FFF0').then((selected) => openAdapter(selected, onDisconnect));
  return { commands, device, session };
}

test('reads health and stored codes through a mock GATT channel with fragmented notifications', async () => {
  const setup = ['ATD', 'ATM0', 'ATE0', 'ATH0', 'ATCAF1', 'ATTP0'];
  const settings = Object.fromEntries(setup.map((command) => [command, ['OK\r>']]));
  const mock = mockAdapter({
    ...settings,
    ATI: ['ATI\rELM', '327 v1.5\r', '>'],
    ATRV: ['ATRV\r12.6V\r>'],
    '0100': ['SEARCHING...\r41 00 80 10 00 01\r41 00 08 00 00 00\r>'],
    '03': ['SEARCHING...\r43 01 ', '01 33\r>'],
    ATDPN: ['A6\r>'],
    ATDP: ['AUTO, ISO 15765-4 (CAN 11/500)\r>'],
  });
  const session = await mock.session;
  try {
    assert.deepEqual(await readAdapterHealth(session), {
      version: '1.5', identification: 'ELM327 V1.5', voltage: '12.6 V',
    });
    assert.deepEqual(await readVehicleHealth(session), {
      protocol: { number: '6', code: 'A6', description: 'AUTO, ISO 15765-4 (CAN 11/500)' },
      replies: ['41 00 80 10 00 01', '41 00 08 00 00 00'],
    });
    assert.deepEqual(await readGeneralOBD(session, { modeId: '03' }), {
      codes: ['P0133'], protocol: 'AUTO, ISO 15765-4 (CAN 11/500)',
    });
    assert.deepEqual(mock.commands, ['ATI', 'ATRV', ...setup, '0100', 'ATDPN', 'ATDP',
      ...setup, '03', 'ATDPN', 'ATDP']);
  } finally {
    session.close();
  }
});

test('shows reported values and keeps a test acknowledgement separate from a firmware version', async () => {
  const replies = { ATI: 'ATI\rTEST OK', ATRV: 'ATRV\rOK\r12,8 v' };
  const adapter = { async command(command) { return replies[command]; } };
  assert.deepEqual(await readAdapterHealth(adapter), { version: null, identification: 'TEST OK', voltage: '12.8 V' });
  replies.ATI = 'ATI\rOK\rSTN1110 v4.2.3';
  replies.ATRV = 'TEST OK';
  assert.deepEqual(await readAdapterHealth(adapter), {
    version: '4.2.3', identification: 'STN1110 V4.2.3', voltage: null,
  });
});

test('reports an unconfirmed or invalid vehicle connection reply instead of a success', async () => {
  const reply = { '0100': 'NO DATA', ATDPN: 'A6', ATDP: 'TEST OK' };
  const adapter = { async command(command) { return reply[command] ?? 'OK'; } };
  await assert.rejects(readVehicleHealth(adapter), { kind: 'unconfirmed' });
  reply['0100'] = '41 01 00 00 00 00';
  await assert.rejects(readVehicleHealth(adapter), /invalid PID/);
  reply['0100'] = '41 00 00 00 00 00';
  assert.deepEqual(await readVehicleHealth(adapter), {
    protocol: { number: '6', code: 'A6', description: 'Protocol A6' },
    replies: ['41 00 00 00 00 00'],
  });
});

test('rejects an in-flight command on disconnection and after a timeout', async () => {
  const dropped = mockAdapter({}, (_session, error) => assert.match(error.message, /disconnected/));
  const droppedSession = await dropped.session;
  const pending = assert.rejects(droppedSession.command('ATI'), /disconnected/);
  dropped.device.gatt.disconnect();
  await pending;

  const timedOut = mockAdapter({}, (_session, error) => assert.match(error.message, /did not finish/));
  const timedOutSession = await timedOut.session;
  await assert.rejects(timedOutSession.command('ATI', 5), /did not finish/);
  assert.equal(timedOut.device.gatt.connected, false);
  await assert.rejects(timedOutSession.command('ATI'), /disconnected/);
});
