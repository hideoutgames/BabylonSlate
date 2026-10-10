# BabylonSlate codebase scan

Read-only scan notes. No product code was changed to produce these findings. This file is the running record so results are not only in the chat.

Status: in progress. Package reads are still running. Entries under **Verified** were checked against the current source. Entries under **Reported, not re-checked** came back from a file read and have not been opened again here. Rejected claims are listed so they are not treated as bugs later.

## Verified

### Play and runtime

- **High.** A failed script or navmesh load still starts Play. `createPlayBootCoordinator` in `packages/runtime/src/play-boot.ts` stores the load promise after `.catch`, so the rejection resolves. `play` then realizes the world and calls `start()`.
- **High.** A failed `play` cannot be retried. `playing` is cleared only in `reset()`. The worker `play` handler reports the error and does not call `boot.reset()`. The next `play` returns the same rejected promise.
- **High.** One thrown tick freezes the worker. `createWorkerScheduler` in `packages/runtime/src/worker-scheduler.ts` calls `advance` and then `schedule()` with no `try`. After a throw, `running` stays true and `start()` returns immediately.
- **High.** `instrumentJsLoops` in `packages/debugger/src/infinite-loop.ts` treats `/` after an operator as the start of a regex, so a `while` after a division is not guarded. A `/` after `return` or `throw` is treated as code, so a regex that contains `while` gets a loop check inserted into the pattern. Hoisted script source goes through this instrumenter.
- **High.** Snapshot backpressure survives `load` and `stop`. `publishSnapshot` in `packages/runtime/src/worker-entry.ts` refuses to send while `pendingGeneration` is set or two buffers are in flight. Those counters are cleared only by a layout ack.
- **Medium.** `World.end` in `packages/object-model/src/world.ts` does not clear `started`. A later `tick` still runs every phase, including Game Instance On Tick.
- **High.** Class variable defaults are shared across spawns. `hydrateClassVariableValue` shallow-copies arrays and returns object defaults as-is. `mapFromDefaultEntries` reuses each map value.

### Saves, journals, and assets

- **High.** Approving migrations does not finish Save All. `approveMigrationsAndSave` in `apps/editor/src/context/document-context.tsx` writes documents and the project file, marks them clean, and does not flush or truncate the recovery journal. It also skips the audio-reverb and nav-bake flushes. Replaying `ReorderActorCommand` splices by index, so recovery can move an actor again. The approve button closes the dialog first. A locked save still resumes Play.
- **Medium.** Every failed Play save opens the migration prompt. `saveProject` returns `false` for a lock, a missing project, or pending migrations. `requestPlay` treats every `false` as `playAwaitingMigration`.
- **Medium.** Save drops journal lines if the journal write fails. `journalBuffer.flush` removes pending lines before the write finishes and swallows the error unless `rejectOnError` is set. Save does not set that option.
- **Medium.** Closing with Save All has no `catch` around `requestSave()` in `apps/editor/src/routes/editor-route.tsx`. A storage rejection is unhandled. The documents stay dirty.
- **High.** A folder listing failure hides files, and deleting that folder removes them. `AssetRegistry.walk` records a child folder before reading it. A thrown `readdir` indexes nothing inside. `deleteFolderUnlocked` then calls recursive `storage.remove`.
- **High.** A torn content-addressed blob is kept. `writeBlob` skips an existing hash path. `readBlob` does not check the bytes. Node `writeBinary` uses `writeFile`, which truncates in place.
- **High.** Two `.babasset` files with the same id collapse to whichever scan sees last. `indexHeader` drops the earlier path from `byGuid` and `byPath`. The other file stays on disk with no index entry.
- **High.** `DesktopSecretStore.read` returns an empty map on any read or parse failure. `set` and `delete` write that whole map, so one bad read followed by saving a token replaces every source-control secret.
- **Medium.** Import and a normal texture-encode retry enqueue the job without `guard` or `sourceSha256`. `encodeJobMayWrite` then allows the job to commit compressed bytes onto newer pixels.
- **Medium.** Any JSON object with an `atlas`, `chars`, or `facetype` field imports as a font representation.
- **Medium.** `resolveJournalLines` swallows parse failures. `skipped` lists only lines that parsed and then could not apply.
- **High.** `WebAppSettingsStore.save` updates memory and then swallows a `localStorage` failure. `load` returns the old stored JSON whenever that read succeeds, so the next update starts from the stale settings. The Electron settings store follows the same pattern.
- **High.** Removing or adding an audio clip can erase a newer edit. `AudioClips` in `apps/editor/src/components/audio-editor.tsx` awaits the chunk write, then calls `onChange` with the `audio` object from the render that started the click.
- **High.** Export toggles keep only the first preset. Packed, debugger, and file-count controls in `apps/editor/src/components/settings-modal.tsx` write `exportPresets` as a one-element array taken from `exportPresets[0]`.

