import * as THREE from 'three';
import {
  globalEventBus,
  EventType,
  Fragment,
  DestructionEvent,
  WorldState,
  PhysicsStepPayload,
} from '../shared/sync-protocol';

/**
 * DEV A — Rendering & Visualization
 *
 * Responsibilities:
 * - Voxel rendering via a single InstancedMesh (1 draw call for the building)
 * - Click-to-destroy input → emits USER_DESTRUCTION_INPUT
 * - Destruction rendering: remove voxel instances, spawn fragment instances
 * - Fragment tracking & animation (1 draw call for ALL debris)
 * - HUD (voxel / debris counters)
 *
 * Communication with DEV B: ONLY via SyncEventBus (see CLAUDE.md).
 *
 * Performance contract (skill rules R3/R4):
 * - Building and debris are two InstancedMesh objects — draw calls do NOT
 *   grow with voxel count. Instance removal is O(1) swap-with-last.
 * - Voxels are indexed in a Map keyed "x|y|z" (same format as DEV B's
 *   structural model) — destruction removal and click picking are bounded
 *   lookups, never full-scene scans.
 * - Click picking uses a 3D-DDA grid ray-march (Amanatides & Woo) through
 *   the voxel hash instead of raycasting meshes.
 * - Per-frame paths allocate nothing: scratch Matrix4/Quaternion/Vector3
 *   objects are reused, the step_complete listener is synchronous and
 *   copies values immediately (DEV B reuses the payload across frames).
 */

interface TrackedFragment {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  angularVelocity: THREE.Vector3;
  rotX: number;
  rotY: number;
  rotZ: number;
  physicsDriven: boolean; // true once DEV B owns this fragment's transform
}

const FRAGMENT_KILL_Y = -20; // fallback-cleanup below this height
const FRAGMENT_SIZE = 0.5;
const HUD_UPDATE_INTERVAL = 30; // frames between HUD text refreshes

export class VoxelChunkRenderer {
  public mesh: THREE.Group;

  private camera?: THREE.Camera;
  private raycaster = new THREE.Raycaster();

  // ---- Building (InstancedMesh + spatial hash) ----
  private voxelInstances!: THREE.InstancedMesh;
  private voxelSlots = new Map<string, number>(); // "x|y|z" → instance slot
  private voxelSlotKeys: string[] = [];           // slot → "x|y|z"
  private buildingBounds = { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };

  // ---- Debris (InstancedMesh, shared by falling fragments AND static rubble) ----
  private fragmentInstances!: THREE.InstancedMesh;
  private fragSlots = new Map<string, number>();  // fragmentId → instance slot
  private fragSlotOwner: string[] = [];           // slot → fragmentId
  private fragCount = 0;

  // Only awake/fallback fragments are tracked per frame; settled rubble
  // keeps its instance slot but leaves all per-frame bookkeeping.
  private fragments = new Map<string, TrackedFragment>();
  private fallbackFragments = new Set<string>();
  private settledCount = 0;

  // R3: reused scratch objects — per-frame paths allocate nothing
  private cullScratch: string[] = [];
  private scratchMatrix = new THREE.Matrix4();
  private scratchQuat = new THREE.Quaternion();
  private scratchVec = new THREE.Vector3();
  private scratchEuler = new THREE.Euler();
  private static readonly UNIT_SCALE = new THREE.Vector3(1, 1, 1);

  // Click-vs-drag discrimination (OrbitControls drags must not destroy)
  private pointerDownX = 0;
  private pointerDownY = 0;

  // Gravity comes from DEV B via WORLD_STATE_CHANGED (fallback animation only)
  private gravity = new THREE.Vector3(0, -9.81, 0);

  private hudElement: HTMLElement | null = null;
  private hudCountdown = 0;

  constructor() {
    this.mesh = new THREE.Group();
    this.setupEventListeners();
    console.log('[DEV A] Voxel-Renderer initialisiert.');
  }

  // ==========================================================================
  // BUILDING — one InstancedMesh, one draw call
  // ==========================================================================

