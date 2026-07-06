# TearDown — Physics Destruction Game
**Branch:** `claude/game-physics-simulation-20q4yj`  
**Status:** Active Dual-Agent Development  
**Last Updated:** 2026-07-06

---

## 🎯 PROJECT VISION

**Realistic Physics-Based Destruction Game** with voxel-based destructible structures and accurate RAPIER3D physics simulation.

### Core Pillars
- 🔬 **Physics Accuracy** — Gravity-correct, collision-precise, deterministic
- 🎨 **Visual Fidelity** — Real-time voxel rendering with Three.js
- ⚡ **Performance** — 60+ FPS, optimized chunks, efficient rendering
- 🎮 **Gameplay** — Click-to-destroy, realistic fragmentation

---

## 👥 DUAL-AGENT ARCHITECTURE

### **DEV A** — Rendering & Visualization
- **Primary Files:** `src/rendering/VoxelChunkRenderer.ts`
- **Engine:** Three.js
- **Responsibilities:**
  - Voxel mesh generation and rendering
  - Fragment visualization after destruction
  - User input handling (clicks → destruction requests)
  - Camera and lighting management
  - Performance optimization (instancing, LOD)

### **DEV B** — Physics & Destruction
- **Primary Files:** `src/physics/DestructionPhysics.ts`
- **Engine:** RAPIER3D
- **Responsibilities:**
  - Physics simulation (gravity, collisions, constraints)
  - Destruction logic and fragmentation
  - Impact detection
  - Structural integrity simulation
  - Force calculations

---

## 🔄 SYNCHRONIZATION PROTOCOL

### Non-Blocking Communication Pattern

```
SYNCHRONIZATION = Event-Based Pub/Sub (async, queued)
BLOCKING = ❌ NEVER
DIRECT STATE ACCESS = ❌ NEVER
COMMUNICATION METHOD = SyncEventBus (src/shared/sync-protocol.ts)
```

### Per-Frame Execution Order

```
Frame N:
├─ 1. DEV B: stepPhysics() [SYNC]
├─ 2. DEV B: emit 'physics:step_complete' [ASYNC]
├─ 3. DEV B: detectDestructions() + emit 'physics:destruction_triggered' [ASYNC, HIGH PRIORITY]
├─ 4. DEV A: onPhysicsUpdate() listener executes [ASYNC]
├─ 5. DEV A: renderer.render() [SYNC]
├─ 6. DEV A: onUserInput() → emit 'render:destruction_input' [ASYNC]
└─ 7. DEV B: listener executes in Frame N+1

Result: Zero blocking, parallel async execution paths
```

### Message Priority System

```
HIGH PRIORITY (Destructions)   → Process immediately, queue front
NORMAL PRIORITY (Updates)      → Queue normally
LOW PRIORITY (Diagnostics)     → Process when queue clear

↓ Prevents destruction delays, ensures responsive gameplay
```

---

## 📡 EVENT INTERFACES

### DEV A → DEV B

```typescript
// User clicks to destroy
'render:destruction_input' : {
  worldPosition: {x, y, z},
  radius: number,
  force: number
}

// Chunk boundaries change (for physics bounds)
'render:chunk_bounds_updated' : {
  chunkId: string,
  bounds: ChunkBounds
}

// DEV A ready to receive updates
'render:ready' : {}
```

### DEV B → DEV A

```typescript
// Physics step complete (every frame)
'physics:step_complete' : {
  frameCount: number,
  time: number,
  worldState: WorldState
}

// Destruction event triggered
'physics:destruction_triggered' : {
  chunkId: string,
  position: {x, y, z},
  radius: number,
  fragments: Fragment[]
}

// Fragment created from destruction
'physics:fragment_created' : {
  fragmentId: string,
  position: {x, y, z},
  velocity: {x, y, z},
  mass: number
}

// World state changed (gravity, constraints, etc)
'physics:world_state_changed' : {
  worldState: WorldState
}
```

---

## 🏗️ FILE STRUCTURE

```
TearDown/
├── src/
│   ├── main.ts                          [Orchestration - both agents read]
│   ├── physics/
│   │   └── DestructionPhysics.ts        [DEV B primary]
│   ├── rendering/
│   │   └── VoxelChunkRenderer.ts        [DEV A primary]
│   └── shared/
│       └── sync-protocol.ts             [BOTH - Central sync system]
├── .dev-sync.json                       [Configuration - BOTH read]
├── CLAUDE.md                            [This file - Agent guide]
├── package.json
├── tsconfig.json
└── vite.config.ts
```

---

## 🚀 QUICK START GUIDE FOR AGENTS

### For DEV A (Renderer)

