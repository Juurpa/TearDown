import RAPIER from '@dimforge/rapier3d-compat';
import {
  globalEventBus,
  EventType,
  Fragment,
  DestructionEvent,
  WorldState,
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
 * - emit:    physics:step_complete { ..., fragmentTransforms } → drives fragment meshes
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
  // Key "x|y|z" → world position of voxel center.
  private voxels = new Map<string, { x: number; y: number; z: number }>();

  // PHASE1-B3: fragmentId → RAPIER body
  private fragmentBodies = new Map<string, RAPIER.RigidBody>();

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
    globalEventBus.subscribe(EventType.USER_DESTRUCTION_INPUT, async (msg) => {
      const { worldPosition, radius, force } = msg.payload as {
        worldPosition: { x: number; y: number; z: number };
        radius: number;
        force: number;
      };
      await this.handleDestructionInput(worldPosition, radius, force);
    });

    // Announce world configuration (DEV A reads gravity from this — never hardcoded there)
    await globalEventBus.emit(
      EventType.WORLD_STATE_CHANGED,
      this.buildWorldState(),
      'DEV_B'
    );

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
          this.voxels.set(this.voxelKey(pos), pos);
        }
      }
    }
    console.log(`[DEV B] Structural model: ${this.voxels.size} voxels registered`);
  }

  // ==========================================================================
  // PHASE1-B2 — FRAGMENT DETECTION
  // ==========================================================================

  private detectFragments(
    worldPosition: { x: number; y: number; z: number },
    radius: number,
    force: number
  ): Fragment[] {
    const fragments: Fragment[] = [];

    for (const [key, voxel] of this.voxels) {
      const dx = voxel.x - worldPosition.x;
      const dy = voxel.y - worldPosition.y;
      const dz = voxel.z - worldPosition.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

      if (distance > radius) continue;

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
        position: { x: voxel.x, y: voxel.y, z: voxel.z },
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

    return fragments;
  }

  // ==========================================================================
  // PHASE1-B1 — DESTRUCTION EVENT EMISSION
  // ==========================================================================

  private async handleDestructionInput(
    worldPosition: { x: number; y: number; z: number },
    radius: number,
    force: number
  ): Promise<void> {
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

    await globalEventBus.emit(EventType.DESTRUCTION_TRIGGERED, event, 'DEV_B', 'HIGH');

    // Announce each fragment → DEV A switches its mesh to physics-driven
    for (const fragment of fragments) {
      await globalEventBus.emit(EventType.FRAGMENT_CREATED, fragment, 'DEV_B');
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
    }
  }

  // ==========================================================================
  // PHYSICS STEP — called synchronously every frame from main.ts
  // ==========================================================================

  public stepPhysics(): void {
    if (!this.world) return;

    this.world.step();
    this.frameCount++;

    // Collect fragment transforms + cull bodies below the kill plane
    const fragmentTransforms: Record<
      string,
      { position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number; w: number } }
    > = {};
    const toRemove: string[] = [];

    for (const [id, body] of this.fragmentBodies) {
      const t = body.translation();
      if (t.y < PHYSICS_CONFIG.killPlaneY) {
        toRemove.push(id);
        continue;
      }
      const r = body.rotation();
      fragmentTransforms[id] = {
        position: { x: t.x, y: t.y, z: t.z },
        rotation: { x: r.x, y: r.y, z: r.z, w: r.w },
      };
    }

    for (const id of toRemove) {
      const body = this.fragmentBodies.get(id)!;
      this.world.removeRigidBody(body);
      this.fragmentBodies.delete(id);
    }

    // Fire-and-forget: never block the frame on event dispatch
    void globalEventBus.emit(
      EventType.PHYSICS_STEP_COMPLETE,
      {
        frameCount: this.frameCount,
        time: this.frameCount / 60,
        worldState: this.buildWorldState(),
        fragmentTransforms,
      },
      'DEV_B'
    );
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

  private voxelKey(pos: { x: number; y: number; z: number }): string {
    return `${pos.x}|${pos.y}|${pos.z}`;
  }

  public getVoxelCount(): number {
    return this.voxels.size;
  }

  public getActiveFragmentCount(): number {
    return this.fragmentBodies.size;
  }
}
