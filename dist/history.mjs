const keyPrefix = 'autodiaghub:reading:v1:';
const hexByte = /^[0-9A-F]{2}$/;
const codePattern = /^[PCBU][0-3][0-9A-F]{3}$/;
const modesWithIds = ['01', '02', '05', '06', '09'];
const codeModes = ['03', '07', '0A'];

function hasRows(reading) {
  return Array.isArray(reading.rows) && reading.rows.length > 0 &&
    reading.rows.every((row) => typeof row?.label === 'string' && typeof row.value === 'string');
}

function isReading(reading) {
  if (!reading || !Number.isFinite(reading.time) ||
      !Number.isFinite(new Date(reading.time).getTime()) || typeof reading.protocol !== 'string') {
    return false;
  }
  if (codeModes.includes(reading.modeId)) {
    return Array.isArray(reading.codes) && reading.codes.every((code) =>
      typeof code === 'string' && codePattern.test(code));
  }
  if (reading.modeId === 'PSA') {
    return ['vehicle', 'variant', 'ecu', 'model'].every((key) => typeof reading[key] === 'string' && reading[key]) &&
      hasRows(reading);
  }
  return modesWithIds.includes(reading.modeId) && typeof reading.identifier === 'string' &&
    hexByte.test(reading.identifier) &&
    (!['02', '05'].includes(reading.modeId) ||
      (typeof reading.extra === 'string' && hexByte.test(reading.extra))) &&
    hasRows(reading);
}

export function makePsaReading({ vehicle, variant, ecu, model, protocol }, rows, time = Date.now()) {
  const reading = { modeId: 'PSA', vehicle, variant, ecu, model, protocol, time, rows };
  return isReading(reading) ? reading : null;
}

export function makeReading(selection, result, time = Date.now()) {
  const { modeId, identifier, extra } = selection;
  const { protocol, codes, rows } = result;
  const reading = { modeId, time, protocol };
  if (codes) {
    reading.codes = codes;
  } else if (rows) {
    reading.identifier = identifier;
    if (modeId === '02' || modeId === '05') reading.extra = extra;
    reading.rows = rows;
  }
  return isReading(reading) ? reading : null;
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

function liveSample({ modeId, rows }) {
  const entry = rows?.[0];
  if (modeId !== '01' || rows?.length !== 1 || entry.label === 'Raw PID data') return null;
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
