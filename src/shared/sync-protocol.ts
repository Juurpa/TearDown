/**
 * SYNC PROTOCOL - Kommunikation zwischen DEV A (Renderer) und DEV B (Physics)
 *
 * Prinzipien:
 * - Event-basiert (nicht polling)
 * - Nicht-blockierend (async/await)
 * - Versioniert (verhindert Race Conditions)
 * - State-agnostic (keine direkten Objekt-Zugriffe)
 */

// ============================================================================
// MESSAGE TYPES
// ============================================================================

export enum EventType {
  // DEV B → DEV A
  PHYSICS_STEP_COMPLETE = 'physics:step_complete',
  DESTRUCTION_TRIGGERED = 'physics:destruction_triggered',
  FRAGMENT_CREATED = 'physics:fragment_created',
  WORLD_STATE_CHANGED = 'physics:world_state_changed',

  // DEV A → DEV B
  USER_DESTRUCTION_INPUT = 'render:destruction_input',
  CHUNK_BOUNDS_UPDATED = 'render:chunk_bounds_updated',
  RENDER_STATE_READY = 'render:ready',

  // Sync
  SYNC_REQUEST = 'sync:request',
  SYNC_ACK = 'sync:ack',
}

export interface SyncMessage {
  id: string;
  type: EventType;
  timestamp: number;
  version: number; // Für Ordering
  payload: any;
  source: 'DEV_A' | 'DEV_B';
  priority: 'LOW' | 'NORMAL' | 'HIGH'; // HIGH = Zerstörungs-Events
}

export interface Fragment {
  id: string;
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  mass: number;
  meshInstanceId?: string; // Für DEV A
}

export interface DestructionEvent {
  chunkId: string;
  position: { x: number; y: number; z: number };
  radius: number;
  force: number;
  fragments: Fragment[];
}

export interface ChunkBounds {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
  voxelsPerUnit: number;
}

export interface WorldState {
  frameCount: number;
  time: number;
  gravity: { x: number; y: number; z: number };
  activeFragmentCount: number;
  lastDestructionTime?: number;
}

// ============================================================================
// EVENT BUS - Zentrale Kommunikation (nicht-blockierend)
// ============================================================================

type EventCallback = (message: SyncMessage) => void | Promise<void>;

export class SyncEventBus {
  private listeners: Map<EventType, EventCallback[]> = new Map();
  private messageQueue: SyncMessage[] = [];
  private messageVersion = 0;
  private isProcessing = false;
  private pendingAcks: Map<string, Promise<SyncMessage>> = new Map();

  subscribe(eventType: EventType, callback: EventCallback): () => void {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, []);
    }
    this.listeners.get(eventType)!.push(callback);

    // Return unsubscribe function
    return () => {
      const callbacks = this.listeners.get(eventType)!;
      const index = callbacks.indexOf(callback);
      if (index > -1) callbacks.splice(index, 1);
    };
  }

  async emit(
    eventType: EventType,
    payload: any,
    source: 'DEV_A' | 'DEV_B',
    priority: 'LOW' | 'NORMAL' | 'HIGH' = 'NORMAL'
  ): Promise<void> {
    const message: SyncMessage = {
      id: `msg_${this.messageVersion}_${Date.now()}`,
      type: eventType,
      timestamp: Date.now(),
      version: this.messageVersion++,
      payload,
      source,
      priority,
    };

    // HIGH priority → vorne in Queue
    if (priority === 'HIGH') {
      this.messageQueue.unshift(message);
    } else {
      this.messageQueue.push(message);
    }

    await this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.messageQueue.length === 0) return;

    this.isProcessing = true;
    while (this.messageQueue.length > 0) {
      const message = this.messageQueue.shift()!;
      const callbacks = this.listeners.get(message.type) || [];

      // Fire all callbacks (parallel, non-blocking)
      await Promise.all(
        callbacks.map(cb =>
          Promise.resolve(cb(message)).catch(console.error)
        )
      );
    }
    this.isProcessing = false;
  }

  // Für synchrone Bestätigung (z.B. nach Destruktion)
  waitFor(eventType: EventType): Promise<SyncMessage> {
    return new Promise(resolve => {
      const unsubscribe = this.subscribe(eventType, message => {
        unsubscribe();
        resolve(message);
      });
    });
  }
}

// ============================================================================
// GLOBAL SINGLETON (wird in main.ts initialisiert)
// ============================================================================

export let globalEventBus: SyncEventBus;

export function initSyncBus(): SyncEventBus {
  globalEventBus = new SyncEventBus();
  return globalEventBus;
}
