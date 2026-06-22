export interface SseEvent {
  type: string;
  data: Record<string, any>;
}

export class EventBus {
  private listeners = new Set<(event: SseEvent) => void>();

  subscribe(fn: (event: SseEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  send(event: SseEvent): void {
    for (const fn of this.listeners) {
      try { fn(event); } catch {}
    }
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }
}

export class SseClient {
  private controller: ReadableStreamDefaultController | null = null;
  private unsubscribe: (() => void) | null = null;

  start(eventBus: EventBus): ReadableStream {
    return new ReadableStream({
      start: (controller) => {
        this.controller = controller;
        this.unsubscribe = eventBus.subscribe((event) => {
          const lines = [
            `event: ${event.type}`,
            `data: ${JSON.stringify({ type: event.type, data: event.data })}`,
            "",
          ];
          try {
            controller.enqueue(new TextEncoder().encode(lines.join("\n") + "\n"));
          } catch {}
        });
      },
      cancel: () => {
        this.unsubscribe?.();
        this.controller = null;
      },
    });
  }

  sendKeepAlive(): void {
    if (this.controller) {
      try {
        this.controller.enqueue(new TextEncoder().encode(":keep-alive\n\n"));
      } catch {}
    }
  }

  isConnected(): boolean {
    return this.controller !== null;
  }
}

const clients = new Set<SseClient>();

export function trackSseClient(client: SseClient): void {
  clients.add(client);
}

export function startKeepAlive(): void {
  setInterval(() => {
    for (const client of clients) {
      client.sendKeepAlive();
    }
    // ponytail: O(n) scan prunes dead clients whose streams were cancelled
    for (const client of clients) {
      if (!client.isConnected()) clients.delete(client);
    }
  }, 15000);
}