  public createInitialBuilding(width: number, height: number, depth: number): void {
    const capacity = width * height * depth;

    const voxelGeometry = new THREE.BoxGeometry(1, 1, 1);
    const voxelMaterial = new THREE.MeshStandardMaterial({ color: 0x8899aa, roughness: 0.4 });
    this.voxelInstances = new THREE.InstancedMesh(voxelGeometry, voxelMaterial, capacity);
    this.voxelInstances.frustumCulled = false;

    let slot = 0;
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        for (let z = 0; z < depth; z++) {
          const worldY = y + 0.5;
          this.scratchMatrix.makeTranslation(x, worldY, z);
          this.voxelInstances.setMatrixAt(slot, this.scratchMatrix);
          const key = `${x}|${worldY}|${z}`;
          this.voxelSlots.set(key, slot);
          this.voxelSlotKeys[slot] = key;
          slot++;
        }
      }
    }
    this.voxelInstances.count = capacity;
    this.voxelInstances.instanceMatrix.needsUpdate = true;

    // Debris pool: every voxel can become at most one fragment, so the
    // building volume is the exact upper bound.
    const fragmentGeometry = new THREE.BoxGeometry(FRAGMENT_SIZE, FRAGMENT_SIZE, FRAGMENT_SIZE);
    const fragmentMaterial = new THREE.MeshStandardMaterial({ color: 0x99aabb, roughness: 0.6 });
    this.fragmentInstances = new THREE.InstancedMesh(fragmentGeometry, fragmentMaterial, capacity);
    this.fragmentInstances.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.fragmentInstances.frustumCulled = false;
    this.fragmentInstances.count = 0;

    this.mesh.add(this.voxelInstances, this.fragmentInstances);

    this.buildingBounds = {
      minX: -0.5, maxX: width - 0.5,
      minY: 0, maxY: height,
      minZ: -0.5, maxZ: depth - 0.5,
    };

    this.hudElement = document.getElementById('info');
    console.log(`[DEV A] Building created: ${capacity} voxels (1 draw call)`);
  }

  /** O(1) instance removal: swap the last instance into the freed slot. */
  private removeVoxelInstance(key: string): boolean {
    const slot = this.voxelSlots.get(key);
    if (slot === undefined) return false;

    const last = this.voxelInstances.count - 1;
    if (slot !== last) {
      this.voxelInstances.getMatrixAt(last, this.scratchMatrix);
      this.voxelInstances.setMatrixAt(slot, this.scratchMatrix);
      const movedKey = this.voxelSlotKeys[last];
      this.voxelSlotKeys[slot] = movedKey;
      this.voxelSlots.set(movedKey, slot);
    }
    this.voxelSlotKeys.length = last;
    this.voxelSlots.delete(key);
    this.voxelInstances.count = last;
    this.voxelInstances.instanceMatrix.needsUpdate = true;
    return true;
  }

  // ==========================================================================
  // INPUT — DDA grid ray-march picking, drag-aware clicks
  // ==========================================================================

  public setupInputHandling(camera: THREE.Camera): void {
    this.camera = camera;

    window.addEventListener('pointerdown', (event: PointerEvent) => {
      this.pointerDownX = event.clientX;
      this.pointerDownY = event.clientY;
    });

    window.addEventListener('click', (event: MouseEvent) => {
      if (!this.camera) return;

      // Camera drags (OrbitControls) must not trigger destruction
      const dragDistance =
        Math.abs(event.clientX - this.pointerDownX) + Math.abs(event.clientY - this.pointerDownY);
      if (dragDistance > 5) return;

      const screenPos = new THREE.Vector2(
        (event.clientX / window.innerWidth) * 2 - 1,
        -(event.clientY / window.innerHeight) * 2 + 1
      );

      this.raycaster.setFromCamera(screenPos, this.camera);
      const hitPoint = this.raymarchVoxels(this.raycaster.ray);

      if (hitPoint) {
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

    // DEV-ONLY: mock destruction for testing without DEV B.
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

  /**
   * Amanatides & Woo 3D-DDA: walk the ray cell by cell through the voxel grid
   * and return the entry point of the first occupied cell. Voxel cells are
   * centered at (ix, gy + 0.5, iz) with unit size.
   */
  private raymarchVoxels(ray: THREE.Ray): THREE.Vector3 | null {
    const b = this.buildingBounds;
    const ox = ray.origin.x, oy = ray.origin.y, oz = ray.origin.z;
    const dx = ray.direction.x, dy = ray.direction.y, dz = ray.direction.z;

    // Slab test against the building AABB
    let tMin = 0;
    let tMax = Infinity;
    const axes: Array<[number, number, number, number]> = [
      [ox, dx, b.minX, b.maxX],
      [oy, dy, b.minY, b.maxY],
      [oz, dz, b.minZ, b.maxZ],
    ];
    for (const [o, d, lo, hi] of axes) {
      if (Math.abs(d) < 1e-12) {
        if (o < lo || o > hi) return null;
      } else {
        let t1 = (lo - o) / d;
        let t2 = (hi - o) / d;
        if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
        tMin = Math.max(tMin, t1);
        tMax = Math.min(tMax, t2);
        if (tMin > tMax) return null;
      }
    }

    // Entry point, nudged inside the box
    let t = tMin + 1e-6;
    const px = ox + dx * t, py = oy + dy * t, pz = oz + dz * t;

    // Cell coordinates: x/z cells span [i-0.5, i+0.5) → i = round(p);
    // y cells span [gy, gy+1) → gy = floor(p)
    let ix = Math.round(px);
    let gy = Math.floor(py);
    let iz = Math.round(pz);

    const stepX = dx > 0 ? 1 : -1;
    const stepY = dy > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;

    let tMaxX = Math.abs(dx) < 1e-12 ? Infinity : ((ix + 0.5 * stepX) - ox) / dx;
    let tMaxY = Math.abs(dy) < 1e-12 ? Infinity : ((gy + (stepY > 0 ? 1 : 0)) - oy) / dy;
    let tMaxZ = Math.abs(dz) < 1e-12 ? Infinity : ((iz + 0.5 * stepZ) - oz) / dz;

    const tDeltaX = Math.abs(dx) < 1e-12 ? Infinity : Math.abs(1 / dx);
    const tDeltaY = Math.abs(dy) < 1e-12 ? Infinity : Math.abs(1 / dy);
    const tDeltaZ = Math.abs(dz) < 1e-12 ? Infinity : Math.abs(1 / dz);

    // Bounded march: the diagonal of the building is the longest possible path
    const maxSteps =
      (b.maxX - b.minX + b.maxY - b.minY + b.maxZ - b.minZ + 3) | 0;

    for (let step = 0; step <= maxSteps; step++) {
      if (this.voxelSlots.has(`${ix}|${gy + 0.5}|${iz}`)) {
        return new THREE.Vector3(ox + dx * t, oy + dy * t, oz + dz * t);
      }

      if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
        t = tMaxX;
        ix += stepX;
        tMaxX += tDeltaX;
      } else if (tMaxY <= tMaxZ) {
        t = tMaxY;
        gy += stepY;
        tMaxY += tDeltaY;
      } else {
        t = tMaxZ;
        iz += stepZ;
        tMaxZ += tDeltaZ;
      }

      if (t > tMax) return null; // left the building AABB
    }
    return null;
  }

  // ==========================================================================
  // DESTRUCTION RENDERING (event listeners)
  // ==========================================================================

  private setupEventListeners(): void {
    globalEventBus.subscribe(EventType.DESTRUCTION_TRIGGERED, (msg) => {
      this.handleDestructionTriggered(msg.payload as DestructionEvent);
    });

    globalEventBus.subscribe(EventType.FRAGMENT_CREATED, (msg) => {
      const fragment = msg.payload as Fragment;
      const tracked = this.fragments.get(fragment.id);
      if (tracked) {
        tracked.physicsDriven = true;
        this.fallbackFragments.delete(fragment.id);
      } else {
        this.spawnFragment(fragment, true);
      }
    });

    globalEventBus.subscribe(EventType.WORLD_STATE_CHANGED, (msg) => {
      const state = msg.payload as WorldState;
      if (state?.gravity) {
        this.gravity.set(state.gravity.x, state.gravity.y, state.gravity.z);
      }
    });

    // Physics step → move fragment instances to the authoritative RAPIER
    // transforms. SYNCHRONOUS listener, for..in iteration, immediate copy:
    // DEV B reuses the payload object across frames (R3 contract).
    globalEventBus.subscribe(EventType.PHYSICS_STEP_COMPLETE, (msg) => {
      const payload = msg.payload as Partial<PhysicsStepPayload>;

      const transforms = payload.fragmentTransforms;
      let touched = false;
      if (transforms) {
        for (const id in transforms) {
          const tracked = this.fragments.get(id);
          const slot = this.fragSlots.get(id);
          if (!tracked || slot === undefined) continue;
          tracked.physicsDriven = true;
          this.fallbackFragments.delete(id);

          const transform = transforms[id];
          this.scratchVec.set(transform.position.x, transform.position.y, transform.position.z);
          this.scratchQuat.set(transform.rotation.x, transform.rotation.y, transform.rotation.z, transform.rotation.w);
          this.scratchMatrix.compose(this.scratchVec, this.scratchQuat, VoxelChunkRenderer.UNIT_SCALE);
          this.fragmentInstances.setMatrixAt(slot, this.scratchMatrix);
          tracked.position.copy(this.scratchVec);
          touched = true;
        }
      }

      // Settled rubble: instance stays frozen at its final transform,
      // but leaves all per-frame tracking (mirrors DEV B's FIXED retirement)
      const settled = payload.settledFragments;
      if (settled) {
        for (let i = 0; i < settled.length; i++) {
          if (this.fragments.delete(settled[i])) this.settledCount++;
          this.fallbackFragments.delete(settled[i]);
        }
      }

      // Kill-plane culls: DEV B removed the body — free the instance slot
      const culled = payload.culledFragments;
      if (culled) {
        for (let i = 0; i < culled.length; i++) {
          this.freeFragmentSlot(culled[i]);
          touched = true;
        }
      }

      if (touched) this.fragmentInstances.instanceMatrix.needsUpdate = true;
    });
  }

  private handleDestructionTriggered(event: DestructionEvent): void {
    // Fragments carry the exact voxel-center positions from DEV B's
    // structural model — keyed O(1) lookups + swap-with-last removal.
    let removed = 0;
    for (const fragment of event.fragments) {
      const key = `${fragment.position.x}|${fragment.position.y}|${fragment.position.z}`;
      if (this.removeVoxelInstance(key)) removed++;
      this.spawnFragment(fragment, false);
    }
    this.fragmentInstances.instanceMatrix.needsUpdate = true;

    console.log(
      `[DEV A] Destruction rendered: ${removed} voxels removed, ${event.fragments.length} fragments spawned`
    );
  }

  private spawnFragment(fragment: Fragment, physicsDriven: boolean): void {
    if (this.fragSlots.has(fragment.id)) return;
    if (this.fragCount >= this.fragmentInstances.instanceMatrix.count) return; // pool exhausted (cannot happen: 1 voxel → 1 fragment)

    const slot = this.fragCount++;
    this.fragmentInstances.count = this.fragCount;
    this.fragSlots.set(fragment.id, slot);
    this.fragSlotOwner[slot] = fragment.id;

    this.scratchMatrix.makeTranslation(fragment.position.x, fragment.position.y, fragment.position.z);
    this.fragmentInstances.setMatrixAt(slot, this.scratchMatrix);

    this.fragments.set(fragment.id, {
      position: new THREE.Vector3(fragment.position.x, fragment.position.y, fragment.position.z),
      velocity: new THREE.Vector3(fragment.velocity.x, fragment.velocity.y, fragment.velocity.z),
      angularVelocity: new THREE.Vector3(
        (fragment.position.x % 1) * 4 - 2,
        (fragment.position.y % 1) * 4 - 2,
        (fragment.position.z % 1) * 4 - 2
      ),
      rotX: 0,
      rotY: 0,
      rotZ: 0,
      physicsDriven,
    });
    if (!physicsDriven) {
      this.fallbackFragments.add(fragment.id);
    }
  }

  /** O(1) slot release: swap the last instance (possibly settled rubble) in. */
  private freeFragmentSlot(id: string): void {
    const slot = this.fragSlots.get(id);
    if (slot !== undefined) {
      const last = this.fragCount - 1;
      if (slot !== last) {
        this.fragmentInstances.getMatrixAt(last, this.scratchMatrix);
        this.fragmentInstances.setMatrixAt(slot, this.scratchMatrix);
        const movedId = this.fragSlotOwner[last];
        this.fragSlotOwner[slot] = movedId;
        this.fragSlots.set(movedId, slot);
      }
      this.fragSlotOwner.length = last;
      this.fragSlots.delete(id);
      this.fragCount = last;
      this.fragmentInstances.count = last;
    }
    this.fragments.delete(id);
    this.fallbackFragments.delete(id);
  }

  // ==========================================================================
  // PER-FRAME FALLBACK ANIMATION, CLEANUP & HUD
  // Called from main.ts render loop with delta time (seconds).
  // Iterates ONLY fragments still in fallback mode — physics-driven
  // fragments are updated exclusively by the step_complete listener.
  // ==========================================================================

  public update(deltaTime: number): void {
    if (this.fallbackFragments.size > 0) {
      this.cullScratch.length = 0;

      for (const id of this.fallbackFragments) {
        const f = this.fragments.get(id);
        const slot = this.fragSlots.get(id);
        if (!f || slot === undefined) {
          this.cullScratch.push(id);
          continue;
        }

        f.velocity.addScaledVector(this.gravity, deltaTime);
        f.position.addScaledVector(f.velocity, deltaTime);
        f.rotX += f.angularVelocity.x * deltaTime;
        f.rotY += f.angularVelocity.y * deltaTime;
        f.rotZ += f.angularVelocity.z * deltaTime;

        this.scratchEuler.set(f.rotX, f.rotY, f.rotZ);
        this.scratchQuat.setFromEuler(this.scratchEuler);
        this.scratchMatrix.compose(f.position, this.scratchQuat, VoxelChunkRenderer.UNIT_SCALE);
        this.fragmentInstances.setMatrixAt(slot, this.scratchMatrix);

        if (f.position.y < FRAGMENT_KILL_Y) {
          this.cullScratch.push(id);
        }
      }

      for (let i = 0; i < this.cullScratch.length; i++) {
        this.freeFragmentSlot(this.cullScratch[i]);
      }
      this.fragmentInstances.instanceMatrix.needsUpdate = true;
    }

    // HUD refresh (cheap DOM write, throttled)
    if (--this.hudCountdown <= 0) {
      this.hudCountdown = HUD_UPDATE_INTERVAL;
      if (this.hudElement) {
        this.hudElement.textContent =
          `Klick: zerstören · Ziehen: Kamera · Scrollen: Zoom   |   ` +
          `Voxel: ${this.voxelSlots.size} · Trümmer: ${this.fragments.size} aktiv / ${this.settledCount} Schutt`;
      }
    }
  }

  // ==========================================================================
  // HELPERS
  // ==========================================================================

  public getActiveFragmentCount(): number {
    return this.fragments.size;
  }

  public getVoxelCount(): number {
    return this.voxelSlots.size;
  }

  /** Builds a fake DestructionEvent from real voxel positions (mock testing only). */
  private buildMockDestructionEvent(
    position: { x: number; y: number; z: number },
    radius: number
  ): DestructionEvent {
    const fragments: Fragment[] = [];
    const radiusSq = radius * radius;

    for (const key of this.voxelSlots.keys()) {
      const parts = key.split('|');
      const vx = Number(parts[0]);
      const vy = Number(parts[1]);
      const vz = Number(parts[2]);

      const dx = vx - position.x;
      const dy = vy - position.y;
      const dz = vz - position.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq > radiusSq) continue;

      const dist = Math.sqrt(distSq);
      const len = Math.max(dist, 1e-6);
      const strength = (1 - dist / radius) * 8;
      fragments.push({
        id: `mock_frag_${key}`,
        position: { x: vx, y: vy, z: vz },
        velocity: {
          x: (dx / len) * strength,
          y: Math.abs(dy / len) * strength + 2,
          z: (dz / len) * strength,
        },
        mass: 1.0,
      });
    }

    return { chunkId: 'chunk_0', position, radius, force: 100, fragments };
  }
}