### Physics, navigation, and graphs

- **High.** `Rapier2DPhysicsBackend.shapeSweep` ignores the shape and calls `lineTrace` from start to end.
- **High.** Each positive-radius `sphereOverlap` constructs a Rapier `Ball` and never calls `free()`. The same method also runs `intersectionsWithPoint` first.
- **High.** 2D nav bake uses the actor position and the raw collider shape. It does not apply the scale, rotation, or parent that `scaleColliderShape` applies. An actor origin outside the bake bounds is skipped even when the shape extends back in. Diagonal and polygon edges become axis-aligned boxes with a fixed thickness of `0.8`.
- **High.** Dynamic navmeshes use `maxObstacles: 128`. The crowd is created with `maxAgents: 32` and `maxAgentRadius: 0.6`. `addObstacle` still records an id when the native add fails. Dynamic box obstacles are added with yaw `0`. `flushTileCache` stops after 64 steps, and `findPath` still runs.
- **High.** Compile emits `break` for `whileLoop`. `isBreakableLoopKind` allows Break only on the For / For Each “With Break” nodes. The constant-True warning tells the author to break.
- **High.** An unused pure cycle validates, then overflows compile. `compileGraph` calls `ensurePure` for every pure node with no in-progress set. `exprCache` is filled only after codegen returns.
- **High.** Validation rewrites a reversed data wire. `compileGraph` does not. `edgeToInput` only matches the stored target, so the input compiles as its default. New canvas connections store the input as the target. Saved or imported wires can still be reversed.
- **Medium.** A wired material float widens by padding with `1`. An unwired literal uses `constantComponents`, which repeats the scalar.
- **Medium.** `DocumentEditStack.apply` always records the inverse. `AddActorCommand`, `AddNodeCommand`, and `AddEdgeCommand` return the same document when the id exists, and the inverse is a remove. Ordinary diffs do not emit that command.
- **Medium.** `RemoveNodeCommand.apply` deletes every edge touching the node. `invert` only adds the node. A full diff batch also emits `RemoveEdgeCommand`s, so a normal delete-undo survives.
- **Medium.** `simplifyLevels` in `packages/render/src/model-lod-simplify.ts` divides by `currentTriangles`. Deforming meshes are not stopped when the simplified index list is empty, so the next screen-size step divides by zero.
- **Medium.** `shareCompiledProgram` keeps every distinct compiled shader string in a map for the life of the engine. The map is not pruned until the engine is discarded.

### Editor behavior and cost

