export const serviceUuid = (input) => {
  const uuid = input.trim().toLowerCase();
  const short = uuid.replace(/^0x/, '');
  if (/^(?:[0-9a-f]{4}|[0-9a-f]{8})$/.test(short)) {
    return short.padStart(8, '0') + '-0000-1000-8000-00805f9b34fb';
  }
  if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(uuid)) return uuid;
  throw new Error('Enter a valid 16-bit, 32-bit, or 128-bit BLE service UUID.');
};

const commonServices = [
  serviceUuid('fff0'),
  serviceUuid('ffe0'),
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
];

export function chooseAdapter(bluetooth, customService) {
  const services = customService ? [serviceUuid(customService)] : commonServices;
  return bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: services })
    .then((device) => ({ device, services }));
}

async function findChannel(server, services) {
  for (const uuid of services) {
    let service;
    try {
      service = await server.getPrimaryService(uuid);
    } catch (error) {
      if (error.name !== 'NotFoundError') throw error;
      continue;
    }
    const characteristics = await service.getCharacteristics();
    const writers = characteristics.filter(({ properties }) =>
      properties.write || properties.writeWithoutResponse);
    const readers = characteristics.filter(({ properties }) =>
      properties.notify || properties.indicate);
    if (writers.length === 1 && readers.length === 1) {
      return { writer: writers[0], reader: readers[0] };
    }
  }
  throw new Error('No unambiguous BLE command and response channel found. Check the adapter’s service UUID and BLE support.');
}

export async function openAdapter({ device, services }, onDisconnect) {
  try {
    const server = await device.gatt.connect();
    const { writer, reader } = await findChannel(server, services);
    const session = new AdapterSession(device, writer, reader, onDisconnect);
    try {
      await reader.startNotifications();
      if (!device.gatt.connected) throw new Error('Adapter disconnected during setup.');
      return session;
    } catch (error) {
      session.close();
      throw error;
    }
  } catch (error) {
    if (device.gatt?.connected) device.gatt.disconnect();
    throw error;
  }
}

class AdapterSession {
  #device;
  #writer;
  #reader;
  #onDisconnect;
  #pending;
  #closed = false;

  constructor(device, writer, reader, onDisconnect) {
    this.#device = device;
    this.#writer = writer;
    this.#reader = reader;
    this.#onDisconnect = onDisconnect;
    device.addEventListener('gattserverdisconnected', this.#disconnect);
    reader.addEventListener('characteristicvaluechanged', this.#receive);
  }

  get name() {
    return this.#device.name || 'BLE adapter';
  }

  command(command, timeout = 3500) {
    if (this.#closed || !this.#device.gatt.connected) {
      return Promise.reject(new Error('Adapter disconnected.'));
    }
    if (this.#pending) return Promise.reject(new Error('Adapter is busy.'));

    return new Promise((resolve, reject) => {
      const request = { buffer: '', resolve, reject, written: false, response: undefined };
      this.#pending = request;
      request.timer = setTimeout(() => {
        this.close(new Error('The adapter did not finish its reply. Reconnect and try again.'));
      }, timeout);
      const bytes = new TextEncoder().encode(command + '\r');
      this.#write(bytes).then(() => {
        request.written = true;
        this.#finishIfReady(request);
      }, () => {
        if (this.#pending === request) {
          this.close(new Error('Could not write to the adapter. Reconnect and try again.'));
        }
      });
    });
  }

  async #write(bytes) {
    const writer = this.#writer;
    if (writer.properties.write && typeof writer.writeValueWithResponse === 'function') {
      await writer.writeValueWithResponse(bytes);
    } else if (writer.properties.writeWithoutResponse && typeof writer.writeValueWithoutResponse === 'function') {
      await writer.writeValueWithoutResponse(bytes);
    } else {
      await writer.writeValue(bytes);
    }
  }

  #receive = (event) => {
    const request = this.#pending;
    if (!request || request.response !== undefined) return;
    request.buffer += new TextDecoder().decode(event.target.value);
    const prompt = request.buffer.indexOf('>');
    if (request.buffer.length > 16384) {
      this.close(new Error('The adapter sent an oversized reply.'));
    } else if (prompt !== -1) {
      request.response = request.buffer.slice(0, prompt);
      this.#finishIfReady(request);
    }
  };

  #finishIfReady(request) {
    if (this.#pending !== request || !request.written || request.response === undefined) return;
    clearTimeout(request.timer);
    this.#pending = undefined;
    request.resolve(request.response);
  }

  #disconnect = () => this.close(new Error('Adapter disconnected.'));

  close(error) {
    if (this.#closed) return;
    this.#closed = true;
    this.#reader.removeEventListener('characteristicvaluechanged', this.#receive);
    this.#device.removeEventListener('gattserverdisconnected', this.#disconnect);
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(error || new Error('Adapter disconnected.'));
    }
    if (this.#device.gatt.connected) this.#device.gatt.disconnect();
    if (error) this.#onDisconnect(this, error);
  }
}
