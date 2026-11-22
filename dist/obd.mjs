const adapterErrors = /^(?:\?|NO DATA|UNABLE TO CONNECT|STOPPED|CAN ERROR|BUS ERROR|BUS BUSY|DATA ERROR|BUFFER FULL|FB ERROR|LV RESET|BUS INIT.*ERROR|<DATA ERROR)$/;

export function replyLines(raw, command) {
  return raw.toUpperCase().split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line && line.replace(/\s/g, '') !== command.toUpperCase())
    .map((line) => line.replace(/^(?:SEARCHING\.{3}|BUS INIT:\s*OK)\s*/, '').trim())
    .filter(Boolean);
}

function readValue(raw, command, pattern) {
  const reply = replyLines(raw, command).join(' ');
  return pattern.test(reply) && !adapterErrors.test(reply) && !/^(?:TEST )?OK$/.test(reply) ? reply : null;
}

export async function readAdapterHealth(session) {
  const identity = replyLines(await session.command('ATI'), 'ATI');
  const versionPattern = /(?:V(?:ERSION)?\s*[:=]?\s*|^|\s)(\d+(?:\.\d+)+(?:[A-Z])?)\b/;
  const versionLine = identity.find((line) => versionPattern.test(line));
  const voltageLine = replyLines(await session.command('ATRV'), 'ATRV')
    .find((line) => /^\d+(?:[.,]\d+)?\s*V$/.test(line));
  return {
    version: versionLine?.match(versionPattern)[1] || null,
    identification: versionLine || identity.join(' ') || null,
    voltage: voltageLine ? voltageLine.replace(/\s*V$/, ' V').replace(',', '.') : null,
  };
}

function hexBytes(line) {
  const hex = line.replace(/\s/g, '');
  if (!/^(?:[0-9A-F]{2})+$/.test(hex)) {
    throw new Error('The adapter returned an invalid hexadecimal reply.');
  }
  return hex.match(/../g).map((byte) => Number.parseInt(byte, 16));
}

function canPayloads(lines) {
  const payloads = [];
  let block;
  const finishBlock = () => {
    if (!block) return;
    if (block.bytes.length !== block.length) {
      throw new Error('The adapter returned an incomplete CAN reply.');
    }
    payloads.push(block.bytes);
    block = undefined;
  };

  for (const line of lines) {
    if (/^[0-9A-F]{3}$/.test(line)) {
      finishBlock();
      block = { length: Number.parseInt(line, 16), next: 0, bytes: [] };
      continue;
    }
    const fragment = /^([0-9A-F]):\s*(.+)$/.exec(line);
    if (fragment) {
      if (!block || Number.parseInt(fragment[1], 16) !== block.next % 16) {
        throw new Error('The adapter returned out-of-order CAN fragments.');
      }
      block.bytes.push(...hexBytes(fragment[2]));
      block.next += 1;
    } else {
      finishBlock();
      payloads.push(hexBytes(line));
    }
  }
  finishBlock();
  return payloads;
}

export class OBDReplyError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

export function vehicleReplyLines(raw, command) {
  const lines = replyLines(raw, command);
  if (!lines.length) throw new Error('The adapter returned an empty reply.');
  const busError = lines.find((line) => adapterErrors.test(line));
  if (busError === 'NO DATA') {
    throw new OBDReplyError('unconfirmed', 'No response for this request. Support could not be confirmed.');
  }
  if (busError) throw new Error('Vehicle read failed (' + busError + '). Check the ignition and adapter.');
  return lines;
}

export function responsePayloads(raw, command, protocol) {
  const lines = vehicleReplyLines(raw, command);
  const isCan = /^[6-9]$/.test(protocol);
  if (!isCan && !/^[1-5]$/.test(protocol)) {
    throw new Error('The reported OBD protocol is unavailable or unsupported.');
  }
  const payloads = isCan ? canPayloads(lines) : lines.map(hexBytes);
  const service = Number.parseInt(command.slice(0, 2), 16);
  const responses = [];
  let rejected = false;
  for (const bytes of payloads) {
    if (bytes[0] === 0x7f && bytes[1] === service && bytes.length >= 3) {
      if ([0x11, 0x12, 0x31].includes(bytes[2])) {
        rejected = true;
        continue;
      }
      throw new OBDReplyError('unconfirmed', 'The vehicle rejected the request (NRC $' +
        bytes[2].toString(16).toUpperCase().padStart(2, '0') + ').');
    }
    if (bytes[0] !== service + 0x40) throw new Error('The adapter returned an unexpected service reply.');
    responses.push(bytes);
  }
  if (!responses.length && rejected) {
    throw new OBDReplyError('unsupported', 'The vehicle explicitly rejected this mode or identifier as unsupported.');
  }
  return responses;
}

export function decodeTroubleCodes(raw, protocol, command) {
  const isCan = /^[6-9]$/.test(protocol);
  const payloads = responsePayloads(raw, command, protocol);
  const codes = new Set();
  for (const bytes of payloads) {
    const data = bytes.slice(isCan ? 2 : 1);
    const count = isCan ? bytes[1] : data.length / 2;
    if (!Number.isInteger(count) || data.length < count * 2 ||
        (isCan && data.slice(count * 2).some(Boolean)) || (!isCan && data.length === 0)) {
      throw new Error('The adapter returned an invalid trouble-code reply.');
    }
    for (let index = 0; index < count * 2; index += 2) {
      const high = data[index];
      const low = data[index + 1];
      if (high === 0 && low === 0) {
        if (isCan) throw new Error('The trouble-code count does not match the reply.');
        continue;
      }
      codes.add(decodeDtc(high, low));
    }
  }
  return [...codes];
}

export function decodeDtc(high, low) {
  const family = 'PCBU'[high >> 6];
  const number = (((high & 0x3f) << 8) | low).toString(16).toUpperCase().padStart(4, '0');
  return family + number;
}

export function decodeMode03(raw, protocol) {
  return decodeTroubleCodes(raw, protocol, '03');
}

export async function prepareOBD(session) {
  // These settings control the adapter's serial output, then allow it to detect the vehicle bus.
  for (const command of ['ATD', 'ATM0', 'ATE0', 'ATH0', 'ATCAF1', 'ATTP0']) {
    if (!replyLines(await session.command(command), command).includes('OK')) {
      throw new Error('The adapter did not accept ' + command + '.');
    }
  }
}

export async function readProtocol(session) {
  const number = readValue(await session.command('ATDPN'), 'ATDPN', /^A?[1-9]$/);
  if (!number) throw new Error('The reported OBD protocol is unavailable or unsupported.');
  const description = readValue(await session.command('ATDP'), 'ATDP', /[A-Z0-9]/);
  return { number: number.slice(-1), code: number, description: description || 'Protocol ' + number };
}

export async function readVehicleHealth(session) {
  await prepareOBD(session);
  const raw = await session.command('0100', 20000);
  vehicleReplyLines(raw, '0100');
  const protocol = await readProtocol(session);
  const payloads = responsePayloads(raw, '0100', protocol.number);
  const replies = payloads.map((bytes) => {
    if (bytes.length < 6 || bytes[1] !== 0x00) {
      throw new Error('The adapter returned an invalid PID $00 reply.');
    }
    return bytes.slice(0, 6)
      .map((byte) => byte.toString(16).toUpperCase().padStart(2, '0')).join(' ');
  });
  return { protocol, replies };
}