- **High.** `PlayProvider` calls deprecated `useDocuments()` and wraps `EditorLayout`, which is not memoized. A document edit re-renders the docked workspace from that provider. The Play context value itself is usually stable.
- **Medium.** `ActorDefaultsGrid` reloads ancestor Class graphs whenever `openDocuments` changes identity.
- **Medium.** Unmeasured graph nodes are culled as 320×120. A pin-heavy node can leave that box while its lower pins are still visible. Any edge that touches a visible node also mounts the other end.
- **Medium.** `NumericDragField` ends a drag with the latest scalar. The vector3 row ignores that argument and commits `row.value` from the last render. The simulation inspector sets `onCommit`. Scene transforms use `onAxisChange` and do not.
- **Medium.** Focused number, text, and color fields keep local draft text and do not reset it when `value` changes. Blur can write the draft back.
- **Medium.** Non-staged mesh assignment builds a rejection fingerprint with `JSON.stringify(command)`. Text visuals that already failed a bitmap allocation do this again on later `assignMesh` calls.
- **High.** `NamedListEditor` keys each row with `` `${value}-${index}` ``. A keystroke changes the key and remounts the input, so focus drops after one character.
- **High.** Toolbar delete uses `deletableNodeIds`, which skips protected nodes (`flow.function.input`, `flow.function.output`, and the anim-graph enter, exit, and event nodes). The canvas passes `deleteKeyCode` through unset, except the behaviour-tree editor and the asset-reference dialog, which pass `null`. React Flow’s default is Backspace. `handleNodesChange` applies `remove` without checking `isProtectedNode`.
- **Medium.** With nothing selected, `TreeView` sets `activeIndex` to `0`. ArrowDown then selects `activeIndex + 1` and skips the first row.
- **Medium.** `hasFlagBit` and `setFlagBit` use `1 << bit`. Bit 31 becomes a negative number, and bit 32 wraps to bit 0. The default mask is 32 bits.
- **Medium.** `useTilesetAtlases` creates a blob URL after an await. Cleanup revokes only URLs already stored. Teardown during the await leaks the later URL.
- **Medium.** The tilemap Stamp tool sends a fixed 2×2 of the selected GID. `applyTilemapPaint` can apply a real pattern.
- **Medium.** `applyTextureGuid` awaits the image read, then `patchFrame` copies `animation.frames` from the render that started the pick.
- **Medium.** `addTileset` awaits the tileset document, then writes `addTilemapTileset` using the `tilemap` from that render.
- **Medium.** A failed Play start calls `onClose` and does not set `closedRef`. `finishSessionRef` can call `sessionOwner.stop` and `onClose` again.
- **Medium.** `SceneLayerSwitcherFields` merges inherited `actorDefaults` into `properties`, then `onChange` spreads that merged object. Editing the list or the initial index stores inherited values as authored properties.
- **Medium.** `scene?.settings.grid.snapRotateDeg` in `viewport-toolbar.tsx` throws when `scene` exists but `settings` or `settings.grid` is missing.
- **High.** `AlertDialogAction` renders a plain `Button`. `AlertDialogCancel` is the control wrapped in `AlertDialogPrimitive.Close`. A confirm button that does not set `open` to false leaves the dialog up.

### Desktop, player, and packaging

- **Medium.** `confinedPath` only rejects a lexical `..`. `readFile` and `writeFile` follow a symlink at the final component. The folder picker resolves the chosen directory once.
- **Medium.** `NodeStorageAdapter.readdir` calls `stat` on every entry. `stat` on a named pipe waits until the other end opens, and that call runs on the Electron main process.
- **Medium.** Account secrets refuse `basic_text` and `unknown` and never write plaintext. Source-control secrets only check `isEncryptionAvailable()`, store plaintext when that is false, and use a direct `writeFile`. Account secrets use a `0o600` temporary file and `rename`. `DesktopSecretStore.get` waits for the write queue and then reads outside it, so a torn `writeFile` can look like a missing token.
- **Medium.** `lfs:fetch` accepts any `https:` URL and returns `await response.text()` with no response-size cap. The sender check limits this to the editor main frame. The host is not pinned to Clerk or Git LFS.
- **Medium.** `electron-builder.yml` sets `win.signAndEditExecutable` to false. `updatesSupported` still returns true for packaged Windows release builds.
- **Low.** `DesktopAccountSecretStore.read` throws `unavailable()` for a bad record, and the surrounding `catch` returns `{}`.
- **Medium.** The Preview iframe is same-origin with the editor and has no `sandbox` attribute. If the player worker fails to start, `boot.ts` runs the game in that frame and compiled scripts are evaluated with `new Function`. A script there can reach `window.parent` and the editor `babylonslate` bridge.
- **Medium.** `copyIfPresent` in `apps/player/vite.config.ts` returns when a source directory is missing. Havok, KTX2, Draco, and meshopt are copied that way.

### Tests

- **Medium.** The material-preview orbit drag in `e2e/p9-content.spec.ts` stores `radiusBefore`, drags, and then only checks that `data-camera-radius` is still finite. Wheel and pinch require a radius change.

## Reported, not re-checked

These are from completed file reads. They are kept so they are not lost. They are not confirmed until the cited code is opened again.

### Editor components and UI

