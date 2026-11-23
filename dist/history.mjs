const keyPrefix = 'autodiaghub:reading:v1:';
const hexByte = /^[0-9A-F]{2}$/;
const codePattern = /^[PCBU][0-3][0-9A-F]{3}$/;
const modesWithIds = ['01', '02', '05', '06', '09'];
const codeModes = ['03', '07', '0A'];
export const scanStateLabels = {
  detected: 'Identification reply',
  rejected: 'ECU replied · identification rejected',
  invalid: 'Invalid identification reply',
  'no-reply': 'No matching reply',
};

function validScan(scan) {
  return [scan.vehicle, scan.variant, scan.variantId, scan.adapter, scan.firmware].every(value => typeof value === 'string') &&
    [undefined, '', '6/14', '3/8'].includes(scan.pinPair) && ['complete', 'stopped', 'interrupted'].includes(scan.outcome) &&
    Number.isInteger(scan.total) && scan.total > 0 && Array.isArray(scan.ecus) && scan.ecus.length <= scan.total &&
    scan.ecus.every(ecu => typeof ecu?.id === 'string' && typeof ecu.name === 'string' &&
      Object.hasOwn(scanStateLabels, ecu.state) &&
      (ecu.faults === undefined || (Array.isArray(ecu.faults) && ecu.faults.every(code => typeof code === 'string'))));
}

const validRows = (rows) => Array.isArray(rows) &&
  rows.every((row) => typeof row?.label === 'string' && typeof row.value === 'string');
const hasRows = (reading) => validRows(reading.rows) && reading.rows.length > 0;
const optionalText = (value) => value === undefined || typeof value === 'string';

function hasExchanges(exchanges) {
  return Array.isArray(exchanges) && exchanges.length > 0 && exchanges.every((exchange) =>
    typeof exchange?.request === 'string' &&
    (typeof exchange.response === 'string' || typeof exchange.error === 'string'));
}

function isReading(reading) {
  if (!reading || !Number.isFinite(reading.time) ||
      !Number.isFinite(new Date(reading.time).getTime()) || typeof reading.protocol !== 'string') {
    return false;
  }
  if (reading.exchanges !== undefined && !hasExchanges(reading.exchanges)) return false;
  if (reading.modeId === 'PSA-SCAN') return validScan(reading);
  if (codeModes.includes(reading.modeId)) {
    return Array.isArray(reading.codes) && reading.codes.every((code) =>
      typeof code === 'string' && codePattern.test(code));
  }
  if (reading.modeId === 'PSA') {
    return ['vehicle', 'variant', 'ecu', 'model'].every((key) => typeof reading[key] === 'string' && reading[key]) &&
      hasRows(reading) && (reading.explanations === undefined || (Array.isArray(reading.explanations) &&
        reading.explanations.every(item => typeof item?.id === 'string' && typeof item.request === 'string' &&
          optionalText(item.response) && optionalText(item.note) && (item.fields === undefined || validRows(item.fields)))));
  }
  return modesWithIds.includes(reading.modeId) &&
    (reading.batch === true || (typeof reading.identifier === 'string' && hexByte.test(reading.identifier))) &&
    (!['02', '05'].includes(reading.modeId) ||
      (typeof reading.extra === 'string' && hexByte.test(reading.extra))) &&
    hasRows(reading);
}

export function makePsaReading({ vehicle, variant, ecu, model, protocol, exchanges, explanations }, rows, time = Date.now()) {
  const reading = { modeId: 'PSA', vehicle, variant, ecu, model, protocol, time, rows };
  if (exchanges?.length) reading.exchanges = exchanges;
  if (explanations?.length) reading.explanations = explanations;
  return isReading(reading) ? reading : null;
}

export function makePsaScan(details) {
  const scan = { modeId: 'PSA-SCAN', protocol: '11-bit CAN · 500 kbit/s', ...details };
  return isReading(scan) ? scan : null;
}

export function scanSummary(scan) {
  const identified = scan.ecus.filter(({ state }) => state === 'detected').length;
  const responded = identified + scan.ecus.filter(({ state }) => state === 'rejected').length;
  return scan.ecus.length + ' of ' + scan.total + ' checked · ' + responded + ' responded · ' + identified + ' identified';
}

export function scanRows(scan) {
  return scan.ecus.map(({ name, id, state, rejected, faults, faultError }) => ({
    label: name + ' (' + id + ')',
    value: [scanStateLabels[state], rejected === undefined || state !== 'rejected' ? '' :
      'NRC $' + rejected.toString(16).toUpperCase().padStart(2, '0'),
    faults ? (faults.join(', ') || 'No matching fault codes') : faultError].filter(Boolean).join(' · '),
  }));
}

