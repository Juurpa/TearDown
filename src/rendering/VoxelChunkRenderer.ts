import * as THREE from 'three';

export class VoxelChunkRenderer {
  public mesh: THREE.Group;

  constructor() {
    this.mesh = new THREE.Group();
    console.log('[Dev A - Renderer] Voxel-Renderer initialisiert.');
  }

  public createInitialBuilding(width: number, height: number, depth: number): void {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshStandardMaterial({ color: 0x8899aa, roughness: 0.4 });

    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        for (let z = 0; z < depth; z++) {
          const block = new THREE.Mesh(geometry, material);
          block.position.set(x, y + 0.5, z);
          this.mesh.add(block);
        }
      }
    }
  }
}
