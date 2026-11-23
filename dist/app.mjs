import { chooseAdapter, openAdapter } from './ble.mjs';
import { readAdapterHealth, readVehicleHealth } from './obd.mjs';
import { identifierName, modes, readGeneralOBD } from './modes.mjs';
import { compareScans, deleteReading, listReadings, makeReading, rawExchangeFile, saveReading,
  scanBaselines, scanRows, scanSummary, traceSession, trendFor } from './history.mjs';
import { mountPsaView, renderPsaExplanations } from './psa-view.mjs';
import { createSessionTrace, readSessionTrace, saveSessionTrace, sessionTraceFile, sessionTraceKey } from './session-trace.mjs';

const element = (id) => document.getElementById(id);
const connect = element('connect');
const disconnect = element('disconnect');
const health = element('health');
const scan = element('scan');
const discover = element('discover');
const readAll = element('read-all');
const service = element('service');
const codes = element('codes');
const values = element('obd-values');
const modePicker = element('obd-mode');
const identifier = element('obd-identifier');
const frame = element('obd-frame');
const sensor = element('obd-sensor');
const supportedPicker = element('obd-supported');
const saveButton = element('save-reading');
const refreshButton = element('refresh-app');
const sessionDownload = element('session-download');
const historyMode = element('history-mode');
const historyEcu = element('history-ecu');
const historyList = element('history-list');
const historyBaseline = element('history-baseline');
const historyDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
const historyDay = new Intl.DateTimeFormat(undefined, { dateStyle: 'full' });
const historyTime = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });
const currentMode = () => modes.find(({ id }) => id === modePicker.value);

for (const mode of modes) {
  const label = '$' + mode.id + ' · ' + mode.title;
  modePicker.add(new Option(label, mode.id));
  if (!mode.infoOnly) historyMode.add(new Option(label, mode.id));
}
historyMode.add(new Option('PSA ECU snapshots', 'PSA'));
historyMode.add(new Option('PSA ECU scans', 'PSA-SCAN'));
modePicker.value = '03';
for (let slot = 0; slot < 8; slot++) {
  const mask = (1 << slot).toString(16).toUpperCase().padStart(2, '0');
  sensor.add(new Option('Slot ' + (slot + 1) + ' ($' + mask + ')', mask));
}

const canConnect = Boolean(globalThis.isSecureContext && navigator.bluetooth?.requestDevice);
let session;
let busy = false;
let pendingReading;
let savedReadings = [];
let selectedHistoryKey;
let obdReadTime;
let psaView;
let offlineRegistration;
let latestSessionTrace;
let traceStorageFailed = false;

function status(id, message, tone = 'idle') {
  const field = element(id);
  field.textContent = message;
  field.dataset.tone = tone;
}

function reportVehicleReply() {
  status('vehicle-status', 'Vehicle replied', 'ready');
}

function renderReadTime(id, time, label) {
  const field = element(id);
  field.hidden = time === undefined;
  if (field.hidden) {
    field.removeAttribute('datetime');
    field.textContent = '';
    return;
  }
  field.dateTime = new Date(time).toISOString();
  field.textContent = label + ' · ' + historyDate.format(time);
}

function renderSessionTrace() {
  const count = latestSessionTrace?.exchanges.length || 0;
  element('session-trace').hidden = !count;
  sessionDownload.disabled = busy || !count;
  if (!count) return;
  const label = session ? 'Current session' : 'Last session';
  status('session-trace-info', [label, historyDate.format(new Date(latestSessionTrace.startedAt)),
    count + (count === 1 ? ' command' : ' commands'),
    traceStorageFailed ? 'Available until this page closes' : ''].filter(Boolean).join(' · '));
}

function restoreSessionTrace() {
  try {
    latestSessionTrace = readSessionTrace(localStorage);
  } catch {
    latestSessionTrace = null;
  }
}

function persistSessionTrace(trace = latestSessionTrace) {
  if (!trace?.exchanges.length) return;
  try {
    saveSessionTrace(localStorage, trace);
    traceStorageFailed = false;
  } catch {
    traceStorageFailed = true;
  }
}

