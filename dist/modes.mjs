import {
  OBDReplyError, decodeDtc, decodeTroubleCodes, prepareOBD, readProtocol,
  responsePayloads, vehicleReplyLines,
} from './obd.mjs';

export const modes = [
  { id: '01', title: 'Current data', description: 'Read current powertrain values, check-engine light status, and emissions readiness.', identifier: 'PID', defaultId: '01' },
  { id: '02', title: 'Freeze-frame data', description: 'Read the snapshot saved with a fault. Frame $00 is the first stored snapshot.', identifier: 'PID', defaultId: '02' },
  { id: '03', title: 'Stored trouble codes', description: 'Read confirmed emissions-related diagnostic trouble codes.', troubleCodes: true },
  { id: '04', title: 'Clear emissions data', description: 'This mode clears emissions-related fault data and can reset readiness. This screen is read-only.', infoOnly: true },
  { id: '05', title: 'Oxygen sensor tests', description: 'Read oxygen sensor test results on older non-CAN vehicles. On CAN, use mode $06.', identifier: 'Test ID', defaultId: '01' },
  { id: '06', title: 'On-board monitor tests', description: 'Read stored test results and limits, such as catalyst or particulate filter monitoring.', identifier: 'Monitor / test ID', defaultId: '01' },
  { id: '07', title: 'Pending trouble codes', description: 'Read emissions-related faults detected in the current or most recent driving cycle.', troubleCodes: true },
  { id: '08', title: 'On-board controls', description: 'This mode can operate on-board tests or components. This screen is read-only.', infoOnly: true },
  { id: '09', title: 'Vehicle information', description: 'Read vehicle identification, calibration details, and other information reported by the vehicle.', identifier: 'Info type', defaultId: '02' },
  { id: '0A', title: 'Permanent trouble codes', description: 'Read permanent emissions-related trouble codes reported by the vehicle.', troubleCodes: true },
];

const modeFor = (id) => modes.find((mode) => mode.id === id);
const usesId = (mode) => Boolean(mode.identifier);
const isCan = (protocol) => /^[6-9]$/.test(protocol);
const hex = (value) => value.toString(16).toUpperCase().padStart(2, '0');
const hexData = (bytes) => bytes.map(hex).join(' ');
const numeric = (bytes) => bytes[0] * 256 + bytes[1];
const format = (value, unit) => Number(value.toFixed(3)) + ' ' + unit;
const row = (label, value) => ({ label, value: String(value) });

const percent = (value) => format(value * 100 / 255, '%');
const temperature = (value) => format(value - 40, '°C');
const signedTrim = (value) => format((value - 128) * 100 / 128, '%');

const pids = {
  0x01: ['Emissions readiness since clearing', 4, readiness],
  0x02: ['Trouble code that triggered the freeze frame', 2, (a, b) => a || b ? decodeDtc(a, b) : 'No freeze-frame trouble code reported'],
  0x04: ['Calculated engine load', 1, percent],
  0x05: ['Engine coolant temperature', 1, temperature],
  0x06: ['Short-term fuel trim, bank 1', 1, signedTrim],
  0x07: ['Long-term fuel trim, bank 1', 1, signedTrim],
  0x08: ['Short-term fuel trim, bank 2', 1, signedTrim],
  0x09: ['Long-term fuel trim, bank 2', 1, signedTrim],
  0x0a: ['Fuel pressure', 1, (a) => format(a * 3, 'kPa')],
  0x0b: ['Intake manifold absolute pressure', 1, (a) => format(a, 'kPa')],
  0x0c: ['Engine speed', 2, (a, b) => format(numeric([a, b]) / 4, 'rpm')],
  0x0d: ['Vehicle speed', 1, (a) => format(a, 'km/h')],
  0x0e: ['Ignition timing advance', 1, (a) => format(a / 2 - 64, '°')],
  0x0f: ['Intake air temperature', 1, temperature],
  0x10: ['Mass air flow', 2, (a, b) => format(numeric([a, b]) / 100, 'g/s')],
  0x11: ['Throttle position', 1, percent],
  0x1f: ['Run time since engine start', 2, (a, b) => format(numeric([a, b]), 's')],
  0x21: ['Distance driven with check-engine light on', 2, (a, b) => format(numeric([a, b]), 'km')],
  0x23: ['Fuel rail gauge pressure', 2, (a, b) => format(numeric([a, b]) * 10, 'kPa')],
  0x2c: ['Commanded EGR', 1, percent],
  0x2d: ['EGR error', 1, signedTrim],
  0x2f: ['Fuel tank level', 1, percent],
  0x30: ['Warm-ups since codes were cleared', 1, (a) => String(a)],
  0x31: ['Distance since codes were cleared', 2, (a, b) => format(numeric([a, b]), 'km')],
  0x33: ['Barometric pressure', 1, (a) => format(a, 'kPa')],
  0x42: ['Control module voltage', 2, (a, b) => format(numeric([a, b]) / 1000, 'V')],
  0x46: ['Ambient air temperature', 1, temperature],
  0x5a: ['Relative accelerator pedal position', 1, percent],
  0x5c: ['Engine oil temperature', 1, temperature],
  0x5e: ['Engine fuel rate', 2, (a, b) => format(numeric([a, b]) / 20, 'L/h')],
};

