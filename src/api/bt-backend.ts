/**
 * Singleton WebSocket client for the BLE backend (/ble-api/ws).
 * Topic-based pub/sub — subscribers only receive events they opted into.
 * Auto-reconnects with exponential backoff; automatically re-subscribes
 * to active topics after reconnect.
 */

type Topic = 'status' | 'adapters' | 'remote_state';
type Handler = (data: any) => void;

const WS_PATH = '/ble-api/ws';

class BtBackendConnection {
  private ws: WebSocket | null = null;
  private handlers: Map<Topic, Set<Handler>> = new Map();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private outbox: string[] = [];  // messages queued while socket is connecting

  constructor() {
    this.connect();
  }

  private connect(): void {
    const url = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${WS_PATH}`;
    try {
      this.ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws.onopen = () => {
      this.reconnectAttempt = 0;
      // Resubscribe to all topics that currently have listeners
      for (const topic of this.handlers.keys()) {
        if (this.handlers.get(topic)!.size > 0) {
          this.send({ type: 'subscribe', topic });
        }
      }
      // Flush queued messages
      for (const msg of this.outbox) this.ws?.send(msg);
      this.outbox = [];
    };
    this.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as { type: Topic; data: any };
        const set = this.handlers.get(msg.type);
        if (!set) return;
        for (const cb of set) {
          try { cb(msg.data); } catch { /* swallow handler errors */ }
        }
      } catch { /* ignore malformed frame */ }
    };
    this.ws.onclose = () => {
      this.ws = null;
      this.scheduleReconnect();
    };
    this.ws.onerror = () => { /* onclose handles reconnect */ };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempt), 10000);  // cap at 10s
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private send(msg: object): void {
    const raw = JSON.stringify(msg);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(raw);
    } else {
      this.outbox.push(raw);
    }
  }

  /** Subscribe to a topic; returns an unsubscribe function. */
  subscribe(topic: Topic, handler: Handler): () => void {
    let set = this.handlers.get(topic);
    if (!set) {
      set = new Set();
      this.handlers.set(topic, set);
    }
    const wasEmpty = set.size === 0;
    set.add(handler);
    if (wasEmpty) this.send({ type: 'subscribe', topic });

    return () => {
      const s = this.handlers.get(topic);
      if (!s) return;
      s.delete(handler);
      if (s.size === 0) this.send({ type: 'unsubscribe', topic });
    };
  }
}

let _instance: BtBackendConnection | null = null;

export function btBackend(): BtBackendConnection {
  if (!_instance) _instance = new BtBackendConnection();
  return _instance;
}
