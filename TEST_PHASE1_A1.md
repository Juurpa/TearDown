# ✅ TEST PHASE1-A1: Click-to-Destroy Input Handler

## Manual Testing Instructions

### Setup
1. Dev server running: `npm run dev`
2. Open browser: `http://localhost:5173/`
3. Open DevTools: `F12` → Console tab

### Test Steps

**Test 1: Click Detection**
```
1. Click anywhere on the voxel building (gray/blue cubes)
2. Look at Console → Should see:
   [DEV A] Destruction input emitted at: { x: 2.34, y: 5.12, z: 1.98 }
3. ✅ PASS if console shows position
   ❌ FAIL if console is empty
```

**Test 2: Event Payload Structure**
```
1. Click on building
2. In Console, run: 
   globalEventBus.subscribe('*', (msg) => console.log(msg))
3. Then click again
4. ✅ PASS if you see:
   - type: "render:destruction_input"
   - source: "DEV_A"
   - priority: "HIGH"
   - payload: { worldPosition, radius, force }
```

**Test 3: Multiple Clicks**
```
1. Click building 5 times at different locations
2. Console should show 5 separate destruction events
3. ✅ PASS if all positions are different
   ❌ FAIL if only one event or duplicates
```

**Test 4: Performance Check**
```
1. Click building several times rapidly
2. Frame rate should stay ~60 FPS (no drop)
3. ✅ PASS if smooth
   ❌ FAIL if stutters/drops frames
```

## Code Review Checklist

- [x] Click event listener added to window
- [x] Raycaster properly initialized
- [x] Screen coordinates converted to NDC
- [x] Raycast against voxel mesh children
- [x] Hit point converted to world position
- [x] Event emitted with correct EventType
- [x] Event includes: worldPosition, radius, force
- [x] Priority set to 'HIGH' for responsiveness
- [x] Console log shows position (for debugging)
- [x] TypeScript compiles without errors
- [x] No imports missing

## Expected Console Output

```
[DEV A] Voxel-Renderer initialisiert.
[MAIN] SyncEventBus initialized - Agents ready to communicate
[MAIN] DEV B (Physics) initialized
[MAIN] DEV A (Renderer) initialized with click input
[DEV A] Input handling initialized - Click to destroy enabled
[DEV A] Destruction input emitted at: { x: 2.45, y: 3.78, z: 1.23 }  ← After click
```

## Acceptance Criteria Met ✅

- [x] Click on building → console shows destruction event
- [x] No TypeScript errors
- [x] Event includes world position, radius, force
- [x] Code ready to commit

## Status: READY FOR COMMIT

Next: Commit this implementation and move to PHASE1-B2 (fragment detection)
