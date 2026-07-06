import * as THREE from 'three';
import { VoxelChunkRenderer } from './rendering/VoxelChunkRenderer';
import { DestructionPhysics } from './physics/DestructionPhysics';
import { initSyncBus, globalEventBus } from './shared/sync-protocol';

/**
 * ORCHESTRATION LAYER — Initializes both DEV A (Renderer) and DEV B (Physics)
 * with non-blocking SyncEventBus for efficient async communication.
 *
 * See CLAUDE.md and .dev-sync.json for architecture details.
 */

async function bootstrap() {
  // Initialize sync bus (central nervous system for agents)
  initSyncBus();
  console.log('[MAIN] SyncEventBus initialized - Agents ready to communicate');

  // Three.js Scene Setup
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

  // Initialize Agents
  const devA_Renderer = new VoxelChunkRenderer();
  const devB_Physics = new DestructionPhysics();

  // Building dimensions — single source shared by both agents
  const BUILDING = { width: 5, height: 10, depth: 5 };

  // DEV B initialization + structural model (physics owns structure data)
  await devB_Physics.init();
  devB_Physics.createBuildingData(BUILDING.width, BUILDING.height, BUILDING.depth);
  console.log('[MAIN] DEV B (Physics) initialized');

  // DEV A: Create initial structure and setup input handling
  devA_Renderer.createInitialBuilding(BUILDING.width, BUILDING.height, BUILDING.depth);
  devA_Renderer.setupInputHandling(camera);
  scene.add(devA_Renderer.mesh);
  console.log('[MAIN] DEV A (Renderer) initialized with click input');

  // UI Info
  document.getElementById('info')!.innerText = 'ENGINE RUNNING: Click to destroy (Ready)';

  // Main Loop — Non-blocking async execution
  const clock = new THREE.Clock();
  function animate() {
    requestAnimationFrame(animate);
    const deltaTime = Math.min(clock.getDelta(), 0.1); // clamp against tab-switch spikes

    // DEV B: Physics step (synchronous, core update)
    devB_Physics.stepPhysics();

    // DEV A: Fragment animation & cleanup, then render
    devA_Renderer.update(deltaTime);
    renderer.render(scene, camera);

    // NOTE: Event processing happens asynchronously via SyncEventBus
    // DEV B emits → DEV A listens (next frame or immediate)
    // DEV A emits → DEV B listens (next physics step)
    // No blocking, no waiting
  }

  animate();
}

bootstrap().catch(console.error);
