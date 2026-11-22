import { decodeDtc, OBDReplyError, prepareOBD, replyLines, vehicleReplyLines } from './obd.mjs';

const canId = /^[1-7][0-9A-F]{2}$/;
const readRequest = /^(?:22[0-9A-F]{4}|21[0-9A-F]{2}|190209|17FF00)$/;
const dtcServices = {
  UDS: { read: '190209', clear: '14FFFFFF' },
  'KWP-PSA2000': { read: '17FF00', clear: '14FF00' },
};
const hex = (value) => value.toString(16).toUpperCase().padStart(2, '0');
export const formatHex = (bytes) => bytes.map(hex).join(' ');

export function parsePsaResponse(raw, request, responseId) {
  const lines = vehicleReplyLines(raw, request);
  const payloads = [];
  let multi;
  for (const line of lines) {
    const compact = line.replace(/\s/g, '');
    const match = /^([0-7][0-9A-F]{2})((?:[0-9A-F]{2}){2,8})$/.exec(compact);
    if (!match) throw new OBDReplyError('invalid', 'The adapter returned a malformed CAN frame.');
    if (match[1] !== responseId) continue;

    const [pci, ...data] = match[2].match(/../g).map((byte) => Number.parseInt(byte, 16));
    const kind = pci >> 4;
    const nibble = pci & 0x0f;
    if (kind === 0 && !multi && nibble > 0 && nibble <= data.length) {
      payloads.push(data.slice(0, nibble));
    } else if (kind === 1 && !multi && data.length === 7) {
      const length = (nibble << 8) | data[0];
      if (length <= 7) throw new OBDReplyError('invalid', 'The ECU returned an invalid ISO-TP length.');
      multi = { length, next: 1, bytes: data.slice(1) };
    } else if (kind === 2 && multi && nibble === multi.next % 16 &&
        (data.length === 7 || multi.bytes.length + data.length >= multi.length)) {
      multi.bytes.push(...data);
      multi.next++;
      if (multi.bytes.length >= multi.length) {
        payloads.push(multi.bytes.slice(0, multi.length));
        multi = undefined;
      }
    } else {
      throw new OBDReplyError('invalid', 'The ECU returned an unexpected ISO-TP frame or sequence.');
    }
  }
  if (multi) throw new OBDReplyError('invalid', 'The ECU response was incomplete.');

  const service = Number.parseInt(request.slice(0, 2), 16);
  const identifier = request.slice(2).match(/../g)?.map((byte) => Number.parseInt(byte, 16)) || [];
  const echoed = service === 0x19 ? [0x02] :
    [0x21, 0x22].includes(service) || request === '14FF00' ? identifier : [];
  const prefix = [service + 0x40, ...echoed];
  const positives = payloads.filter((bytes) => prefix.every((byte, index) => bytes[index] === byte));
  if (positives.length === 1) return { data: positives[0].slice(prefix.length) };
  if (positives.length > 1) throw new OBDReplyError('invalid', 'The ECU returned multiple matching responses.');
  const negative = payloads.find((bytes) => bytes[0] === 0x7f && bytes[1] === service && bytes.length === 3);
  if (negative) return { rejected: negative[2] };
  throw new OBDReplyError('unconfirmed', 'No matching response from the selected ECU.');
}

async function adapterSetting(session, command) {
  if (!replyLines(await session.command(command), command).includes('OK')) {
    throw new Error('The adapter rejected ' + command + '. PSA diagnostics require configurable CAN headers and flow control.');
  }
}

async function withPsaAdapter(session, operation) {
  let primaryError;
  try {
    await prepareOBD(session);
    for (const setting of ['ATTP6', 'ATH1', 'ATS1', 'ATD0', 'ATCFC1', 'ATFCSD300000', 'ATST64']) {
      await adapterSetting(session, setting);
    }
    return await operation();
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await prepareOBD(session);
    } catch (error) {
      session.close?.(error);
      if (!primaryError) throw error;
    }
  }
}

