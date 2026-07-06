import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
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

  // Building dimensions — single source shared by both agents
  const BUILDING = { width: 12, height: 16, depth: 12 };
  const buildingCenter = new THREE.Vector3(
    (BUILDING.width - 1) / 2,
    BUILDING.height / 2,
    (BUILDING.depth - 1) / 2
  );

  // Three.js Scene Setup
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a24);
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(buildingCenter.x + 22, BUILDING.height + 8, buildingCenter.z + 28);
  camera.lookAt(buildingCenter);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  document.body.appendChild(renderer.domElement);

  const light = new THREE.DirectionalLight(0xffffff, 2);
  light.position.set(20, 40, 20);
  scene.add(light, new THREE.AmbientLight(0x404040, 1.5));

  // Ground plane (visual — the physics ground lives in DEV B)
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(100, 100),
    new THREE.MeshStandardMaterial({ color: 0x22242e, roughness: 0.9 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = 0.5; // flush with the physics ground top surface
  scene.add(ground);

  // Camera controls: drag to orbit, scroll to zoom (clicks still destroy —
  // DEV A's input handler discriminates clicks from drags)
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(buildingCenter);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI / 2 - 0.02; // never below the ground
  controls.minDistance = 5;
  controls.maxDistance = 120;
  controls.update();

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // Initialize Agents
  const devA_Renderer = new VoxelChunkRenderer();
  const devB_Physics = new DestructionPhysics();

  // DEV B initialization + structural model (physics owns structure data)
  await devB_Physics.init();
  devB_Physics.createBuildingData(BUILDING.width, BUILDING.height, BUILDING.depth);
  console.log('[MAIN] DEV B (Physics) initialized');

  // DEV A: Create initial structure and setup input handling
  devA_Renderer.createInitialBuilding(BUILDING.width, BUILDING.height, BUILDING.depth);
  devA_Renderer.setupInputHandling(camera);
  scene.add(devA_Renderer.mesh);
  console.log('[MAIN] DEV A (Renderer) initialized with click input');

  // Main Loop — deterministic per-frame order:
  //   1. DEV B steps physics (enqueues step_complete)
  //   2. Bus flush: THE single controlled delivery point per frame.
  //      Queued input → DEV B fragmentation → destruction/transform events
  //      → DEV A applies them. No listener ever runs on an emitter's stack.
  //   3. DEV A fallback animation + HUD, camera damping, render
  const bus = globalEventBus;
  const clock = new THREE.Clock();
  function animate() {
    requestAnimationFrame(animate);
    const deltaTime = Math.min(clock.getDelta(), 0.1); // clamp against tab-switch spikes

    devB_Physics.stepPhysics();
    bus.flush();
    devA_Renderer.update(deltaTime);
    controls.update();
    renderer.render(scene, camera);
  }

  animate();
}

bootstrap().catch(console.error);
