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
  return pattern.test(reply) && !adapterErrors.test(reply) ? reply : null;
}

export async function readAdapterHealth(session) {
  const firmware = readValue(await session.command('ATI'), 'ATI', /[A-Z0-9]/);
  if (!firmware) throw new Error('The adapter did not return an identification string.');
  const voltage = readValue(await session.command('ATRV'), 'ATRV', /^\d+(?:\.\d+)?\s*V$/);
  return { firmware, voltage };
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

export function decodeMode03(raw, protocol) {
  const lines = replyLines(raw, '03');
  if (!lines.length) throw new Error('The adapter returned an empty reply.');
  const busError = lines.find((line) => adapterErrors.test(line));
  if (busError) throw new Error('Vehicle read failed (' + busError + '). Check the ignition and adapter.');
  const isCan = /^[6-9]$/.test(protocol);
  if (!isCan && !/^[1-5]$/.test(protocol)) {
    throw new Error('The reported OBD protocol is unavailable or unsupported.');
  }
  const payloads = isCan ? canPayloads(lines) : lines.map(hexBytes);
  const codes = new Set();
  for (const bytes of payloads) {
    const data = bytes.slice(isCan ? 2 : 1);
    const count = isCan ? bytes[1] : data.length / 2;
    if (bytes[0] === 0x7f && bytes[1] === 0x03) {
      throw new Error('The vehicle rejected the stored-code request.');
    }
    if (bytes[0] !== 0x43 || !Number.isInteger(count) || data.length < count * 2 ||
        (isCan && data.slice(count * 2).some(Boolean)) || (!isCan && data.length === 0)) {
      throw new Error('The adapter returned an invalid stored-code reply.');
    }
    for (let index = 0; index < count * 2; index += 2) {
      const high = data[index];
      const low = data[index + 1];
      if (high === 0 && low === 0) {
        if (isCan) throw new Error('The stored-code count does not match the reply.');
        continue;
      }
      const family = 'PCBU'[high >> 6];
      const number = (((high & 0x3f) << 8) | low).toString(16).toUpperCase().padStart(4, '0');
      codes.add(family + number);
    }
  }
  return [...codes];
}

export async function readStoredCodes(session) {
  // These settings control the adapter's serial output, then allow it to detect the vehicle bus.
  for (const command of ['ATD', 'ATM0', 'ATE0', 'ATH0', 'ATCAF1', 'ATTP0']) {
    if (!replyLines(await session.command(command), command).includes('OK')) {
      throw new Error('The adapter did not accept ' + command + '.');
    }
  }
  const raw = await session.command('03', 20000);
  const failure = replyLines(raw, '03').find((line) => adapterErrors.test(line));
  if (failure) throw new Error('Vehicle read failed (' + failure + '). Check the ignition and adapter.');
  const number = readValue(await session.command('ATDPN'), 'ATDPN', /^A?[1-9]$/);
  const codes = decodeMode03(raw, number?.slice(-1));
  const description = readValue(await session.command('ATDP'), 'ATDP', /[A-Z0-9]/);
  return { codes, protocol: description || 'Protocol ' + number };
}