async function configureTarget(session, model) {
  const { requestId, responseId } = model;
  if (!canId.test(requestId) || !canId.test(responseId)) {
    throw new Error('This ECU route is outside the bundled profile.');
  }
  for (const setting of ['ATSH' + requestId, 'ATCRA' + responseId, 'ATFCSH' + requestId, 'ATFCSM1']) {
    await adapterSetting(session, setting);
  }
}

async function requestRead(session, model, request) {
  if (!readRequest.test(request)) throw new Error('This request is outside the read-only profile.');
  return parsePsaResponse(await session.command(request, 4500), request, model.responseId);
}

async function sendRead(session, model, request) {
  await configureTarget(session, model);
  return requestRead(session, model, request);
}

export async function scanPsaEcus(session, variant, models, onResult) {
  return withPsaAdapter(session, async () => {
    for (const ecu of variant.ecus) {
      if (!ecu.models.length) continue;
      const probes = new Map();
      for (const link of ecu.models) {
        const model = models[link.key];
        const signature = [model.requestId, model.responseId, model.probe].join('/');
        if (!probes.has(signature)) probes.set(signature, { model, keys: [] });
        probes.get(signature).keys.push(link.key);
      }
      const matched = [];
      const replies = [];
      let rejected;
      let invalid;
      for (const { model, keys } of probes.values()) {
        try {
          const response = await sendRead(session, model, model.probe);
          if (response.data?.length) {
            matched.push(...keys);
            replies.push({ request: model.probe, data: response.data });
          } else if (response.rejected !== undefined) {
            rejected = response.rejected;
          } else {
            invalid = true;
          }
        } catch (error) {
          if (!(error instanceof OBDReplyError)) throw error;
          if (error.kind === 'invalid') invalid = true;
        }
      }
      onResult(ecu.id, {
        state: matched.length ? 'detected' : rejected !== undefined ? 'rejected' : invalid ? 'invalid' : 'no-reply',
        modelKeys: matched, replies, rejected,
      });
    }
  });
}

function checkedData(response) {
  if (response.rejected !== undefined) {
    throw new OBDReplyError('unconfirmed', 'The ECU rejected the read (NRC $' + hex(response.rejected) + ').');
  }
  return response.data;
}

function decodeField(field, bytes) {
  const range = /^(\d+)\.([0-7])(?:-(\d+)\.([0-7]))?$/.exec(field.bits);
  if (!range) return null;
  const [, firstByte, firstBit, lastByte = firstByte, lastBit = firstBit] = range;
  const start = (Number(firstByte) - 1) * 8 + (7 - Number(firstBit));
  const end = (Number(lastByte) - 1) * 8 + (7 - Number(lastBit));
  const width = end - start + 1;
  if (start < 0 || width < 1 || end >= bytes.length * 8) return null;
  if (['ascii', 'bcd'].includes(field.type) && start % 8 === 0 && width % 8 === 0) {
    const data = bytes.slice(start / 8, (end + 1) / 8);
    if (field.type === 'bcd') {
      const value = data.map(hex).join('');
      return /^[0-9]+$/.test(value) ? value : null;
    }
    if (data.every((byte) => byte === 0 || (byte >= 0x20 && byte <= 0x7e))) {
      return String.fromCharCode(...data.filter(Boolean)).trim() || null;
    }
    return null;
  }
  if (width > 32 || !['uint', 'int', 'enum', 'bool'].includes(field.type)) return null;
  let value = 0;
  for (let position = start; position <= end; position++) {
    value = value * 2 + (bytes[position >> 3] >> (7 - position % 8) & 1);
  }
  if (field.type === 'enum') return field.values?.[value] || '$' + hex(value);
  if (field.type === 'bool') return value ? 'Yes' : 'No';
  if (field.type === 'int' && value >= 2 ** (width - 1)) value -= 2 ** width;
  value = value * (field.factor ?? 1) + (field.offset ?? 0);
  return String(Number(value.toFixed(6))) + (field.unit ? ' ' + field.unit : '');
}

export function decodePsaParameter(parameter, bytes) {
  const rows = [];
  if (parameter.length === bytes.length) {
    for (const field of parameter.fields) {
      const value = decodeField(field, bytes);
      if (value !== null) rows.push({ label: field.name, value });
    }
  }
  rows.push({ label: 'Raw data', value: formatHex(bytes) });
  return rows;
}

