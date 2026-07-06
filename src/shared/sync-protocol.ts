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

export interface FragmentTransform {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
}

/**
 * Payload of 'physics:step_complete'. DEV B reuses this object across frames
 * (GC-spike prevention) — it is ONLY valid during the flush() in which it is
 * delivered. Listeners must copy values immediately, never retain a reference.
 */
export interface PhysicsStepPayload {
  frameCount: number;
  time: number;
  worldState: WorldState;
  /** Live transforms of awake fragment bodies, keyed by fragment id. */
  fragmentTransforms: Record<string, FragmentTransform>;
  /** Fragments that came to rest this frame — now static, no further updates. */
  settledFragments: string[];
  /** Fragments removed below the kill plane — DEV A must delete their meshes. */
  culledFragments: string[];
}

// ============================================================================
// EVENT BUS - Zentrale Kommunikation (nicht-blockierend)
// ============================================================================

type EventCallback = (message: SyncMessage) => void | Promise<void>;

export class SyncEventBus {
  private listeners: Map<EventType, EventCallback[]> = new Map();
  private messageQueue: SyncMessage[] = [];
  private messageVersion = 0;
  private isFlushing = false;

  // Safety valve: a flush processes at most this many messages, so a
  // pathological emit-loop between listeners cannot freeze the frame.
  private static readonly MAX_MESSAGES_PER_FLUSH = 10_000;

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

  /**
   * Enqueue-only: NO listener ever runs on the emitter's call stack.
   * Delivery happens exclusively in flush(), which main.ts calls at exactly
   * one controlled point per frame. This is what makes cross-agent
   * communication genuinely non-blocking (skill rule R1/R2).
   */
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
  }

  /**
   * Drain the queue once per frame (called from the main loop). Messages
   * enqueued by listeners during the drain are delivered in the same flush.
   * Listener errors are contained — one throwing listener cannot stall the bus.
   */
  flush(): void {
    if (this.isFlushing) return;
    this.isFlushing = true;
    try {
      let processed = 0;
      while (this.messageQueue.length > 0 && processed < SyncEventBus.MAX_MESSAGES_PER_FLUSH) {
        const message = this.messageQueue.shift()!;
        processed++;
        const callbacks = this.listeners.get(message.type);
        if (!callbacks) continue;
        for (let i = 0; i < callbacks.length; i++) {
          try {
            const result = callbacks[i](message);
            if (result && typeof (result as Promise<void>).catch === 'function') {
              (result as Promise<void>).catch(console.error);
            }
          } catch (err) {
            console.error(err);
          }
        }
      }
      if (this.messageQueue.length > 0) {
        console.warn(`[SyncEventBus] Flush budget hit, ${this.messageQueue.length} messages deferred to next frame`);
      }
    } finally {
      this.isFlushing = false;
    }
  }

  // Für asynchrone Bestätigung (z.B. nach Destruktion)
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