function renderControls() {
  connect.hidden = Boolean(session);
  connect.disabled = busy || !canConnect;
  service.disabled = busy || Boolean(session);
  disconnect.hidden = !session;
  element('vehicle-status').hidden = !session;
  health.disabled = busy || !session;
  refreshButton.disabled = busy || !offlineRegistration;
  renderSessionTrace();
  const mode = currentMode();
  scan.disabled = busy || !session || mode.infoOnly;
  discover.disabled = busy || !session || !mode.identifier;
  readAll.disabled = discover.disabled;
  for (const field of [modePicker, identifier, frame, sensor, supportedPicker]) field.disabled = busy;
  psaView?.update(Boolean(session), busy);
}

function clearScanResults() {
  codes.replaceChildren();
  codes.hidden = true;
  values.replaceChildren();
  values.hidden = true;
  obdReadTime = undefined;
  renderReadTime('obd-read-time');
  pendingReading = undefined;
  element('save-actions').hidden = true;
  saveButton.disabled = false;
  status('save-status', '');
}

function clearSupported() {
  supportedPicker.replaceChildren();
  element('supported-field').hidden = true;
}

function showScanPrompt() {
  status('scan-status', currentMode().infoOnly || session ? '' : 'Connect an adapter to read this mode.');
}

function showMode() {
  const mode = currentMode();
  element('mode-description').textContent = mode.description;
  element('mode-fields').hidden = !mode.identifier;
  element('frame-field').hidden = mode.id !== '02';
  element('sensor-field').hidden = mode.id !== '05';
  element('identifier-label').textContent = mode.identifier ? mode.identifier + ' (hex)' : 'Identifier (hex)';
  identifier.value = mode.defaultId || '';
  scan.hidden = Boolean(mode.infoOnly);
  discover.hidden = !mode.identifier;
  readAll.hidden = !mode.identifier;
  scan.textContent = mode.troubleCodes ? 'Read ' + mode.title.toLowerCase() : 'Read value';
  clearScanResults();
  clearSupported();
  showScanPrompt();
  renderControls();
}

function resetReadings() {
  status('vehicle-status', 'Vehicle reply not yet checked');
  element('firmware').textContent = '—';
  element('adapter-id').textContent = '—';
  element('voltage').textContent = '—';
  element('vehicle').textContent = 'Not checked';
  element('protocol').textContent = '—';
  element('vehicle-reply').textContent = '—';
  clearSupported();
  status('health-status', 'Connect an adapter to check its health.');
  if (obdReadTime === undefined) showScanPrompt();
  else renderReadTime('obd-read-time', obdReadTime, 'Last reading · disconnected');
}

function showDisconnected(endedSession, error) {
  if (session !== endedSession) return;
  latestSessionTrace.endedAt = new Date().toISOString();
  latestSessionTrace.endReason = error?.message || 'Disconnected by user';
  session = undefined;
  persistSessionTrace();
  resetReadings();
  psaView.disconnectSession();
  status('connection-status', error?.message || 'Adapter disconnected', error ? 'error' : 'idle');
  renderControls();
}

async function runOperation(target, pendingMessage, operation) {
  if (busy || !session) return;
  const active = session;
  const trace = latestSessionTrace;
  const entry = {
    name: pendingMessage.replace(/…$/, ''),
    startedAt: new Date().toISOString(),
    firstExchange: trace.exchanges.length,
  };
  if (target.startsWith('psa-')) entry.context = psaView.traceContext(target !== 'psa-status');
  trace.operations.push(entry);
  busy = true;
  renderControls();
  status(target, pendingMessage);
  try {
    await operation(active);
  } catch (error) {
    entry.error = error?.message ?? String(error);
    if (session === active) {
      const tone = error.kind === 'unsupported' || error.kind === 'unconfirmed' ? 'idle' : 'error';
      status(target, error.message || 'The request failed.', tone);
    }
  } finally {
    entry.finishedAt = new Date().toISOString();
    entry.exchangeCount = trace.exchanges.length - entry.firstExchange;
    persistSessionTrace(trace);
    busy = false;
    renderControls();
  }
}

