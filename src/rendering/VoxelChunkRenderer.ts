import * as THREE from 'three';
import {
  globalEventBus,
  EventType,
  Fragment,
  DestructionEvent,
  WorldState,
} from '../shared/sync-protocol';

/**
 * DEV A — Rendering & Visualization
 *
 * Responsibilities:
 * - Voxel mesh generation (createInitialBuilding)
 * - Click-to-destroy input → emits USER_DESTRUCTION_INPUT   [PHASE1-A1]
 * - Destruction rendering: remove voxels, spawn fragments    [PHASE1-A2]
 * - Fragment tracking & animation (id → mesh map)            [PHASE1-A3]
 *
 * Communication with DEV B: ONLY via SyncEventBus (see CLAUDE.md).
 */

interface TrackedFragment {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  angularVelocity: THREE.Vector3;
  physicsDriven: boolean; // true once DEV B owns this fragment's transform
}

const FRAGMENT_KILL_Y = -20; // cleanup below this height
const FRAGMENT_SIZE = 0.5;

export class VoxelChunkRenderer {
  public mesh: THREE.Group;

  private voxelGroup: THREE.Group;
  private fragmentGroup: THREE.Group;
  private camera?: THREE.Camera;
  private raycaster = new THREE.Raycaster();

  // PHASE1-A3: fragmentId → mesh tracking
  private fragments = new Map<string, TrackedFragment>();

  // Gravity comes from DEV B via WORLD_STATE_CHANGED (never hardcode logic on it,
  // it is only used as visual fallback until physics positions arrive)
  private gravity = new THREE.Vector3(0, -9.81, 0);

  private fragmentGeometry = new THREE.BoxGeometry(FRAGMENT_SIZE, FRAGMENT_SIZE, FRAGMENT_SIZE);
  private fragmentMaterial = new THREE.MeshStandardMaterial({ color: 0x99aabb, roughness: 0.6 });

  constructor() {
    this.mesh = new THREE.Group();
    this.voxelGroup = new THREE.Group();
    this.fragmentGroup = new THREE.Group();
    this.mesh.add(this.voxelGroup, this.fragmentGroup);

    this.setupEventListeners();
    console.log('[DEV A] Voxel-Renderer initialisiert.');
  }

  // ==========================================================================
  // BUILDING
  // ==========================================================================

