import { makePsaReading, makePsaScan, rawExchangeFile, scanStateLabels, scanSummary, traceSession } from './history.mjs';
import { clearPsaDtcs, ecuIdentificationIds, formatHex, readPsaDtcs, readPsaParameters, scanPsaEcus } from './psa.mjs';

const selectionKey = 'autodiaghub:psa-selection:v1';
const searchText = (value) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const architecturePinoutSource = 'https://github.com/ludwig-v/arduino-psa-diag#pinout';
const readableHex = (payload) => payload.match(/../g)?.join(' ') || payload;

export function renderPsaExplanations(container, explanations = [], renderValues) {
  container.replaceChildren();
  for (const { id, request, response, fields, note } of explanations) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = (fields?.length ? 'How $' + id + ' was decoded' : 'Response details for $' + id);
    const list = document.createElement('dl');
    const rows = [{ label: 'Request', value: readableHex(request) }];
    if (response) rows.push({ label: 'Response payload', value: readableHex(response) });
    if (fields) rows.push(...fields);
    if (note) rows.push({ label: 'Result', value: note });
    renderValues(list, rows);
    details.append(summary, list);
    container.append(details);
  }
  container.hidden = explanations.length === 0;
}

export function diagnosticPinout(vehicleCode, { id, architecture }) {
  const psaCan = 'PSA diagnostic CAN uses vehicle pin 3 (CAN High) and pin 8 (CAN Low).';
  if (vehicleCode === 'B58' && id === 'picasso') {
    return { text: psaCan, source: 'https://citroens-club.ru/applications/core/interface/file/attachment.php?id=94208' };
  }
  if (vehicleCode === 'B78' && id === 'phase1') {
    return { text: psaCan, source: 'https://diagnostdata.com/citroen/c4-picasso/ii-2013-2016/remont/general-points/general-points/presentation-multiplexed-structure-aee2010-full/' };
  }
  const family = architecture.split('.')[0];
  if (family === 'AEE2004' || family === 'AEE2010') {
    return { text: psaCan + ' This is architecture-level guidance. Confirm the pinout for your exact variant.',
      source: architecturePinoutSource };
  }
  if (family === 'NEA2020') {
    return { text: 'The NEA2020 reference lists diagnostic CAN on vehicle pin 6 (CAN High) and pin 14 (CAN Low). Confirm the pinout for your exact variant.',
      source: architecturePinoutSource };
  }
  return { text: 'No documented pinout is available in the app for this variant. Check the vehicle wiring diagram.' };
}

