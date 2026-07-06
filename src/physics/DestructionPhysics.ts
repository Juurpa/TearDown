import RAPIER from '@dimforge/rapier3d-compat';
import {
  globalEventBus,
  EventType,
  Fragment,
  DestructionEvent,
  WorldState,
  FragmentTransform,
  PhysicsStepPayload,
} from '../shared/sync-protocol';

/**
 * DEV B — Physics & Destruction
 *
 * Responsibilities:
 * - RAPIER3D world simulation (gravity, collisions)
 * - Structural voxel data (physics is the source of truth for structure)
 * - Fragment detection on destruction input                 [PHASE1-B2]
 * - Destruction event emission to DEV A                     [PHASE1-B1]
 * - Dynamic rigid bodies for fragments + per-frame sync     [PHASE1-B3]
 *
 * Communication with DEV A: ONLY via SyncEventBus (see CLAUDE.md).
 * Contract with DEV A:
 * - listen:  render:destruction_input { worldPosition, radius, force }
 * - emit:    physics:destruction_triggered (DestructionEvent, HIGH)
 * - emit:    physics:fragment_created (Fragment) → DEV A marks mesh physics-driven
 * - emit:    physics:step_complete (PhysicsStepPayload) → drives fragment meshes,
 *            announces settled (now static) and culled (kill-plane) fragments
 *
 * Performance contract (skill rules R3/R4/R5):
 * - stepPhysics() allocates NOTHING per frame: transforms are pooled per
 *   fragment, the step payload object is reused across frames (valid only
 *   during the flush it is delivered in).
 * - Blast queries iterate only the (2r)^3 cells around the impact via keyed
 *   lookups — never the whole voxel grid.
 * - Debris that falls asleep is retired to a FIXED body (stays tangible as
 *   static rubble) and leaves the per-frame loop, so cost tracks the AWAKE
 *   set, not cumulative destruction.
 */

// Configurable physics constants (no magic numbers inline)
const PHYSICS_CONFIG = {
  gravity: { x: 0.0, y: -9.81, z: 0.0 },
  voxelSize: 1.0,
  voxelMass: 1.0,
  fragmentHalfExtent: 0.25, // matches DEV A's FRAGMENT_SIZE 0.5
  forceToVelocity: 0.08,    // impulse scaling: force 100 → max 8 m/s at impact center
  upwardKick: 2.0,          // debris pops slightly upward, like real rubble
  killPlaneY: -25,          // remove bodies that fell off the world
  restitution: 0.3,
  friction: 0.8,
};

export class DestructionPhysics {
  private world!: RAPIER.World;

  // Structural voxel occupancy — physics-side model of the building.
  // Key "x|y|z" → world position of voxel center. Doubles as a spatial hash:
  // integer x/z, y = gridY + 0.5.
  private voxels = new Map<string, { x: number; y: number; z: number }>();

  // PHASE1-B3: fragmentId → RAPIER body (awake bodies only — settled bodies
  // are converted to FIXED and leave this map)
  private fragmentBodies = new Map<string, RAPIER.RigidBody>();

  // R3: transform objects are allocated ONCE per fragment (event path) and
  // mutated in place every frame — zero per-frame allocations.
  private transformPool = new Map<string, FragmentTransform>();

  // R3: the step payload is a single reusable object. Valid only during the
  // flush() it is delivered in — DEV A copies values immediately.
  private readonly stepPayload: PhysicsStepPayload = {
    frameCount: 0,
    time: 0,
    worldState: {
      frameCount: 0,
      time: 0,
      gravity: PHYSICS_CONFIG.gravity,
      activeFragmentCount: 0,
    },
    fragmentTransforms: {},
    settledFragments: [],
    culledFragments: [],
  };

  private frameCount = 0;
  private fragmentIdCounter = 0;

  public async init(): Promise<void> {
    await RAPIER.init();
    this.world = new RAPIER.World(PHYSICS_CONFIG.gravity);

    // Static ground plane — top surface at y = 0.5, flush with the lowest voxel row
    const groundCollider = RAPIER.ColliderDesc.cuboid(50.0, 0.5, 50.0)
      .setFriction(PHYSICS_CONFIG.friction)
      .setRestitution(PHYSICS_CONFIG.restitution);
    this.world.createCollider(groundCollider);

    // PHASE1-B1: listen for destruction requests from DEV A
    globalEventBus.subscribe(EventType.USER_DESTRUCTION_INPUT, (msg) => {
      const { worldPosition, radius, force } = msg.payload as {
        worldPosition: { x: number; y: number; z: number };
        radius: number;
        force: number;
      };
      this.handleDestructionInput(worldPosition, radius, force);
    });

    // Announce world configuration (DEV A reads gravity from this — never hardcoded there)
    void globalEventBus.emit(EventType.WORLD_STATE_CHANGED, this.buildWorldState(), 'DEV_B');

    console.log('[DEV B] Rapier3D Physik-Engine startklar.');
  }