  public createInitialBuilding(width: number, height: number, depth: number): void {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshStandardMaterial({ color: 0x8899aa, roughness: 0.4 });

    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        for (let z = 0; z < depth; z++) {
          const block = new THREE.Mesh(geometry, material);
          block.position.set(x, y + 0.5, z);
          this.voxelGroup.add(block);
        }
      }
    }
    console.log(`[DEV A] Building created: ${this.voxelGroup.children.length} voxels`);
  }

  // ==========================================================================
  // PHASE1-A1 — INPUT
  // ==========================================================================

  public setupInputHandling(camera: THREE.Camera): void {
    this.camera = camera;

    window.addEventListener('click', (event: MouseEvent) => {
      if (!this.camera) return;

      const screenPos = new THREE.Vector2(
        (event.clientX / window.innerWidth) * 2 - 1,
        -(event.clientY / window.innerHeight) * 2 + 1
      );

      this.raycaster.setFromCamera(screenPos, this.camera);
      const intersects = this.raycaster.intersectObjects(this.voxelGroup.children);

      if (intersects.length > 0) {
        const hitPoint = intersects[0].point;

        globalEventBus.emit(
          EventType.USER_DESTRUCTION_INPUT,
          {
            worldPosition: { x: hitPoint.x, y: hitPoint.y, z: hitPoint.z },
            radius: 2.5,
            force: 100,
          },
          'DEV_A',
          'HIGH'
        );

        console.log('[DEV A] Destruction input emitted at:', {
          x: hitPoint.x.toFixed(2),
          y: hitPoint.y.toFixed(2),
          z: hitPoint.z.toFixed(2),
        });
      }
    });

    // DEV-ONLY: mock destruction for testing A2/A3 without DEV B.
    // Usage in browser console:  devA_mockDestruction(2, 5, 2, 2.5)
    (window as any).devA_mockDestruction = (x = 2, y = 5, z = 2, radius = 2.5) => {
      const mockEvent = this.buildMockDestructionEvent({ x, y, z }, radius);
      this.handleDestructionTriggered(mockEvent);
      console.log(`[DEV A][MOCK] Destruction simulated: ${mockEvent.fragments.length} fragments`);
    };

    // Signal readiness to DEV B
    globalEventBus.emit(EventType.RENDER_STATE_READY, {}, 'DEV_A');
    console.log('[DEV A] Input handling initialized - Click to destroy enabled');
  }

  // ==========================================================================
  // PHASE1-A2 — DESTRUCTION RENDERING (event listeners)
  // ==========================================================================

  private setupEventListeners(): void {
    // Destruction from DEV B → remove voxels + spawn fragment meshes
    globalEventBus.subscribe(EventType.DESTRUCTION_TRIGGERED, async (msg) => {
      this.handleDestructionTriggered(msg.payload as DestructionEvent);
    });

    // Individual fragments announced by DEV B (PHASE1-B3) → mark physics-driven
    globalEventBus.subscribe(EventType.FRAGMENT_CREATED, async (msg) => {
      const fragment = msg.payload as Fragment;
      const tracked = this.fragments.get(fragment.id);
      if (tracked) {
        tracked.physicsDriven = true;
      } else {
        // DEV B knows a fragment we don't render yet → create it
        this.spawnFragmentMesh(fragment, true);
      }
    });

    // World state (gravity etc.) from DEV B — used for visual fallback animation
    globalEventBus.subscribe(EventType.WORLD_STATE_CHANGED, async (msg) => {
      const state = msg.payload as WorldState;
      if (state?.gravity) {
        this.gravity.set(state.gravity.x, state.gravity.y, state.gravity.z);
      }
    });

    // Physics step → future: DEV B can ship fragment transforms in worldState.
    // Contract extension point for PHASE1-A3/B3 integration.
    globalEventBus.subscribe(EventType.PHYSICS_STEP_COMPLETE, async (msg) => {
      const payload = msg.payload as { fragmentTransforms?: Record<string, { position: { x: number; y: number; z: number }; rotation?: { x: number; y: number; z: number; w: number } }> };
      if (!payload?.fragmentTransforms) return;

      for (const [id, transform] of Object.entries(payload.fragmentTransforms)) {
        const tracked = this.fragments.get(id);
        if (!tracked) continue;
        tracked.physicsDriven = true;
        tracked.mesh.position.set(transform.position.x, transform.position.y, transform.position.z);
        if (transform.rotation) {
          tracked.mesh.quaternion.set(transform.rotation.x, transform.rotation.y, transform.rotation.z, transform.rotation.w);
        }
      }
    });
  }

  private handleDestructionTriggered(event: DestructionEvent): void {
    const center = new THREE.Vector3(event.position.x, event.position.y, event.position.z);

    // 1. Remove destroyed voxels from the building mesh
    const removed: THREE.Object3D[] = [];
    for (const voxel of this.voxelGroup.children) {
      if (voxel.position.distanceTo(center) <= event.radius) {
        removed.push(voxel);
      }
    }
    removed.forEach((v) => this.voxelGroup.remove(v));

    // 2. Spawn fragment meshes from DEV B's fragment data
    for (const fragment of event.fragments) {
      this.spawnFragmentMesh(fragment, false);
    }

    console.log(
      `[DEV A] Destruction rendered: ${removed.length} voxels removed, ${event.fragments.length} fragments spawned`
    );
  }

  private spawnFragmentMesh(fragment: Fragment, physicsDriven: boolean): void {
    if (this.fragments.has(fragment.id)) return;

    const mesh = new THREE.Mesh(this.fragmentGeometry, this.fragmentMaterial);
    mesh.position.set(fragment.position.x, fragment.position.y, fragment.position.z);
    this.fragmentGroup.add(mesh);

    this.fragments.set(fragment.id, {
      mesh,
      velocity: new THREE.Vector3(fragment.velocity.x, fragment.velocity.y, fragment.velocity.z),
      angularVelocity: new THREE.Vector3(
        (fragment.position.x % 1) * 4 - 2,
        (fragment.position.y % 1) * 4 - 2,
        (fragment.position.z % 1) * 4 - 2
      ),
      physicsDriven,
    });
  }

  // ==========================================================================
  // PHASE1-A3 — PER-FRAME FRAGMENT ANIMATION & CLEANUP
  // Called from main.ts render loop with delta time (seconds).
  // ==========================================================================

  public update(deltaTime: number): void {
    if (this.fragments.size === 0) return;

    const toDelete: string[] = [];

    for (const [id, f] of this.fragments) {
      // Visual fallback animation — only until DEV B drives the transform.
      // Once physics positions arrive (FRAGMENT_CREATED / fragmentTransforms),
      // DEV B is the single source of truth.
      if (!f.physicsDriven) {
        f.velocity.addScaledVector(this.gravity, deltaTime);
        f.mesh.position.addScaledVector(f.velocity, deltaTime);
        f.mesh.rotation.x += f.angularVelocity.x * deltaTime;
        f.mesh.rotation.y += f.angularVelocity.y * deltaTime;
        f.mesh.rotation.z += f.angularVelocity.z * deltaTime;
      }

      if (f.mesh.position.y < FRAGMENT_KILL_Y) {
        toDelete.push(id);
      }
    }

    for (const id of toDelete) {
      const f = this.fragments.get(id)!;
      this.fragmentGroup.remove(f.mesh);
      this.fragments.delete(id);
    }
  }

  // ==========================================================================
  // HELPERS
  // ==========================================================================

  public getActiveFragmentCount(): number {
    return this.fragments.size;
  }

  public getVoxelCount(): number {
    return this.voxelGroup.children.length;
  }

  /** Builds a fake DestructionEvent from real voxel positions (mock testing only). */
  private buildMockDestructionEvent(
    position: { x: number; y: number; z: number },
    radius: number
  ): DestructionEvent {
    const center = new THREE.Vector3(position.x, position.y, position.z);
    const fragments: Fragment[] = [];

    for (const voxel of this.voxelGroup.children) {
      const dist = voxel.position.distanceTo(center);
      if (dist <= radius) {
        const dir = voxel.position.clone().sub(center).normalize();
        const strength = (1 - dist / radius) * 8;
        fragments.push({
          id: `mock_frag_${voxel.id}`,
          position: { x: voxel.position.x, y: voxel.position.y, z: voxel.position.z },
          velocity: {
            x: dir.x * strength,
            y: Math.abs(dir.y) * strength + 2,
            z: dir.z * strength,
          },
          mass: 1.0,
        });
      }
    }

    return { chunkId: 'chunk_0', position, radius, force: 100, fragments } as DestructionEvent;
  }
}
