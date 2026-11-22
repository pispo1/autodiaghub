import { chooseAdapter, openAdapter } from './ble.mjs';
import { readAdapterHealth, readVehicleHealth } from './obd.mjs';
import { identifierName, modes, readGeneralOBD } from './modes.mjs';
import { deleteReading, listReadings, makeReading, saveReading, trendFor } from './history.mjs';
import { mountPsaView } from './psa-view.mjs';

const element = (id) => document.getElementById(id);
const connect = element('connect');
const disconnect = element('disconnect');
const health = element('health');
const scan = element('scan');
const discover = element('discover');
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
const historyMode = element('history-mode');
const historyPicker = element('history-reading');
const historyDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
const currentMode = () => modes.find(({ id }) => id === modePicker.value);

for (const mode of modes) {
  const label = '$' + mode.id + ' · ' + mode.title;
  modePicker.add(new Option(label, mode.id));
  if (!mode.infoOnly) historyMode.add(new Option(label, mode.id));
}
historyMode.add(new Option('PSA ECU snapshots', 'PSA'));
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
let psaView;
let offlineRegistration;

function status(id, message, tone = 'idle') {
  const field = element(id);
  field.textContent = message;
  field.dataset.tone = tone;
}

function renderControls() {
  connect.hidden = Boolean(session);
  connect.disabled = busy || !canConnect;
  service.disabled = busy || Boolean(session);
  disconnect.hidden = !session;
  health.disabled = busy || !session;
  refreshButton.disabled = busy || !offlineRegistration;
  const mode = currentMode();
  scan.disabled = busy || !session || mode.infoOnly;
  discover.disabled = busy || !session || !mode.identifier;
  for (const field of [modePicker, identifier, frame, sensor, supportedPicker]) field.disabled = busy;
  psaView?.update(Boolean(session), busy);
}

function clearScanResults() {
  codes.replaceChildren();
  codes.hidden = true;
  values.replaceChildren();
  values.hidden = true;
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
  scan.textContent = mode.troubleCodes ? 'Read ' + mode.title.toLowerCase() : 'Read value';
  clearScanResults();
  clearSupported();
  showScanPrompt();
  renderControls();
}

function resetReadings() {
  element('firmware').textContent = '—';
  element('adapter-id').textContent = '—';
  element('voltage').textContent = '—';
  element('vehicle').textContent = 'Not checked';
  element('protocol').textContent = '—';
  element('vehicle-reply').textContent = '—';
  clearScanResults();
  clearSupported();
  status('health-status', 'Connect an adapter to check its health.');
  showScanPrompt();
}

function showDisconnected(endedSession, error) {
  if (session !== endedSession) return;
  session = undefined;
  resetReadings();
  psaView.reset();
  status('connection-status', error?.message || 'Adapter disconnected', error ? 'error' : 'idle');
  renderControls();
}

async function runOperation(target, pendingMessage, operation) {
  if (busy || !session) return;
  const active = session;
  busy = true;
  renderControls();
  status(target, pendingMessage);
  try {
    await operation(active);
  } catch (error) {
    if (session === active) {
      const tone = error.kind === 'unsupported' || error.kind === 'unconfirmed' ? 'idle' : 'error';
      status(target, error.message || 'The request failed.', tone);
    }
  } finally {
    busy = false;
    renderControls();
  }
}

async function checkHealth(includeVehicle) {
  await runOperation('health-status', 'Checking adapter…', async (active) => {
    const result = await readAdapterHealth(active);
    if (session !== active) return;
    element('firmware').textContent = result.version || 'Not reported';
    element('adapter-id').textContent = result.identification || 'No identification returned';
    element('voltage').textContent = result.voltage || 'Not reported';
    const adapterComplete = Boolean(result.version && result.voltage);
    if (!includeVehicle) {
      status('health-status', adapterComplete ? 'Check the vehicle to detect its OBD protocol.' :
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
    session = await openAdapter(selected, showDisconnected);
    status('connection-status', 'Connected to ' + session.name, 'ready');
    status('health-status', 'Ready to check the adapter.');
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
  active?.close();
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
    const count = result.supported.length;
    const message = count === 0 ? 'No supported data identifiers reported.' :
      count + (count === 1 ? ' supported identifier reported.' : ' supported identifiers reported.');
    status('scan-status', [message, result.note].filter(Boolean).join(' '), result.note ? 'idle' : 'ready');
    return;
  }
  renderValues(values, result.rows);
  status('scan-status', 'Read complete.', 'ready');
}

function runScan(findSupported) {
  const mode = currentMode();
  if (mode.infoOnly) return;
  const selection = {
    modeId: mode.id,
    identifier: identifier.value.trim().toUpperCase(),
    extra: mode.id === '05' ? sensor.value : frame.value.trim().toUpperCase(),
    discover: findSupported,
  };
  const message = findSupported ? 'Finding supported identifiers…' : 'Reading mode $' + mode.id + '…';
  return runOperation('scan-status', message, async (active) => {
    clearScanResults();
    if (findSupported) clearSupported();
    const vehicle = element('vehicle');
    const previousVehicleState = vehicle.textContent;
    vehicle.textContent = 'Checking…';
    let result;
    try {
      result = await readGeneralOBD(active, selection);
    } catch (error) {
      if (session === active) {
        vehicle.textContent = error.kind === 'unsupported' ? 'Responded' : previousVehicleState;
      }
      throw error;
    }
    if (session !== active) return;
    vehicle.textContent = 'Responded';
    element('protocol').textContent = result.protocol;
    displayResult(result, mode);
    pendingReading = makeReading(selection, result);
    element('save-actions').hidden = !pendingReading;
  });
}

scan.addEventListener('click', () => runScan(false));
discover.addEventListener('click', () => runScan(true));

function readingLabel(reading) {
  if (reading.modeId === 'PSA') {
    return [reading.vehicle, reading.variant, reading.ecu, reading.model].join(' · ');
  }
  const mode = modes.find(({ id }) => id === reading.modeId);
  const name = reading.identifier && identifierName(mode.id, Number.parseInt(reading.identifier, 16));
  const parts = ['$' + mode.id + ' ' + mode.title];
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

function showSavedReading() {
  const selected = savedReadings.find(({ key }) => key === historyPicker.value);
  element('history-result').hidden = !selected;
  if (!selected) return;
  const label = [readingLabel(selected), selected.protocol];
  if (selected.codes?.length === 0) label.push('No trouble codes returned');
  element('history-meta').textContent = label.join(' · ');
  renderCodes(element('history-codes'), selected.codes);
  renderValues(element('history-values'), selected.rows);
  drawTrend(trendFor(savedReadings, selected));
}

function renderHistory(preferred = historyPicker.value) {
  const filtered = savedReadings.filter(({ modeId }) => !historyMode.value || modeId === historyMode.value);
  historyPicker.replaceChildren();
  for (const reading of filtered) {
    const label = historyDate.format(reading.time) + ' · ' + readingLabel(reading);
    historyPicker.add(new Option(label, reading.key));
  }
  if (filtered.some(({ key }) => key === preferred)) historyPicker.value = preferred;
  historyPicker.disabled = filtered.length === 0;
  element('history-controls').hidden = savedReadings.length === 0;
  status('history-status', filtered.length ? '' :
    savedReadings.length ? 'No saved readings for this mode.' : 'No saved readings yet.');
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
historyPicker.addEventListener('change', showSavedReading);
window.addEventListener('storage', () => loadHistory());
element('delete-reading').addEventListener('click', () => {
  const key = historyPicker.value;
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
psaView = mountPsaView({ element, status, renderValues, runOperation, persistReading });

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