- Skybox source drag re-encodes all six faces and recreates the preview engine on each pointer move (`skybox-creator-editor.tsx`).
- Play overlay polls memory, draws, and rendering every 200ms even when Stats is hidden, and runs a permanent audio-debug animation frame (`play-overlay.tsx`).
- `new Blob([bytes.buffer])` in export download can attach bytes outside the `Uint8Array` view (`settings-modal.tsx`).
- Behaviour-tree blackboard state is not cleared when the linked asset changes or fails to load (`behaviour-tree-editor.tsx`).
- Animation-graph commits apply a captured document in `queueMicrotask` and can drop a Details edit (`anim-graph-editor.tsx`).
- `CodeBodyEditor` replaces the whole buffer when the `value` prop differs (`js-body-editor.tsx`).
- Model thumbnail jobs are deleted from the queue before capture, and capture returns immediately when no shared engine exists (`model-thumbnail-capture-host.tsx`).
- Editor utility script loads are not cancelled between `host.load` calls (`editor-utility-runtime.tsx`).
- Graph paste always offsets the original clipboard position by 40 and does not advance, so a second paste overlaps the first (`graph-editor.tsx`).
- Atlas `ResizeObserver` calls `fitAtlasView` on every surface resize and resets pinch zoom (`atlas-tile-grid.tsx`).
- `MultilineTextField` reseeds `draft` from `value` while the dialog is open (`multiline-text-field.tsx`).
- `SearchDialog` height is fixed from the item count at open time (`search-dialog.tsx`).
- `Checkbox` always shows `CheckIcon` when indeterminate. Disabled styles use `:disabled` while Base UI sets `data-disabled` on a `span` (`packages/ui/src/components/checkbox.tsx`).
- `ToggleGroup` and `Tabs` copy `orientation` onto `data-orientation` and do not pass it to the primitive, so a vertical group would still rove horizontally.
- `ScrollArea` always injects one vertical bar. An extra `ScrollBar` child lands inside the viewport.

### Render files starting with `m`

- `MaterialLibrary.cancelPending` looks up the bare asset guid, while `acquire` stores unlit and instance jobs under a different cache key (`material-library.ts`).
- Screen UV remap is described as clip-space to `0..1`, but the `RemapBlock` is created without source or target ranges (`material-compiler.ts`).
- Auto LOD selection allocates a camera-to-center vector per mesh per pass (`model-lod.ts`).
- `meshAssetFingerprint` JSON-stringifies tilemap, tileset, and water maps on each compare (`mesh-assets.ts`).
- `isGltfModelBytes` parses the model, then the loader parses it again (`model-mesh.ts`).
- A failed material resolve leaves the previous override on the mesh (`model-preview.ts`).
- A transient simplifier load failure caches `null` for the process (`model-lod.ts`).

### VFS, exporter, bridge, and debugger

- Node and documents `writeBinary` write in place. Save-game storage stages then renames. A crash can truncate project files.
- `GitLfsLockProvider.list` parses every lock with `ours: false`, so the caller’s own locks look foreign.
- `for await` is not instrumented because the scanner requires `(` immediately after `for` (`infinite-loop.ts`).
- `setVoiceGain` is a command message but is not in `PLAY_ENGINE_COMMAND_TYPES` (`play-engine-commands.ts`).
- `dynamicMeshTransferables` transfers `array.buffer`, which can detach a shared underlying buffer (`dynamic-mesh-transfers.ts`).
- `exportGame` extra file paths strip a leading slash and do not reject `..` (`export-game.ts`).
- OPFS `readdir` returns `[]` when `entries` is missing (`web-adapter.ts`).
- Derived storage and template storage use OPFS on desktop instead of the Node documents tree (`derived-storage.ts`, `template-storage.ts`).
- Corrupt Preferences JSON throws instead of falling back (`preferences-app-settings.ts`).
- `previewPackFromFiles` JSON-parses `game.json` without a missing-file check when on-demand (`preview-protocol.ts`).
- `http:` Git remotes are rewritten to an `https:` LFS endpoint (`lfs-endpoint.ts`).
- Quoted `url = "..."` values in git config keep the quotes (`git-config.ts`).
- LFS pagination follows `next_cursor` with no repeated-cursor guard.
- Diagnostic admission can fail at 2500ms while the session budget is 3000ms.
- Mobile binary encoding builds a string with `String.fromCharCode` in a loop (`documents-adapter.ts`).

### End-to-end specs

