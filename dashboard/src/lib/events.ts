import { writable } from 'svelte/store';
import { getToken } from './api';

export const sseConnected = writable(false);
export const lastEvent = writable<Record<string, unknown> | null>(null);

let eventSource: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let listeners: Array<(event: Record<string, unknown>) => void> = [];

export function onSseEvent(callback: (event: Record<string, unknown>) => void) {
  listeners.push(callback);
  return () => {
    listeners = listeners.filter(l => l !== callback);
  };
}

export function connectSSE() {
  disconnectSSE();

  const token = getToken();
  if (!token) return;

  sseConnected.set(false);

  eventSource = new EventSource(`/api/v1/events?token=${token}`);

  eventSource.onopen = () => {
    sseConnected.set(true);
  };

  eventSource.onerror = () => {
    sseConnected.set(false);
    scheduleReconnect();
  };

  const eventTypes = [
    'job_created', 'job_started', 'job_progress', 'job_checkpoint',
    'job_completed', 'job_failed', 'job_retried', 'job_removed', 'queue_update',
  ];

  eventTypes.forEach(type => {
    eventSource?.addEventListener(type, (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        const event = { type, ...data };
        lastEvent.set(event);
        listeners.forEach(l => l(event));
      } catch { /* ignore parse errors */ }
    });
  });
}

export function disconnectSSE() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  eventSource?.close();
  eventSource = null;
  sseConnected.set(false);
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectSSE();
  }, 3000);
}