export async function readPsaParameters(session, model, parameterIds, onProgress = () => {}) {
  const selected = new Set(parameterIds);
  const parameters = model.parameters.filter(({ id }) => selected.has(id));
  if (!parameters.length || parameters.length !== selected.size) {
    throw new Error('Choose read parameters from the selected ECU definition.');
  }
  return withPsaAdapter(session, async () => {
    await configureTarget(session, model);
    const results = [];
    const prefix = model.protocol === 'UDS' ? '22' : '21';
    for (const parameter of parameters) {
      try {
        const bytes = checkedData(await requestRead(session, model, prefix + parameter.id));
        if (!bytes.length) throw new OBDReplyError('invalid', 'The ECU returned an empty parameter value.');
        results.push({ parameter, rows: decodePsaParameter(parameter, bytes) });
      } catch (error) {
        if (!(error instanceof OBDReplyError)) throw error;
        results.push({ parameter, error: error.message });
      }
      onProgress(results.length, parameters.length);
    }
    return results;
  });
}

const udsStatuses = [
  'Test failed', 'Failed this cycle', 'Pending', 'Confirmed',
  'Test incomplete since last clear', 'Failed since last clear',
  'Test incomplete this cycle', 'Warning indicator requested',
];

export function decodePsaDtcs(data, descriptions) {
  if (data.length < 1 || (data.length - 1) % 4 !== 0) {
    throw new Error('The ECU returned an incomplete UDS trouble-code list.');
  }
  const faults = [];
  for (let index = 1; index < data.length; index += 4) {
    const [high, low, type, status] = data.slice(index, index + 4);
    const code = decodeDtc(high, low);
    const flags = udsStatuses.filter((_, bit) => (data[0] & status & (1 << bit)) !== 0);
    faults.push({ code: code + '-' + hex(type), description: descriptions[code], status: hex(status), flags });
  }
  return faults;
}

function decodeKwpDtcs(data, descriptions) {
  if (!data.length || data.length !== 1 + data[0] * 3) {
    throw new Error('The ECU returned an invalid KWP trouble-code count.');
  }
  const faults = [];
  for (let index = 1; index < data.length; index += 3) {
    const [high, low, status] = data.slice(index, index + 3);
    const code = decodeDtc(high, low);
    faults.push({ code, description: descriptions[code], status: hex(status) });
  }
  return faults;
}

function modelDtcServices(model) {
  if (!model.readDtcs || !Object.hasOwn(dtcServices, model.protocol)) {
    throw new Error('This model has no supported DTC read.');
  }
  return dtcServices[model.protocol];
}

async function readTargetDtcs(session, model) {
  const { read } = modelDtcServices(model);
  const response = await requestRead(session, model, read);
  const decode = model.protocol === 'UDS' ? decodePsaDtcs : decodeKwpDtcs;
  return decode(checkedData(response), model.dtcs);
}

export async function readPsaDtcs(session, model) {
  modelDtcServices(model);
  return withPsaAdapter(session, async () => {
    await configureTarget(session, model);
    return readTargetDtcs(session, model);
  });
}

export async function clearPsaDtcs(session, model) {
  if (!model.clearDtcs) throw new Error('This ECU has no documented DTC clear operation.');
  const { clear } = modelDtcServices(model);
  return withPsaAdapter(session, async () => {
    await configureTarget(session, model);
    await readTargetDtcs(session, model);

    let outcome;
    try {
      const raw = await session.command(clear, 4500);
      const reply = parsePsaResponse(raw, clear, model.responseId);
      if (reply.rejected !== undefined && reply.rejected !== 0x78) {
        outcome = { state: 'rejected', reason: 'NRC $' + hex(reply.rejected) };
      } else {
        outcome = { state: reply.data?.length === 0 ? 'acknowledged' : 'unconfirmed' };
      }
    } catch {
      // The ECU may have received the request even when its acknowledgement was lost.
      outcome = { state: 'unconfirmed' };
    }

    try {
      return { ...outcome, faults: await readTargetDtcs(session, model) };
    } catch {
      return outcome;
    }
  });
}
