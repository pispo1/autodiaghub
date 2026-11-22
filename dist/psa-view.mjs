import { makePsaReading } from './history.mjs';
import { clearPsaDtcs, formatHex, readPsaDtcs, readPsaParameters, scanPsaEcus } from './psa.mjs';

const resultLabels = {
  detected: 'Identification reply',
  rejected: 'ECU replied · identification rejected',
  invalid: 'Invalid identification reply',
  'no-reply': 'No matching reply',
};
const selectionKey = 'autodiaghub:psa-selection:v1';
const searchText = (value) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

export function mountPsaView({ element, status, renderValues, runOperation, persistReading }) {
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
  const parameterButton = element('psa-read-parameter');
  const dtcButton = element('psa-read-dtcs');
  const clearButton = element('psa-clear-dtcs');
  const confirmClear = element('psa-confirm-clear');
  const cancelClear = element('psa-cancel-clear');
  const saveButton = element('psa-save');
  const results = new Map();
  const catalogRows = new Map();
  let catalog;
  let selectedVariant;
  let connected = false;
  let busy = false;
  let loading = false;
  let pendingReading;
  let dtcsRead = false;

  function currentEcu() {
    return selectedVariant?.ecus.find(({ id }) => id === ecuPicker.value);
  }

  function currentModel() {
    return catalog?.models[modelPicker.value];
  }

  function canRead() {
    return results.get(ecuPicker.value)?.modelKeys.includes(modelPicker.value);
  }

  function update(isConnected, isBusy) {
    connected = isConnected;
    busy = isBusy;
    scanButton.disabled = !connected || busy || !selectedVariant?.scanAvailable;
    parameterButton.disabled = !connected || busy || !canRead() || selectedParameters.size === 0;
    dtcButton.disabled = !connected || busy || !canRead() || !currentModel()?.readDtcs;
    clearButton.disabled = dtcButton.disabled || !dtcsRead || !currentModel()?.clearDtcs;
    confirmClear.disabled = clearButton.disabled;
    for (const picker of [vehiclePicker, vehicleSearch, ecuPicker, modelPicker, element('psa-parameter-field')]) {
      picker.disabled = busy;
    }
    variantPicker.disabled = busy || !vehiclePicker.value;
  }

  function currentStatus(ecu) {
    const result = results.get(ecu.id);
    if (result) return resultLabels[result.state];
    return ecu.models.length ? 'Ready to scan' : 'Catalog only';
  }

  function showParameterCount(matches) {
    const count = selectedParameters.size;
    element('psa-parameter-count').textContent = count + ' selected · ' + matches + ' matching parameters';
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
    renderValues(element('psa-values'));
    pendingReading = undefined;
    element('psa-save-actions').hidden = true;
    saveButton.disabled = false;
    status('psa-save-status', '');
  }

  function hideConfirmation() {
    element('psa-clear-confirmation').hidden = true;
  }

  function showModel() {
    const model = currentModel();
    selectedParameters.clear();
    parameterSearch.value = '';
    showParameters();
    element('psa-parameter-field').hidden = !model?.parameters.length;
    parameterButton.hidden = !model?.parameters.length;
    dtcButton.hidden = !model?.readDtcs;
    dtcButton.textContent = model?.protocol === 'UDS' ? 'Read active or confirmed DTCs' : 'Read ECU DTCs';
    clearButton.hidden = !model?.clearDtcs;
    dtcsRead = false;
    hideConfirmation();
    element('psa-read').hidden = !canRead() || (!model?.parameters.length && !model?.readDtcs);
    clearResult();
    status('psa-read-status', '');
    update(connected, busy);
  }

  function showSnapshot(rows) {
    const vehicle = catalog.vehicles.find(({ code }) => code === vehiclePicker.value);
    const selected = modelPicker.selectedOptions[0];
    const ecu = currentEcu();
    renderValues(element('psa-values'), rows);
    pendingReading = makePsaReading({
      vehicle: vehicle.code,
      variant: selectedVariant.label,
      ecu: ecu.name + ' (' + ecu.id + ')',
      model: ecu.models.find(({ key }) => key === selected.value).name,
      protocol: currentModel().protocol,
    }, rows);
    element('psa-save-actions').hidden = !pendingReading;
  }

  function showFaults(faults) {
    const rows = faults.map(({ code, description, status: dtcStatus, flags }) => ({
      label: code,
      value: [description, flags?.join(', '), 'Status $' + dtcStatus].filter(Boolean).join(' · '),
    }));
    if (!rows.length) rows.push({ label: 'Trouble codes', value: 'No matching DTCs returned' });
    showSnapshot(rows);
  }

  function showEcu() {
    const ecu = currentEcu();
    if (!ecu) {
      modelPicker.replaceChildren();
      element('psa-ecu-info').textContent = '';
      renderValues(element('psa-identification'));
      showModel();
      return;
    }
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
    renderValues(element('psa-identification'), replies);

    const selection = modelPicker.value;
    modelPicker.replaceChildren();
    const eligible = ecu.models.filter(({ key }) => result?.modelKeys.includes(key));
    modelPicker.add(new Option('Choose the ECU model fitted to your car', ''));
    for (const model of eligible) {
      modelPicker.add(new Option(model.name + ' · ' + catalog.models[model.key].protocol, model.key));
    }
    if (eligible.some(({ key }) => key === selection)) modelPicker.value = selection;
    element('psa-model-field').hidden = eligible.length === 0;
    showModel();
  }

  function reset() {
    results.clear();
    if (!selectedVariant) return;
    for (const ecu of selectedVariant.ecus) {
      catalogRows.get(ecu.id).textContent = currentStatus(ecu);
    }
    status('psa-status', '');
    showEcu();
  }

  function selectVariant() {
    try {
      localStorage.setItem(selectionKey, JSON.stringify({ vehicle: vehiclePicker.value, variant: variantPicker.value }));
    } catch {
      // Browsing the catalog also works when browser storage is unavailable.
    }
    const vehicle = catalog.vehicles.find(({ code }) => code === vehiclePicker.value);
    selectedVariant = vehicle?.variants.find(({ id }) => id === variantPicker.value);
    if (!selectedVariant) {
      results.clear();
      element('psa-vehicle-data').hidden = true;
      update(connected, busy);
      return;
    }
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
    scanButton.hidden = !selectedVariant.scanAvailable;
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

  scanButton.addEventListener('click', () => {
    if (scanButton.disabled) return;
    reset();
    const variant = selectedVariant;
    const total = variant.ecus.filter(({ models }) => models.length).length;
    runOperation('psa-status', 'Scanning 0 of ' + total + ' documented ECU routes…', async (session) => {
      await scanPsaEcus(session, variant, catalog.models, (id, result) => {
        if (!connected) return;
        results.set(id, result);
        catalogRows.get(id).textContent = resultLabels[result.state];
        if (id === ecuPicker.value) showEcu();
        status('psa-status', 'Scanned ' + results.size + ' of ' + total + ' documented ECU routes…');
      });
      if (!connected) return;
      const detected = [...results.entries()].filter(([, { state }]) => state === 'detected');
      if (detected.length && results.get(ecuPicker.value)?.state !== 'detected') {
        ecuPicker.value = detected[0][0];
      }
      showEcu();
      status('psa-status', detected.length + ' of ' + total +
        ' scanned ECUs returned identification. Open the results to see each ECU.', 'ready');
    });
  });

  parameterButton.addEventListener('click', () => {
    if (parameterButton.disabled) return;
    const model = currentModel();
    const ids = [...selectedParameters];
    hideConfirmation();
    runOperation('psa-read-status', 'Reading ' + ids.length + ' selected parameters…', async (session) => {
      clearResult();
      const batch = await readPsaParameters(session, model, ids, (done, total) => {
        if (connected) status('psa-read-status', 'Read ' + done + ' of ' + total + ' parameter requests…');
      });
      if (!connected) return;
      const rows = batch.flatMap(({ parameter, rows, error }) => {
        const id = '$' + parameter.id;
        return error ? [{ label: id + ' · ' + parameter.name, value: error }] :
          rows.map(({ label, value }) => ({ label: id + ' · ' + label, value }));
      });
      const successes = batch.filter(({ rows }) => rows).length;
      if (successes) showSnapshot(rows);
      else renderValues(element('psa-values'), rows);
      status('psa-read-status', successes + ' of ' + batch.length + ' parameter reads succeeded.',
        successes === batch.length ? 'ready' : 'idle');
    });
  });

  dtcButton.addEventListener('click', () => {
    if (dtcButton.disabled) return;
    const model = currentModel();
    dtcsRead = false;
    hideConfirmation();
    runOperation('psa-read-status', 'Reading ECU trouble codes…', async (session) => {
      clearResult();
      const faults = await readPsaDtcs(session, model);
      if (!connected) return;
      dtcsRead = true;
      showFaults(faults);
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
      clearResult();
      let result;
      try {
        result = await clearPsaDtcs(session, model);
      } catch (error) {
        if (!connected) status('psa-status', 'The DTC clear could not be verified. Reconnect and read the ECU again.', 'error');
        throw error;
      }
      if (!connected) return;
      if (result.faults) {
        dtcsRead = true;
        showFaults(result.faults);
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

  return { update, reset };
}
