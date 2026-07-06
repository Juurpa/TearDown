import * as THREE from 'three';
import { globalEventBus, EventType } from '../shared/sync-protocol';

export class VoxelChunkRenderer {
  public mesh: THREE.Group;
  private camera?: THREE.Camera;
  private raycaster = new THREE.Raycaster();

  constructor() {
    this.mesh = new THREE.Group();
    console.log('[DEV A] Voxel-Renderer initialisiert.');
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

  public setupInputHandling(camera: THREE.Camera): void {
    this.camera = camera;

    window.addEventListener('click', (event: MouseEvent) => {
      if (!this.camera) return;

      // Convert screen coordinates to normalized device coordinates
      const screenPos = new THREE.Vector2(
        (event.clientX / window.innerWidth) * 2 - 1,
        -(event.clientY / window.innerHeight) * 2 + 1
      );

      // Raycasting: find intersections with voxel mesh
      this.raycaster.setFromCamera(screenPos, this.camera);
      const intersects = this.raycaster.intersectObjects(this.mesh.children);

      if (intersects.length > 0) {
        const hitPoint = intersects[0].point;

        // Emit destruction request with HIGH priority for responsiveness
        globalEventBus.emit(
          EventType.USER_DESTRUCTION_INPUT,
          {
            worldPosition: { x: hitPoint.x, y: hitPoint.y, z: hitPoint.z },
            radius: 5,
            force: 100
          },
          'DEV_A',
          'HIGH'
        );

        console.log('[DEV A] Destruction input emitted at:', {
          x: hitPoint.x.toFixed(2),
          y: hitPoint.y.toFixed(2),
          z: hitPoint.z.toFixed(2)
        });
      }
    });

    console.log('[DEV A] Input handling initialized - Click to destroy enabled');
  }
}