export function mountPsaView({ element, status, renderValues, runOperation, persistReading, downloadFile, reportVehicleReply, renderReadTime }) {
  const section = element('psa-section');
  const vehiclePicker = element('psa-vehicle');
  const vehicleSearch = element('psa-vehicle-search');
  const variantPicker = element('psa-variant');
  const ecuPicker = element('psa-ecu');
  const modelPicker = element('psa-model');
  const parameterSearch = element('psa-parameter-search');
  const parameterList = element('psa-parameters');
  const selectedParameters = new Set();
  const scanButton = element('psa-scan');
  const includeFaults = element('psa-include-faults');
  const stopScan = element('psa-stop-scan');
  const progress = element('psa-progress');
  const responderList = element('psa-responders');
  const resultFilters = element('psa-result-filters');
  const retryButton = element('psa-retry');
  const ecuTitle = element('psa-ecu-title');
  const saveScan = element('psa-save-scan');
  const downloadScan = element('psa-download-scan');
  const parameterButton = element('psa-read-parameter');
  const clearSelection = element('psa-clear-selection');
  const identifyButton = element('psa-identify');
  const dtcButton = element('psa-read-dtcs');
  const clearButton = element('psa-clear-dtcs');
  const confirmClear = element('psa-confirm-clear');
  const cancelClear = element('psa-cancel-clear');
  const saveButton = element('psa-save');
  const results = new Map();
  const verifiedEcus = new Set();
  const catalogRows = new Map();
  let catalog;
  let selectedVariant;
  let connected = false;
  let busy = false;
  let loading = false;
  let pendingReading;
  let pendingScan;
  let scanning = false;
  let stopRequested = false;
  let dtcsRead = false;
  let readTime;
  let previousConnection = false;
  let resultFilter = 'detected';

  function currentEcu() {
    return selectedVariant?.ecus.find(({ id }) => id === ecuPicker.value);
  }

  function currentModel() {
    return catalog?.models[modelPicker.value];
  }

  function canRead() {
    return verifiedEcus.has(ecuPicker.value) && results.get(ecuPicker.value)?.modelKeys.includes(modelPicker.value);
  }

  function update(isConnected, isBusy) {
    connected = isConnected;
    busy = isBusy;
    scanButton.disabled = !connected || busy || !selectedVariant?.scanAvailable;
    parameterButton.disabled = !connected || busy || !canRead() || selectedParameters.size === 0;
    clearSelection.disabled = busy || selectedParameters.size === 0;
    const result = results.get(ecuPicker.value);
    retryButton.hidden = !result || (result.state === 'detected' && verifiedEcus.has(ecuPicker.value));
    retryButton.disabled = !connected || busy || retryButton.hidden;
    identifyButton.disabled = !connected || busy || !canRead();
    dtcButton.disabled = !connected || busy || !canRead() || !currentModel()?.readDtcs;
    clearButton.disabled = dtcButton.disabled || !dtcsRead || !currentModel()?.clearDtcs;
    clearButton.hidden = !dtcsRead || !currentModel()?.clearDtcs;
    confirmClear.disabled = clearButton.disabled;
    for (const picker of [vehiclePicker, vehicleSearch, ecuPicker, modelPicker, includeFaults, element('psa-parameter-field')]) {
      picker.disabled = busy;
    }
    for (const button of responderList.querySelectorAll('button')) button.disabled = busy;
    variantPicker.disabled = busy || !vehiclePicker.value;
    if (previousConnection && readTime !== undefined) {
      renderReadTime('psa-read-time', readTime, connected ? 'Previous connection' : 'Last reading · disconnected');
    }
  }

  function currentStatus(ecu) {
    const result = results.get(ecu.id);
    if (result) return scanStateLabels[result.state];
    return ecu.models.length ? 'Ready to scan' : 'Catalog only';
  }

  function showParameterCount(matches) {
    const count = selectedParameters.size;
    element('psa-parameter-count').textContent = matches + ' matching parameters';
    element('psa-selected-count').textContent = count + ' selected';
  }

  function showParameters() {
    const query = parameterSearch.value.trim().toLowerCase();
    const parameters = currentModel()?.parameters || [];
    const visible = parameters.filter(({ id, name }) =>
      name?.toLowerCase().includes(query) || ('$' + id).toLowerCase().includes(query));
    parameterList.replaceChildren();
    for (const { id, name } of visible) {
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = id;
      checkbox.checked = selectedParameters.has(id);
      label.append(checkbox, '$' + id + ' · ' + name);
      parameterList.append(label);
    }
    showParameterCount(visible.length);
  }

  function clearResult() {
    readTime = undefined;
    previousConnection = false;
    renderReadTime('psa-read-time');
    renderValues(element('psa-values'));
    renderPsaExplanations(element('psa-explanations'), [], renderValues);
    pendingReading = undefined;
    element('psa-save-actions').hidden = true;
    saveButton.disabled = false;
    status('psa-save-status', '');
  }

  function hideConfirmation() {
    element('psa-clear-confirmation').hidden = true;
  }

  function markLastReading() {
    if (readTime !== undefined) renderReadTime('psa-read-time', readTime, 'Last reading');
  }

  function showModel() {
    const model = currentModel();
    selectedParameters.clear();
    parameterSearch.value = '';
    showParameters();
    element('psa-parameter-field').hidden = !model?.parameters.length;
    parameterButton.hidden = !model?.parameters.length;
    identifyButton.hidden = !ecuIdentificationIds(model).length;
    dtcButton.hidden = !model?.readDtcs;
    element('psa-parameter-details').hidden = !model?.parameters.length;
    element('psa-parameter-details').open = false;
    dtcButton.textContent = 'Read fault codes';
    dtcsRead = false;
    hideConfirmation();
    element('psa-read').hidden = !canRead() || (!model?.parameters.length && !model?.readDtcs);
    clearResult();
    status('psa-read-status', '');
    update(connected, busy);
  }

  function showSnapshot(rows, exchanges, explanations) {
    const vehicle = catalog.vehicles.find(({ code }) => code === vehiclePicker.value);
    const selected = modelPicker.selectedOptions[0];
    const ecu = currentEcu();
    renderValues(element('psa-values'), rows);
    renderPsaExplanations(element('psa-explanations'), explanations, renderValues);
    readTime = Date.now();
    previousConnection = false;
    renderReadTime('psa-read-time', readTime, 'Read at');
    pendingReading = makePsaReading({
      vehicle: vehicle.code,
      variant: selectedVariant.label,
      ecu: ecu.name + ' (' + ecu.id + ')',
      model: ecu.models.find(({ key }) => key === selected.value).name,
      protocol: currentModel().protocol,
      exchanges,
      explanations,
    }, rows, readTime);
    element('psa-save-actions').hidden = !pendingReading;
  }

  function showFaults(faults, exchanges) {
    const rows = faults.map(({ code, description, status: dtcStatus, flags }) => ({
      label: code,
      value: [description, flags?.join(', '), 'Status $' + dtcStatus].filter(Boolean).join(' · '),
    }));
    if (!rows.length) rows.push({ label: 'Trouble codes', value: 'No matching DTCs returned' });
    showSnapshot(rows, exchanges);
  }

  function showEcu() {
    const ecu = currentEcu();
    ecuTitle.hidden = !ecu;
    element('psa-ecu-details').hidden = !ecu;
    element('psa-ecu-details').open = false;
    element('psa-model-field').hidden = true;
    status('psa-retry-status', '');
    if (!ecu) {
      modelPicker.replaceChildren();
      element('psa-ecu-info').textContent = '';
      status('psa-ecu-response', '');
      renderValues(element('psa-identification'));
      showModel();
      return;
    }
    ecuTitle.textContent = ecu.name;
    const result = results.get(ecu.id);
    const metadata = [
      currentStatus(ecu),
      ecu.networks.join(', '),
      ecu.optional ? 'Optional equipment' : '',
      ecu.modelNames.length ? 'Catalog models ' + ecu.modelNames.join(', ') : '',
    ].filter(Boolean);
    element('psa-ecu-info').textContent = metadata.join(' · ');
    const replies = result?.replies.map(({ request, data }) => ({
      label: 'Identification $' + request, value: formatHex(data),
    })) || [];
    if (result?.state === 'rejected') {
      replies.push({ label: 'Negative response code', value: '$' + result.rejected.toString(16).toUpperCase().padStart(2, '0') });
    }
    const routes = new Set(ecu.models.filter(({ key }) => result?.modelKeys.includes(key)).map(({ key }) => {
      const { requestId, responseId } = catalog.models[key];
      return '$' + requestId + ' → $' + responseId;
    }));
    if (routes.size) replies.unshift({ label: 'CAN request → reply', value: [...routes].join(', ') });
    status('psa-ecu-response', result?.state === 'detected'
      ? [verifiedEcus.has(ecu.id) ? 'Responded' : 'Responded on previous connection', ...routes, 'Model unconfirmed'].join(' · ')
      : result ? currentStatus(ecu) : '', result?.state === 'detected' ? 'ready' : 'idle');
    renderValues(element('psa-identification'), replies);

    const selection = modelPicker.value;
    modelPicker.replaceChildren();
    const eligible = ecu.models.filter(({ key }) => result?.modelKeys.includes(key));
    modelPicker.add(new Option('Choose the ECU model fitted to your car', ''));
    for (const model of eligible) {
      modelPicker.add(new Option(model.name + ' · ' + catalog.models[model.key].protocol, model.key));
    }
    if (eligible.length === 1) modelPicker.value = eligible[0].key;
    else if (eligible.some(({ key }) => key === selection)) modelPicker.value = selection;
    element('psa-model-field').hidden = eligible.length < 2;
    showModel();
  }

  function reset() {
    results.clear();
    verifiedEcus.clear();
    resultFilter = 'detected';
    responderList.replaceChildren();
    element('psa-responding').hidden = true;
    if (!selectedVariant) return;
    if (selectedVariant.scanAvailable) ecuPicker.selectedIndex = -1;
    for (const ecu of selectedVariant.ecus) {
      catalogRows.get(ecu.id).textContent = currentStatus(ecu);
    }
    status('psa-status', '');
    showEcu();
  }

  function disconnectSession() {
    verifiedEcus.clear();
    dtcsRead = false;
    previousConnection = true;
    hideConfirmation();
    const current = element('psa-ecu-response').textContent;
    if (current.startsWith('Responded ·')) {
      status('psa-ecu-response', current.replace('Responded ·', 'Responded on previous connection ·'));
    }
  }

  function renderScanResults() {
    element('psa-responding').hidden = !results.size;
    responderList.replaceChildren();
    const labels = { detected: 'Responded', rejected: 'Rejected', 'no-reply': 'No reply', invalid: 'Invalid reply' };
    const counts = { detected: 0, rejected: 0, 'no-reply': 0, invalid: 0 };
    for (const [id, result] of results) {
      counts[result.state]++;
      if (result.state !== resultFilter) continue;
      const ecu = selectedVariant.ecus.find(ecu => ecu.id === id);
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.ecu = id;
      button.disabled = busy;
      button.textContent = ecu.name;
      item.append(button);
      responderList.append(item);
    }
    for (const button of resultFilters.querySelectorAll('button')) {
      const state = button.dataset.state;
      button.textContent = labels[state] + ' · ' + counts[state];
      button.setAttribute('aria-pressed', String(resultFilter === state));
      button.hidden = state === 'invalid' && !counts.invalid && resultFilter !== state;
    }
    status('psa-filter-status', responderList.children.length ? '' : 'No results in this group.');
  }

  function storeScanResult(ecu, result) {
    results.set(ecu.id, result);
    verifiedEcus.add(ecu.id);
    catalogRows.get(ecu.id).textContent = currentStatus(ecu);
    if (result.state === 'detected' || result.state === 'rejected') reportVehicleReply();
    renderScanResults();
  }

  function selectVariant() {
    try {
      localStorage.setItem(selectionKey, JSON.stringify({ vehicle: vehiclePicker.value, variant: variantPicker.value }));
    } catch {
      // Browsing the catalog also works when browser storage is unavailable.
    }
    const vehicle = catalog.vehicles.find(({ code }) => code === vehiclePicker.value);
    selectedVariant = vehicle?.variants.find(({ id }) => id === variantPicker.value);
    pendingScan = undefined;
    element('psa-scan-save-actions').hidden = true;
    progress.hidden = true;
    status('psa-scan-save-status', '');
    if (!selectedVariant) {
      results.clear();
      element('psa-vehicle-data').hidden = true;
      update(connected, busy);
      return;
    }
    const pinout = diagnosticPinout(vehicle.code, selectedVariant);
    element('psa-pinout').textContent = pinout.text;
    const reference = element('psa-pinout-source');
    reference.hidden = !pinout.source;
    if (pinout.source) reference.href = pinout.source;
    else reference.removeAttribute('href');
    ecuPicker.replaceChildren();
    catalogRows.clear();
    const list = element('psa-ecu-list');
    list.replaceChildren();
    for (const ecu of selectedVariant.ecus) {
      const name = ecu.name + ' (' + ecu.id + ')';
      ecuPicker.add(new Option(name, ecu.id));
      const item = document.createElement('div');
      const label = document.createElement('dt');
      const value = document.createElement('dd');
      label.textContent = name;
      item.append(label, value);
      list.append(item);
      catalogRows.set(ecu.id, value);
    }
    const hasInventory = selectedVariant.ecus.length > 0;
    element('psa-ecu-catalog').hidden = !hasInventory;
    element('psa-ecu-selection').hidden = !hasInventory;
    element('psa-empty-catalog').hidden = hasInventory;
    element('psa-scan-options').hidden = !selectedVariant.scanAvailable;
    const architecture = selectedVariant.architecture === 'none' ?
      'Architecture unavailable' : selectedVariant.architecture;
    element('psa-profile').textContent = [architecture, selectedVariant.years,
      selectedVariant.scanAvailable ? 'Scan available' : 'Catalog only'].filter(Boolean).join(' · ');
    element('psa-vehicle-data').hidden = false;
    reset();
  }

  function selectVehicle(savedVariant = '') {
    const vehicle = catalog.vehicles.find(({ code }) => code === vehiclePicker.value);
    const aliases = vehicle?.aliases.filter((name) => name !== vehicle.name) || [];
    element('psa-aliases').textContent = aliases.length ? 'Also listed as ' + aliases.join(', ') : '';
    variantPicker.replaceChildren();
    if (!vehicle || vehicle.variants.length > 1) {
      variantPicker.add(new Option('Choose a vehicle variant', ''));
    }
    for (const variant of vehicle?.variants || []) {
      const availability = variant.scanAvailable ? 'Scan available' : 'Catalog only';
      variantPicker.add(new Option([variant.label, variant.years, availability].filter(Boolean).join(' · '), variant.id));
    }
    if (vehicle?.variants.some(({ id }) => id === savedVariant)) variantPicker.value = savedVariant;
    selectVariant();
  }

  function showVehicles(preferred = vehiclePicker.value) {
    const query = searchText(vehicleSearch.value).trim().split(/\s+/).filter(Boolean);
    const matchesQuery = (text) => {
      const searchable = searchText(text);
      return query.every((word) => searchable.includes(word));
    };
    const matches = catalog.vehicles.filter(({ code, name, aliases, projectCodes }) => {
      return matchesQuery([code, name, ...aliases, ...projectCodes].join(' '));
    });
    vehiclePicker.replaceChildren(new Option('Choose a vehicle', ''));
    for (const { code, name, aliases } of matches) {
      const label = matchesQuery(name) ? name : aliases.find(matchesQuery) || name;
      vehiclePicker.add(new Option(label + ' · ' + code, code));
    }
    if (preferred && !matches.some(({ code }) => code === preferred)) {
      const selected = catalog.vehicles.find(({ code }) => code === preferred);
      if (selected) vehiclePicker.add(new Option(selected.name + ' · Current selection', selected.code));
    }
    if (Array.from(vehiclePicker.options).some(({ value }) => value === preferred)) {
      vehiclePicker.value = preferred;
    }
    status('psa-vehicle-matches', query.length ? matches.length +
      (matches.length === 1 ? ' matching vehicle group' : ' matching vehicle groups') : '');
  }

  async function loadCatalog() {
    if (!section.open || catalog || loading) return;
    loading = true;
    status('psa-source-status', 'Loading the PSA-RE vehicle catalog…');
    try {
      const response = await fetch(new URL('./psa/catalog.json', import.meta.url));
      if (!response.ok) throw new Error('Catalog unavailable');
      const data = await response.json();
      catalog = data;
      element('psa-upstream').href = 'https://github.com/prototux/PSA-RE/tree/' + catalog.revision;
      let saved;
      try {
        saved = JSON.parse(localStorage.getItem(selectionKey));
      } catch {
        // An unavailable store or invalid entry leaves the vehicle picker at its default.
      }
      showVehicles(saved?.vehicle);
      selectVehicle(saved?.variant);
      element('psa-controls').hidden = false;
      status('psa-source-status', '');
    } catch {
      vehiclePicker.replaceChildren();
      catalog = undefined;
      status('psa-source-status', 'The PSA-RE catalog could not load. Close and reopen PSA Diagnostics to retry.', 'error');
    } finally {
      loading = false;
    }
  }

  section.addEventListener('toggle', loadCatalog);
  vehicleSearch.addEventListener('input', () => showVehicles());
  vehiclePicker.addEventListener('change', () => selectVehicle());
  variantPicker.addEventListener('change', selectVariant);
  ecuPicker.addEventListener('change', showEcu);
  modelPicker.addEventListener('change', showModel);
  parameterSearch.addEventListener('input', showParameters);
  parameterList.addEventListener('change', ({ target }) => {
    if (target.checked) selectedParameters.add(target.value);
    else selectedParameters.delete(target.value);
    showParameterCount(parameterList.children.length);
    update(connected, busy);
  });
  clearSelection.addEventListener('click', () => {
    selectedParameters.clear();
    showParameters();
    update(connected, busy);
  });
  resultFilters.addEventListener('click', ({ target }) => {
    const button = target.closest('button[data-state]');
    if (!button) return;
    resultFilter = button.dataset.state;
    renderScanResults();
  });

  scanButton.addEventListener('click', () => {
    if (scanButton.disabled) return;
    reset();
    const variant = selectedVariant;
    const total = variant.ecus.filter(({ models }) => models.length).length;
    const report = {
      vehicle: vehiclePicker.value, variant: variant.label, variantId: variant.id,
      adapter: element('adapter-id').textContent, firmware: element('firmware').textContent,
      includeFaults: includeFaults.checked, total, ecus: [], time: Date.now(),
    };
    pendingScan = undefined;
    element('psa-scan-save-actions').hidden = true;
    status('psa-scan-save-status', '');
    stopRequested = false;
    scanning = true;
    stopScan.hidden = false;
    stopScan.disabled = false;
    progress.max = total;
    progress.value = 0;
    progress.hidden = false;
    runOperation('psa-status', 'Scanning ECUs · ' + scanSummary(report), async (session) => {
      const traced = traceSession(session);
      let nextExchange = 0;
      let outcome = 'interrupted';
      try {
        await scanPsaEcus(traced, variant, catalog.models, (id, result) => {
          const ecu = variant.ecus.find(ecu => ecu.id === id);
          report.ecus.push({ id, name: ecu.name, ...result, exchangeStart: nextExchange, exchangeEnd: traced.exchanges.length });
          nextExchange = traced.exchanges.length;
          if (!connected) return;
          storeScanResult(ecu, result);
          progress.value = report.ecus.length;
          status('psa-status', (stopRequested ? 'Stopping · ' : '') + scanSummary(report));
        }, { shouldStop: () => stopRequested, includeFaults: report.includeFaults });
        outcome = report.ecus.length === total ? 'complete' : 'stopped';
        if (connected) {
          showEcu();
          status('psa-status', (outcome === 'stopped' ? 'Stopped · ' : 'Scan complete · ') + scanSummary(report), 'ready');
        }
      } catch (error) {
        report.error = error.message;
        if (connected) showEcu();
        status('psa-status', 'Scan interrupted · ' + scanSummary(report) + '. ' + report.error, 'error');
      } finally {
        scanning = false;
        stopScan.hidden = true;
        if (traced.exchanges.length) {
          pendingScan = makePsaScan({ ...report, outcome, exchanges: traced.exchanges });
          saveScan.disabled = false;
          downloadScan.hidden = !pendingScan;
          element('psa-scan-save-actions').hidden = !pendingScan;
        }
      }
    });
  });

  responderList.addEventListener('click', ({ target }) => {
    const id = target.closest('button[data-ecu]')?.dataset.ecu;
    if (!id || busy) return;
    ecuPicker.value = id;
    showEcu();
    if (results.get(id)?.state === 'rejected') element('psa-ecu-details').open = true;
    ecuTitle.focus();
    ecuTitle.scrollIntoView({ block: 'start' });
  });

  retryButton.addEventListener('click', () => {
    if (retryButton.disabled) return;
    const ecu = currentEcu();
    runOperation('psa-retry-status', 'Checking ' + ecu.name + '…', async (session) => {
      await scanPsaEcus(session, { ecus: [ecu] }, catalog.models, (_, result) => {
        if (!connected) return;
        resultFilter = result.state;
        storeScanResult(ecu, result);
        showEcu();
        status('psa-retry-status', scanStateLabels[result.state], result.state === 'detected' ? 'ready' : 'idle');
      });
    });
  });

  stopScan.addEventListener('click', () => {
    if (!scanning || stopRequested) return;
    stopRequested = true;
    stopScan.disabled = true;
    status('psa-status', 'Stopping after the current ECU…');
  });

  saveScan.addEventListener('click', () => {
    if (pendingScan && persistReading(pendingScan, 'psa-scan-save-status')) saveScan.disabled = true;
  });
  downloadScan.addEventListener('click', () => downloadFile(rawExchangeFile(pendingScan)));

  function runParameterRead(ids, identifying = false) {
    const model = currentModel();
    hideConfirmation();
    runOperation('psa-read-status', identifying ? 'Reading ECU identification…' :
      'Reading ' + ids.length + ' selected parameters…', async (session) => {
      markLastReading();
      const traced = traceSession(session);
      const batch = await readPsaParameters(traced, model, ids, (done, total) => {
        if (connected) status('psa-read-status', 'Checked ' + done + ' of ' + total + ' requests…');
      });
      if (!connected) return;
      clearResult();
      const rows = batch.flatMap(({ parameter, rows, error, explanation }) => {
        const id = '$' + parameter.id;
        if (error) return [{ label: id + ' · ' + parameter.name, value: error }];
        const values = explanation.fields.length ? rows.slice(0, -1) : rows;
        return values.map(({ label, value }) => ({ label: id + ' · ' + label, value }));
      });
      const explanations = batch.map(({ explanation }) => explanation);
      const successes = batch.filter(({ rows }) => rows).length;
      if (successes) showSnapshot(rows, traced.exchanges, explanations);
      else {
        renderValues(element('psa-values'), rows);
        renderPsaExplanations(element('psa-explanations'), explanations, renderValues);
        readTime = Date.now();
        renderReadTime('psa-read-time', readTime, 'Attempted at');
      }
      if (identifying) {
        const decoded = explanations.some(({ fields }) => fields?.length);
        const matched = currentEcu().models.find(({ key }) => key === modelPicker.value);
        status('psa-read-status', decoded ? 'Identification data decoded with the ' + matched.name + ' profile.' :
          'Identification fields could not be decoded. Open the response details.', decoded ? 'ready' : 'idle');
      } else {
        status('psa-read-status', successes + ' of ' + batch.length + ' parameter reads succeeded.',
          successes === batch.length ? 'ready' : 'idle');
      }
    });
  }

  parameterButton.addEventListener('click', () => {
    if (!parameterButton.disabled) runParameterRead([...selectedParameters]);
  });
  identifyButton.addEventListener('click', () => {
    if (!identifyButton.disabled) runParameterRead(ecuIdentificationIds(currentModel()), true);
  });

  dtcButton.addEventListener('click', () => {
    if (dtcButton.disabled) return;
    const model = currentModel();
    dtcsRead = false;
    hideConfirmation();
    runOperation('psa-read-status', 'Reading ECU trouble codes…', async (session) => {
      markLastReading();
      const traced = traceSession(session);
      const faults = await readPsaDtcs(traced, model);
      if (!connected) return;
      clearResult();
      dtcsRead = true;
      showFaults(faults, traced.exchanges);
      status('psa-read-status', faults.length ? 'Trouble-code read complete.' : 'No matching DTCs returned.', 'ready');
    });
  });

  clearButton.addEventListener('click', () => {
    if (clearButton.disabled) return;
    const ecu = currentEcu();
    const model = ecu.models.find(({ key }) => key === modelPicker.value);
    element('psa-clear-target').textContent = 'Clear DTCs in ' + ecu.name + ' (' + ecu.id + ') · ' + model.name + '?';
    element('psa-clear-confirmation').hidden = false;
    cancelClear.focus();
  });

  cancelClear.addEventListener('click', () => {
    hideConfirmation();
    clearButton.focus();
  });

  confirmClear.addEventListener('click', () => {
    if (confirmClear.disabled || element('psa-clear-confirmation').hidden) return;
    const model = currentModel();
    dtcsRead = false;
    hideConfirmation();
    runOperation('psa-read-status', 'Checking the selected ECU and clearing DTCs…', async (session) => {
      markLastReading();
      const traced = traceSession(session);
      let result;
      try {
        result = await clearPsaDtcs(traced, model);
      } catch (error) {
        if (!connected) status('psa-status', 'The DTC clear could not be verified. Reconnect and read the ECU again.', 'error');
        throw error;
      }
      if (!connected) return;
      if (result.faults) {
        clearResult();
        dtcsRead = true;
        showFaults(result.faults, traced.exchanges);
      }
      const outcome = result.state === 'acknowledged' ? 'ECU acknowledged the clear.' :
        result.state === 'rejected' ? 'ECU rejected the clear (' + result.reason + ').' : 'Clear acknowledgement unconfirmed.';
      const followup = !result.faults ? 'Follow-up read failed.' : result.faults.length ?
        result.faults.length + ' matching DTCs on the follow-up read.' : 'No matching DTCs on the follow-up read.';
      status('psa-read-status', outcome + ' ' + followup,
        result.state === 'acknowledged' && result.faults ? 'ready' : 'error');
    });
  });

  saveButton.addEventListener('click', () => {
    if (pendingReading && !saveButton.disabled && persistReading(pendingReading, 'psa-save-status')) {
      saveButton.disabled = true;
    }
  });

  function traceContext(includeEcu) {
    const context = { vehicle: vehiclePicker.value, variant: variantPicker.value };
    if (includeEcu && ecuPicker.value) context.ecu = ecuPicker.value;
    if (includeEcu && modelPicker.value) context.model = modelPicker.value;
    return context;
  }

  return { update, disconnectSession, traceContext };
}
