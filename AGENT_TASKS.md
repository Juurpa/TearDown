# TearDown Development Tasks
**Branch:** `claude/game-physics-simulation-20q4yj`  
**Status:** Ready for Parallel Execution  
**Coordination:** Via SyncEventBus (see CLAUDE.md)

---

## 🎯 CURRENT SPRINT: Click-to-Destroy Proof of Concept

### Phase 1: Event Integration (Non-Blocking Setup)

#### [PHASE1-A1] DEV A: Add Input Listener
- **File:** `src/rendering/VoxelChunkRenderer.ts`
- **Task:** Add click-to-destroy input handler
- **Details:**
  - Listen to window 'click' events
  - Convert screen coordinates to world coordinates (raycasting)
  - Emit `render:destruction_input` event via `globalEventBus`
  - Emit with `priority: 'HIGH'` for responsive destruction
- **Dependencies:** None (sync-protocol.ts ready)
- **Acceptance:** Can click on voxels and receive destruction events
- **Status:** ⏳ TODO

#### [PHASE1-B1] DEV B: Add Destruction Event Emission
- **File:** `src/physics/DestructionPhysics.ts`
- **Task:** Add method to process destruction requests
- **Details:**
  - Subscribe to `render:destruction_input` events
  - Create physics body at impact position with given force/radius
  - Implement basic fragmentation (split voxel grid)
  - Emit `physics:destruction_triggered` event with Fragment array
  - Emit with `priority: 'HIGH'`
- **Dependencies:** PHASE1-B2 (Fragment detection)
- **Acceptance:** Destruction events reach DEV A with fragment data
- **Status:** ⏳ TODO

#### [PHASE1-B2] DEV B: Fragment Detection Logic
- **File:** `src/physics/DestructionPhysics.ts`
- **Task:** Implement sphere-based voxel destruction
- **Details:**
  - Given: world position, radius, force
  - Find all voxels within radius of impact position
  - Create Fragment objects with:
    - `id`: unique identifier
    - `position`: world position of fragment
    - `velocity`: calculated from force and distance
    - `mass`: based on fragment size
  - Return array of Fragment[] for emission
- **Dependencies:** None
- **Acceptance:** Fragment objects properly structured with physics data
- **Status:** ⏳ TODO

#### [PHASE1-A2] DEV A: Handle Destruction Rendering
- **File:** `src/rendering/VoxelChunkRenderer.ts`
- **Task:** Visualize destruction events
- **Details:**
  - Subscribe to `physics:destruction_triggered` events
  - Remove destroyed voxels from the main mesh
  - Create THREE.Mesh for each fragment (with animation)
  - Add falling animation (use fragment velocity from DEV B)
  - Scale down fragments for visual effect
- **Dependencies:** PHASE1-B1 (fragment data from physics)
- **Acceptance:** Click on building → voxels disappear → fragments fall with physics
- **Status:** ⏳ TODO

#### [PHASE1-B3] DEV B: Fragment Physics Bodies
- **File:** `src/physics/DestructionPhysics.ts`
- **Task:** Create RAPIER bodies for fragments
- **Details:**
  - For each Fragment: create dynamic rigid body in physics world
  - Set initial velocity from Fragment.velocity
  - Set mass from Fragment.mass
  - Track fragment bodies for future queries
  - Emit `physics:fragment_created` for each (so DEV A can track)
- **Dependencies:** PHASE1-B2 (Fragment creation)
- **Acceptance:** Fragments fall with gravity in physics simulation
- **Status:** ⏳ TODO

#### [PHASE1-A3] DEV A: Mesh Instance Tracking
- **File:** `src/rendering/VoxelChunkRenderer.ts`
- **Task:** Map fragment IDs to mesh instances
- **Details:**
  - When creating fragment mesh, store meshInstanceId in Fragment tracking
  - Subscribe to `physics:fragment_created` to link meshes
  - Update fragment mesh position every physics frame
  - Clean up fragments when they fall out of bounds
- **Dependencies:** PHASE1-B3 (fragment bodies from physics)
- **Acceptance:** Fragment meshes move in sync with physics bodies
- **Status:** ⏳ TODO

---

### Phase 2: Performance & Polish (After Phase 1 Complete)