export function compareScans(previous, selected) {
  const before = new Map(previous.ecus.map(ecu => [ecu.id, ecu]));
  const after = new Map(selected.ecus.map(ecu => [ecu.id, ecu]));
  const changes = [];
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const left = before.get(id);
    const right = after.get(id);
    const details = [];
    if (left?.state !== right?.state) {
      details.push((scanStateLabels[left?.state] || 'Not checked') + ' → ' +
        (scanStateLabels[right?.state] || 'Not checked'));
    }
    if (left?.faults && right?.faults && left.modelKeys?.[0] === right.modelKeys?.[0]) {
      const added = [...new Set(right.faults.filter(code => !left.faults.includes(code)))];
      const removed = [...new Set(left.faults.filter(code => !right.faults.includes(code)))];
      if (added.length) details.push('Faults added ' + added.join(', '));
      if (removed.length) details.push('Faults absent on follow-up ' + removed.join(', '));
    }
    if (details.length) changes.push({ label: (right || left).name + ' (' + id + ')', value: details.join(' · ') });
  }
  return changes;
}

export function scanBaselines(readings, selected) {
  return readings.slice(readings.indexOf(selected) + 1).filter(reading =>
    reading.modeId === 'PSA-SCAN' && reading.vehicle === selected.vehicle && reading.variantId === selected.variantId &&
    reading.pinPair === selected.pinPair);
}

export function makeReading(selection, result, time = Date.now()) {
  const { modeId, identifier, extra, readAll } = selection;
  const { protocol, codes, rows, exchanges } = result;
  const reading = { modeId, time, protocol };
  if (exchanges?.length) reading.exchanges = exchanges;
  if (codes) {
    reading.codes = codes;
  } else if (rows) {
    if (readAll) reading.batch = true;
    else reading.identifier = identifier;
    if (modeId === '02' || modeId === '05') reading.extra = extra;
    reading.rows = rows;
  }
  return isReading(reading) ? reading : null;
}

export function traceSession(session, { timestamped = false } = {}) {
  const exchanges = [];
  return {
    exchanges,
    async command(request, timeout) {
      const exchange = { request };
      if (timestamped) exchange.startedAt = new Date().toISOString();
      exchanges.push(exchange);
      try {
        exchange.response = await session.command(request, timeout);
        return exchange.response;
      } catch (error) {
        exchange.error = error?.message ?? String(error);
        if (timestamped && typeof error?.partialResponse === 'string') exchange.partialResponse = error.partialResponse;
        throw error;
      } finally {
        if (timestamped) exchange.finishedAt = new Date().toISOString();
      }
    },
    close: (error) => session.close?.(error),
  };
}

export function rawExchangeFile(reading) {
  if (!reading?.exchanges?.length) return null;
  const { key, time, rows, codes, explanations, ...data } = reading;
  const timestamp = new Date(time).toISOString();
  return {
    name: 'autodiaghub-' + reading.modeId + '-' + timestamp.replaceAll(':', '-') + '.json',
    contents: JSON.stringify({ readAt: timestamp, ...data }, null, 2) + '\n',
  };
}

export function saveReading(storage, reading) {
  const key = keyPrefix + globalThis.crypto.getRandomValues(new Uint32Array(4)).join('-');
  storage.setItem(key, JSON.stringify(reading));
  return key;
}

export function listReadings(storage) {
  const readings = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith(keyPrefix)) continue;
    const raw = storage.getItem(key);
    let reading;
    try {
      reading = JSON.parse(raw);
    } catch {
      continue;
    }
    if (isReading(reading)) readings.push({ ...reading, key });
  }
  return readings.sort((a, b) => b.time - a.time || a.key.localeCompare(b.key));
}

export function deleteReading(storage, key) {
  if (key.startsWith(keyPrefix)) storage.removeItem(key);
}

function liveSample({ modeId, batch, rows }) {
  const entry = rows?.[0];
  if (modeId !== '01' || batch || rows?.length !== 1 || entry.label === 'Raw PID data') return null;
  const match = /^(-?\d+(?:\.\d+)?) (\S.*)$/.exec(entry.value);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? { label: entry.label, value, unit: match[2] } : null;
}

export function trendFor(readings, selected) {
  const sample = liveSample(selected);
  if (!sample) return null;
  const points = readings.flatMap((reading) => {
    if (reading.identifier !== selected.identifier || reading.protocol !== selected.protocol) return [];
    const entry = liveSample(reading);
    return entry?.label === sample.label && entry.unit === sample.unit
      ? [{ time: reading.time, value: entry.value }]
      : [];
  });
  points.sort((a, b) => a.time - b.time);
  return points.length < 2 ? null : { label: sample.label, unit: sample.unit, points };
}