const infoTypes = {
  0x01: 'VIN message count', 0x02: 'VIN', 0x03: 'Calibration ID message count',
  0x04: 'Calibration ID', 0x05: 'Calibration verification message count',
  0x06: 'Calibration verification number', 0x07: 'Performance tracking message count',
  0x08: 'In-use performance tracking, spark ignition', 0x09: 'ECU name message count',
  0x0a: 'ECU name', 0x0b: 'In-use performance tracking, compression ignition',
};

// SAE J1979 Mode $06 unit and scaling identifiers used by common CAN monitors.
const monitorScales = {
  0x01: [1], 0x02: [0.1], 0x03: [0.01], 0x04: [0.001],
  0x07: [0.25, 'rpm'], 0x09: [1, 'km/h'], 0x0b: [0.001, 'V'],
  0x10: [1, 'ms'], 0x16: [0.1, '°C', -40],
};

export function identifierName(modeId, id) {
  if (modeId === '01' || modeId === '02') return pids[id]?.[0] || '';
  if (modeId === '09') return infoTypes[id] || '';
  return '';
}

function readiness(a, b, c, d) {
  const monitors = [['Misfire', 'Fuel system', 'Comprehensive components'], b, b >> 4];
  const spark = ['Catalyst', 'Heated catalyst', 'Evaporative system', 'Secondary air',
    'A/C refrigerant', 'Oxygen sensors', 'Oxygen sensor heaters', 'EGR / VVT'];
  const diesel = ['NMHC catalyst', 'NOx / SCR', null, 'Boost pressure', null,
    'Exhaust gas sensor', 'Particulate filter', 'EGR / VVT'];
  const checks = [monitors, [(b & 8) ? diesel : spark, c, d]];
  return [
    row('Check-engine light', a & 0x80 ? 'On' : 'Off'),
    row('Stored code count', a & 0x7f),
    ...checks.flatMap(([names, supported, incomplete]) => names.flatMap((name, bit) =>
      name && (supported & (1 << bit))
        ? [row(name, incomplete & (1 << bit) ? 'Incomplete' : 'Complete')]
        : [])),
  ];
}

function requireLength(bytes, expected) {
  if (bytes.length < expected) throw new Error('The vehicle reply is missing expected data bytes.');
  return bytes.slice(0, expected);
}

function pidRows(id, bytes) {
  const definition = pids[id];
  if (!definition) return [row('Raw PID data', hexData(bytes))];
  const [name, length, decode] = definition;
  const value = decode(...requireLength(bytes, length));
  return Array.isArray(value) ? value : [row(name, value)];
}

function supportBits(bytes, base) {
  return requireLength(bytes, 4).flatMap((byte, index) =>
    Array.from({ length: 8 }, (_, bit) => byte & (0x80 >> bit) ? base + index * 8 + bit + 1 : 0)
      .filter((value) => value > 0 && value < 256));
}

function ascii(bytes) {
  if (bytes.some((byte) => byte !== 0 && (byte < 0x20 || byte > 0x7e))) {
    throw new Error('The vehicle returned invalid text data.');
  }
  return String.fromCharCode(...bytes.filter((byte) => byte !== 0)).trim();
}