async function checkHealth(includeVehicle) {
  await runOperation('health-status', includeVehicle ? 'Checking adapter and vehicle…' : 'Checking adapter…', async (active) => {
    const result = await readAdapterHealth(active);
    if (session !== active) return;
    element('firmware').textContent = result.version || 'Not reported';
    element('adapter-id').textContent = result.identification || 'No identification returned';
    element('voltage').textContent = result.voltage || 'Not reported';
    const adapterComplete = Boolean(result.version && result.voltage);
    if (!includeVehicle) {
      status('health-status', adapterComplete ? '' :
        'The adapter did not report every value.');
      return;
    }

    const vehicle = element('vehicle');
    const protocol = element('protocol');
    const reply = element('vehicle-reply');
    vehicle.textContent = 'Checking…';
    protocol.textContent = '—';
    reply.textContent = '—';
    status('health-status', 'Checking vehicle communication…');
    let report;
    try {
      report = await readVehicleHealth(active);
    } catch (error) {
      if (session === active) vehicle.textContent = 'Not confirmed';
      throw error;
    }
    if (session !== active) return;
    reportVehicleReply();
    vehicle.textContent = report.replies.length + (report.replies.length === 1 ? ' reply' : ' replies');
    const { code, description } = report.protocol;
    protocol.textContent = description === 'Protocol ' + code ? description : description + ' · ' + code;
    reply.textContent = report.replies.join(' / ');
    status('health-status', adapterComplete ? 'Adapter and vehicle details read.' :
      'Vehicle replied. The adapter did not report every value.', 'ready');
  });
}

connect.addEventListener('click', async () => {
  if (busy || session) return;
  busy = true;
  renderControls();
  status('connection-status', 'Select your ELM327 adapter…');
  try {
    const selected = await chooseAdapter(navigator.bluetooth, service.value.trim());
    status('connection-status', 'Connecting to the adapter…');
    let traced;
    const adapter = await openAdapter(selected, (_ended, error) => {
      if (traced) showDisconnected(traced, error);
    });
    traced = traceSession(adapter, { timestamped: true });
    latestSessionTrace = createSessionTrace(adapter.name, traced.exchanges);
    traceStorageFailed = false;
    session = traced;
    status('connection-status', 'Adapter connected · ' + adapter.name, 'ready');
    status('health-status', 'Ready to check the adapter.');
    if (obdReadTime !== undefined) renderReadTime('obd-read-time', obdReadTime, 'Previous connection');
    showScanPrompt();
  } catch (error) {
    if (error.name === 'NotFoundError') {
      status('connection-status', 'No adapter selected or found.');
    } else {
      status('connection-status', error.message || 'Bluetooth connection failed.', 'error');
    }
  } finally {
    busy = false;
    renderControls();
  }
  await checkHealth(false);
});

disconnect.addEventListener('click', () => {
  const active = session;
  if (!active) return;
  active.close();
  showDisconnected(active);
});

health.addEventListener('click', () => checkHealth(true));
modePicker.addEventListener('change', showMode);
for (const field of [frame, sensor]) {
  field.addEventListener('input', () => {
    clearScanResults();
    clearSupported();
    showScanPrompt();
  });
}
identifier.addEventListener('input', () => {
  clearScanResults();
  supportedPicker.value = identifier.value.trim().toUpperCase();
  showScanPrompt();
});
supportedPicker.addEventListener('change', () => {
  if (supportedPicker.value) identifier.value = supportedPicker.value;
  clearScanResults();
  showScanPrompt();
});

function renderCodes(list, items = []) {
  list.replaceChildren();
  for (const code of items) {
    const item = document.createElement('li');
    const value = document.createElement('code');
    value.textContent = code;
    item.append(value);
    list.append(item);
  }
  list.hidden = items.length === 0;
}

function renderValues(list, rows = []) {
  list.replaceChildren();
  for (const entry of rows) {
    const line = document.createElement('div');
    const label = document.createElement('dt');
    const value = document.createElement('dd');
    label.textContent = entry.label;
    value.textContent = entry.value;
    line.append(label, value);
    list.append(line);
  }
  list.hidden = rows.length === 0;
}

