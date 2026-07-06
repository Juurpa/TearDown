import * as THREE from 'three';
import { VoxelChunkRenderer } from './rendering/VoxelChunkRenderer';
import { DestructionPhysics } from './physics/DestructionPhysics';

async function bootstrap() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a24);
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(10, 10, 15);
  camera.lookAt(2, 2, 2);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  const light = new THREE.DirectionalLight(0xffffff, 2);
  light.position.set(20, 40, 20);
  scene.add(light, new THREE.AmbientLight(0x404040, 1.5));

  const devA_Renderer = new VoxelChunkRenderer();
  const devB_Physics = new DestructionPhysics();

  await devB_Physics.init();

  devA_Renderer.createInitialBuilding(5, 10, 5);
  scene.add(devA_Renderer.mesh);

  document.getElementById('info')!.innerText = 'ENGINE RUNNING: Linksklick zum Zerstören (Bald verfügbar)';

  function animate() {
    requestAnimationFrame(animate);
    devB_Physics.stepPhysics();
    renderer.render(scene, camera);
  }

  animate();
}

bootstrap().catch(console.error);
