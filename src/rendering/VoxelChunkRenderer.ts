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
 * - Voxel mesh generation (createInitialBuilding)
 * - Click-to-destroy input → emits USER_DESTRUCTION_INPUT   [PHASE1-A1]
 * - Destruction rendering: remove voxels, spawn fragments    [PHASE1-A2]
 * - Fragment tracking & animation (id → mesh map)            [PHASE1-A3]
 *
 * Communication with DEV B: ONLY via SyncEventBus (see CLAUDE.md).
 *
 * Performance contract (skill rules R3/R4):
 * - Voxels are indexed in a Map keyed "x|y|z" (same format as DEV B's
 *   structural model) — destruction removal and click picking are bounded
 *   lookups, never full-scene scans.
 * - Click picking uses a 3D-DDA grid ray-march (Amanatides & Woo) through
 *   the voxel hash instead of raycasting N meshes.
 * - The per-frame step_complete listener is synchronous, iterates with
 *   for..in (no Object.entries allocation), and copies transform values
 *   immediately (DEV B reuses the payload object across frames).
 * - update() iterates only fragments that still need fallback animation.
 */

interface TrackedFragment {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  angularVelocity: THREE.Vector3;
  physicsDriven: boolean; // true once DEV B owns this fragment's transform
}

const FRAGMENT_KILL_Y = -20; // fallback-cleanup below this height
const FRAGMENT_SIZE = 0.5;

export class VoxelChunkRenderer {
  public mesh: THREE.Group;

  private voxelGroup: THREE.Group;
  private fragmentGroup: THREE.Group;
  private camera?: THREE.Camera;
  private raycaster = new THREE.Raycaster();

  // R4: voxel lookup keyed "x|y|z" (identical to DEV B's voxelKey format)
  private voxelMeshes = new Map<string, THREE.Mesh>();
  private buildingBounds = { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };

  // PHASE1-A3: fragmentId → mesh tracking
  private fragments = new Map<string, TrackedFragment>();
  // Only fragments in here still run the local fallback animation
  private fallbackFragments = new Set<string>();
  // Reused scratch buffer for per-frame cleanup (R3: no per-frame allocation)
  private cullScratch: string[] = [];