  /**
   * Mirror of the building the renderer creates — called from main.ts with the
   * SAME dimensions. Physics owns structural data; DEV A only draws it.
   */
  public createBuildingData(width: number, height: number, depth: number): void {
    this.voxels.clear();
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        for (let z = 0; z < depth; z++) {
          const pos = { x, y: y + 0.5, z };
          this.voxels.set(this.voxelKey(pos.x, pos.y, pos.z), pos);
        }
      }
    }
    console.log(`[DEV B] Structural model: ${this.voxels.size} voxels registered`);
  }

  // ==========================================================================
  // PHASE1-B2 — FRAGMENT DETECTION
  // R4: bounded lookup — iterates only the cells inside the blast AABB via
  // keyed Map access. A radius-2.5 click touches ~216 cells regardless of
  // whether the building has 250 or 1,000,000 voxels.
  // ==========================================================================

  private detectFragments(
    worldPosition: { x: number; y: number; z: number },
    radius: number,
    force: number
  ): Fragment[] {
    const fragments: Fragment[] = [];
    const radiusSq = radius * radius;

    // Voxel centers live at integer x/z and y = gridY + 0.5.
    const minX = Math.ceil(worldPosition.x - radius);
    const maxX = Math.floor(worldPosition.x + radius);
    const minGY = Math.ceil(worldPosition.y - radius - 0.5);
    const maxGY = Math.floor(worldPosition.y + radius - 0.5);
    const minZ = Math.ceil(worldPosition.z - radius);
    const maxZ = Math.floor(worldPosition.z + radius);

    for (let x = minX; x <= maxX; x++) {
      for (let gy = minGY; gy <= maxGY; gy++) {
        const y = gy + 0.5;
        for (let z = minZ; z <= maxZ; z++) {
          const key = this.voxelKey(x, y, z);
          const voxel = this.voxels.get(key);
          if (!voxel) continue;

          const dx = x - worldPosition.x;
          const dy = y - worldPosition.y;
          const dz = z - worldPosition.z;
          const distSq = dx * dx + dy * dy + dz * dz;
          if (distSq > radiusSq) continue;

          const distance = Math.sqrt(distSq);

          // Force falloff: full at impact center, zero at blast edge
          const falloff = 1 - distance / radius;
          const speed = force * falloff * PHYSICS_CONFIG.forceToVelocity;

          // Direction: radially away from impact (normalized, safe at distance≈0)
          const len = Math.max(distance, 1e-6);
          const dirX = dx / len;
          const dirY = dy / len;
          const dirZ = dz / len;

          fragments.push({
            id: `frag_${this.fragmentIdCounter++}`,
            position: { x, y, z },
            velocity: {
              x: dirX * speed,
              y: dirY * speed + PHYSICS_CONFIG.upwardKick * falloff,
              z: dirZ * speed,
            },
            mass: PHYSICS_CONFIG.voxelMass,
          });

          // Voxel is destroyed → remove from structural model
          this.voxels.delete(key);
        }
      }
    }

    return fragments;
  }

  // ==========================================================================
  // PHASE1-B1 — DESTRUCTION EVENT EMISSION
  // ==========================================================================

  private handleDestructionInput(
    worldPosition: { x: number; y: number; z: number },
    radius: number,
    force: number
  ): void {
    const fragments = this.detectFragments(worldPosition, radius, force);
    console.log(`[DEV B] Destruction input @(${worldPosition.x.toFixed(1)}, ${worldPosition.y.toFixed(1)}, ${worldPosition.z.toFixed(1)}) → ${fragments.length} fragments`);

    if (fragments.length === 0) return;

    // PHASE1-B3: give every fragment a real physics body BEFORE announcing,
    // so transforms are ready on the very next step_complete
    this.createFragmentBodies(fragments);

    const event: DestructionEvent = {
      chunkId: 'chunk_0',
      position: worldPosition,
      radius,
      force,
      fragments,
    };

    // Enqueue-only emits — delivered in the same flush() cycle
    void globalEventBus.emit(EventType.DESTRUCTION_TRIGGERED, event, 'DEV_B', 'HIGH');
    for (const fragment of fragments) {
      void globalEventBus.emit(EventType.FRAGMENT_CREATED, fragment, 'DEV_B');
    }
  }

  // ==========================================================================
  // PHASE1-B3 — FRAGMENT PHYSICS BODIES
  // ==========================================================================

  private createFragmentBodies(fragments: Fragment[]): void {
    for (const fragment of fragments) {
      const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(fragment.position.x, fragment.position.y, fragment.position.z)
        .setLinvel(fragment.velocity.x, fragment.velocity.y, fragment.velocity.z)
        .setAngvel({
          x: fragment.velocity.z * 0.5, // tumble derived from lateral motion (deterministic)
          y: fragment.velocity.x * 0.3,
          z: fragment.velocity.x * -0.5,
        });

      const body = this.world.createRigidBody(bodyDesc);

      const half = PHYSICS_CONFIG.fragmentHalfExtent;
      const colliderDesc = RAPIER.ColliderDesc.cuboid(half, half, half)
        .setMass(fragment.mass)
        .setFriction(PHYSICS_CONFIG.friction)
        .setRestitution(PHYSICS_CONFIG.restitution);
      this.world.createCollider(colliderDesc, body);

      this.fragmentBodies.set(fragment.id, body);

      // R3: allocate the transform object once, here on the event path;
      // stepPhysics() only mutates it.
      const transform: FragmentTransform = {
        position: { x: fragment.position.x, y: fragment.position.y, z: fragment.position.z },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      };
      this.transformPool.set(fragment.id, transform);
      this.stepPayload.fragmentTransforms[fragment.id] = transform;
    }
  }

  // ==========================================================================
  // PHYSICS STEP — called synchronously every frame from main.ts
  // R3: zero per-frame allocations (pooled transforms, reused payload/arrays).
  // R5: settled debris retires to a FIXED body (static, still tangible) and
  //     leaves this loop; kill-plane culls remove bodies entirely.
  // ==========================================================================

  public stepPhysics(): void {
    if (!this.world) return;

    this.world.step();
    this.frameCount++;

    const payload = this.stepPayload;
    payload.settledFragments.length = 0;
    payload.culledFragments.length = 0;

    for (const [id, body] of this.fragmentBodies) {
      const t = body.translation();

      if (t.y < PHYSICS_CONFIG.killPlaneY) {
        payload.culledFragments.push(id);
        this.world.removeRigidBody(body);
        this.retireFragment(id);
        continue;
      }

      if (body.isSleeping()) {
        // Rubble at rest: freeze as a FIXED body so later debris still
        // collides with it, but stop paying per-frame cost for it.
        body.setBodyType(RAPIER.RigidBodyType.Fixed, false);
        payload.settledFragments.push(id);
        this.retireFragment(id);
        continue;
      }

      const r = body.rotation();
      const transform = this.transformPool.get(id)!;
      transform.position.x = t.x;
      transform.position.y = t.y;
      transform.position.z = t.z;
      transform.rotation.x = r.x;
      transform.rotation.y = r.y;
      transform.rotation.z = r.z;
      transform.rotation.w = r.w;
    }

    payload.frameCount = this.frameCount;
    payload.time = this.frameCount / 60;
    payload.worldState.frameCount = this.frameCount;
    payload.worldState.time = payload.time;
    payload.worldState.activeFragmentCount = this.fragmentBodies.size;

    if (payload.settledFragments.length > 0) {
      console.log(`[DEV B] ${payload.settledFragments.length} fragments settled (now static rubble)`);
    }

    // Enqueue-only: delivered by the bus flush right after this call in main.ts
    void globalEventBus.emit(EventType.PHYSICS_STEP_COMPLETE, payload, 'DEV_B');
  }

  /** Removes a fragment from all per-frame bookkeeping (body map, pool, payload). */
  private retireFragment(id: string): void {
    this.fragmentBodies.delete(id);
    this.transformPool.delete(id);
    delete this.stepPayload.fragmentTransforms[id];
  }

  // ==========================================================================
  // HELPERS
  // ==========================================================================

  private buildWorldState(): WorldState {
    return {
      frameCount: this.frameCount,
      time: this.frameCount / 60,
      gravity: PHYSICS_CONFIG.gravity,
      activeFragmentCount: this.fragmentBodies.size,
    };
  }

  private voxelKey(x: number, y: number, z: number): string {
    return `${x}|${y}|${z}`;
  }

  public getVoxelCount(): number {
    return this.voxels.size;
  }

  public getActiveFragmentCount(): number {
    return this.fragmentBodies.size;
  }
}
