import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseAdapter, openAdapter } from '../dist/ble.mjs';
import { decodeMode03, readAdapterHealth, readStoredCodes } from '../dist/obd.mjs';

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
    '03': ['SEARCHING...\r43 01 ', '01 33\r>'],
    ATDPN: ['A6\r>'],
    ATDP: ['AUTO, ISO 15765-4 (CAN 11/500)\r>'],
  });
  const session = await mock.session;
  try {
    assert.deepEqual(await readAdapterHealth(session), { firmware: 'ELM327 V1.5', voltage: '12.6V' });
    assert.deepEqual(await readStoredCodes(session), {
      codes: ['P0133'], protocol: 'AUTO, ISO 15765-4 (CAN 11/500)',
    });
    assert.deepEqual(mock.commands, ['ATI', 'ATRV', ...setup, '03', 'ATDPN', 'ATDP']);
  } finally {
    session.close();
  }
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