  // Gravity comes from DEV B via WORLD_STATE_CHANGED (only used as visual
  // fallback until physics transforms arrive)
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
          const worldY = y + 0.5;
          block.position.set(x, worldY, z);
          block.matrixAutoUpdate = false;
          block.updateMatrix();
          this.voxelGroup.add(block);
          this.voxelMeshes.set(`${x}|${worldY}|${z}`, block);
        }
      }
    }

    this.buildingBounds = {
      minX: -0.5, maxX: width - 0.5,
      minY: 0, maxY: height,
      minZ: -0.5, maxZ: depth - 0.5,
    };
    console.log(`[DEV A] Building created: ${this.voxelMeshes.size} voxels`);
  }

  // ==========================================================================
  // PHASE1-A1 — INPUT
  // R4: picking via 3D-DDA grid ray-march through the voxel hash — cost is
  // bounded by the ray's path length, not the voxel count.
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

    // t at which the ray crosses the next cell boundary on each axis
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
      if (this.voxelMeshes.has(`${ix}|${gy + 0.5}|${iz}`)) {
        return new THREE.Vector3(ox + dx * t, oy + dy * t, oz + dz * t);
      }

      // Advance to the next cell along the axis with the nearest boundary
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
  // PHASE1-A2 — DESTRUCTION RENDERING (event listeners)
  // ==========================================================================

  private setupEventListeners(): void {
    // Destruction from DEV B → remove voxels + spawn fragment meshes
    globalEventBus.subscribe(EventType.DESTRUCTION_TRIGGERED, (msg) => {
      this.handleDestructionTriggered(msg.payload as DestructionEvent);
    });

    // Individual fragments announced by DEV B (PHASE1-B3) → mark physics-driven
    globalEventBus.subscribe(EventType.FRAGMENT_CREATED, (msg) => {
      const fragment = msg.payload as Fragment;
      const tracked = this.fragments.get(fragment.id);
      if (tracked) {
        tracked.physicsDriven = true;
        this.fallbackFragments.delete(fragment.id);
      } else {
        // DEV B knows a fragment we don't render yet → create it
        this.spawnFragmentMesh(fragment, true);
      }
    });

    // World state (gravity etc.) from DEV B — used for visual fallback animation
    globalEventBus.subscribe(EventType.WORLD_STATE_CHANGED, (msg) => {
      const state = msg.payload as WorldState;
      if (state?.gravity) {
        this.gravity.set(state.gravity.x, state.gravity.y, state.gravity.z);
      }
    });

    // Physics step → move fragment meshes to the authoritative RAPIER
    // transforms. SYNCHRONOUS listener, for..in iteration, immediate copy:
    // DEV B reuses the payload object across frames (R3 contract).
    globalEventBus.subscribe(EventType.PHYSICS_STEP_COMPLETE, (msg) => {
      const payload = msg.payload as Partial<PhysicsStepPayload>;

      const transforms = payload.fragmentTransforms;
      if (transforms) {
        for (const id in transforms) {
          const tracked = this.fragments.get(id);
          if (!tracked) continue;
          tracked.physicsDriven = true;
          this.fallbackFragments.delete(id);
          const transform = transforms[id];
          tracked.mesh.position.set(transform.position.x, transform.position.y, transform.position.z);
          tracked.mesh.quaternion.set(transform.rotation.x, transform.rotation.y, transform.rotation.z, transform.rotation.w);
        }
      }

      // Settled rubble: mesh stays visible at its final transform, but leaves
      // all per-frame tracking (mirrors DEV B retiring the body to FIXED)
      const settled = payload.settledFragments;
      if (settled) {
        for (let i = 0; i < settled.length; i++) {
          this.fragments.delete(settled[i]);
          this.fallbackFragments.delete(settled[i]);
        }
      }

      // Kill-plane culls: DEV B removed the body — remove the mesh too
      const culled = payload.culledFragments;
      if (culled) {
        for (let i = 0; i < culled.length; i++) {
          const tracked = this.fragments.get(culled[i]);
          if (tracked) this.fragmentGroup.remove(tracked.mesh);
          this.fragments.delete(culled[i]);
          this.fallbackFragments.delete(culled[i]);
        }
      }
    });
  }

  private handleDestructionTriggered(event: DestructionEvent): void {
    // R4: fragments carry the exact voxel-center positions from DEV B's
    // structural model — keyed lookups instead of scanning every mesh.
    const doomed = new Set<THREE.Object3D>();
    for (const fragment of event.fragments) {
      const key = `${fragment.position.x}|${fragment.position.y}|${fragment.position.z}`;
      const voxelMesh = this.voxelMeshes.get(key);
      if (voxelMesh) {
        doomed.add(voxelMesh);
        this.voxelMeshes.delete(key);
      }
      this.spawnFragmentMesh(fragment, false);
    }

    // Single O(N) sweep instead of k separate O(N) Group.remove() splices.
    // (Bypasses Three's remove() event dispatch — voxel meshes have no listeners.)
    if (doomed.size > 0) {
      const kept: THREE.Object3D[] = [];
      for (const child of this.voxelGroup.children) {
        if (doomed.has(child)) {
          (child as { parent: THREE.Object3D | null }).parent = null;
        } else {
          kept.push(child);
        }
      }
      this.voxelGroup.children = kept;
    }

    console.log(
      `[DEV A] Destruction rendered: ${doomed.size} voxels removed, ${event.fragments.length} fragments spawned`
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
    if (!physicsDriven) {
      this.fallbackFragments.add(fragment.id);
    }
  }

  // ==========================================================================
  // PHASE1-A3 — PER-FRAME FALLBACK ANIMATION & CLEANUP
  // Called from main.ts render loop with delta time (seconds).
  // R4: iterates ONLY fragments still in fallback mode — physics-driven
  // fragments are updated exclusively by the step_complete listener.
  // ==========================================================================

  public update(deltaTime: number): void {
    if (this.fallbackFragments.size === 0) return;

    this.cullScratch.length = 0;

    for (const id of this.fallbackFragments) {
      const f = this.fragments.get(id);
      if (!f) {
        this.cullScratch.push(id);
        continue;
      }

      // Visual fallback — only until DEV B drives the transform
      f.velocity.addScaledVector(this.gravity, deltaTime);
      f.mesh.position.addScaledVector(f.velocity, deltaTime);
      f.mesh.rotation.x += f.angularVelocity.x * deltaTime;
      f.mesh.rotation.y += f.angularVelocity.y * deltaTime;
      f.mesh.rotation.z += f.angularVelocity.z * deltaTime;

      if (f.mesh.position.y < FRAGMENT_KILL_Y) {
        this.cullScratch.push(id);
      }
    }

    for (let i = 0; i < this.cullScratch.length; i++) {
      const id = this.cullScratch[i];
      const f = this.fragments.get(id);
      if (f) this.fragmentGroup.remove(f.mesh);
      this.fragments.delete(id);
      this.fallbackFragments.delete(id);
    }
  }

  // ==========================================================================
  // HELPERS
  // ==========================================================================

  public getActiveFragmentCount(): number {
    return this.fragments.size;
  }

  public getVoxelCount(): number {
    return this.voxelMeshes.size;
  }

  /** Builds a fake DestructionEvent from real voxel positions (mock testing only). */
  private buildMockDestructionEvent(
    position: { x: number; y: number; z: number },
    radius: number
  ): DestructionEvent {
    const fragments: Fragment[] = [];
    const radiusSq = radius * radius;

    for (const [, voxelMesh] of this.voxelMeshes) {
      const dx = voxelMesh.position.x - position.x;
      const dy = voxelMesh.position.y - position.y;
      const dz = voxelMesh.position.z - position.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq > radiusSq) continue;

      const dist = Math.sqrt(distSq);
      const len = Math.max(dist, 1e-6);
      const strength = (1 - dist / radius) * 8;
      fragments.push({
        id: `mock_frag_${voxelMesh.id}`,
        position: { x: voxelMesh.position.x, y: voxelMesh.position.y, z: voxelMesh.position.z },
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