function displayResult(result, mode) {
  if (result.codes) {
    renderCodes(codes, result.codes);
    const count = result.codes.length;
    const name = mode.title.toLowerCase();
    const message = count === 0 ? 'No ' + name + ' returned.' :
      count + ' ' + (count === 1 ? name.slice(0, -1) : name) + ' found.';
    status('scan-status', message, 'ready');
    return;
  }
  if (result.supported) {
    supportedPicker.replaceChildren(new Option('Choose an identifier', ''));
    for (const id of result.supported) {
      const hex = id.toString(16).toUpperCase().padStart(2, '0');
      const name = identifierName(mode.id, id);
      supportedPicker.add(new Option('$' + hex + (name ? ' · ' + name : ''), hex));
    }
    element('supported-field').hidden = result.supported.length === 0;
    if (result.rows) {
      renderValues(values, result.rows);
      const message = result.successful + ' of ' + result.supported.length + ' supported identifiers read.';
      status('scan-status', [message, result.note].filter(Boolean).join(' '),
        result.note || result.successful !== result.supported.length ? 'idle' : 'ready');
      return;
    }
    const count = result.supported.length;
    const message = count === 0 ? 'No supported data identifiers reported.' :
      count + (count === 1 ? ' supported identifier reported.' : ' supported identifiers reported.');
    status('scan-status', [message, result.note].filter(Boolean).join(' '), result.note ? 'idle' : 'ready');
    return;
  }
  renderValues(values, result.rows);
  status('scan-status', 'Read complete.', 'ready');
}

function runScan(action) {
  const mode = currentMode();
  if (mode.infoOnly) return;
  const selection = {
    modeId: mode.id,
    identifier: identifier.value.trim().toUpperCase(),
    extra: mode.id === '05' ? sensor.value : frame.value.trim().toUpperCase(),
    discover: action === 'discover',
    readAll: action === 'all',
  };
  const message = action === 'read' ? 'Reading mode $' + mode.id + '…' : 'Finding supported identifiers…';
  return runOperation('scan-status', message, async (active) => {
    if (obdReadTime !== undefined) renderReadTime('obd-read-time', obdReadTime, 'Last reading');
    if (action !== 'read') clearSupported();
    const vehicle = element('vehicle');
    const previousVehicleState = vehicle.textContent;
    vehicle.textContent = 'Checking…';
    const traced = traceSession(active);
    let result;
    try {
      result = await readGeneralOBD(traced, selection, (done, total) => {
        if (session === active) status('scan-status', 'Read ' + done + ' of ' + total + ' identifiers…');
      });
    } catch (error) {
      if (session === active) {
        clearScanResults();
        vehicle.textContent = error.kind === 'unsupported' ? 'Responded' : previousVehicleState;
        if (error.kind === 'unsupported') reportVehicleReply();
      }
      throw error;
    }
    if (session !== active) return;
    clearScanResults();
    reportVehicleReply();
    vehicle.textContent = 'Responded';
    element('protocol').textContent = result.protocol;
    displayResult(result, mode);
    obdReadTime = Date.now();
    renderReadTime('obd-read-time', obdReadTime, 'Read at');
    pendingReading = makeReading(selection, { ...result, exchanges: traced.exchanges }, obdReadTime);
    element('save-actions').hidden = !pendingReading;
  });
}

scan.addEventListener('click', () => runScan('read'));
discover.addEventListener('click', () => runScan('discover'));
readAll.addEventListener('click', () => runScan('all'));

function readingLabel(reading) {
  if (reading.modeId === 'PSA-SCAN') {
    return [reading.vehicle, reading.variant, reading.pinPair && 'Pins ' + reading.pinPair,
      'Scan ' + reading.outcome].filter(Boolean).join(' · ');
  }
  if (reading.modeId === 'PSA') {
    return [reading.vehicle, reading.variant, reading.ecu, reading.model].join(' · ');
  }
  const mode = modes.find(({ id }) => id === reading.modeId);
  const name = reading.identifier && identifierName(mode.id, Number.parseInt(reading.identifier, 16));
  const parts = ['$' + mode.id + ' ' + mode.title];
  if (reading.batch) parts.push('All supported identifiers');
  if (reading.identifier) parts.push(mode.identifier + ' $' + reading.identifier);
  if (name) parts.push(name);
  if (reading.extra) parts.push((mode.id === '02' ? 'Frame $' : 'Sensor mask $') + reading.extra);
  return parts.join(' · ');
}