#### [PHASE2-A1] DEV A: Chunk-Based Rendering
- Implement spatial chunking for large structures
- Support dynamic chunk loading/unloading
- Performance target: Render 100x100x100 voxel building at 60 FPS

#### [PHASE2-B1] DEV B: Constraint-Based Structures
- Add connectors between voxels (joints/constraints)
- Implement structural collapse when constraints break
- Realistic fracture patterns

#### [PHASE2-A2] DEV A: LOD System
- Implement Level of Detail for distant structures
- Reduce mesh complexity for far voxels

#### [PHASE2-B2] DEV B: Optimization
- Frame time target: < 5ms for physics simulation
- Object pooling for fragments
- Spatial hashing for collision queries

---

## 📋 EXECUTION RULES

### Parallel Execution (No Blocking)
```
❌ DON'T WAIT for other agent to finish
✅ DO emit events and continue
✅ DO listen for async events
```

### Task Completion Checklist
- [ ] Code compiles without errors
- [ ] Task-specific functionality works
- [ ] Events properly emit/listen
- [ ] No console errors
- [ ] Updated CLAUDE.md if needed
- [ ] Commit with clear message
- [ ] Push to `claude/game-physics-simulation-20q4yj`

### Communication Pattern
```
Agent A                          Agent B
│                               │
├─ emit render:input ────────→ listen
│                               │
│                           (async processing)
│                               │
└─────── listen ←──── emit physics:update
```

### Dependencies & Order
```
PHASE1-B2 ──┐
            ├─→ PHASE1-B1 ──┐
PHASE1-B3 ──┘               ├─→ PHASE1-A2
                             │
            PHASE1-A1 ───────┘

Recommendation: Start with B2, B3, A1 in parallel → then A2
```

---

## 🔄 STATUS TRACKING

| Task | DEV | Status | PR/Commit |
|------|-----|--------|-----------|
| PHASE1-A1 | A | ⏳ TODO | - |
| PHASE1-B1 | B | ⏳ TODO | - |
| PHASE1-B2 | B | ⏳ TODO | - |
| PHASE1-A2 | A | ⏳ TODO | - |
| PHASE1-B3 | B | ⏳ TODO | - |
| PHASE1-A3 | A | ⏳ TODO | - |

---

## 🚀 HOW TO GET STARTED

### For DEV A (Renderer)
1. Read `CLAUDE.md` section "For DEV A"
2. Start with **PHASE1-A1**: Add click input handler
3. Import SyncEventBus and emit destruction requests
4. Then implement **PHASE1-A2**: Listen to destruction events and render

### For DEV B (Physics)
1. Read `CLAUDE.md` section "For DEV B"
2. Start with **PHASE1-B2**: Implement fragment detection
3. Then **PHASE1-B1**: Handle destruction input and emit events
4. Finally **PHASE1-B3**: Create physics bodies for fragments

### Coordination
- Both agents work on their PHASE1 tasks in parallel
- Use SyncEventBus for communication
- Commit frequently to `claude/game-physics-simulation-20q4yj`
- Check `.dev-sync.json` for role definitions

---

## 💡 TIPS FOR SUCCESS

1. **Test in Isolation First**
   - DEV A: Test raycasting without physics
   - DEV B: Test fragment detection without rendering

2. **Use Sync Protocol**
   - Always emit via `globalEventBus.emit()`
   - Always subscribe via `globalEventBus.subscribe()`
   - Never call methods directly across agents

3. **Debug with Logs**
   ```typescript
   // DEV B emitting
   console.log(`[DEV B] Emitting destruction: ${fragments.length} fragments`);
   await globalEventBus.emit(EventType.DESTRUCTION_TRIGGERED, {...}, 'DEV_B', 'HIGH');

   // DEV A listening
   globalEventBus.subscribe(EventType.DESTRUCTION_TRIGGERED, async (msg) => {
     console.log(`[DEV A] Received destruction event: ${msg.payload.fragments.length} fragments`);
   });
   ```

4. **Version Your Code**
   - Use commit messages like `[DEV A] Implement click input handler`
   - Reference task ID: `[PHASE1-A1] Add input listener`

5. **Keep It Simple**
   - Don't over-engineer in Phase 1
   - Basic sphere destruction is enough
   - Polish comes in Phase 2

---

**Last Updated:** 2026-07-06  
**Branch:** `claude/game-physics-simulation-20q4yj`
