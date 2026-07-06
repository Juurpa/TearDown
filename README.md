# TearDown — Physics-Based Destruction Game

A realistic, physics-driven destruction game engine built with **RAPIER3D** (physics simulation) and **Three.js** (3D rendering). Click buildings to destroy them and watch voxels fragment and fall with accurate physics.

![Status](https://img.shields.io/badge/Status-In%20Development-yellow) ![Branch](https://img.shields.io/badge/Branch-claude%2Fgame--physics--simulation-blue) ![Physics](https://img.shields.io/badge/Physics-RAPIER3D-success) ![Rendering](https://img.shields.io/badge/Rendering-Three.js-blue)

---

## 🎮 What Is This?

**TearDown** is a game engine where:
- 🏢 Buildings are made of **voxels** (3D cubes)
- 💥 Click to **destroy** voxels with physics-based force
- 📉 Fragments fall realistically with **gravity & collisions**
- ⚡ Everything runs in **real-time at 60 FPS**
- 🎯 Physics simulation is **accurate & deterministic**

The entire game is driven by a **Dual-Agent AI Architecture** where two specialized agents (DEV A for rendering, DEV B for physics) work in parallel without blocking each other.

---

## 🏗️ Architecture Overview

### Two Specialized Agents

```
┌─────────────────────────────────────────────────────────────┐
│                   TearDown Game Engine                      │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              │               │               │
              ▼               ▼               ▼
        ┌──────────┐    ┌─────────┐    ┌──────────┐
        │  DEV A   │    │  SYNC   │    │  DEV B   │
        │Renderer  │◄──►│ EventBus│◄──►│ Physics  │
        └──────────┘    └─────────┘    └──────────┘
        
        Three.js         Async Events      RAPIER3D
        VoxelChunks      Non-Blocking      Physics
        Fragments        Priority Queue     Destruction
        UI/Input         Type-Safe Msgs    Fragmentation
```

### **DEV A — Rendering & Visualization**
- **What it does:** Renders voxels, handles user input, visualizes destruction
- **Technology:** Three.js WebGL renderer
- **Key Components:**
  - `VoxelChunkRenderer` — Generates and manages voxel meshes
  - User input handling — Click detection and raycasting
  - Fragment rendering — Visualizes broken voxels falling
  - Camera & lighting — Scene setup and visual effects

### **DEV B — Physics & Destruction**
- **What it does:** Simulates physics, detects collisions, fragments voxels
- **Technology:** RAPIER3D physics engine (WebAssembly)
- **Key Components:**
  - `DestructionPhysics` — World setup and physics stepping
  - Fragment detection — Calculates which voxels break
  - Physics bodies — Dynamic rigid bodies for fragments
  - Constraints — Structural integrity between voxels

### **Sync Layer — Non-Blocking Communication**
- **What it does:** Enables DEV A and DEV B to communicate asynchronously
- **Technology:** Event-based pub/sub system
- **Key Features:**
  - `SyncEventBus` — Central event dispatcher
  - Priority queue — HIGH priority for destruction events
  - Message versioning — Prevents race conditions
  - Type safety — TypeScript interfaces for all messages

---

## ⚙️ How It Works (Per-Frame Execution)

Every frame (at 60 FPS), the engine executes in this order:

```
Frame Start (0ms)
│
├─ [SYNC] DEV B: stepPhysics()
│  └─ World.step() — Update physics, resolve collisions
│     └─ Time: ~2-5ms
│
├─ [ASYNC] DEV B: emit 'physics:step_complete'
│  └─ Queued event — Non-blocking, no wait
│
├─ [SYNC] DEV A: renderer.render(scene, camera)
│  └─ Render all meshes, fragments, lighting
│     └─ Time: ~5-11ms
│
├─ [ASYNC] DEV A: onUserInput()
│  └─ Check for clicks, raycasting
│
├─ [ASYNC] DEV A: emit 'render:destruction_input'
│  └─ User clicked → queued destruction request (HIGH PRIORITY)
│
└─ [EVENT LOOP] Process queued events (next frame)
   ├─ DEV B listens to destruction input
   ├─ Fragments created
   ├─ 'physics:destruction_triggered' emitted
   └─ DEV A renders destruction (next frame)

Total Frame Time: ~16.67ms (60 FPS)
Physics: ~5ms | Rendering: ~11ms | Event Overhead: <1ms
```

### Key Points

- **No blocking:** DEV A never waits for DEV B, vice versa
- **Async events:** Communication happens via queued messages
- **Priority queue:** Destruction events processed first (responsive gameplay)
- **Per-frame loop:** `requestAnimationFrame` in `main.ts` orchestrates both

---

## 📡 Communication: Events Flow

### DEV A → DEV B (User Input)

```typescript
// User clicks on voxel at world position
onMouseClick(screenPos) {
  const worldPos = raycaster.getWorldPos(screenPos);
  globalEventBus.emit(
    EventType.USER_DESTRUCTION_INPUT,
    { worldPosition, radius: 5, force: 100 },
    'DEV_A',
    'HIGH'  // High priority → processed first
  );
}

// DEV B listens (next physics step)
globalEventBus.subscribe(EventType.USER_DESTRUCTION_INPUT, async (msg) => {
  const { worldPosition, radius, force } = msg.payload;
  applyDestructionForce(worldPosition, radius, force);
  detectFragments();
  emit('physics:destruction_triggered', fragments, 'HIGH');
});
```

### DEV B → DEV A (Physics Updates)

```typescript
// Every physics step, DEV B emits update
async stepPhysics() {
  this.world.step();
  
  await globalEventBus.emit(
    EventType.PHYSICS_STEP_COMPLETE,
    { frameCount, time, worldState },
    'DEV_B'
  );
}

// DEV A listens
globalEventBus.subscribe(EventType.PHYSICS_STEP_COMPLETE, async (msg) => {
  const { worldState } = msg.payload;
  updateCameraPosition(worldState);
  updateLighting(worldState);
});

// Destruction event received
globalEventBus.subscribe(EventType.DESTRUCTION_TRIGGERED, async (msg) => {
  const { fragments, position } = msg.payload;
  removeVoxelsFromMesh(position);
  createFragmentMeshes(fragments);
  animateFragmentsFalling(fragments);
});
```

---

## 🎯 Current Development Status

### ✅ Phase 1 — COMPLETE (playable)
- Physics engine initialization (RAPIER3D) + structural voxel model
- Click-to-destroy: DDA grid-raymarch picking → fragmentation → falling debris
- Dual-agent sync system (SyncEventBus, enqueue-only + per-frame flush)
- Fragment physics bodies with damping; debris settles into static rubble
- Orbit camera (drag to rotate, scroll to zoom — clicks stay destructive)
- Live HUD (voxel / active debris / rubble counters)

### ✅ Performance Hardening (skill-audit verified)
- InstancedMesh rendering: whole building = 1 draw call, all debris = 1 draw call
- Zero per-frame allocations (pooled transforms, reused payloads, scratch math)
- All voxel queries bounded by blast radius via "x|y|z" spatial hash
- O(1) instance removal (swap-with-last)
- Settled debris retires from all per-frame loops (FIXED bodies, still tangible)

### 🔮 Planned (Phase 2+)
- Constraint-based structural integrity (unsupported voxels collapse)
- Chunked buildings & greedy meshing for city-scale scenes
- Sound effects & particle effects
- Material types (concrete, glass, wood) with distinct fracture behavior

---

## 📂 Project Structure

```
TearDown/
├── README.md                        ← You are here
├── CLAUDE.md                        ← Agent development guide
├── AGENT_TASKS.md                   ← Concrete tasks for Phase 1
├── .dev-sync.json                   ← Dual-agent configuration
│
├── src/
│   ├── main.ts                      ← Game engine entry point
│   │   └─ Initializes SyncEventBus
│   │   └─ Creates scene, renderer, camera
│   │   └─ Main animation loop (60 FPS)
│   │
│   ├── rendering/
│   │   └─ VoxelChunkRenderer.ts     ← DEV A: 3D Visualization
│   │       ├─ Generates voxel meshes (Three.js)
│   │       ├─ Handles user input (clicks)
│   │       ├─ Renders fragments falling
│   │       └─ Subscribes to physics events
│   │
│   ├── physics/
│   │   └─ DestructionPhysics.ts     ← DEV B: Physics Simulation
│   │       ├─ RAPIER3D world setup
│   │       ├─ Physics stepping
│   │       ├─ Fragment detection
│   │       └─ Emits physics events
│   │
│   └── shared/
│       └─ sync-protocol.ts          ← Central Sync System
│           ├─ SyncEventBus (pub/sub)
│           ├─ EventType enum (all event types)
│           ├─ Message interfaces (Fragment, WorldState, etc)
│           ├─ Priority queue logic
│           └─ Global singleton bus
│
├── package.json                     ← Dependencies
├── tsconfig.json                    ← TypeScript config
└── vite.config.ts                   ← Build config
```

---

## 🚀 Getting Started

### Prerequisites
- Node.js 16+
- npm or yarn

### Installation

```bash
npm install
```

### Development Server

```bash
npm run dev
```

Opens at `http://localhost:5173`

### Build for Production

```bash
npm run build
npm run preview
```

---

## 💻 For Developers

### Architecture Documents
- **`CLAUDE.md`** — Complete guide for both DEV A and DEV B agents
  - Sync protocol explanation
  - Event interfaces with payloads
  - Code examples for each agent
  - Integration checklist

- **`AGENT_TASKS.md`** — Development tasks for Phase 1
  - 6 concrete sub-tasks
  - Dependency diagram
  - Task acceptance criteria
  - Execution rules for parallel development

- **`.dev-sync.json`** — Configuration & role definitions
  - DEV A & B responsibilities
  - Event mapping
  - Communication patterns
  - Sync constraints

### Adding Features

1. **Agent Responsibility Check:** Is this DEV A (rendering) or DEV B (physics)?
2. **Event Design:** What events need to be emitted/listened to?
3. **Message Types:** Add interfaces to `sync-protocol.ts`
4. **Implementation:** Update respective agent
5. **Testing:** Test in isolation, then integration

### Code Example: Implementing a Feature

**Goal:** Add impact sounds when voxels break

```typescript
// 1. Add to sync-protocol.ts
export enum EventType {
  AUDIO_PLAY_SOUND = 'audio:play_sound',
}

export interface SoundEvent {
  soundType: 'impact' | 'destruction';
  position: {x, y, z};
  volume: number;
}

// 2. DEV B emits when destruction happens
globalEventBus.emit(
  EventType.AUDIO_PLAY_SOUND,
  {soundType: 'destruction', position, volume: 1.0},
  'DEV_B'
);

// 3. Audio agent listens
globalEventBus.subscribe(EventType.AUDIO_PLAY_SOUND, async (msg) => {
  const event = msg.payload as SoundEvent;
  audioEngine.playSound(event.soundType, event.position, event.volume);
});
```

---

## 🔧 Key Technologies

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Physics** | RAPIER3D | Accurate 3D rigid body physics simulation |
| **Rendering** | Three.js | WebGL 3D graphics rendering |
| **Language** | TypeScript | Type-safe development |
| **Build** | Vite | Fast development server & bundling |
| **Async** | SyncEventBus | Non-blocking inter-agent communication |

---

## 📊 Performance Targets

```
Frame Rate:          60 FPS (16.67ms per frame)
Physics Step:        < 5ms per frame
Rendering:           < 11ms per frame
Event Overhead:      < 1ms per frame

Destruction Events:  Responsive (HIGH priority)
Fragment Limit:      1000+ active fragments
Voxel Grid Size:     100x100x100+ voxels
```

---

## 🎨 Visual System

### Voxel Grid
- **Size:** Configurable (default 5x10x5)
- **Material:** Three.js MeshStandardMaterial
- **Color:** 0x8899aa (blue-gray)
- **Lighting:** Directional + Ambient

### Fragments
- **Creation:** When voxels break (radius-based)
- **Physics:** Dynamic bodies with gravity
- **Visualization:** Individual meshes falling
- **Cleanup:** Auto-removed when out of bounds

### Camera
- **Position:** (10, 10, 15)
- **Look-at:** (2, 2, 2)
- **FOV:** 60°
- **Near/Far:** 0.1 / 1000

---

## 🐛 Debugging

### Enable Logs
```typescript
// In console
localStorage.debug = 'teardown:*';
```

### Check Event Flow
```typescript
// In main.ts or any file
globalEventBus.subscribe('*', (msg) => {
  console.log('EVENT:', msg.type, msg.payload);
});
```

### Physics Debug
```typescript
// In DestructionPhysics.ts
console.log('[Physics] Fragment count:', fragments.length);
console.log('[Physics] World state:', this.world.gravity);
```

---

## 📝 License

MIT

---

## 🤝 Contributing

This project uses a **Dual-Agent Development System**:

1. **DEV A** (Renderer) and **DEV B** (Physics) work in parallel
2. Communication happens via `SyncEventBus` (no blocking)
3. See `CLAUDE.md` and `AGENT_TASKS.md` for contribution guidelines

### Quick Links
- 🏗️ **Architecture:** See `CLAUDE.md`
- 📋 **Tasks:** See `AGENT_TASKS.md`
- ⚙️ **Config:** See `.dev-sync.json`
- 💬 **Sync Protocol:** See `src/shared/sync-protocol.ts`

---

## 🚀 Next Steps

1. Read `CLAUDE.md` to understand the architecture
2. Pick a task from `AGENT_TASKS.md`
3. Implement following the sync protocol
4. Test in isolation, then with the other agent
5. Commit and push to `claude/game-physics-simulation-20q4yj`

**Status:** ✅ Framework ready | ⏳ Phase 1 tasks in progress

---

**Last Updated:** 2026-07-06  
**Branch:** `claude/game-physics-simulation-20q4yj`  
**Maintainer:** TearDown Development Team