function drawTrend(trend) {
  const figure = element('history-trend');
  figure.hidden = !trend;
  if (!trend) return;
  const { points, label, unit } = trend;
  const samples = points.map(({ value }) => value);
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  element('trend-label').textContent = label + ' over time · ' + min + ' to ' + max + ' ' + unit;
  element('trend-unit').textContent = 'Value (' + unit + ')';
  const table = element('trend-values');
  table.replaceChildren();
  for (const point of points) {
    const line = table.insertRow();
    line.insertCell().textContent = historyDate.format(point.time);
    line.insertCell().textContent = point.value + ' ' + unit;
  }

  const canvas = element('trend-canvas');
  const context = canvas.getContext('2d');
  canvas.hidden = !context;
  if (!context) return;
  const { width, height } = canvas;
  const padding = 22;
  const elapsed = points[points.length - 1].time - points[0].time;
  const positions = points.map(({ time, value }, index) => [
    padding + (width - 2 * padding) * (elapsed ? (time - points[0].time) / elapsed : index / (points.length - 1)),
    height - padding - (height - 2 * padding) * (max === min ? .5 : (value - min) / (max - min)),
  ]);
  context.clearRect(0, 0, width, height);
  context.strokeStyle = '#66777e';
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(padding, padding);
  context.lineTo(padding, height - padding);
  context.lineTo(width - padding, height - padding);
  context.stroke();
  context.strokeStyle = context.fillStyle = '#92ebcb';
  context.lineWidth = 4;
  context.beginPath();
  context.moveTo(...positions[0]);
  for (const position of positions.slice(1)) context.lineTo(...position);
  context.stroke();
  for (const [x, y] of positions) {
    context.beginPath();
    context.arc(x, y, 5, 0, Math.PI * 2);
    context.fill();
  }
}

function savedRawReplies(reading) {
  return reading?.exchanges?.flatMap(({ request, response }) =>
    !request.startsWith('AT') && typeof response === 'string' ? [response] : []) || [];
}

function showSavedReading() {
  const selected = savedReadings.find(({ key }) => key === selectedHistoryKey);
  element('history-result').hidden = !selected;
  if (!selected) return;
  element('history-result-title').textContent = selected.modeId === 'PSA-SCAN' ? 'Saved scan' : 'Saved reading';
  renderReadTime('history-read-time', selected.time, 'Read at');
  const label = [readingLabel(selected), selected.protocol];
  if (selected.modeId === 'PSA-SCAN') {
    label.push(scanSummary(selected));
    if (selected.firmware && selected.firmware !== '—') label.push('Firmware ' + selected.firmware);
  }
  if (selected.codes?.length === 0) label.push('No trouble codes returned');
  element('history-meta').textContent = label.join(' · ');
  renderCodes(element('history-codes'), selected.codes);
  renderValues(element('history-values'), selected.modeId === 'PSA-SCAN' ? scanRows(selected) : selected.rows);
  renderPsaExplanations(element('history-explanations'), selected.explanations, renderValues);
  drawTrend(trendFor(savedReadings, selected));
  const compare = element('history-scan-compare');
  compare.hidden = selected.modeId !== 'PSA-SCAN';
  if (!compare.hidden) {
    const baselineKey = historyBaseline.value;
    const earlier = scanBaselines(savedReadings, selected);
    historyBaseline.replaceChildren(new Option('Choose an earlier scan', ''));
    for (const scan of earlier) {
      historyBaseline.add(new Option(historyDate.format(scan.time) + ' · ' + readingLabel(scan), scan.key));
    }
    if (earlier.some(({ key }) => key === baselineKey)) historyBaseline.value = baselineKey;
    historyBaseline.disabled = !earlier.length;
    showScanComparison();
  }
  const raw = rawExchangeFile(selected);
  const download = element('history-download');
  download.hidden = !raw;
  download.textContent = selected.modeId === 'PSA-SCAN' ? 'Download scan' : 'Download raw exchange';
  element('history-no-exchange').hidden = Boolean(raw);
  const details = element('history-raw');
  details.hidden = !raw;
  details.open = false;
  element('history-raw-text').textContent = raw?.contents || '';
  element('history-copy').hidden = !savedRawReplies(selected).length;
  element('history-raw-copy').hidden = true;
  status('history-copy-status', '');
}