- `e2e/p4-play.spec.ts` can treat three missing `liveObjectCounts()` reads as equal sentinel counts.
- `e2e/p2-accept.spec.ts` dismisses an import-errors dialog and continues.
- `e2e/p9-content.spec.ts` closes a preview session report after Stop and starts Play again.
- `e2e/p11-ai.spec.ts` fills the decorator key only when the control is an `INPUT`.
- `e2e/basic-3d-mannequin-shadow-hosts.spec.ts` passes the same pixel buffer twice into `mannequinShadowMetrics`. The visible assertions do not read `changed`, so this is not yet a false pass.
- `e2e/webgl2-fallback.spec.ts` does not replace `requestAdapter` when `navigator.gpu` is already missing.
- Several specs keep a second mode in a one-element loop, so the Preview Build arm never runs. Named files include `play-debug-console.spec.ts`, `scene-layer-joystick.spec.ts`, `scene-layer-controls.spec.ts`, `scene-streaming.spec.ts`, `runtime-scene-loading.spec.ts`, `preview-build-preparation.spec.ts`, `qa-custom-events.spec.ts`, `qa-input.spec.ts`, `qa-state-lifecycle.spec.ts`, `qa-core-runtime.spec.ts`, `save-game-parity.spec.ts`, `render-settings-export.spec.ts`, `framegraph-forward.spec.ts`, and `player-backend.spec.ts`.
- `e2e/p14-export.spec.ts` treats a missing `data-ticks` attribute as not equal to `"0"`.

### Scripts and CI

- `scripts/distribution/preflight.mjs` hardcodes four Verify e2e shards instead of the shared policy list. Both sides are four today.
- Distribution GitHub outputs write patch notes on one `name=value` line. A `%` in the notes can be interpolated by Actions.
- `security.yml` does not run on pull-request review comments.
- A host file with `profile: "standard"` can set `reserveGiB` below 2. The low-memory profile clamps that floor. The standard profile does not (`local-resource-config.mjs`).
- `publish-release` does not require the iPadOS or TestFlight jobs. A test-channel run can publish a GitHub Release after those jobs fail (`distribute.yml`, `publish.mjs`).
- `eslint.config.js` physics import ban does not list every `@babylonjs/*` package named in the architecture rule.
- `check-public-hygiene.mjs` decides it is the main module with `endsWith` on the argv basename. A non-matching path can exit 0 without scanning.

### Player and desktop leftovers

- `registerPackedFonts` is only referenced from its test (`apps/player/src/fonts.ts`).
- `grantedFolders()` casts parsed JSON to `string[]` without checking the shape (`apps/desktop/src/main.ts`).
- Scene-loading dataset fields are not cleared when loading ends (`apps/player/src/scene-loading-state.ts`).
- `DesktopSaveGames.epochs` grows one entry per contents id and is not deleted (`desktop-save-games.ts`).
- `__babylonslateAudioStats` and `__babylonslateParticleStats` are installed on `window` for every player boot (`boot.ts`).
- `electron-updater` is a desktop devDependency. The packaged host must inline it or the packaged update path hits the unavailable catch.

## Rejected or narrowed

- `saveGame` refusing a newer or incomplete schema is intentional. `save-game.test.ts` expects `incompatible`.
- `CSC_LINK` set to the base64 Developer ID certificate matches electron-builder’s accepted form. It is not a bad assignment.
- The GPU particle end-to-end test calls `test.skip` when the browser has no GPU owner. That run is skipped, not green.
- The mannequin shadow spec passes one pixel buffer twice, but it does not assert the `changed` count that would make that mistake a false pass.
- `NodeStorageAdapter.openKnownFolder` ignores the folder id and opens `baseDir/<name>`. The desktop IPC path does not use that method for `node:` ids. It reopens those with `openAbsoluteFolder`.
- `AlertDialogAction` was first described as a Close. The source renders a plain `Button`. The finding that Confirm does not dismiss is the one that holds.

## Coverage still open

Letter-bucket and large-file reads are still running across render, runtime, assets, core, scripting, editor services, panels, context, and the largest single files (`water-material.ts`, `create-engine.ts`, `document-context.tsx`, `registry.ts`, `snapshot-apply.ts`, `script-host.ts`, `driver.ts`, `project-service.ts`). This note will be updated as those reads are checked.
