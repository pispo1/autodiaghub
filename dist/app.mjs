import { chooseAdapter, openAdapter } from './ble.mjs';
import { readAdapterHealth, readStoredCodes } from './obd.mjs';

const element = (id) => document.getElementById(id);
const connect = element('connect');
const disconnect = element('disconnect');
const health = element('health');
const scan = element('scan');
const service = element('service');
const codes = element('codes');

const canConnect = Boolean(globalThis.isSecureContext && navigator.bluetooth?.requestDevice);
let session;
let busy = false;

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
  scan.disabled = busy || !session;
}

function resetReadings() {
  element('firmware').textContent = '—';
  element('voltage').textContent = '—';
  element('vehicle').textContent = 'Not checked';
  element('protocol').textContent = '—';
  codes.replaceChildren();
  codes.hidden = true;
  status('health-status', 'Connect an adapter to check its health.');
  status('scan-status', 'Connect an adapter to read codes.');
}

function showDisconnected(endedSession, error) {
  if (session !== endedSession) return;
  session = undefined;
  resetReadings();
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
    if (session === active) status(target, error.message || 'The request failed.', 'error');
  } finally {
    busy = false;
    renderControls();
  }
}

async function checkHealth() {
  await runOperation('health-status', 'Checking adapter…', async (active) => {
    element('firmware').textContent = '—';
    element('voltage').textContent = '—';
    const result = await readAdapterHealth(active);
    if (session !== active) return;
    element('firmware').textContent = result.firmware;
    element('voltage').textContent = result.voltage || 'Unavailable';
    status('health-status', 'Adapter responded.', 'ready');
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
    status('scan-status', 'Ready to read stored codes.');
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
  await checkHealth();
});

disconnect.addEventListener('click', () => {
  const active = session;
  active?.close();
  showDisconnected(active);
});

health.addEventListener('click', checkHealth);
scan.addEventListener('click', () => runOperation('scan-status', 'Reading stored codes…', async (active) => {
  codes.replaceChildren();
  codes.hidden = true;
  element('vehicle').textContent = 'Checking…';
  element('protocol').textContent = '—';

  let result;
  try {
    result = await readStoredCodes(active);
  } catch (error) {
    if (session === active) element('vehicle').textContent = 'Read failed';
    throw error;
  }
  if (session !== active) return;
  element('vehicle').textContent = 'Responded';
  element('protocol').textContent = result.protocol;
  const count = result.codes.length;
  const message = count === 0 ? 'No stored trouble codes returned.' :
    count + (count === 1 ? ' stored trouble code found.' : ' stored trouble codes found.');
  for (const code of result.codes) {
    const item = document.createElement('li');
    const value = document.createElement('code');
    value.textContent = code;
    item.append(value);
    codes.append(item);
  }
  codes.hidden = count === 0;
  status('scan-status', message, 'ready');
}));

if (!canConnect) {
  status('connection-status', globalThis.isSecureContext ?
    'Web Bluetooth unavailable. Open this page in Bluefy on your iPhone.' :
    'Bluetooth requires HTTPS or a trusted local address.', 'error');
}
renderControls();

async function prepareOffline() {
  if (!navigator.serviceWorker) {
    status('offline', 'Offline cache unavailable');
    return;
  }
  try {
    await navigator.serviceWorker.register('./sw.js');
    await navigator.serviceWorker.ready;
    status('offline', 'App cached');
  } catch {
    status('offline', 'Offline setup failed');
  }
}
prepareOffline();
