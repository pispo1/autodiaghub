export const sessionTraceKey = 'autodiaghub:session-trace:v1';

export function createSessionTrace(adapter, exchanges) {
  return {
    version: 1,
    id: crypto.getRandomValues(new Uint32Array(4)).join('-'),
    adapter,
    startedAt: new Date().toISOString(),
    operations: [],
    exchanges,
  };
}

export function readSessionTrace(storage) {
  try {
    const trace = JSON.parse(storage.getItem(sessionTraceKey));
    if (trace?.version === 1 && typeof trace.id === 'string' && typeof trace.adapter === 'string' &&
        Number.isFinite(Date.parse(trace.startedAt)) && Array.isArray(trace.operations) && Array.isArray(trace.exchanges)) {
      return trace;
    }
  } catch {
    // A missing or unreadable trace leaves the export unavailable.
  }
  return null;
}

export function saveSessionTrace(storage, trace) {
  const saved = readSessionTrace(storage);
  if (saved && saved.id !== trace.id &&
      (saved.startedAt > trace.startedAt || (saved.startedAt === trace.startedAt && saved.id > trace.id))) return;
  storage.setItem(sessionTraceKey, JSON.stringify(trace));
}

export function sessionTraceFile(trace) {
  if (!trace?.exchanges.length) return null;
  return {
    name: 'autodiaghub-session-' + trace.startedAt.replaceAll(':', '-') + '.json',
    contents: JSON.stringify(trace, null, 2) + '\n',
  };
}