function vehicleInfoRows(id, replies, can) {
  const name = infoTypes[id] || 'Vehicle information';
  if ([1, 3, 5, 7, 9].includes(id)) {
    return replies.map((bytes) => row(name, requireLength(bytes, 1)[0]));
  }
  if (id === 2 && !can) {
    // Legacy VIN is five four-byte records. Reject ambiguous interleaved records.
    const ordered = [...replies].sort((a, b) => a[0] - b[0]);
    if (ordered.length !== 5 || ordered.some((bytes, index) => bytes[0] !== index + 1)) {
      throw new Error('The legacy VIN reply is incomplete or has multiple responders.');
    }
    const vin = ascii(ordered.flatMap((bytes) => requireLength(bytes.slice(1), 4)));
    if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) throw new Error('The vehicle returned an invalid VIN.');
    return [row(name, vin)];
  }
  const widths = { 2: 17, 4: 16, 6: 4, 10: 20 };
  if (!can || !widths[id]) {
    return replies.map((bytes) => row(name + ' · raw data', hexData(bytes)));
  }
  return replies.flatMap(([count, ...bytes]) => {
    const width = widths[id];
    if (!count || bytes.length !== count * width) {
      throw new Error('Vehicle information record count does not match the reply.');
    }
    return Array.from({ length: count }, (_, index) => {
      const data = bytes.slice(index * width, (index + 1) * width);
      const value = id === 6 ? hexData(data).replaceAll(' ', '') : ascii(data);
      if (id === 2 && !/^[A-HJ-NPR-Z0-9]{17}$/.test(value)) {
        throw new Error('The vehicle returned an invalid VIN.');
      }
      return row(name, value || 'Empty');
    });
  });
}

function testRows(modeId, id, bytes, can) {
  if (modeId === '05') {
    if (id > 0x0a) return [row('Raw oxygen sensor test data', hexData(bytes))];
    const [value, minimum, maximum] = requireLength(bytes, id <= 4 ? 1 : 3);
    const scale = (value) => id <= 4 || id === 7 || id === 8 ? format(value * 0.005, 'V') :
      format(value * (id >= 9 ? 40 : 4), 'ms');
    return [row('Test value', scale(value)), ...(minimum === undefined ? [] :
      [row('Minimum', scale(minimum)), row('Maximum', scale(maximum))])];
  }
  if (!can) {
    // Legacy limits are manufacturer-defined and encoded one limit per reply.
    const [component, valueHigh, valueLow, limitHigh, limitLow] =
      requireLength(bytes, bytes.length === 3 ? 3 : 5);
    return [
      row('Component ID', '$' + hex(component & 0x7f)),
      row('Test value', numeric([valueHigh, valueLow])),
      ...(limitHigh === undefined ? [] : [
        row(component & 0x80 ? 'Minimum limit' : 'Maximum limit', numeric([limitHigh, limitLow])),
      ]),
    ];
  }
  const records = [id, ...bytes];
  if (records.length % 9 !== 0) throw new Error('The monitor test reply is incomplete.');
  const rows = [];
  for (let offset = 0; offset < records.length; offset += 9) {
    const [monitor, tid, scaling, valueHigh, valueLow, minHigh, minLow, maxHigh, maxLow] =
      records.slice(offset, offset + 9);
    if (monitor !== id) throw new Error('The vehicle returned an unexpected monitor ID.');
    const scale = monitorScales[scaling];
    const display = (a, b) => {
      if (!scale) return '$' + hex(a) + hex(b);
      const [factor, unit, offset = 0] = scale;
      const value = numeric([a, b]) * factor + offset;
      return unit ? format(value, unit) : Number(value.toFixed(3));
    };
    rows.push(row('Test $' + hex(tid) + ' · scaling ID', '$' + hex(scaling)),
      row(scale ? 'Test value' : 'Raw value', display(valueHigh, valueLow)),
      row(scale ? 'Minimum' : 'Raw minimum', display(minHigh, minLow)),
      row(scale ? 'Maximum' : 'Raw maximum', display(maxHigh, maxLow)));
  }
  return rows;
}

function dataFor(replies, id, extra) {
  return replies.map((bytes) => {
    if (bytes[1] !== id || (extra !== undefined && bytes[2] !== extra)) {
      throw new Error('The vehicle returned an unexpected identifier, freeze frame, or sensor.');
    }
    const data = bytes.slice(extra === undefined ? 2 : 3);
    if (!data.length) throw new Error('The vehicle returned an empty data record.');
    return data;
  });
}