1. **Listen for Physics Updates**
   ```typescript
   globalEventBus.subscribe(EventType.PHYSICS_STEP_COMPLETE, async (msg) => {
     const worldState = msg.payload as WorldState;
     // Update camera, update lighting, etc
   });
   ```

2. **Handle Destruction Events**
   ```typescript
   globalEventBus.subscribe(EventType.DESTRUCTION_TRIGGERED, async (msg) => {
     const event = msg.payload as DestructionEvent;
     // Remove voxels from mesh
     // Create fragment meshes
     // Animate destruction
   });
   ```

3. **Send User Input**
   ```typescript
   onMouseClick(position) {
     globalEventBus.emit(
       EventType.USER_DESTRUCTION_INPUT,
       { worldPosition: position, radius: 5, force: 100 },
       'DEV_A',
       'HIGH'
     );
   }
   ```

### For DEV B (Physics)

1. **Initialize Physics World**
   ```typescript
   const bus = initSyncBus();
   await RAPIER.init();
   this.world = new RAPIER.World({x: 0, y: -9.81, z: 0});
   await bus.emit(EventType.WORLD_STATE_CHANGED, {...}, 'DEV_B');
   ```

2. **Step Physics & Emit Events**
   ```typescript
   async stepPhysics() {
     this.world.step();
     await globalEventBus.emit(
       EventType.PHYSICS_STEP_COMPLETE,
       { frameCount, time, worldState },
       'DEV_B'
     );
     
     const destructions = this.detectDestructions();
     for (const d of destructions) {
       await globalEventBus.emit(
         EventType.DESTRUCTION_TRIGGERED,
         d,
         'DEV_B',
         'HIGH'  // Priority!
       );
     }
   }
   ```

3. **Listen for Destruction Requests**
   ```typescript
   globalEventBus.subscribe(EventType.USER_DESTRUCTION_INPUT, async (msg) => {
     const { worldPosition, radius, force } = msg.payload;
     // Apply force at position
     // Trigger fragmentation
     // Emit DESTRUCTION_TRIGGERED
   });
   ```

---

## ⚙️ INTEGRATION CHECKLIST

### Current Status
- [x] Sync protocol defined (`sync-protocol.ts`)
- [x] Event types specified
- [x] SyncEventBus implemented
- [x] Configuration file created (`.dev-sync.json`)
- [ ] Main loop updated with SyncEventBus initialization
- [ ] VoxelChunkRenderer integrated with listeners
- [ ] DestructionPhysics integrated with emitters
- [ ] User input handling added
- [ ] Fragment visualization implemented
- [ ] Testing & optimization

### To Implement (Task Order)
1. **DEV B:** Add event emissions to DestructionPhysics
2. **DEV A:** Add event listeners to VoxelChunkRenderer
3. **Both:** Integrate SyncEventBus in main.ts
4. **DEV A:** Add click-to-destroy input handler
5. **DEV B:** Implement fragment detection logic
6. **DEV A:** Implement fragment mesh rendering
7. **Both:** End-to-end testing

---

## 🧪 TESTING STRATEGY

### Per-Agent Testing
- **DEV A:** Renders arbitrary destruction events (mock data)
- **DEV B:** Triggers destructions without rendering (headless)
- **Integration:** Both agents working together, click-to-destroy flow

### Performance Benchmarks
- Physics: < 5ms per frame (16.67ms @ 60FPS)
- Rendering: < 11ms per frame (60 FPS target)
- Memory: < 500MB for 50x50x50 voxel building

---

## 🛠️ RULES FOR DUAL-AGENT DEVELOPMENT

### ✅ DO
- Emit events via SyncEventBus
- Listen for events asynchronously
- Use message interfaces (Fragment, DestructionEvent, etc)
- Check `.dev-sync.json` for role definitions
- Version and prioritize messages
- Keep agent responsibilities isolated
- Document event contracts in sync-protocol.ts

### ❌ DON'T
- Block one agent waiting for another
- Access objects directly between agents
- Synchronously call methods across agents
- Ignore message priorities
- Create race conditions with shared state
- Hardcode physics constants (use WorldState)
- Hardcode rendering parameters (use events)

---

## 📋 CURRENT BRANCH INFO

```
Branch: claude/game-physics-simulation-20q4yj
Base: main
Status: WIP - Dual-agent framework ready
Next Milestone: Fragment destruction proof-of-concept
```

**To start work:** Read `.dev-sync.json` and this file. Check your role's event interfaces. Start with integration tasks in the checklist.

---

## 🔗 REFERENCES

- **RAPIER3D Docs:** https://rapier.rs/docs/
- **Three.js Docs:** https://threejs.org/docs/
- **Sync Protocol:** `src/shared/sync-protocol.ts`
- **Config:** `.dev-sync.json`
