import RAPIER from '@dimforge/rapier3d-compat';

export class DestructionPhysics {
  private world!: RAPIER.World;

  public async init(): Promise<void> {
    await RAPIER.init();
    const gravity = { x: 0.0, y: -9.81, z: 0.0 };
    this.world = new RAPIER.World(gravity);

    const groundCollider = RAPIER.ColliderDesc.cuboid(50.0, 0.5, 50.0);
    this.world.createCollider(groundCollider);

    console.log('[Dev B - Physics] Rapier3D Physik-Engine startklar.');
  }

  public stepPhysics(): void {
    if (this.world) {
      this.world.step();
    }
  }
}