function readConfiguration(modeId, identifier, extra, discover) {
  const mode = modeFor(modeId);
  if (!mode || mode.infoOnly) throw new Error('This mode has no read action.');
  if (discover && !usesId(mode)) throw new Error('This mode has no support map.');
  if (usesId(mode) && !discover && !/^[0-9A-F]{2}$/.test(identifier)) {
    throw new Error('Enter a two-digit hexadecimal identifier, such as 0C.');
  }
  if (mode.id === '02' && !/^[0-9A-F]{2}$/.test(extra)) {
    throw new Error('Enter a two-digit hexadecimal freeze-frame number, such as 00.');
  }
  if (mode.id === '05' && !/^(01|02|04|08|10|20|40|80)$/.test(extra)) {
    throw new Error('Select one oxygen sensor.');
  }
  return mode;
}

export async function readGeneralOBD(session, { modeId, identifier, extra, discover = false, readAll = false },
  onProgress = () => {}) {
  const discoverRanges = discover || readAll;
  const mode = readConfiguration(modeId, identifier, extra, discoverRanges);
  const suffix = mode.id === '02' || mode.id === '05' ? extra : '';
  const extraByte = suffix ? Number.parseInt(suffix, 16) : undefined;
  await prepareOBD(session);

  let protocol;
  async function request(command) {
    const raw = await session.command(command, 20000);
    vehicleReplyLines(raw, command);
    protocol ??= await readProtocol(session);
    return raw;
  }

  if (mode.id === '05') {
    const probe = await request('0100');
    responsePayloads(probe, '0100', protocol.number);
    if (isCan(protocol.number)) {
      throw new OBDReplyError('unsupported', 'Mode $05 is for non-CAN vehicles. Use mode $06 on the detected CAN protocol.');
    }
  }

  if (mode.troubleCodes) {
    const raw = await request(modeId);
    return { protocol: protocol.description, codes: decodeTroubleCodes(raw, protocol.number, modeId) };
  }

  async function readId(id) {
    const command = modeId + hex(id) + suffix;
    const raw = await request(command);
    try {
      return dataFor(responsePayloads(raw, command, protocol.number), id, extraByte);
    } catch (error) {
      if (error instanceof OBDReplyError) throw error;
      throw new OBDReplyError('invalid', error.message);
    }
  }

  function decodeRows(id, replies) {
    if (mode.id === '09') return vehicleInfoRows(id, replies, isCan(protocol.number));
    return replies.flatMap((bytes, index) => {
      const entries = mode.id === '01' || mode.id === '02' ? pidRows(id, bytes) :
        testRows(mode.id, id, bytes, isCan(protocol.number));
      return replies.length === 1 ? entries : entries.map(({ label, value }) =>
        row('Reply ' + (index + 1) + ' · ' + label, value));
    });
  }

  const id = discoverRanges ? 0 : Number.parseInt(identifier, 16);
  const isSupportPage = id % 32 === 0;
  const replies = await readId(id);
  if (isSupportPage) {
    const ids = new Set();
    let page = id;
    let data = replies;
    let note;
    while (true) {
      const supported = data.flatMap((bytes) => {
        if (modeId !== '06' || isCan(protocol.number)) return supportBits(bytes, page);
        if (bytes[0] !== 0xff) throw new Error('The legacy monitor support reply is missing its filler byte.');
        return supportBits(bytes.slice(1), page);
      });
      for (const entry of supported) {
        if (entry % 32 !== 0) ids.add(entry);
      }
      if (!discoverRanges || page >= 0xe0 || !supported.includes(page + 32)) break;
      page += 32;
      try {
        data = await readId(page);
      } catch (error) {
        if (!(error instanceof OBDReplyError)) throw error;
        note = 'Discovery stopped at range $' + hex(page) + '. ' + error.message;
        break;
      }
    }
    const supported = [...ids].sort((a, b) => a - b);
    if (!readAll || !supported.length) return { protocol: protocol.description, supported, note };

    const rows = [];
    let successful = 0;
    let completed = 0;
    for (const id of supported) {
      const label = '$' + hex(id);
      let data;
      try {
        data = await readId(id);
      } catch (error) {
        if (!(error instanceof OBDReplyError)) throw error;
        rows.push(row(label, error.message));
      }
      if (data) {
        try {
          rows.push(...decodeRows(id, data).map((entry) => row(label + ' · ' + entry.label, entry.value)));
          successful++;
        } catch (error) {
          rows.push(row(label, error.message));
        }
      }
      onProgress(++completed, supported.length);
    }
    return { protocol: protocol.description, supported, rows, note, successful };
  }

  return { protocol: protocol.description, rows: decodeRows(id, replies) };
}