function showScanComparison() {
  const previous = savedReadings.find(({ key }) => key === historyBaseline.value);
  const selected = savedReadings.find(({ key }) => key === selectedHistoryKey);
  const changes = previous && selected ? compareScans(previous, selected) : [];
  renderValues(element('history-changes'), changes);
  const message = historyBaseline.disabled ? 'Save another scan of this vehicle profile to compare.' :
    previous ? changes.length ? '' : 'No changes in scan results or comparable fault codes.' : '';
  status('history-compare-status', message);
}

function renderHistory(preferred = selectedHistoryKey) {
  const matchingMode = savedReadings.filter(({ modeId }) => !historyMode.value || modeId === historyMode.value);
  const ecus = [...new Set(matchingMode.map(({ ecu }) => ecu).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const preferredEcu = historyEcu.value;
  historyEcu.replaceChildren(new Option('All ECUs', ''));
  for (const ecu of ecus) historyEcu.add(new Option(ecu, ecu));
  if (ecus.includes(preferredEcu)) historyEcu.value = preferredEcu;
  historyEcu.disabled = !ecus.length;
  const filtered = matchingMode.filter(({ ecu }) => !historyEcu.value || ecu === historyEcu.value);
  selectedHistoryKey = filtered.some(({ key }) => key === preferred) ? preferred : filtered[0]?.key;
  historyList.replaceChildren();
  let day;
  let list;
  for (const reading of filtered) {
    const date = historyDay.format(reading.time);
    if (date !== day) {
      day = date;
      const group = document.createElement('section');
      const heading = document.createElement('h2');
      heading.textContent = date;
      list = document.createElement('ul');
      group.append(heading, list);
      historyList.append(group);
    }
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.reading = reading.key;
    button.setAttribute('aria-current', String(reading.key === selectedHistoryKey));
    const time = document.createElement('time');
    time.dateTime = new Date(reading.time).toISOString();
    time.textContent = historyTime.format(reading.time);
    button.append(readingLabel(reading), time);
    item.append(button);
    list.append(item);
  }
  historyList.hidden = !filtered.length;
  element('history-controls').hidden = savedReadings.length === 0;
  status('history-status', filtered.length ? '' :
    savedReadings.length ? 'No saved readings match these filters.' : 'No saved readings yet.');
  showSavedReading();
}

function loadHistory(preferred) {
  try {
    savedReadings = listReadings(localStorage);
    renderHistory(preferred);
  } catch {
    savedReadings = [];
    renderHistory();
    status('history-status', 'Browser storage is unavailable.', 'error');
  }
}

function persistReading(reading, statusId) {
  let key;
  try {
    key = saveReading(localStorage, reading);
  } catch {
    status(statusId, 'Could not save this reading. Browser storage may be unavailable or full.', 'error');
    return false;
  }
  if (historyMode.value && historyMode.value !== reading.modeId) historyMode.value = '';
  if (historyEcu.value && historyEcu.value !== reading.ecu) historyEcu.value = '';
  status(statusId, 'Saved on this device.', 'ready');
  loadHistory(key);
  return true;
}

saveButton.addEventListener('click', () => {
  if (pendingReading && !saveButton.disabled && persistReading(pendingReading, 'save-status')) {
    saveButton.disabled = true;
  }
});

historyMode.addEventListener('change', () => renderHistory());
historyEcu.addEventListener('change', () => renderHistory());
historyList.addEventListener('click', ({ target }) => {
  const button = target.closest('button[data-reading]');
  if (!button) return;
  selectedHistoryKey = button.dataset.reading;
  for (const item of historyList.querySelectorAll('button')) item.setAttribute('aria-current', String(item === button));
  showSavedReading();
  element('history-result-title').focus();
});
historyBaseline.addEventListener('change', showScanComparison);
function downloadFile(file) {
  if (!file) return;
  const url = URL.createObjectURL(new Blob([file.contents], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}
sessionDownload.addEventListener('click', () => downloadFile(sessionTraceFile(latestSessionTrace)));
element('history-download').addEventListener('click', () => {
  const reading = savedReadings.find(({ key }) => key === selectedHistoryKey);
  downloadFile(rawExchangeFile(reading));
});
element('history-copy').addEventListener('click', async () => {
  const key = selectedHistoryKey;
  const reading = savedReadings.find(item => item.key === key);
  const replies = savedRawReplies(reading);
  if (!replies.length) return;
  const copyText = replies.join('\n');
  try {
    await navigator.clipboard.writeText(copyText);
    if (selectedHistoryKey === key) status('history-copy-status', 'Raw replies copied.', 'ready');
  } catch {
    if (selectedHistoryKey !== key) return;
    const fallback = element('history-raw-copy');
    fallback.value = copyText;
    fallback.hidden = false;
    element('history-raw').open = true;
    fallback.focus();
    fallback.select();
    status('history-copy-status', 'Use your device’s Copy action on the selected replies.');
  }
});
window.addEventListener('storage', ({ key }) => {
  if (key === sessionTraceKey || key === null) {
    if (!session) {
      restoreSessionTrace();
      renderSessionTrace();
    }
    if (key === sessionTraceKey) return;
  }
  loadHistory();
});
window.addEventListener('pagehide', () => {
  if (session) persistSessionTrace();
});
element('delete-reading').addEventListener('click', () => {
  const key = selectedHistoryKey;
  if (!key || !window.confirm('Delete this saved reading?')) return;
  try {
    deleteReading(localStorage, key);
  } catch {
    status('history-status', 'Could not delete this reading from browser storage.', 'error');
    return;
  }
  loadHistory();
});
loadHistory();
restoreSessionTrace();
psaView = mountPsaView({ element, status, renderValues, runOperation, persistReading, downloadFile, reportVehicleReply, renderReadTime });

if (!canConnect) {
  status('connection-status', globalThis.isSecureContext ?
    'Web Bluetooth unavailable. Open this page in Bluefy on your iPhone.' :
    'Bluetooth requires HTTPS or a trusted local address.', 'error');
}
showMode();

async function prepareOffline() {
  if (!navigator.serviceWorker) {
    status('offline', 'Offline cache unavailable');
    return;
  }
  try {
    const registration = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
    if (!registration.active) {
      await waitForWorker(registration.installing || registration.waiting, ['activated']);
    }
    offlineRegistration = registration;
    status('offline', 'App cached');
  } catch {
    status('offline', 'Offline setup failed');
  }
  renderControls();
}

function waitForWorker(worker, states) {
  if (!worker) return Promise.reject(new Error('The app update worker is unavailable.'));
  if (states.includes(worker.state)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    function finish(error) {
      clearTimeout(timeout);
      worker.removeEventListener('statechange', check);
      if (error) reject(error);
      else resolve();
    }
    function check() {
      if (states.includes(worker.state)) finish();
      else if (worker.state === 'redundant') finish(new Error('The app update could not be installed.'));
    }
    const timeout = setTimeout(() => finish(new Error('The app update took too long.')), 45000);
    worker.addEventListener('statechange', check);
    check();
  });
}

function refreshCachedFiles(worker) {
  return new Promise((resolve, reject) => {
    const { port1, port2 } = new MessageChannel();
    function finish(error) {
      clearTimeout(timeout);
      port1.close();
      if (error) reject(error);
      else resolve();
    }
    const timeout = setTimeout(() => finish(new Error('Refreshing app files took too long.')), 45000);
    port1.onmessage = ({ data }) => finish(data?.ok ? null : new Error('App files could not be refreshed.'));
    try {
      worker.postMessage('refresh-files', [port2]);
    } catch (error) {
      finish(error);
    }
  });
}

refreshButton.addEventListener('click', async () => {
  if (busy || !offlineRegistration) return;
  const registration = offlineRegistration;
  const previous = registration.active;
  busy = true;
  renderControls();
  status('offline', 'Refreshing app…');
  try {
    await registration.update();
    const worker = registration.installing || registration.waiting;
    if (worker) {
      await waitForWorker(worker, ['installed', 'activating', 'activated']);
      if (worker.state === 'installed') worker.postMessage('activate-update');
      await waitForWorker(worker, ['activated']);
    } else if (registration.active === previous) {
      await refreshCachedFiles(registration.active);
    }
    window.location.reload();
  } catch {
    status('offline', navigator.onLine ? 'Refresh failed · app cached' : 'Offline · app cached');
  } finally {
    busy = false;
    renderControls();
  }
});
prepareOffline();
