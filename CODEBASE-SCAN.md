# BabylonSlate codebase scan

Read-only scan notes. No product code was changed to produce these findings. This file is the running record so results are not only in the chat.

Status: in progress. Package reads are still running. Entries under **Verified** were checked against the current source. Entries under **Reported, not re-checked** came back from a file read and have not been opened again here. Rejected claims are listed so they are not treated as bugs later.

The engine is not released. Backwards compatibility should not exist. An old-format reader, renamed-node adapter, legacy field, or migration that exists only so older projects still load is bloat to remove. Do not record that code as intended support.

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
- Several specs keep a second mode in a one-element loop, so the Preview Build arm never runs. Named files include `play-debug-console.spec.ts`, `scene-layer-joystick.spec.ts`, `scene-layer-controls.spec.ts`, `scene-streaming.spec.ts`, `runtime-scene-loading.spec.ts`, `preview-build-preparation.spec.ts`, `qa-custom-events.spec.ts` (`preview` is `[false]`), `qa-input.spec.ts`, `qa-state-lifecycle.spec.ts`, `framegraph-forward.spec.ts`, and `player-backend.spec.ts`. `qa-core-runtime.spec.ts` is the opposite: `preview` is `[true]`, so Normal Play never runs. `save-game-parity.spec.ts` and `render-settings-export.spec.ts` are packed-only loops, not missing Preview Build arms.
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

## Verified in the later batch

- **High.** A While Loop compiles with an empty body. `execSuccessorEdges` in `packages/scripting/src/compile.ts` keeps an exec output only when `pin.name` equals the requested pin. `flow.whileLoop` names those pins `Loop Body` and `Completed` and passes the ids `loopBody` and `completed`. For Loop pins use the same string for id and name, so those loops still connect. The condition can run. The body and the Completed chain are not emitted.
- **High.** Renaming a function does not retarget Call nodes. `patchClassMember` in `apps/editor/src/lib/class-members.ts` returns as soon as `patch.pins` is absent. A name-only edit never reaches `syncFunctionGraphPins`. Variable and event renames take earlier branches.
- **High.** Graph diff ignores edge endpoint changes and node type changes. `diffGraphCommands` adds or removes edges only by id. It compares node position and data, not `type`. Rewiring an existing edge id, or retyping a node, emits nothing.
- **High.** Prefab is not in `JSON_TYPES` in `apps/editor/src/services/export-game-inputs.ts`. A Prefab whose payload is only a JSON document chunk is not loaded as a document for export.

## Reported in the later batch, not re-checked

### Editor library

- A failed audio-reverb bake is stored under the real geometry hash, so the next flush returns dry silence (`audio-reverb-bake.ts`). The default bake ignores the abort signal.
- Removing an Animation Graph variable drops it from the variable list and leaves Get and Set nodes bound to it (`anim-graph-variables.ts`).
- Plugin import can catalog a new generation and then throw on `defaults.json`, with no rollback (`engine-plugin-library.ts`).
- A user plugin or extension whose name matches a bundled entry is skipped and then cannot be removed (`engine-extension-library.ts`, `engine-plugin-library.ts`).
- `classParentLookup` only reads `header.type === "Class"`, so a parent that is still a legacy Graph is missing (`content-browser-helpers.ts`).
- Collision layer `0` is labeled with the first layer name (`component-property-rows.ts`).
- `downloadPluginArchive` revokes the blob URL in the same turn as the click (`plugin-download.ts`). The same pattern is in `extension-download.ts`.
- `prefabPreviewLoadKey` JSON-stringifies component transforms, so a gizmo drag restarts collection every frame (`prefab-preview.ts`).
- `flattenInspectTree` and `reparentPrefabComponents` walk `parentId` with no cycle guard (`play-inspect-tree.ts`, `prefab-preview.ts`).
- `folderMoveForTarget` drops a folder onto the scene root when the drop target is an actor (`outliner-drop.ts`).
- `useInspectWorldPoll` has no `catch`, so a rejected inspect poll is an unhandled rejection (`use-inspect-world-poll.ts`).
- The scene viewport asset key does not include particle documents, and it JSON-stringifies every project resource of the watched types (`scene-viewport-assets.ts`).
- `moveKeyedEntry` deletes the destination when the source key is missing (`move-keyed-entry.ts`).
- `playPrefabDependencyScene` is only referenced from tests (`play-content.ts`).

### Editor shell and services

- Exclusive-scene Save calls `saveAll()` directly. It does not open the migration prompt, and a pending migration leaves that dialog stuck (`editor-route.tsx`).
- Migration approve still closes the dialog before the write and can resume Play when the save did not happen. Already noted; the shell read adds that a thrown approve leaves `playAwaitingMigration` set with no dialog left to cancel.
- Dev player middleware treats a sibling path such as `dist-backup` as inside `dist` because `startsWith` has no separator (`vite-player-host.ts`).
- The engine-plugin Vite watcher does not rebuild the public catalog on change (`vite-engine-plugins.ts`).
- Dismissing a recovery journal drops a rejecting promise (`home-route.tsx`, `editor-route.tsx`).
- An unreadable existing `.babasset` save mints a new GUID and drops extra chunks (`project-service.ts` `guidForAsset`, `extraChunksFor`).
- Navmesh and audio-clip writes stamp the current schema version without the migration-approval gate (`writeSceneNavmeshChunkUnlocked`, `writeAssetDocumentWithExtra`).
- `hydrateClassDocumentPayload` replaces a Class payload with a default graph when `nodes` or `edges` is not an array (`graph-validation.ts`).
- Editor hydration prunes wires and rewrites enum defaults, and the graph panel commits that hydrated graph (`hydrateSerializedGraphForEditor`).
- Validation does not apply the wired Cast class the way editor hydration does (`materializeLogicGraph`).
- Audio clip writes do not take the rename-safe document lock.
- Simulate-mode pointer and focus navigation ignore the pause input gate (`play-session.ts`).
- Worker console and inspect waiters never time out.
- A zip import without `project.json` throws on a missing file instead of an import error.
- `SimulationInspectionStore.poll` publishes the structural cursor before the selection fetch returns, so a cancelled selection leaves the identity list empty (`simulation-inspection-store.ts`).
- `SimulationSession.resolveStop` checks discard only before `applyScene` (`simulation-session.ts`).
- A failed preview or play input-suppression request can leave input suppressed (`preview-diagnostics.ts`, `play-session.ts`).
- A failed simulation capture does not roll back `captureRequested` (`play-session.ts`).
- A source-control lock that appears after the document is open does not mark it read-only (`source-control-service.ts`).
- Nav, audio, and game worker hosts clear pending work on `terminate` without rejecting it.
- `collectPlayDataCatalog` always reloads Structure and Enum instead of using the indexed payload (`play-data-assets.ts`).
- `playAssetCatalog` turns a reachability error into an empty catalog (`asset-catalog.ts`).
- Export omits an asset whose document bytes fail to load and can still succeed (`export-game-inputs.ts`).
- `loadPlayerDistFiles` trusts names in `player-files.json` (`load-player-files.ts`).
- `replayRecoveryJournal` can return before `onRecoveryResolved`, so the recovery banner stays up (`document-editing-service.ts`).

### Scripting

- Set Variable looks up pins by the variable name, and `pinForCodegen` matches id before name. A variable named `exec`, `target`, or `then` binds the wrong pin (`variables.ts`).
- Call Function can create two pins with id `target` (`functions.ts`).
- Wildcard int/float binding depends on edge order (`wildcard-resolve.ts`).
- Interface signature matching ignores Array versus Map (`validate.ts` `pinsMatch`).
- `struct.break` optional chaining does not cover `.Name` when `input` is missing (`struct.ts`).
- Get Effective Scalability reads `?.effects?.vignette.color`, which throws when `effects` exists and `vignette` does not (`scalability.ts`).
- An unwired physics radius compiles as `0` and is not diagnosed (`physics.ts`).
- Float To Int uses `| 0`, which wraps through int32 (`casting.ts`).
- For Each inlines the array expression twice (`compile.ts`).

### Navigation

- Cylinder bake and obstacles treat `size.x` as a radius. The editor cylinder is a diameter-1 mesh (`blockers.ts`, `recast-backend.ts`).
- Tile-cache cylinder obstacles take a base pose. Callers pass a center (`addObstacle`).
- Walkable height, climb, and radius are documented as world units and forwarded as Recast voxels (`toRecastConfig`).
- `addAgent` returns an id even when the native add fails.
- Cost-volume queries force a Y half-extent of at least 4 (`costVolumeHalfExtents`).
- `stampCostVolumes` stops at 512 polygons.
- `removeObstacle` deletes the JS id before the native remove succeeds.
- Dynamic navmesh generation does not destroy `TileCacheMeshProcess`.
- `setAgentTarget` uses Crowd extents `{1,1,1}`, not the 4-unit query extents.

### Render files `a`–`f` and `m`

- `resolveAnimationGroup` can seek another actor’s group when the clip guid is empty (`anim-apply.ts`).
- Bold or italic font faces are marked ready after loading only `16px` regular (`font-registry.ts`).
- Voice muffle adds a low-passed copy on top of the still-connected dry output (`babylon-audio-backend.ts`).
- Doppler off does not restore the last playback rate (`audio-service.ts`).
- A failed environment cube throws from `isReady` inside the render observer (`environment-lighting.ts`).
- Missing foliage indices become an empty index buffer (`foliage-mesh.ts`).
- `MaterialLibrary.cancelPending` looks up the bare guid, not the unlit or instance cache key.
- Auto LOD selection allocates a camera delta per mesh per pass (`model-lod.ts`).
- Tilemap, tileset, and water fingerprints JSON-stringify the whole map (`mesh-assets.ts`).

### VFS

- Derived and template OPFS binds are remembered as user projects and can become `currentId` (`derived-storage.ts`, `web-adapter.ts`).
- Memory `writeBinary` replaces a directory entry with a file (`memory-adapter.ts`).
- Electron renderer `getCurrentFolder` is not the main-process root (`electron-storage-adapter.ts`).
- OPFS and memory path split do not reject `..` (`web-adapter.ts`, `memory-adapter.ts`).
- Mobile `getCurrentFolder` does not wait for adapter init (`mobile-storage-adapter.ts`).

### End-to-end and distribution

- `e2e/p9-content.spec.ts` “Material Function edits reach every calling material” only checks that the outputs panel is visible.
- `e2e/p15-source-control.spec.ts` Edit Anyway only checks that the same button is still visible.
- `e2e/basic-3d-mannequin-shadows.spec.ts` checks contact coverage only when a single region has more than five contacts.
- `e2e/input-assets.spec.ts` Listen does not assert that the binding became `KeyJ`.
- iPadOS metadata uses `GITHUB_RUN_ATTEMPT` while the GitHub Release identity stays on the preflight attempt (`generate-metadata.mjs`).
- `assertAppleBuildAvailable` rejects any existing App Store build version that is not `X.Y.Z` (`contract.mjs`).
- Apple `xcodebuild` and upload commands use a 30-minute private-command timeout inside a 75-minute job (`private-command.mjs`).
- TestFlight finalization lists only the first 200 builds (`testflight.mjs`).

## Verified in the third batch

- **High.** `wouldCreateCycle` in `packages/core/src/scene.ts` walks `parentId` with no visited set. `wouldCreateComponentCycle` records `seen`. An actor parent cycle that does not include the actor being moved never ends, so the next reparent check can hang.
- **High.** `decodeBabasset` copies an inline chunk with `subarray` and does not compare `sha256`. A short payload is returned as the chunk.
- **High.** Deleting a Class loads every closed document except traces. Any null or thrown load sets `failed`, and `deleteBlocked` disables confirm (`content-browser-workspace.tsx`).
- **High.** `recastMeshesFromCollider2d` handles chain, polygon, and circle. `capsule2d` falls through to a default box.

## Reported in the third batch, not re-checked

- Creating a project deletes the finished folder if removing `.babylonslate-creating` throws, and the next create deletes a folder that still has that marker (`project-service.ts` `scaffoldOwnedProject`).
- A `.gltf` import that consumes a PNG sidecar and then misses the `.bin` drops the PNG from the remaining import set (`gltf-import-batch.ts`).
- `gltfJsonToGlb` can encode an empty BIN for a non-relative buffer URI (`glb-parse.ts`).
- Static audio geometry bakes every mesh as a 1×1×1 box at the actor transform, ignoring mesh kind and parent (`audio-reverb.ts`).
- glTF node scale `0` is treated as `1` (`glb-geometry.ts`).
- Reverb occupancy rasterizes each triangle as its axis-aligned box (`audio-reverb.ts`).
- External-change classification ignores deleted open files when the change count is small (`mtime-diff.ts`).
- A guid-remap failure on the document chunk returns the original bytes after the header was already remapped (`guid-remap.ts`).
- Encode timeout does not abort the in-flight worker job, and a commit throw after `compressed` is then reported as `encode_failed` (`encode-queue.ts`).
- A font named `serif` is dropped from its own CSS stack (`font-stack.ts`).
- Font file import does not attach TTF, WOFF, or OTF to an existing family (`importers/font.ts`).
- An MSDF PNG can be consumed when the JSON page names a different file (`msdf-import-batch.ts`).
- An audio-channel parent cycle also clears parents of nodes that only lead into the cycle (`audio-payload.ts`).
- Memory blob storage returns the caller’s `Uint8Array` by reference (`blob-store.ts`).
- Extra-chunk helpers skip chunks whose bytes were not loaded, so a later save can drop them (`asset-document.ts`).
- An empty `actors` array drops meshes converted by `migrateSceneMeshesToActors` (`migration.ts`).
- Havok character movement does not apply collider layer and mask (`havok-backend.ts` `moveCharacter`).
- Software `shapeSweep` returns the center ray from both overlap branches (`software-backend.ts`).
- An oriented software cylinder AABB uses four corners instead of the full slab (`software-backend.ts`).
- `importNavMesh` disposes the live mesh before import, with no restore if import throws (`recast-backend.ts`).
- Shader and particle reciprocal, log, and square-root nodes default to `0` (`shader-graph` and `particle-graph` catalogs).
- Duplicating a behaviour-tree root does not parent the clone (`behaviour-tree` `duplicateSubtree`).
- Unknown behaviour-tree decorators pass when no decorator host is set (`evaluate.ts`).
- Canvas and document behaviour-tree parsers disagree on a missing service `intervalMs` (`serialize.ts` vs `tree.ts`).
- Overlay pointer `up` and `cancel` do not clear hover (`scene-layer-pointer.ts`).
- 2D marquee selection force-updates every pickable mesh (`two-d.ts`).
- Water reflection searches every mesh for the skybox on each sync (`water-reflection.ts`).
- `sameComponentVisuals` JSON-stringifies mesh parts during snapshot reconcile, separate from the rejection fingerprint (`snapshot-apply.ts`).
- The material-function end-to-end test only checks that the outputs panel is visible (`e2e/p9-content.spec.ts`).
- Source-control Edit Anyway only checks that the same button is still visible (`e2e/p15-source-control.spec.ts`).
- Mannequin contact coverage is asserted only when one region has more than five contacts (`e2e/basic-3d-mannequin-shadows.spec.ts`).
- Input Listen does not assert that the binding became `KeyJ` (`e2e/input-assets.spec.ts`).

## Verified from the desktop-only read

These are separate from the iframe bridge, the unbounded `lfs:fetch` body, the source-control secret file mode, and the update fail-open already recorded above.

- **Medium.** `project:readBinary` has no size cap. `validateIpcArguments` limits `project:readBinaryRange` and `project:writeBinary` to 512 MiB. A full read only checks the path, then `readFile`s the file in the main process.
- **Medium.** Save-game leases are not hierarchical. `DesktopSaveGames.acquire` locks the exact key. `operation` then allows `key === lease.key` or `key.startsWith(lease.key + "/")`. Two owners can hold `project/game` and `project/game/slot` at the same time and both write the child path.
- **Medium.** `registerIpc` builds one `NodeStorageAdapter` for every window. Project reads and writes follow whichever folder was opened last. `activate` can create another window when none are open.
- **Medium.** Navigation blocking is `will-navigate` on the main frame. There is no `will-frame-navigate` handler, so the Preview iframe can navigate itself.

## Verified in the fourth batch

- **High.** A single simulation step does not pause if the tick throws. `worker-entry.ts` handles `"step"` as `resume()`, `tick()`, `pause()` with no `finally`. Pause is skipped, and the scheduler keeps running.
- **High.** A Class display name can replace an engine parent. `classParentLookup` stores `header.name` in the same map as class ids. A class named `Actor` makes `map.get("Actor")` return that class’s parent instead of the engine parent.
- **High.** Function-graph inspector edits write the class graph. `updateNodeData` patches `graph.nodes` by id. Data-graph nodes go through `patchDataGraphNode` with `activeFunctionId`. Other nodes do not. A function node that is not in the class graph is a no-op, and a colliding id patches the class node.
- **High.** Android external writes truncate in place. `BabylonSlateScopedStoragePlugin.writeFile` opens the stream with `"wt"` and writes the payload. There is no temporary file.
- **High.** iOS ranged reads do not start an iCloud download. `readFileRange` calls `withCoordinatedRead` with `materialize: false`.

## Reported in the fourth batch, not re-checked

- Choosing a font with no MSDF pair calls `update` for the font and then for the renderer. Scene Details applies each update to the scene captured when the callback was created, so the second write can drop the font (`component-property-rows.ts`).
- Duplicate component labels can collide after uniquify (`component-graph-members.ts`).
- A viewport registered while the editor is paused never receives `setPaused(true)` (`editor-scheduler-registry.ts`).
- Retargeted animation file names collapse characters outside `[A-Za-z0-9_.-]`, so distinct display names can share one path (`animation-retarget.ts`).
- A failed optional-content fetch is cached as an empty set for the session (`engine-content.ts`).
- Deleting an event removes event nodes and leaves `flow.event.call` nodes (`class-members.ts` `removeClassMember`).
- Canvas resize dispose can leave the scheduler in a resizing hold (`canvas-resize-guard.ts`).
- A failed scene realization leaves `sceneWorkBlocked` set, and the next realize awaits the same rejected promise (`scene-realizer.ts`).
- Change Scene deletes the old scene before the new one is ready. Failure then has no scene to restore (`scene-realizer.ts`).
- `WaterWorld.evaluate` scratch is cleared only at the end, so a throw leaves stale actors for the next pass (`water-world.ts`).
- Save-game registration keeps the first selection and does not update it (`save-game-world.ts`).
- Scene-stream `notifyReady` resolves the load promise before admission flush. A later throw retires a stream the caller already saw as loaded (`scene-streams.ts`).
- `invokeFunction` returns on the first Promise and skips later modules of the same class (`script-host.ts`).
- `ResourceCacheOwner.acquireExisting` is not tracked by `dispose` (`resource-cache.ts`).
- Font `dispose` does not clear `loaded`, so `isReady` stays true (`font-registry.ts`).
- Android text reads replace invalid UTF-8 instead of rejecting it (`BabylonSlateScopedStoragePlugin.java`).
- iOS permission errors on one file are reported as `ACCESS_REVOKED` for the folder (`BabylonSlateScopedStoragePlugin.swift`).
- `docs/architecture/overview.md` still says Android keeps the Clerk token only in process memory. The Android secrets plugin uses AndroidKeyStore.
- iOS Keychain `set` deletes the old item before `SecItemAdd` (`BabylonSlateSecretsPlugin.swift`).
- Android SAF listings can collapse two children with the same display name on later read and write (`DirectoryReadCache.java`).
- Parse Float success uses `Number` while the value uses `parseFloat`, so `0x10` and `1_000` disagree (`string.ts`).
- Switch on Enum routes by a Title Case label, so members that share a label share one arm (`enum.ts`).
- Custom event names that differ only by spaces, underscores, or hyphens compile to the same identifier (`member-pins.ts`).

## Verified in the fifth batch

- **High.** Painter2D size changes do not resize the surface. `createPainter2DMesh` builds the plane and texture from width, height, and pixels per unit. `updatePainter2DMesh` paints into the existing texture and does not change the mesh or the texture size.
- **High.** Dynamic nav cost volumes are restamped from the actor’s local transform. `syncNavCostVolumes` passes `actor.transform` into `rotatedBoxWorldAabb`. Obstacle registration uses `actorWorldTransforms`. A cost volume parented to a moving actor is corrected once, then overwritten on the next crowd tick.
- **High.** Script traces, overlaps, and sweeps always use the main physics world. `createPhysicsHostBindings` calls `deps.physics()` for `lineTrace`, `sphereOverlap`, and `shapeSweep`. Impulses, character movement, and teleports use `deps.physicsFor(actor)`, which can be a Scene Layer world.

## Reported in the fifth batch, not re-checked

- Tilemap collision chains ignore actor scale and the component’s local transform (`physics-sync.ts` `collectTilemapColliders`).
- A failed ragdoll capture is not retried while the descriptor stays the same (`ragdoll-sync.ts`).
- Any `RagdollComponent`, including `enabled: false`, excludes Movement physics (`physics-sync.ts` `classifyActor`).
- Debug sphere segment counts are unbounded and duration-0 draws rebuild the mesh every tick (`play-debug-draw.ts`).
- Render-target history captures walk every mesh material every frame (`render-target-capture.ts`).
- A 0×0 registered view reports the frame as rendered and skips the engine fallback (`registered-view-admission.ts`).

## Verified in the sixth batch

- **High.** Reparenting a Class writes the open graph immediately. `reparentClassDocument` calls `saveDocument` with `doc.content` and `{ parentClass }`, then `bump()`. It does not mark the document clean and does not catch a failed write. Discard after that only drops memory. The parent change is already on disk.
- **High.** A nav bake writes the scene body captured when the bake started. `startBake` passes `doc.content` into `writeSceneNavmeshChunk`. Each new bake replaces `abortRef` without aborting the previous controller, and `finally` sets `abortRef.current = null`. Edits made during the bake stay in the tab. Disk gets the older body plus the new navmesh chunk.
- **Medium.** Settings events that include `theme` republish appearance as the previous snapshot plus the new theme. `AppSettingsOwner.receiveUpdate` does that whenever `patch.theme` is set, so a Touch Target Scale change stored in the same settings object is not what `useAppSettings()` publishes.
- **Medium.** Approving migrations does not run compile-on-save, model thumbnail jobs, or the scene-saved editor-utility hook. `saveProject` does all three. `approveMigrationsAndSave` writes the documents, marks them clean, and stops.

## Reported in the sixth batch, not re-checked

- Data Definition `commit` applies `{ ...definition, fields }` from the render that created it, with no mutation queue (`data-definition-editing-context.tsx`).
- A Material Instance whose root graph will not lower stays on `"loading"` instead of `"error"` (`material-editing-context.tsx`).
- Preview Build posts the pack from both iframe `onLoad` and the player pack request, and the second call disposes the first asset server (`play-context.tsx` `sendPreviewPack`).
- Material render control registration keeps one owner. A second registration replaces the first, and the first does not register again (`material-render-control-context.tsx`).

## Verified in the seventh batch

- **High.** A live Play scene change does not clear the interpolator. `loadScene` calls `interpolator.clear()` and retires world slots. The `sceneLoading` / `activeScene` command path updates `worldLoadId` and does not. Slot ids are reused, so the next apply can put the previous scene’s poses on the new meshes (`create-engine.ts`).
- **High.** Havok `shapeSweep` only calls `shapeCast`. It does not test whether the shape already overlaps the start pose. `end.rotation` is unused. The cast keeps `start.rotation` for the whole segment (`havok-backend.ts`).
- **High.** Rapier dynamic bodies call `setAdditionalMass` and do not set their own collider density to 0. Hosted child shapes do call `setDensity(0)`. Authored mass is added on top of the collider’s default density (`rapier-backend.ts`).
- **High.** Scene display names overwrite library keys. `indexSceneLibrary` always `scenes.set(displayName, scene)`. The guid map only stores a display name when that key is free. The file comment says a key wins over a display name (`scene-library.ts`).
- **High.** A thrown stream despawn leaves the stream unloading. `SceneStreams.unload` sets `state` to `"Unloading"` and calls `retire` only after actor removal finishes. There is no `catch`. `load` then rejects because the target is still unloading (`scene-streams.ts`).

## Reported in the seventh batch, not re-checked

- World material warm-up ignores `worldLoadId` and can finish after a Play scene change (`create-engine.ts` `loadingScope`).
- `applyRenderingQuality` returns before fog, LUT, and water revisions are compared (`create-engine.ts`).
- Construction-time `fontRegistry.registerAll` is not awaited and does not invalidate the scheduler (`create-engine.ts`).
- Overlay animation apply searches the world scene’s animation groups (`create-engine.ts`).
- Play dispose re-enables every other registered view, not the set that was enabled before Play (`create-engine.ts`).
- Commands queued behind a loading slot are dropped when that load fails (`command-source-preparation.ts`).
- A Both Ways animation transition inserts a reverse row with an empty rule graph, and that reverse row is hidden on the canvas (`anim-graph` `setTransitionBidirectional`).
- A Loop restart clears cooldown memory on descendant nodes (`behaviour-tree` `resetSubtreeForLoop`).
- Animation clip speed of 0 or a negative speed is treated as `0.001`, so the clip becomes extremely long (`anim-graph` `clipDurationMs`).
- Save-game `register` keeps the first selection (`save-game-world.ts`). Already noted; this read adds that `capture` then writes that frozen selection.
- `SimulationSession.quiesce` has no `try/catch`. A throw leaves the returned promise pending and the loading pause on (`simulation-session.ts`).
- `setVariable` on `RenderTargetCaptureComponent` returns without writing non-capture fields (`script-host.ts`).
- `waitForSceneWork` can resolve an already fulfilled promise before it honors an already aborted signal (`scene-realization-work.ts`).

## Verified in the eighth batch

- **High.** A failed Preview input boundary leaves input suppressed. `setEditorInputSuppressed` sets `inputTransitionPending` and clears it only after `requestBoundary` resolves. The boundary client rejects after 3000ms, and a `success: false` result throws. `applyInputOwnership` keeps pointer, keyboard, and gamepad input suppressed for the rest of the session (`boot.ts`).
- **High.** A failed Preview resume leaves the view paused while the frame pump runs. The lifecycle handler calls `handle.setPaused(true)` and then `requestBoundary({ kind: "pause" })`. `setPaused(false)` runs only in the boundary success path. When the page becomes visible again, the pump is restarted from `lifecyclePaused` alone (`boot.ts`).
- **High.** A failed startup scene-source upload rejects every later scene acquire. `systemSources` is `acquireSceneSources(...).then(...)` with no `catch`. `acquireScene` awaits that same promise (`boot.ts`).
- **High.** Cable particle frames never reach the Play handle. `CommandMessage` includes `cableFrame`. `PLAY_ENGINE_COMMAND_TYPES` forwards `waterTime` and does not include `cableFrame` (`play-engine-commands.ts`, `channels.ts`). `setVoiceGain` was already noted.
- **High.** Loop instrumentation ends a regex at a slash inside a character class. In regex mode, `classifyCode` does `if (ch === "/") stack.pop()` with no class tracking. A pattern such as `/[/)]/` inside `while (` or `for (` closes the header early and `parseStatement` rewrites the following source (`infinite-loop.ts`). The operator-versus-`return` slash heuristic is a separate case.
- **High.** Moving an asset keeps the old locator path. `moveAssetUnlocked` and `moveFolderUnlocked` copy the indexed asset and overwrite `path` only. `getAssetLocator` returns that locator when the new file’s revision and size still match. Payload reads use `locator.path` (`registry.ts`, `payload-loader.ts`).
- **High.** Delete drops unsaved edits before the files are removed. `confirmDelete` runs class-reference replacement and `closeDocumentsForPaths` before `deleteFolder` / `deleteAsset`. `closeDocumentsForPaths` drops undo history and closes the tabs. A later throw leaves the files on disk and the open edits gone. A class delete that fails after reference replacement leaves the class file while its usages are already rewritten (`content-browser-workspace.tsx`, `document-context.tsx`).
- **High.** Opening another Scene stops Play before the save-or-discard choice. `openDocument` awaits the `replace-document` gate, and that gate calls `sessionOwner.stop()`, before it looks for dirty scenes. Cancel only bumps `exclusiveSceneRequest` and clears the prompt (`document-context.tsx`, `play-context.tsx`).
- **High.** Cancel during the exclusive-scene gate still opens the Scene. `confirmExclusiveSceneOpen` captures `ref` before the gate await and samples `exclusiveSceneRequest` after it. Discard mode never reads the token. A cancel in that window has already incremented it, then discard and the post-await save path both call `finishOpenDocument(ref)` (`document-context.tsx`).
- **High.** Crash-recovery replay is not tied to the project that was open. `replayRecoveryJournal` reads `project.guid` once, then applies lines when the authoring-lock object is unchanged. That object changes only when an authoring lock is published. Close and project enter do not publish one. The guid check is only inside the later truncate predicate (`document-editing-service.ts`, `document-service.ts`).
- **High.** A nested `World.tick` double-steps the clock and drops spawn deferral. `tick` always calls `clock.advance()` and has no re-entry guard. `runPhase` clears `ticking` in `finally`. The nested clear runs while the outer phase is still walking actors, so `spawnActorNow` commits immediately and later actors tick twice (`world.ts`).
- **High.** Number-prompt Save submits the last live value. The confirm button calls `submit()` with React state. `NumberField` updates that state only for an in-range parse. Enter runs `finishDraft` first, which clamps or refuses. An out-of-range draft such as `30/6` with `min={10}` is saved as the previous number and the dialog closes (`number-prompt-dialog.tsx`, `number-field.tsx`).
- **High.** Size Graph To Fit frames the mounted neighborhood. The control calls `fitView` with no node list. Once the host has a size, React Flow is given `visibleGraph.nodes` only (`graph-viewport-controls.tsx`, `graph-editor.tsx`).
- **Medium.** A text property commits on blur even when the draft never changed. `TextRowControl` `onBlur` calls `row.onCommit` unless the row is read-only or Escape set the cancel flag (`property-grid.tsx`).
- **Medium.** Debug-draw spheres take an unbounded segment count (`Math.max(4, Math.round(segments))` with two `O(rings²)` loops). Cone radius is `length * Math.tan(angle)` and frustum size is `Math.tan(fov / 2)`, with no upper angle (`play-debug-draw.ts`). The sphere bound was previously only reported.

## Reported in the eighth batch, not re-checked

- Stop or preview abort during a `.babpack` range download does not cancel the HTTP request (`artifact.ts` `createHttpPackSource`).
- Cooked complex collision is ignored after the Model bytes are trimmed (`artifact.ts` `cookComplexCollision`).
- An in-process snapshot copy failure throws before `sceneReadiness.receive` (`boot.ts` `onCommand`).
- In-process halt from `runtime.advance` disposes the engine, then `pump` requests another frame (`boot.ts`).
- Stop during profiling admits profile-stop only after the worker has halted (`main.ts` `cleanupPage`).
- `help stat unit` looks up `stat` because `parseCommandArgs` keeps one token (`commands.ts`).
- `framecap -1` is applied, while manifest parsing normalizes `0` and `-1` to `60` (`commands.ts`).
- A scene `classId` of a duplicate class name packages every class with that name (`closure.ts` `walkClosure`).
- `dependencyCatalog` binds an unresolved name to the last asset with that display name (`export-game.ts`).
- A CSS file whose `href` is not `filename.css` or `./filename.css` is deleted from the export while the link stays (`inlineCssIntoIndex`).
- Concatenated scripts with no trailing newline glue the next `//# sourceURL=` onto the last line (`scripts.ts`).
- An `http:` LFS remote is rewritten to `https:` (`lfs-endpoint.ts`).
- `GitLfsLockProvider.list` marks every lock `ours: false` (`git-lfs-lock-provider.ts`).
- A second `TraceRecorder.start` drops the in-progress frames (`trace-recorder.ts`).
- A large preview profile is failed 10 seconds after start, not after the last chunk (`preview-diagnostics.ts`).
- `diagnosticOperationStopped` cannot carry the `"error"` stop reason (`channels.ts`).
- `packedSourceControls` on a subset still declares every original audio guid (`hydrate.ts`).
- `ClassRegistry.reparent` checks only the moved class against the depth cap, so an existing child can land at depth 17 (`class-registry.ts`).
- Cyclic actor parents are omitted from the inspect tree (`inspect-snapshot.ts`).
- A SceneLayer drop rewrites a surviving child’s `parentId` onto a component that was never created (`instantiate-scene.ts`).
- Interface pin defaults share nested objects across dispatches (`interfaces.ts`).
- A second `World.end` runs Game Instance On End again (`world.ts`).
- `setGameInstance` after `start` skips On End for the old instance and On Creation for the new one (`world.ts`).
- Actor On Init failure leaves the actor spawned and skips component On Init (`commitSpawn`).
- Read-only folder delete is skipped and still clears the selection (`confirmDelete`).
- Folder drag calls `applyRegistryMoves` without reading `busy` (`handleTreeReparent`).
- New Asset accepts `.` and `..`, which the rename dialog rejects (`ContentBrowserNewAssetDialog`).
- Console follow-output stays on because `ScrollArea` `onScroll` is on the root, not the viewport (`debug-console.tsx`).
- A failed mobile session refresh unmounts the local project library (`homepage-account-native.tsx`).
- Folder copy duplicates files without a folder-local guid remap (`registry.ts` `copyFolder`).
- `map_Kd -s 1 1 1 hero.png` captures `-s` as the texture name (`obj-import-batch.ts`).
- Tilemap collision chains cancel shared edges only inside one chunk (`tilemap-chains.ts`).
- A selected anim transition that leaves the viewport stays selected (`AnimTransitionEdge`).
- Graph format sizes an unmeasured node as 220×88 (`graph-format.ts`).
- A property-grid slider never calls `onCommit` (`property-grid.tsx`).
- Range, color, curve, and gradient fields combine the edited component with the last rendered sibling (`property-grid.tsx`).
- `NumericDragField` commits on `pointercancel` and does not require button 0 (`numeric-drag-field.tsx`).
- Flag bit 31 is a negative mask and bits past 31 alias (`flags-field.tsx`).
- Multiline text Escape and overlay click commit (`multiline-text-field.tsx`).
- Parametric reverb `dispose` leaves the caller’s send connections (`parametric-reverb.ts`).
- A failed collider rebuild keeps a disposed mesh in the overlay slot map (`play-console-viz.ts`).
- `PostProcessRetirement.whenReleased` does not include generations added after the wait starts (`post-process-retirement.ts`).
- Own class delete and rename writes of `project.json` skip the mtime snapshot, so the next rescan looks external (`document-context.tsx`).
- A foreground rescan in flight can classify the new project against the previous snapshot (`runForegroundRescan`).
- Save All can mark documents clean and then skip journal truncate when the project document object was replaced (`saveProject`).
- Two asset-tab activations resolve in completion order, with no last-click token (`finishOpenDocument`).
- `dismissRecovery` clears the banner after the await even if another project is now open (`document-context.tsx`).
- Delete repair writes the on-disk copy under dirty tabs and patches those tabs only in memory (`repairAfterAssetDelete`).

## Verified in the ninth batch

- **High.** Phone layout freezes the desktop dock snapshot. `enterPhoneDockLayout` stores `api.toJSON()` once. `captureAdaptiveDockviewLayout` returns that object instead of the live API, and document save uses it. A function-graph tab opened or renamed after phone layout starts is missing from rotation restore and from the saved layout (`phone-dock-layout.ts`, `document-context.tsx`).
- **High.** Call Custom Event drops the caller’s tick. `invokeCustomEvent` dispatches with delta `0`, tick index `0`, and no `tick` or `extras`. Call Parent passes `deltaSeconds`, `tickIndex`, `tick`, and `extras`. Input queries inside the custom event therefore see empty defaults (`script-host.ts`).
- **High.** An async event swallows an infinite-loop abort. `dispatchEvent` rethrows `isInfiniteLoopError` only from the synchronous `catch`. A returned promise is logged and then `clearPending` runs, so the next tick starts the event again (`script-host.ts`).
- **High.** Project and game export put `bytes.buffer` in the download `Blob`. A `Uint8Array` view with a non-zero `byteOffset` or spare capacity includes bytes outside the zip. `handleExportGame` revokes the object URL only on the success path (`settings-modal.tsx`). This was previously only reported.
- **High.** Water chop and glitter run in absolute float32 world space. `swPosW` adds `slateWaterOrigin`, and `swWorld` is `swPosW.xz`. Swell rest is `vPositionW.xz` without that origin. `swGlitterP` adds `slateWaterOrigin.xz` to that eye-relative rest (`water-material.ts`). Fine chop and glints quantize once the origin is large.
- **Medium.** `stopParticles` uses slot `0` when the actor has no slot and still emits `assignParticle` with a null guid (`audio-particle-emitter.ts`).
- **Medium.** Aborting a non-sound behaviour-tree task stops the actor’s leftover PlaySound voice. The PlaySound branch stops that node’s voice. The `else if` still calls `stopPlaySound` whenever `voiceByActor` has the actor (`behaviour-tree-runtime.ts`).
- **Medium.** An overlay slot whose layer scene is not live is added to `liveSlots` and then skipped. Migration, leftover disposal, and the pose pass do not run, so a mesh already in the world scene keeps its last transform (`snapshot-apply.ts` `reconcileSnapshotVisuals`).
- **Medium.** `retirePlayWorldSlots` skips overlay slots and then sets `possessedCameraSlotId` and `defaultCameraSlotId` to null. An overlay camera that was selected is cleared on a world-scene reload (`snapshot-apply.ts`).

## Reported in the ninth batch, not re-checked

- A remembered dock placement on the other side of its catalog reference, or tabbed into that reference, reopens on the catalog side (`dock-window-ops.ts`).
- Phone inlining flattens a multi-panel floating group and drops the splits inside it (`inlineDetachedDockviewLayout`).
- A default Sprite Animation layout created while the host width is 0 never receives the 75% Details width (`window-catalog.ts`).
- Renaming the active function leaves the phone Window picker on the old title (`dockview-shell.tsx`).
- Orthographic water thickness uses `|view[1][2]|`, so a horizontal ortho view forces refracting depth to 0 (`water-material.ts`).
- Painted water fog removal treats `swRefractedWeight` as the share of `swRefracted`, but the color also includes transmittance, caustics, and foam (`water-material.ts`).
- A reflected ray with negative clip `w` is divided by a tiny positive number and can still contribute (`water-material.ts`).
- The water outline vertex path never defines `SLATE_WATER_BLEND`, so a blending surface uses the unscaled swell (`water-material.ts`).
- Low water shading with refraction on still draws the fake sand bed for sky-depth pixels (`water-material.ts`).
- Water removal selection uses `getAbsolutePosition()` while the shader cuts with the eye-relative world matrix (`water-material.ts`). Confidence was medium without the installed Babylon matrix source.
- Contact derivatives are taken before `discard`. Shading footprints in `surfaceSource` run after that discard (`water-material.ts`).
- Water temporal fade assumes 30 fps (`TEMPORAL_FRAME`).
- A failed registry walk leaves the root mounted with a partial index (`mountRoot`).
- Path reservation is case-insensitive, and the existing-asset check is exact case (`reservePath`).
- `copyFolder` throws when the destination directory exists but was not indexed (`registry.ts`).
- `unmountRoot` does not wait for `textureWriteChain`, so an in-flight rewrite can index a file under a root that is gone (`registry.ts`).
- `attachToExistingAssetUnlocked` can rewrite a read-only root when the caller’s `rootId` is writable (`registry.ts`).
- A second sprite part replaces the only tracked blend mesh for that slot (`createPlayMesh`).
- Component parent cycles are not broken when play visuals are parented (`createPlayVisual`).
- `isPathValid` treats a one-point path as invalid (`runtime-host-navigation.ts`).
- Tilemap collider chains ignore actor scale and the component’s local transform (`physics-sync.ts`).
- A failed ragdoll capture stays in `states` and is not retried until the descriptor changes (`ragdoll-sync.ts`).
- Any live `RagdollComponent` excludes movement and blocks inspector teleport, including when it is disabled (`physics-sync.ts`, `runtime-inspector.ts`).
- `showcollision` lists only main-world colliders (`runtime-physics-worlds.ts`).
- A synchronous infinite loop in an animation graph or behaviour tree returns before the frame is published (`driver.ts` `tickSceneSystems`).
- Nested sync console commands share one `commandResult` (`script-host.ts` `invokeCommand`).
- Cancelling an async console command rejects the waiter and leaves the handler running (`invokeCommandAsync`).
- The first async function export returns immediately, so later modules on that class never run (`invokeFunction`).
- `setText`, audio, particles, camera, impulse, constraint, and movement native calls do not check `canInvokeOwner` (`callNativeComponentFunction`).
- Attach Actor to a destroyed parent clears the live parent (`attachActor`).
- Transform writes accept non-finite numbers and destroyed actors (`setActorLocation`).
- Source-control prefill writes the pre-await settings snapshot, so edits made during the await are overwritten (`settings-modal.tsx`).
- Light `shadowPriority` also appears as a generic numeric row (`component-property-rows.ts`).
- Text3D `depth` has no inspector row (`component-property-rows.ts`).
- The next Collision Layer edit keeps only the first set bit (`layerNameFromBitmask`).
- Sprite frame boxes replace authored `box2d` half-extents at the same collider id (`collectSpriteColliders`).

## Rejected in the ninth batch

- `InProcessRuntime.start` swallowing an infinite loop in Game Instance On Init is tested containment (`infinite-loop.test.ts` expects `start()` not to throw). The same swallow still leaves `running` true, and `World.start` will not retry hooks that had not run.
- `clearCurrentScene` destroying a scene created during On End was called intentional.
- Double `sceneLoadGeneration` increments were called harmless.
- `PhysicsWorldSync.retireActor` leaking character controllers was withdrawn because `destroyBody` already destroys the controller.

## Verified in the tenth batch

- **Medium.** Two graph pastes in the same millisecond reuse node ids. `pasteClipboard` stamps every copy with one `Date.now()` plus the clipboard index, and the position is always the original clipboard point plus 40 (`graph-editor.tsx`).
- **Medium.** A palette insert id is `` `${paletteNode.id}-${Date.now()}` `` with no counter. Two inserts of the same palette node in one millisecond share an id, while their positions do step by 40 (`graph-editor.tsx` `handleAddPaletteNode`).
- **Medium.** Render-target history checks call `getActiveTextures()` on every mesh in the capture list and on each particle material, with no cache (`render-target-capture.ts` `samplesAttachment`).

## Rejected in the tenth batch

- The basic emission `while (cycleTime >= duration)` loop has no duration guard. Authored Basic schedules clamp duration to at least 0.05 (`PARTICLE_EMITTER_LIMITS`), so the play path does not spin. The earlier “loops forever” report is withdrawn for that path.
- `getAnimationRatio() || 1` on the GPU particle override was called an intentional copy of Babylon’s clock, not a preview desync.
- `play-free-cam.ts` 3D `look()` was called standard zero-roll order. Unclamped pitch past vertical was not re-checked.
- Ragdoll pose matrix order was accepted as Babylon’s row-vector `local = world * inverse(parentWorld)`.

## Verified in the eleventh batch

These are documentation mismatches. The code is the behavior below.

- **Medium.** `docs/architecture/scene-editing.md` says `normalizeScene` renames a repeated actor id (`dupe` to `dupe-2`). `assertUniqueSceneActorIds` throws `"<document>" contains duplicate actor id "<id>"` (`packages/core/src/scene.ts`). The same page later says load rejects duplicates.
- **Medium.** That page says 3D pinch and wheel zoom dolly toward the point under the cursor. `EditorCamera.zoom` changes only `camera.radius` in 3D. The pointer pivot is computed only when `mode === "2d"` (`packages/render/src/editor-camera.ts`).
- **Medium.** `docs/architecture/physics.md` lists the tick order as `gameInstance` → `actors` → `components` → `physics` → `postPhysics`. `TICK_PHASES` inserts `sceneSubsystems` between `gameInstance` and `actors` (`packages/object-model/src/tick.ts`).
- **Medium.** `docs/architecture/object-model.md` lists seven overlay-exclusive components. `ENGINE_COMPONENT_DESCRIPTORS` also marks layout boxes, padding, spacer, painter, joystick, form controls, virtualized list and grid, mask, safe area, and focus target as `placement: "overlay"` (`packages/core/src/engine-components.ts`).
- **Medium.** `docs/architecture/overview.md` says only `PlayProvider` and the Content Browser call `useDocuments()`. `ActorDefaultsGrid` calls it too (`apps/editor/src/panels/actor-defaults-grid.tsx`).
- **Medium.** `docs/design/gestures.md`, `docs/engineplan.md`, and `docs/CODING_STANDARDS.md` say Dockview tab strips are 18px on fine pointers and 26px on coarse pointers. `dockview-theme.css` sets the strip to 26px by default and 30px under `pointer: coarse`.
- **Medium.** `docs/engineplan.md` says the Outliner can group by sorting layer. `scene-outliner-panel.tsx` groups by folders and actor `parentId`.
- **Medium.** `docs/engineplan.md` says pixel-perfect mode offers integer-only zoom steps. `PixelPerfectSettings.integerZoomSteps` is documented as unused by editor pinch and wheel, and `EditorCamera.zoom` multiplies continuously (`packages/render/src/pixel-perfect.ts`).
- **Medium.** `docs/engineplan.md` says cost volumes stamp Detour poly area `1`. `applyAreaCosts` assigns `index + 1`, and tile-cache walkable polygons use area 63 (`packages/navigation/src/recast-backend.ts`).
- **Low.** `docs/engineplan.md` still tells the reader to add `@recast-navigation/babylon`. `docs/architecture/navigation.md` and the `p11-nav-editor-host` checklist say that package is unpublished.

## Reported in the eleventh batch, not re-checked

- `docs/architecture/scene-layers.md` repeats the short overlay-only list while later sections describe the extra components.
- `docs/engineplan.md` says the tile palette is a searchable dropdown from a Palette button. The editor opens a DockView `tilemap-palette` panel.
- `docs/engineplan.md` says a NavMesh actor owns a debug-overlay toggle. The overlay is `scene.settings.showNavmesh`.
- `docs/engineplan.md` says nav geometry collection is chunked across frames and the editor stays interactive once generation starts. `runNavBake` collects in one call, and Cancel is enabled only while generating.
- `docs/design/particle-emitters.md` says Particle Graph lowering targets Babylon 9.20. `packages/render/package.json` pins `@babylonjs/core` at 9.29.0.

## Coverage still open

## Verified in the twelfth batch

These are documentation mismatches. The code is the behavior below. The `useDocuments()` claim in `command-layer.md` is the same `ActorDefaultsGrid` call already recorded.

- **Medium.** `docs/architecture/input.md` says the Play worker stamps canvas and gamepad samples from the last `stats.tickIndex`. `applyPlaySnapshotTick` returns `snapshotTickIndex(buffer)` (`apps/editor/src/services/play-session.ts`).
- **Medium.** `docs/architecture/audio.md` says console `pause` stays simulation-only. Console `pause` calls `host.pause()` and emits `sessionPaused`. The editor then requests a `resetInput` boundary, and a successful result calls `setGameTimePaused`. That sets `gameTimePaused`, and `applyPause` calls `audioService.setPaused` (`runtime-console.ts`, `play-session.ts`, `create-engine.ts`). A `resetInput` reply after pause reports `paused: true` (`session-boundary.test.ts`).
- **Medium.** `docs/architecture/asset-registry.md` says Model Import Default Scale defaults to 10. `modelImportDefaultScale` defaults to 1 (`packages/vfs/src/app-settings.ts`). `docs/architecture/vfs.md` already says 1.
- **Medium.** That page says Model Preview Show Collision defaults on. `model-collider-session.tsx` initializes `showCollision` to `false`.
- **Medium.** That page says New Asset creates a fixed World / Scripting / 2D / Animation / Rendering / AI / Audio list. `CREATABLE_ASSET_TYPES` also creates SceneLayer, Prefab, MaterialInstance, SaveGame, DataDefinition, DataTree, InputAction, InputAxis, Water, RenderTarget, and RenderTargetTexture, and the dialog adds Input and Data groups (`content-browser-helpers.ts`).
- **Medium.** `docs/architecture/containers.md` says header `parentClass` is an optional parent class guid. Class saves store a class id such as `BObject` or `Hero` (`class-asset-refs.test.ts`).
- **Medium.** `docs/architecture/components.md` says the Animation Graph variable picker is Bool / Int / Float / String. `VARIABLE_TYPES` also includes `tag` and `tagContainer` (`anim-graph-editor.tsx`).
- **Medium.** `docs/architecture/behaviour-tree.md` says `HOST_TASKS` is `moveTo`, `rotateToFace`, `playAnimation`, and `playSound`. The set also includes `bt.task.moveToBlackboardKey` (`builtins.ts`).
- **Medium.** `docs/architecture/keybinds.md` lists Editing defaults as Duplicate, Rename, and Delete. `editor-keybinds.ts` also defaults Copy Actors to `Mod+C` and Paste Actors to `Mod+V`.
- **Medium.** `docs/architecture/debugger.md` does not list `renderpath`, `possess`, or `destroyactor`. All three are commands (`commands.ts`). `lightsdebug` is documented there. `docs/architecture/console-commands.md` describes `quality lighting` as `[tier|reset]`. `quality lighting budget 3` succeeds and sets `maxLocalLights` (`execute-console.test.ts`).

## Verified in the thirteenth batch

- **High.** Screen-space reflections compose onto the original scene color and drop ambient occlusion when both are on. AO compose records `mainInput` as the stage index of the color to composite. SSR combine hardcodes `mainInput: 0`. The frame graph binds `inputs[stage.mainInput]` as `mainSampler`, and `inputs[0]` is the color before the first stage (`spatial-effects.ts`, `spatial-effects-graph.ts`). Documented order is occlusion, then reflections (`scene-effects.ts`).
- **Medium.** The volumetric march shader does not receive the compile-failure callback. AO, SSR, and volume compose pass `failure` into `customWrapper`. The volume march call omits it, so a failed march does not set `compileFailure` (`spatial-effects.ts`).

The second-sprite overlay map entry was already reported: `createPlayMesh` stores one overlay per slot.

## Verified in the fourteenth batch

- **High.** `updateLandscapeMesh` does not rebuild chunks when subdivisions change. Chunks and their `width` / `depth` are created once. The updater only rewrites vertex data for those chunks. A smaller subdivision indexes `heights` past the new grid, and a larger one never creates the extra cells (`landscape-mesh.ts`).
- **High.** `MaterialLibrary.cancelPending` looks up and deletes `pending` by the raw asset guid. `acquire` stores unlit, instanced, and logical-buffer jobs under `cacheKey`, which is `"${assetGuid}:unlit"` or a JSON tuple (`material-library.ts`). This was previously only reported.

## Reported in the fourteenth batch, not re-checked

- Authored prepass view depth writes `(view * position).z` without the right-handed Z negation that geometry capture applies (`geometry-surface-output-block.ts`).
- PBR lattice shadows read `opacityTexture` from a `StandardMaterial` cast, so an alpha-tested PBR material draws a solid shadow (`native-lattice-shadow.ts`).
- Text-2D gizmo resize inverse-scales every descendant mesh, not only glyphs (`overlay-transform-box.ts`).
- Overlapping `NavMeshDebugOverlay.sync` calls can leave blocker meshes after `clear` bumps the generation (`nav-debug-overlay.ts`).
- Joystick pointer moves allocate vectors and invert a matrix on every event (`joystick2d-input.ts`).
- Overlay clip scissor allocates on every bind (`overlay-layout-render.ts`).
- The first native-preparation caller’s memory limits stick for the engine (`native-preparation.ts`).
- Overlay style records the child list once and does not see meshes added later (`overlay-visual-style.ts`).
- Linked skeletons parent bones by node name, so duplicate names last-write-win (`node-rig.ts`).

## Verified in the fifteenth batch

These are end-to-end tests whose titles name a behavior the body does not run.

- **Medium.** `Particle Emitter and System assets survive save and reopen` creates and reopens `ReopenSparks`, a Particle Emitter. It never creates a Particle System (`e2e/p17-particles.spec.ts`).
- **Medium.** `enables Fake locks, auto-locks on edit, Edit Anyway, Release All, and mtime reload` opens the Release All confirm and clicks `locks-release-all-cancel`. The lock count is not released. The mtime clause touches the file, rescans, and clicks `external-change-keep-edits`. Reload is not confirmed (`e2e/p15-source-control.spec.ts`).
- **Medium.** `2D project paints tiles, plays an animated sprite, and reports physics` opens the sprite editor and creates an Animation Graph named `Loco` with no states. Play checks physics time, fps, and actor Y. No sprite frame or graph playback is read (`e2e/p10-tilemap.spec.ts`).

## Reported in the fifteenth batch, not re-checked

- `build, save, reopen, play in 3D and 2D with gamepad and gizmo undo` asserts gamepad `data-move-x` only while the viewport says 2D (`e2e/p6-scene-editing.spec.ts`).
- `Prefab Preview, Play overlay, and Scene viewport share one session` checks that three canvases are visible and does not read a shared session (`e2e/p18-editor-opt.spec.ts`).
- `play-performance-route.spec.ts` and `play-sustained-route.spec.ts` skip unless `BL_PERF_ROUTE` or `BL_PERF_SUSTAINED` is set.

## Verified in the sixteenth batch

These loops type a second arm and then pass a one-element list, so the other arm never runs.

- **Medium.** `spatial-effects.spec.ts` types reflections, point, spot, sun, and combined, and both WebGL2 and WebGPU. The lists are `["combined"]` and `["webgl2"]`. The fog-volume and ambient-occlusion tests are also `["webgl2"]` only.
- **Medium.** `render-targets.spec.ts`, `scalability-play.spec.ts`, and `shared-outline.spec.ts` type `"webgl2" | "webgpu"` and iterate `["webgl2"]`.
- **Medium.** `qa-custom-events.spec.ts` types a legacy arm and iterates `legacy` as `[false]`. `delete next.members` never runs. Its Preview Build arm was already noted.
- **Medium.** `qa-core-runtime.spec.ts` iterates `preview` as `[true]`. The title’s Normal Play arm never runs. Preview Build does.
- **Medium.** `save-game-parity.spec.ts` types `"packed" | "loose"` and iterates `["packed"]`.
- **Medium.** `render-settings-export.spec.ts` types packed/loose, WebGL2/WebGPU, and an initialization-failure flag. The only entry is packed WebGL2 with `fail: false`. The file comment says other specs cover backend variants.

## Verified in the seventeenth batch

- **Medium.** `basic-3d-mannequin-shadows.spec.ts` types WebGPU, CEL, low, and an alternate light. `cases` has one entry: WebGL2, PBR, medium, alternate off. The WebGPU settings branch and the alternate-light edit never run.
- **Medium.** `color-grading.spec.ts` and `lattice-deformer.spec.ts` iterate `["webgl2"]` only. The lattice cost call is `__latticeDeformerCost("webgl2")`.
- **Medium.** `basic-3d-mannequin-shadow-hosts.spec.ts` checks per-region contact coverage only when `region.contacts > 5`. The required sum of contacts can be greater than 5 while every region stays at or below 5, so `retained / contacts` never runs. `sourceSha256` and `materialDefines` are attached and not expected. The same-pixel-buffer call in this file was already noted.

## Verified in the eighteenth batch

- **Medium.** `dirty Class tab close prompts Save / Discard / Cancel` opens the dialog and clicks `dirty-cancel`. `dirty-save` and `dirty-discard` are never clicked (`e2e/type-editor-chrome.spec.ts`).
- **Medium.** `Object Reference variables show Class Type and drag opens Get/Set` clicks Get and Validated Get. `member-access-set` is never used (`e2e/type-editor-chrome.spec.ts`).
- **Medium.** `Unlit preserves skyboxes and PBR model color in Scene, Prefab, and Model Preview` checks skybox pixels on the scene and model previews. The prefab section only requires more than 500 green pixels in Unlit and again in PBR (`e2e/viewport-shading.spec.ts`).
- **Medium.** `encoded Tilemap atlas renders its pixels in Scene Preview and Play` accepts a green canvas for both the PNG and the KTX2. The format, mip, and byte-size expects sit inside the software-renderer branch. Play does not read `ktx2Uploads` (`e2e/tileset-preview.spec.ts`).
- **Medium.** `water.spec.ts` and `temporal-anti-aliasing.spec.ts` type `"webgl2" | "webgpu"` and iterate `["webgl2"]`. `webgpu-previews.spec.ts` iterates `["webgpu"]` only, and its material and model canvases are only required to be non-blank.

## Verified in the nineteenth batch

These are editor tests whose titles name a sequence the body does not run.

- **Medium.** `moves and removes repeated post-process assets` asserts the move, then clicks remove without writing that scene back. The panel still shows `[a, b]`. Removing the original first row leaves `b`, which is what the test expects. Removing the row the move placed first would leave `a` (`scene-details-panel.test.tsx`).
- **Medium.** `reorders, disables, and removes a post-process pass` also leaves the scene at `[pp-a, pp-b]` after the move. Disable and remove then act on that original order. The checks are only `enabled === false` and `length === 1` (`scene-details-panel.test.tsx`).
- **Medium.** `keeps repeated layers' Z-Order and enabled state` asserts a Z-Order edit of `12`, then expects the enabled switch to save `{ zOrder: 8, enabled: true }`. `8` is the last rendered value. The toggle never sees `12` (`scene-details-panel.test.tsx`).
- **Medium.** `opens Duplicate/Delete from the row menu button` clicks `outliner-delete-actor-1` only. Duplicate is never opened (`scene-outliner-panel.menu.test.tsx`).
- **Medium.** `pastes a copied actor into an empty scene after switching documents` replaces `harness.scene.actors` and rerenders the same provider. The document id stays `scene:assets/Main.scene.babasset` (`scene-outliner-panel.menu.test.tsx`).
- **Medium.** `falls back to the owned engine when overlay Play is not running` passes a usable `owned` engine. `nextRegisteredSharedEngine` returns that engine before it reads `overlayPlaying` (`shared-engine-generation.ts`).

## Reported in the nineteenth batch, not re-checked

- `returns the guid and path for Content Browser reveal` passes only a Texture, which opens as a document, so the `{ guid, path }` branch never runs (`search-navigation.test.ts`).
- `does not change selection when unlocking` calls `selectionAfterLockChange` with the lock flag (`scene-editing-context.test.ts`).
- `never blocks an edit when create conflicts or is offline` only adds a theirs lock (`source-control-service.test.ts`).
- `adds a distinct component after deleting a middle row` never deletes a row (`scene-details-panel.test.tsx`).

## Verified in the twentieth batch

- **Medium.** `skips pointer and keyboard while free cam is on, but still forwards gamepads` drops pointer and keyboard while `steal` is true, then sets `steal` to false before `pollGamepads()`. The gamepad sample is taken with free cam off (`input-capture.test.ts`).
- **Medium.** `opens web folder or ZIP imports explicitly` only clicks Import ZIP and expects `"zip"`. Import Folder is not clicked (`homepage.test.tsx`).
- **Medium.** `lists the subsystem's Call, Get, Set and Call event rows first` requires the event id somewhere in `suggested`. The prefix check is `suggested.slice(0, 3)` with `expect.arrayContaining`, so those three ids can be in any order and the event row can sit anywhere after them (`graph-validation.test.ts`).

## Reported in the twentieth batch, not re-checked

- `does not report a pure cycle when Line Trace location feeds back through Make Vector3` builds `vector.add3`, not `vector.make3` (`graph-validation.test.ts`).
- `keeps phone-sized project access available without an account` stubs width and the gate returns children for every non-mobile host without reading width (`homepage-mobile-account-gate.test.tsx`).
- `commits Array container and resets the Default` uses a bool member with no default (`inspector-panel.member.test.tsx`).

## Verified in the twenty-first batch

`docs/engineplan.md` still describes these as current behavior. The code does the other thing.

- **Medium.** Sections 3.5 and 7.2 say editor texture LOD defaults on. `editorTextureLodEnabled` defaults to false (`packages/vfs/src/app-settings.ts`).
- **Medium.** Section 2.4 says `skipPointerMovePicking` is true in every scene. Each SceneLayer scene sets it false (`scene-layer-compositor.ts`).
- **Medium.** Section 7.4 says proximity wire previews appear within 96 screen pixels. `assistantDistance` defaults to 48 (`graph-interaction-settings.ts`).
- **Medium.** Section 17 says a wasm physics failure uses the software backend. Play creates Havok and Rapier with `allowSoftwareFallback: false` (`runtime-physics-worlds.ts`).
- **Medium.** Section 2.4 says a WebGL restore drops one quality tier and flushes the texture cache. `noteRestore` clears hitch samples and sets the level to `minLevel` (`hardware-scaling.ts`).
- **Medium.** Section 2.5 says area lights are out of v1. `AreaRectLightComponent` is a world engine component (`engine-components.ts`).
- **Low.** The CI paragraph says each Verify end-to-end shard times out at 25 minutes. The `e2e` job is `timeout-minutes: 35` (`.github/workflows/verify.yml`).
- **Low.** Sections 1 and 16.1 say the ready-PR cap is two. The cadence rule waits when four other counted pull requests are already ready.
- **Low.** Section 15.1 points at `apps/editor/ios/App/App/public/assets`. `apps/editor/ios/.gitignore` ignores `App/App/public`.

## Reported in the twenty-first batch, not re-checked

- SceneLayer joysticks push `touchAxis` events in Play and the player. The plan says Touch bindings are fed only by `injectTestTouchAxis`.
- A 3D scene clear color is `settings.environmentColor`, not the dark editor chrome gray.
- The Texture document labels the control Downsample. The plan’s window list still says Max Dimension.
- The Stats HUD has no invalidations-per-second row and no hardware-scaling level.
- The checked `p11-bt-editor` item says behaviour trees have no free drag. The editor passes `commitPositionsOnDragEnd`.

## Verified in the twenty-second batch

- **High.** A non-MSDF 2D font pick drops the font. `PrefabComponentDetails` calls `onUpdate("fontAssetGuid", guid)` and then `onUpdate("renderer", "bitmap")`. `updateComponent` maps the component list captured when the callback was created. The second apply still has the old properties, so the new font guid is replaced and only `renderer: "bitmap"` remains. Clearing the font does the same. An MSDF pair is one update (`inspector-panel.tsx`, `prefab-editing-context.tsx`).
- **High.** A struct variable’s asset field replaces the whole default. Struct rows call `onPickAsset(pinId, assetType)`. The member inspector ignores both arguments and opens the scalar default picker. That picker commits `{ defaultValue: guid ?? "" }` and allows types from `member.typeClassId`, the structure id (`inspector-panel.tsx`, `graph-inspector.ts`).

## Reported in the twenty-second batch, not re-checked

- Function and event pin editors key selection by index, so a reorder selects a different pin (`memberPinRows`).
- Optional and Default controls on those pin editors commit and then snap back because the saved pin drops them (`memberPinsFromRows`).
- Selecting Prefab Root does not clear `selectedMemberId`, so the member inspector stays up (`AuthoringInspectorPanel`).
- Render-target capture actors come from the first open Scene tab (`sceneDocuments[0]`).
- A function-graph binding still looks unwired because the wiring check reads the class event graph (`inputEventPropertyRows`).

## Verified in the twenty-third batch

- **High.** Havok contact ids cannot name a hosted child shape. `firstColliderIdForActor` walks colliders for the body owner, and the comment says hosted child shapes cannot be told apart from the owner’s colliders. `dispatchContacts` sends that id to `onHit`. Software and Rapier report the handle’s collider. The Havok test requires the parent crate’s collider (`havok-backend.ts`, `physics-hosted-shapes.test.ts`).
- **High.** In-process Step does not pause if the tick throws. `applyPlaySessionStep` calls `resume()`, `tick()`, then `pause()` with no `finally`. The worker step path was already noted (`play-session.ts`).
- **Medium.** Idle numerics round to two places and show `0.001` as `0`. `formatNumericDisplay` uses `toFixed(2)` and strips trailing zeros. A later edit commits that rounded text (`numeric-expression.ts`).
- **Medium.** A relative numeric edit of a scientific value is rejected. A leading `*`, `/`, or `+` is applied by concatenating `String(currentValue)`. `String(1e-7)` is `"1e-7"`, and the tokenizer accepts only digits and a dot (`numeric-expression.ts`).
- **Medium.** Picker titles strip any trailing `.Word`. `displayPickerTitle` uses `/\.[A-Za-z][A-Za-z0-9]*$/`. A class named `Boss.Phase` is shown and indexed as `Boss` (`picker-identity.tsx`).
- **Medium.** Switching a pin type to enum keeps the previous `typeClassId`. `pinPickerKeepsTypeClassId` returns true for `enum`, so an object pin’s class id stays on the enum pin (`pin-types.ts`, `pin-list-editor.tsx`).
- **Medium.** A list viewport height of 0 mounts every row. `windowedSlice` returns `lastIndex: itemCount` in that case. `SearchDialog` remounts the list on each query, and the height state starts at 0 (`windowed-slice.ts`).
- **Medium.** Low directional shadows add three texture fetches. `shadow-diagnostics.ts` sets `extraTextureFetches: 3` for `QUALITY_LOW`. `docs/design/renderer-qualification.md` says native PCF fetch counts are unchanged.
- **Low.** The sustained Play route reads `BL_PERF_SUSTAINED_SAMPLE_MS`. Its header and the qualification doc say `BL_PERF_SAMPLE_MS` (`play-sustained-route.spec.ts`).

## Reported in the twenty-third batch, not re-checked

- A static trigger on a moving parent stays at the pose from the start of the step until the next tick (`physics-static-follow.test.ts`).
- Software complex-collision overlap uses the AABB of every position and does not read indices (`software-backend.ts`).
- `uses a live size override without writing project settings` uses a 16:9 live size and a 16:9 lock, so ignoring the live size still fits (`play-preview-aspect.test.ts`).
- Play Without Saving is judged only by the dialog closing. The fixture throws `No project catalog is available.` before Play starts (`play-context.test.tsx`).
- Content-browser search tests can pass if only one of name, path, or type matches (`content-browser-helpers.test.ts`).
- `writes renderer back to bitmap when the Font no longer has an MSDF pair` calls `onChange(null)` while the MSDF checkers still return true (`component-property-rows.test.ts`).
- The qualification matrix says CI applies `SOFTWARE_WEBGPU_ARGS` to the whole suite. `playwright.config.ts` `desktop-chrome` sets no launch args.
- Preview Build sustained windows store tick rate as null because the player test hook has no `tickIndex`.

Runtime tests `sn`–`z` and render tests `t`–`z` reported no new product bugs.

## Verified in the twenty-fourth batch

- **Medium.** Dismissing the material custom-mesh picker resets the preview to a cube. `openCustomMeshPicker` marks a fallback whenever the current mesh is not already a custom mesh with a guid. Closing the picker without a pick then writes `{ mesh: "cube", customMeshGuid: null }` (`material-editor.tsx`).
- **Medium.** Renaming an existing material parameter commits `setProperties({ name })` with no uniqueness check. The new-parameter prompt rejects a duplicate name (`material-editor.tsx`).
- **Medium.** A streaming scene can present while scene-level work is still pending. `isSceneFrameReady` treats the waiting count as clear whenever an admission scope exists (`admitted !== undefined || scene.getWaitingItemsCount() === 0`) (`scene-perf.ts`).
- **Medium.** A scripting exec output does not fan out. `edgesAfterConnect` drops the previous wire when `singleExecOutput` is set and the source pin is exec. `docs/architecture/scripting.md` says exec pins accept multiple wires out (`graph-connect.ts`).
- **Medium.** `callInterface` returns `{}` when there is no interface registry or no receiver. The scripting page says a miss returns pin defaults (`script-host.ts`).
- **Medium.** Renaming a Class to a locked engine id throws. The scripting page says renaming an existing Class is not guarded (`project-service.ts`).
- **Medium.** Play does not log `playSound`. `overlayLogForCommand` returns null for that command (`play-session.ts`).
- **Low.** `docs/architecture/testing.md` says every package is gated at 60%. `packages/physics` is 50% lines, 50% functions, 45% branches, and 50% statements (`vitest.workspace.ts`).
- **Low.** That page says end-to-end shards reuse a shared static artifact. The `e2e` job sets `BL_TEST_BUILD_MODE: ci-bundle` and does not depend on `static` (`.github/workflows/verify.yml`).

## Reported in the twenty-fourth batch, not re-checked

- Escape during keybind recording is tested with a window keydown, which does not reach the document listener (`keybind-settings.test.tsx`).
- The 1 fps model preview test never creates a presenter because the shared engine stays null (`model-editor.test.tsx`).
- `signOut` is not checked for an Authorization header on the session-remove request (`native-clerk.test.ts`).
- Scene-layer `dispose` rethrows a bounded retirement failure as a failed teardown (`scene-layer-compositor.test.ts`).
- Actor and ActorComponent event stubs also include On Game Loaded and Scalability Changed. SceneLayerActor does special-case overlay pointer events. A Call Interface miss with no method returns `{}` rather than pin defaults (`docs/architecture/scripting.md`).
- The testing page’s exclusion table, shard count, merge-job count, phone safe-area viewport, and `fast-check` list do not match the current configs.

## Verified in the twenty-fifth batch

- **High.** A custom-event argument named `target` is never sent. Call codegen skips every input pin whose name is `target`, including the data argument. Implicit self still drops that argument (`scripting-nodes` `flow.ts`).
- **High.** Array Contains, Find, and Remove Item use `includes` and `indexOf`. Vector, rotator, color, transform, and struct values are new objects on each read, so an equal value does not match the stored element (`array-map.ts`).
- **High.** A data definition with a `missing-field` error is omitted from the runtime catalog. `RuntimeDataCatalog.replace` adds a definition only when validation has no error. Every tree entry of that definition then keeps `values` null, including entries that already have the new field (`data-catalog.ts`).
- **High.** Struct map keys are compared by object identity. `projectFieldValue` stores keys in a `Set`. Two entries with the same struct fields are different objects, so both are kept and a later equal lookup misses (`data-values.ts`).
- **High.** An LFS lock response that is empty, invalid JSON, or not an object becomes `{}`. `list` then returns success with no locks. A refresh that applies that result clears `locksByPath` and drops read-only mode (`git-lfs-lock-provider.ts`).
- **High.** A particle texture can bind an older block-aligned KTX2 chunk. The committed particle encode is read only when the first selected chunk is not block-aligned (`resolve-gpu-texture.ts`).
- **High.** Shift-click in a tree toggles one row. `onPointerUp` treats Shift like Ctrl and calls `onSelect` with `{ additive: true }`. Shift+Arrow passes `{ range: true }` (`tree-view.tsx`).

## Reported in the twenty-fifth batch, not re-checked

- Int switch cases truncate `2.9` to `2` with no warning (`normalizeIntSwitchCases`).
- A color pin that has never had an alpha is stored as `{ w: 0 }` (`colorRgbToPinDefault`).
- An unknown member pin type compiles as float (`pinTypeForMember`).
- A stale material-preview failure sets `status` to `error` and drops a newer dirty edit (`materialPreviewReducer`).
- An unclosed `/*` in Custom GLSL is accepted and comments out the generated helper’s closing brace (`custom-glsl.ts`).
- Shader-graph docs say a missing vector channel is widened with Z = 0. `convertMaterialValue` pads with `1`. The page also omits the landscape and text material domains.
- A sprite pivot uses Babylon `setPivotPoint`, so the graphic stays centered while the collider shifts (`applySpriteAnimationAssetFrame`).
- `pointercancel` over a 2D button emits `onClick` (`applyOverlayPointer`).
- Scale-down hardware pressure treats a null presentation interval as 0 ms (`noteFramePressure`).
- Lock polling can start after a hidden-document pause that arrived before `start`, and overlapping refreshes can drop a successful older result (`poll-scheduler.ts`).
- Git prefill of a detached HEAD uses the first branch merge ref (`git-config.ts`).
- OBJ import treats any same-stem file other than `.obj`, `.glb`, or `.gltf` as a sidecar (`groupObjImportSidecars`).
- Pull-request review bodies are not scanned for session links (`check-public-hygiene.mjs`).

## Verified in the twenty-sixth batch

- **High.** A shift-range folder delete includes an ancestor and its descendants. `requestDeleteSnapshot` does not call `rootSelectedFolderPaths`. Move and duplicate do. Deleting the parent removes the child directory, then deleting the child throws and the dialog reports Delete Failed (`content-browser-workspace.tsx`).
- **High.** Closing a project does not wait for an in-flight save. `forceCloseProject` truncates the recovery journal and calls `closeProject` without waiting on `projectWriteQueue` (`document-context.tsx`).
- **High.** Export class lookup uses the header name, not the compile id. `indexAssets` keys classes by `asset.name`. The editor’s class id comes from the file path (`classIdFromClassAsset`). A scene reference to `main` does not match a header named `main.class` (`closure.ts`).
- **High.** A failed OPFS write still changes the file revision. `writeBinary` increments the write counter before `write`/`close` and again in `finally`, including after `abort()` leaves the previous bytes in place. The next read with the old revision throws `SourceRevisionChangedError` (`web-adapter.ts`).
- **Medium.** Prepare Emission stays enabled while another user’s lock blocks encoding. `textureUsageBlockedReason` disables Retry Encoding only. Prepare Emission is disabled only while a job is already running (`texture-editor.tsx`).

## Reported in the twenty-sixth batch, not re-checked

- After a folder move, `selectedFolderPaths` still names the old path, so the next Delete misses (`content-browser-workspace.tsx`).
- A move into a read-only destination closes with no error (`confirmMove`).
- Preview route changes during boot are not replayed (`attachPreviewLifecycle`).
- A definition rename’s `previousPath` uses the new parent name (`reconcileDataEntry`).
- One-element color and quaternion defaults are copied into every channel, including alpha (`coerceLiteralValue`).
- A missing render-target guid is reported as `"SceneColor"` (`getRenderTargetMode`).
- Clearing `materialGuid` and assigning the same asset again drops authored material-instance overrides (`captureOverrides`).
- Theme docs say pin rows use `gap-6`, settings save immediately, and surfaces never call `env()`. The pin row is `gap-12`, render settings commit on Done, and the simulation bar uses `env(safe-area-inset-top)`.
- HTTP catalog range reads of a partial part are not checked against `part.sha256` (`http-catalog-storage.ts`).

## Verified in the twenty-seventh batch

- **High.** A behaviour-tree lower-priority abort needs the selector frame on the stack. `yieldToParallel` pops every frame above the parallel and marks those nodes running. The selector is gone on the next tick, so the abort walk pops the parallel instead (`evaluate.ts`).
- **High.** Set At Index pastes the index expression three times: the integer check, the bounds check, and the write. A pure `randomInt` rolls again on each paste, so the write can land on a different index than the check (`array-map.ts`).
- **High.** Sequence output count is `Math.max(1, Number(properties.count ?? 2))` with no finite cap. `Infinity` never finishes the pin loop (`flow.ts`).
- **High.** Editor-utility scripts are matched by header name first. Registered ids are path class ids. A class named `Level Tools` is stored as `Level Tools` and registered as `Level_Tools`, so it never boots (`play-content-service.ts`).
- **High.** A quiet prefab sync rewrites a clean scene in memory and stores that rewrite as the saved identity. `patchLoadedContent` does this only when `dirty` is false, so Save stays off and the file keeps the old instances (`document-editing-service.ts`, `document-service.ts`).
- **High.** Software physics separates a dynamic body only from non-dynamic bodies, and only by adding the vertical overlap to `position.y` when vertical velocity is not upward. A side wall throws the body up, and two dynamic bodies never separate (`software-backend.ts`).
- **High.** Static nav blockers are baked from each actor’s local `transform`. A blocker parented under a moved actor is carved at that local pose (`blockers.ts`).
- **High.** Android derived and template storage use `DocumentsStorageAdapter` with no directory, which is `Directory.Documents`. Project storage on Android uses `Directory.Data` (`derived-storage.ts`, `create-storage.ts`).
- **High.** The player class map is `Object.fromEntries` of class id, display name, asset guid, and `scene:` guid. A later class whose display name is another class’s id, including `Actor`, overwrites that key (`boot.ts`).

## Reported in the twenty-seventh batch, not re-checked

- An anim-rule enter sink with no input compiles as the constant `"true"` (`compile.ts`).
- Call Parent Event forwards only `properties.pins`, so catalog scene-event arguments are dropped (`flow.event.callParent`).
- A missing render-target guid is reported as `"SceneColor"` (`getRenderTargetMode`).
- Reassigning the same material after clearing it drops authored instance overrides (`captureOverrides`).
- Preview headphones-route changes during boot are not replayed (`attachPreviewLifecycle`).
- `docs/design/perf-budget.md` says Medium shadows use four cascades. `SHADOW_PROFILES.medium` uses two.
- `docs/architecture/render.md` says snapshot interpolation runs when the render rate exceeds the tick rate. `interpAlpha` is only assigned `1`.
- `docs/architecture/theming.md` says pin rows use `gap-6` and settings save immediately. The row is `gap-12`, and render settings commit on Done.
- Nine-slice cells reuse scaled corner sizes as texture coordinates when the panel is smaller than the margins (`overlayNineSliceCells`).
- A locked play framebuffer does not pass the 8192 side cap (`playFramebufferSize`).

## Verified in the twenty-eighth batch

- **High.** Havok `sphereOverlap` tests the body’s world AABB, not the collider shape. `ignoreActorIds` drops only the body owner, so a hosted child stays in the hit. `includeTriggers: false` drops the body only when every collider is a trigger (`havok-backend.ts`).
- **High.** Rapier `moveCharacter` applies the solved pose only with `setNextKinematicTranslation`. The returned pose still says the body moved. A static or dynamic body does not take that kinematic target, and Play writes the returned pose onto the actor (`rapier-backend.ts`, `physics-sync.ts`).
- **High.** An interface handler runs with delta 0, tick 0, and no tick or extras. A returned promise is logged and the call returns `{}`. A throw, including an infinite-loop error, is logged and also returns `{}`, so the session is not aborted (`script-host.ts`).
- **High.** An anim-rule throw, including an infinite-loop error, is logged and the rule returns undefined. The graph then treats that as no decision (`script-host.ts`).
- **High.** Loop instrumentation copies an unbraced body through the first semicolon at depth 0. `for (...) if (item.ok) { use(item); } cleanup();` includes `cleanup()` in the guarded statement (`infinite-loop.ts`).
- **High.** An empty float parameter succeeds as 0. `Number("")` is finite. An empty int is rejected (`parser.ts`).
- **High.** Anim-graph evaluation falls back to `entryStateId`, then uses `states.get(stateId)!`. A missing entry state throws on the next sample (`graph.ts`).
- **High.** A parallel with no children never succeeds. The empty result list fails the `results.length > 0` check, then the node is set back to running and the tick stops (`evaluate.ts`).
- **Medium.** A software ray that starts inside an AABB keeps a zero normal. `tMin` stays 0 and the normal is never written (`software-backend.ts`).
- **Medium.** Software `sphereOverlap` pushes every overlapping collider. One actor with two shapes is listed twice (`software-backend.ts`).
- **Medium.** `getComponent` returns the first component with that class id and does not skip destroyed components (`script-host.ts`).
- **Medium.** `setActorRotation` does not reject a null rotator. `rotatorToQuat(null)` is identity, and the actor is teleported to that rotation (`script-host.ts`, `euler.ts`).
- **Medium.** Blackboard equality is `===`. A number on the blackboard does not match the same digits stored as a string (`evaluate.ts`).
- **Medium.** `normalizeChord("+")` splits on `+` and the remaining key is empty, so the chord is rejected. The plus key is accepted only when the chord ends in `++` (`keybinds.ts`).
- **Medium.** A Rapier trigger overlap that ends because its collider was replaced is reported at the origin with an up normal (`rapier-backend.ts`).

## Reported in the twenty-eighth batch, not re-checked

- A `for` or `while` written inside another loop header is not rewritten (`infinite-loop.ts`).
- `destroyactor` with a quoted value such as `boss=final` is parsed as the wrong command.
- Play free-cam pitch is not clamped.
- Particle `orderInLayer` is not applied to the rendered component.
- Particle `preparationFailed` disables the whole component.
- `onTextChanged` can call itself again.
- A behaviour-tree service applies a large elapsed interval in one tick.
- A Wait node with a NaN duration does not finish.
- A preview save can race the lock.
- The distribution splash says Development build while the manifest says Test.
- The homepage says sign-in is not set up while a temporary demo is wired.
- A three-digit color such as `#0f0` commits immediately.
- A disabled module card hides its summary.
- Navigation eval tests only assert `path.length > 1`.
- Console `quality` autocomplete offers `li`.

## Rejected in the twenty-eighth batch

- `serializedToAnimGraph` does not throw when the graph has no states. The entry id is `states[0]?.id ?? previous.entryStateId` (`serialize.ts`).
- `persistTransitionRuleGraph` strips `__disabled` because that flag is canvas-only. One-way exits are applied again by `decorateTransitionRuleGraph` (`graph.ts`).
- The software vertical-overlap separation is the same defect already recorded in the twenty-seventh batch.

## Verified in the twenty-ninth batch

- **High.** Deleting a connected node from the keyboard puts its wires back. React Flow removes the edges and then the node as two changes. Each handler emits through `graphStateRef`, which still has the other side from the last commit, so the node delete sends the pre-delete edge list and the wires return with no node. Toolbar delete updates both together (`graph-editor.tsx`).
- **High.** A SceneSubsystem Spawned hook that destroys the actor and flushes runs On Destroyed, then `commitSpawn` still calls On Init. The destroyed check is only at the start of `commitSpawn`, and `callOnCreation` does not look again (`world.ts`).
- **High.** Arrival is marked before the subsystem loop. If an earlier subsystem destroys the actor, Destroyed is sent to every live subsystem, including ones that have not heard Spawned, and the loop then still calls Spawned (`world.ts`).
- **High.** SceneSubsystem On Init runs only after the whole list is published. If the first On Init changes scene, On End runs on siblings whose On Init has not run, and those siblings are then skipped (`world.ts`).
- **High.** Destroying a scene layer removes actors already in the world and leaves actors queued in `pendingSpawn`. The next flush still runs On Init (`world.ts`).
- **High.** `retryTextureEncoding` and `requeueUncompressedTextures` rewrite a texture with no `assertWritable` check. A read-only plugin texture can be marked pending and then committed (`registry.ts`).
- **High.** Input actions, axes, and 2D axes are stored by display name. Two assets named Jump share one slot, and the later one wins, so `isActionHeld("Jump")` can be false while the first asset is held (`resolver.ts`).
- **High.** A new finger is ignored while an extra finger is still in `contacts`. Primary is chosen only when that set is empty, so another tap does not press a mouse-button action until every finger is up (`resolver.ts`).
- **High.** A Switch on String case whose value is `Default` creates an exec pin with that same name as the default pin. Both arms follow every wire on either pin (`compile.ts`, `flow.ts`).
- **High.** Sequence outputs are emitted in one function scope. A second path into a node that declares a local emits that declaration twice, and the module does not parse (`compile.ts`).
- **High.** A custom event whose name is a reserved word (`default`, `function`, `await`, `if`) is exported as that word. The module does not parse, so every entry in that graph fails to load (`compile.ts`).
- **High.** A second material acquire for the same key with a different plan disposes the pending material already returned to the first caller, and the replacement keeps that caller’s reference count (`material-library.ts`).
- **High.** Play water is returned before `finishPlayWorldMesh`, so it stays in rendering group 0. Other Play world meshes are moved into the world group (`snapshot-apply.ts`).
- **High.** A collision cloud with no volume becomes a box at the origin whose half extents match the cloud size. A segment from `x = 0` to `x = 2` is covered only on `[-1, 1]`, so the far point sits outside the cooked box (`simple-collision.ts`).
- **High.** The desktop renderer jail rejects a path segment that is exactly `..`. `..%20` decodes to `.. ` with a trailing space, the lexical check allows it, and Win32 then treats that segment as a parent (`packaged-security.ts`).
- **High.** Painted and Toon refraction still composite a sky-depth texel as the bed. Realistic open water clears transmission there. Painted also multiplies caustics onto that sky color (`water-material.ts`).
- **High.** Refracted fog is pre-corrected with `toLinearSpace(CalcFogFactor())`. That factor is already the linear mix weight, so partial fog divides by the gamma-decoded value (`water-material.ts`).
- **High.** A non-physical nav agent writes its rotation every crowd tick from a yaw that defaults to 0. Before it has a target, a kinematic or 2D agent snaps to yaw 0 (`runtime-navigation.ts`).
- **High.** `stopAgent` and dynamic steering write velocity through the main-scene physics world. A dynamic nav agent on a Scene Layer has its body on the layer world, so the write does nothing and MoveTo never arrives (`runtime-navigation.ts`).
- **High.** `teleportActor` calls `teleportBody` and does not call `setBodyTargetTransform`. A kinematic body, including Movement, still has the target captured before the teleport, and the next step moves it back (`physics-sync.ts`).
- **High.** If `snapshotLayout` cannot grow the snapshot buffer, the worker reports the error and returns without posting the layout. Later copies that do not fit the old buffer fail, and nothing retries the layout, so poses stop (`worker-entry.ts`).
- **High.** A reference that is not an asset guid is resolved as a class name and a scene display name together. An actor class id of `Level2` also packages a scene named `Level2`, and two scenes with that name keep only the first guid (`closure.ts`).
- **High.** Clamp, Smooth Step, and Remap are built by `generic()`, which sets every input default to `[0]`. An unwired Clamp is `clamp(x, 0, 0)`. Smooth Step and Remap divide by a zero range (`catalog.ts`).
- **Medium.** `attachComponent` does not check `destroyed`. On Destroyed still sees `world`, so a component attached there is initialized and never ended (`objects.ts`, `world.ts`).
- **Medium.** A nav cost volume can be applied and cannot be removed. Deleting the blocker, or switching it from cost to unwalkable, leaves the detour on that cost. The registration comment states that cost volumes cannot be removed (`recast-backend.ts`, `runtime-navigation.ts`).

## Reported in the twenty-ninth batch, not re-checked

- Marquee, paste, and palette selection replace the node selection and leave the previous edge selected, so Break Links can delete that stale wire (`graph-editor.tsx`).
- A second finger during an armed marquee leaves pane panning off (`graph-marquee.ts`).
- A class-member drop on the graph toolbar is accepted (`graph-canvas-api.ts`).
- Read-only canvases apply node selection and drop edge selection (`graph-editor.tsx`).
- Replacing a texture parameter can settle the in-flight compile as cancelled and dispose the new material (`material-library.ts`).
- World Position Offset ancestors stay on the pre-offset tap when the fragment graph reads the same node (`material-compiler.ts`).
- Scene-layer dynamic meshes, cables, water time, area lights, and anisotropy are applied on the world scene (`create-engine.ts`).
- A horizontal scroll container sends wheel `deltaY` as `deltaX` (`create-engine.ts`).
- A focus-script infinite loop is swallowed together with `world.tick`, so that frame’s world tick never runs (`driver.ts`).
- `quit` from anim-graph, behaviour-tree, or crowd tick still flushes commands and publishes (`driver.ts`).
- Boot can tick the world while the loading-screen latch is still held (`driver.ts`).
- Dynamic unwalkable blockers are tracked only when the caller passes `acquired`, so a blocker destroyed after load keeps carving (`runtime-navigation.ts`).
- A parent nav agent’s child is stored against the parent’s pre-tick pose (`runtime-navigation.ts`).
- Electron denies `clipboard-sanitized-write`, so editor copy actions fail (`main.ts`).
- Same-document navigation releases the desktop save lease (`main.ts`).
- A truncated `engine-settings.json` turns automatic updates back on (`desktop-updates.ts`).
- A damaged account-secret record drops every stored key on the next write (`desktop-account-secrets.ts`).
- Overlapping folder picks can overwrite each other’s grants (`main.ts`).
- Android `DocumentFile.delete` failure is reported as not found (`BabylonSlateScopedStoragePlugin.java`).
- A full-file native read has no 512 MiB cap (`BabylonSlateScopedStoragePlugin.java`, `BabylonSlateScopedStoragePlugin.swift`).
- An input ring that is all releases drops a release when it overflows (`ring-buffer.ts`).
- A partial gamepad sample leaves higher button indices held (`resolver.ts`).
- Render-target capture restores the view and projection from the same matrix objects the probe camera overwrites (`render-target-capture.ts`).
- An unresolved material guid leaves the mesh on the previous material and fails the final resource fence (`snapshot-apply.ts`).
- A glTF clip whose keys share one time, including a pose at t = 0, stores no duration and falls back to 1000 ms (`glb-parse.ts`).
- `pixel`, `sprite`, `normal`, and `button` match anywhere in an image file name (`image.ts`).
- Reverb occlusion does not count the voxel that contains the emitter (`audio-reverb.ts`).
- Erasing an empty tilemap cell allocates a chunk, and the next bucket fill paints it (`tilemap-paint.ts`).
- A UI slider step grid never snaps to a partial last step, so the maximum can be unreachable (`ui-controls2d.ts`).
- Repairing a missing actor id as `actor-${index}` throws when that id already exists (`scene.ts`).
- An inverted deformer axis is replaced with the unit interval at the origin (`deformer-component.ts`).
- A model clip named like its state, when that name is not on the model, plays the first glTF group (`graph.ts`).
- A dangling anim transition still passes for one tick, then snaps back to the entry state (`graph.ts`).
- Graph reorder produces no edit commands, so a pure reorder is dropped (`graph-diff.ts`).
- Clearing a component property stores an own `undefined` key (`scene.ts`).
- A duplicate component add is recorded as history and its undo deletes the existing component (`scene.ts`).
- TestFlight processing is marked failed, so a build still processing fails the distribution job (`summary.mjs`).
- GitHub release uploads share a 120-second timeout with metadata requests (`publish.mjs`).
- An Attractor after Align Angle reads the previous particle and can throw out of the uncaught update loop (`validate.ts`).
- A shader function still emits an input it never reads, including a Scene Depth requirement (`lower.ts`).
- Switching a Text material back to Surface keeps unlit, translucent, and two-sided (`document.ts`).
- `return(A);` is rejected as custom GLSL, and `dFdxCoarse` is not treated as a derivative (`custom-glsl.ts`).
- A stale profile error aborts the capture that is in progress (`preview-diagnostics.ts`).
- Exported CSS is inserted with `String.prototype.replace`, so `$&` and `</style>` in the stylesheet are special (`export-game.ts`).
- A startup-required flag matches every asset whose display name equals the game-instance class (`export-game.ts`).
- Navmesh loads are not chained, so an earlier import can land after a later one (`play-boot.ts`).
- A save client replacement restarts request ids at 1, so an in-flight response can resolve the new session’s first call (`worker-entry.ts`).

## Rejected in the twenty-ninth batch

- The missing anim-graph entry throw is the same defect already recorded in the twenty-eighth batch.
- Cost-volume removal is limited on purpose in the registration comment. The missing remove is recorded above as that limitation, not as a forgotten `removeObstacle` call.

## Verified in the thirtieth batch

- **High.** Opening another Scene does not stop Play. The transition gate allows a `replace-document` whose id is not the playing scene, and `beforeCommit` then closes that playing scene with `performCloseDocument`, which never asks the gate. Play keeps the shared engine after the document is gone (`play-context.tsx`, `document-context.tsx`).
- **High.** Closing a project stops Play before the unsaved-documents dialog. `closeProject` awaits the `close-project` gate, and that gate calls `sessionOwner.stop()`, then looks for dirty documents. Cancel does not start Play again (`document-context.tsx`, `play-context.tsx`).
- **High.** A library function called by class id stores Do Once, Do N, Flip Flop, and Gate state with a null receiver. Every caller shares that latch. The context comment says this state is keyed by the receiving object (`script-host.ts`).
- **High.** Undo cannot put a transform back on a `2DAnchorComponent`. `SetComponentTransformPresenceCommand` allows the transform to be deleted and returns the component unchanged when `to` is set. A batch undo restores the transform while the component is still an anchor, so the transform stays missing (`scene-fields.ts`).
- **High.** `SetComponentPropertyCommand` and `SetSceneSettingCommand` have no `byteSize`. The undo stack treats a missing size as 0, so landscape heights, tile data, spline points, and foliage groups do not count toward the byte budget (`scene.ts`, `stack.ts`).
- **Medium.** A class variable’s scalar default produces no inspector rows. `variableDefaultPropertyRows` returns nothing for `class` when `onPickClass` is absent, and the class-member panel does not pass it (`graph-inspector.ts`, `inspector-panel.tsx`).

## Reported in the thirtieth batch, not re-checked

- `releaseInitialSources` clears the play scene, so the close gate then keys off the editor tab (`play-context.tsx`).
- A compile error leaves `requestPlay` unable to start while the viewport has already resumed (`play-context.tsx`).
- `invokeCommand` returns success when `dispatchEvent` swallowed the throw (`script-host.ts`).
- A destroyed camera or light component is still updated (`script-host.ts`).
- A destroyed scene layer still matches the generic guid branch (`script-host.ts`).
- With temporal anti-aliasing, occlusion, reflection, and volume reconstruct from the unjittered projection (`spatial-effects.ts`).
- Orthographic reflection rays use a parallel view direction while the combiner does not (`spatial-effects.ts`).
- Temporal anti-aliasing blends encoded color on Legacy Display and CEL (`spatial-effects.ts`).
- A mount at `plugin/virtual` and another at `plugin/virtual/note` makes `readdir("plugin")` report `virtual` as a file (`mounted-storage.ts`).
- An OPFS project delete and a save can recreate or remove the directory after the other call has succeeded (`web-adapter.ts`).
- A web save read takes one snapshot and does not retry a commit that lands between `getFile` and the read (`save-game-web.ts`).
- Documents and scoped storage reject `"."` as the project root (`project-path.ts`).
- Rotated 2D static nav blockers are mirrored, and a 2D circle solid is centered on the walk plane so half of it is under the floor (`blockers.ts`).
- Search dropdowns swallow arrow keys, so the result list cannot be chosen from the keyboard (`search-dropdown.tsx`).
- Create New can run twice before `creatingId` is set (`use-picker-create.ts`).
- Creating a tag overwrites toggles made while the create was in flight (`tag-picker.tsx`).
- Enter submits a name prompt during IME composition (`name-prompt-dialog.tsx`).
- An unknown pin type is labeled Float while the stored type stays put (`pin-type-picker.tsx`).
- Get Assets By Class materializes the class picked on the node, not the wired class (`graph-validation.ts`).
- A blank component id is saved onto the only matching component (`graph-validation.ts`).
- Inherited custom events `Foo Bar` and `Foo-Bar` share one slug, so the later event is skipped (`graph-validation.ts`).
- A play worker that fails to post is left running when the session falls back in-process (`play-session.ts`).
- A rejected profile start leaves `profileActive` true (`preview-diagnostics.ts`).
- A document repath does not abort the load, so completion inserts a second tab at the old id (`document-service.ts`).
- Execute JavaScript looks up pins by display name and can bind the flow pin (`debug.ts`).
- Call Interface drops arguments named `target`, `result`, `method`, or `interfaceGuid` (`interface.ts`).
- Normalize reads a random vector once per component, so the result is not one unit vector (`vector.ts`).
- `pipeline?.limits.join` throws when `limits` is missing, and the fallback does not run (`scalability.ts`).
- Rotator nearly-equal treats `0` and `360` as different (`rotator.ts`).
- A screen-locked tilemap chunk is parented to the actor, so the actor pose shifts it (`tilemap-mesh.ts`).
- Sprite quads ignore the frame pivot and stay centered (`sprite-quad.ts`).
- A throw from `sceneForSlot` still marks the slot seen (`snapshot-apply.ts`).
- `diffActor` ignores `prefabGuid`, so that one-field edit becomes a full scene replace (`scene-diff.ts`).
- `quality lighting:high` tokenizes as a named argument and succeeds as a query (`parser.ts`).
- A profiler budget stop discards the rest of the tick chunk without counting it (`session-diagnostics.ts`).
- Dock positions are remembered only in memory, so a clean close restores the last saved layout (`document-context.tsx`).
- A failed disk reload clears the prompt and does not offer those files again (`document-context.tsx`).
- `pendingExclusiveScene` survives project close and can open the previous project’s scene (`document-context.tsx`).
- Class-reference repair writes referrers first, and a later failed save can put the old contents back (`document-context.tsx`).
- Fonts are indexed only by header name, so a later font captures an import (`registry.ts`).
- Duplicate, rename, and attach reindex with a null mtime (`registry.ts`).
- A texture encode that cannot read pixels leaves the file in `pending` (`registry.ts`).
- Two overlapping folder copies can choose the same destination name (`registry.ts`).
- `firstSceneLoaded` stays set when On First Scene Loaded throws, so later loads do not retry it (`world.ts`).
- A suppressed deformer target becomes `undefined` even when a later active mesh has the same source id (`instantiate-scene.ts`).
- Dynamic MoveTo can succeed from a 4 m closest-point box while the actor is still far in XZ (`runtime-navigation.ts`).
- Reloading a navmesh clears steered actors and leaves their last velocity (`runtime-navigation.ts`).
- `moveCharacter` does not take the composed parent pose that `moveMovement` uses (`physics-sync.ts`).
- Font registration does not invalidate the scheduler, so bitmap text keeps the fallback face (`create-engine.ts`).
- A free-cam drag on a HUD control also looks or pans the camera (`create-engine.ts`).
- A shift-click in the content tree anchors on the open folder when the selection is not one asset (`content-browser-workspace.tsx`).
- The move dialog rejects a destination that already holds any selected asset, while a tree drop of that selection still moves the others (`content-browser-helpers.ts`).
- Asset duplicate writes into the open grid folder, not beside the source (`content-browser-workspace.tsx`).
- A thumbnail load throw skips the rest of that batch (`content-browser-thumbnails.ts`).

## Rejected in the thirtieth batch

- The earlier note that opening another Scene stops Play before the save-or-discard choice does not match the current gate. A `replace-document` for a different document id returns before `stop()`. The scene is closed later, without that stop, as recorded above.
- An asset field inside a struct default does open a picker. `singleDefaultRows` passes `onPickAsset`, and struct fields use that mapping (`graph-inspector.ts`).
- `SetComponentTransformPresenceCommand` does define `byteSize`. The missing sizes are the property and scene-setting commands recorded above.

## Verified in the thirty-first batch

- **High.** Software separation ignores collision layers. The overlap loop never reads `layer` or `mask`, while `pollContacts` skips a pair unless each layer hits the other mask. A pair that produces no contact is still pushed apart (`software-backend.ts`).
- **High.** That same loop builds the dynamic box once. After the first static collider moves the body, the next static collider is tested against the old box (`software-backend.ts`).
- **Medium.** A looped Rapier chain stores its closing segment under the chain’s collider id. Contact keys use that id, so leaving either the polyline or the segment ends the overlap while the other shape is still touching (`rapier-backend.ts`).
- **Medium.** Havok `moveCharacter` returns null for `dt <= 0` and leaves the body in place. A positive `dt` at or below `1e-8` forces the integrated velocity to 0, so that displacement is dropped (`havok-backend.ts`).
- **Medium.** Software circles and capsules extend `±radius` on Z. Boxes, polygons, and chains use a `±0.01` slab, so a 2D circle overlaps geometry a box at the same Z would miss (`software-backend.ts`).
- **Low.** Snapshot `frameId` and `tickIndex` are stored as binary32. Past 16,777,216 those integers are no longer distinct, so an interpolation reset can miss the teleport frame and water sampling looks up the rounded id (`snapshot-buffer.ts`).

## Verified in the thirty-second batch

- **Medium.** The in-process player pump requests the next frame only after `runtime.advance` returns. Any tick error other than the infinite-loop sentinel ends the callback, so input, simulation, and snapshot push never resume (`boot.ts`).
- **Medium.** On that same fallback, `sceneRealized`, `sceneLayerRealized`, and `sceneStreamRealized` throw when `copySnapshot` returns false, and they throw before readiness is recorded. The load stays open (`boot.ts`).
- **Medium.** Preview `profile-stop` returns `{ success: true }` after `publishProfile`. That publisher catches a transfer failure, sends `profile-error`, and still resolves (`preview-diagnostics.ts`).
- **Medium.** Prefab, Data Definition, Data Tree, Material Instance, Save Game, and Water are not focus-keep keys. Focus then keeps only the primary panel and closes every other open panel, including the last one if the primary is not open (`layout-ops.ts`, `app-settings.ts`).
- **Medium.** Source control and the actor prefab panels are closed only inside Dockview’s one-time ready callback. Turning source control off, or resolving a class as non-Actor after that, leaves Locks, Prefab, and Components mounted (`dockview-shell.tsx`).
- **Medium.** On every shell ready, a Class tab that shares a group with Components is moved below Components. The next layout save stores that split (`layout-ops.ts`).
- **Medium.** A phone open keeps the desktop layout only when the saved panel count still matches after migration and the Locks or Prefab closes. If those closes change the count, the saved snapshot is the already inlined grid (`dockview-shell.tsx`).
- **Low.** The player HUD tick count is the last applied snapshot index. The stats command’s `tickIndex` is ignored, so a dropped snapshot leaves the count behind the simulation (`boot.ts`).

## Rejected in the thirty-second batch

- The startup `systemSources` rejection is the same defect already recorded: `acquireSceneSources(...).then(...)` has no `catch`, and every later scene acquire awaits that promise (`boot.ts`).

## Verified in the thirty-third batch

- **High.** The theme link in `docs/engineplan.md` is `../../packages/ui/src/styles/globals.css`. From a doc at the docs root, `rewriteRepoSourceHref` keeps one `..`, so the published URL is `blob/main/../packages/ui/src/styles/globals.css`. GitHub drops `main` from that path. The same link from a nested doc collapses correctly (`rewrite-repo-links.ts`).
- **Medium.** The continuation-status fragment omits the em dash. The heading is `Current continuation status — 23 September 2026`, and VitePress keeps that dash in the id (`renderer-qualification.md`, `issue-tracker.md`, `render.md`).
- **Medium.** The 2D Text fragment is `2d-text-and-2d-rich-text`. The heading starts with a digit, so the id is `_2d-text-and-2d-rich-text` (`scripting.md`, `scene-layers.md`).
- **Medium.** The P4 and P5 follow-up fragments keep a double hyphen. The headings use a slash, and VitePress collapses that run, so the ids are `p4-follow-ups-open-deferrals` and `p5-follow-ups-open-deferrals` (`issue-tracker.md`, `scripting.md`, `testing.md`, `engineplan.md`).
- **Medium.** The pin-defaults fragment is `pin-defaults-inspector--canvas`. Parentheses and `+` are removed, so the id is `pin-defaults-inspector-canvas` (`scripting.md`, `engineplan.md`).
- **Medium.** `physics.md#change-driven-preparation-and-verification-pickup` is not a heading. The page has `change-driven-preparation` and `native-lifecycle-verification` (`renderer-qualification.md`).
- **Medium.** Directory links are published as GitHub blob URLs. `GITHUB_BLOB_BASE` is always `blob/main/`, including for `packages/ui/src/components/`, `packages/editor-kit/src/`, `engine-logos/`, and `packages/render/src/default-skybox/` (`rewrite-repo-links.ts`).

## Verified in the thirty-fourth batch

- **Medium.** Every horizontal slider control is at least 44px tall and sets `touch-none`. A drag that starts on the slider changes the value and does not scroll the panel (`slider.tsx`).
- **Medium.** Sliders default to `thumbAlignment="edge"`, so the thumb center stays inside the track. The hue track paints its gradient across the whole track, and the thumb sits on the wrong color at both ends (`slider.tsx`, `color-picker.tsx`).
- **Medium.** Dialog content scrolls, and the close button is `absolute` inside that scroller. A dialog taller than the max height moves the close button with the content (`dialog.tsx`).
- **Medium.** Sheet content uses the same pattern. Side and bottom sheets scroll the close button out of the visible top (`sheet.tsx`).
- **Low.** `Tabs` copies `orientation` onto `data-orientation` and does not pass it to the Base UI root, so arrow keys stay left and right (`tabs.tsx`).
- **Low.** `ToggleGroup` does the same. A vertical group can lay out in a column while keyboard movement stays horizontal (`toggle-group.tsx`).
- **Low.** Disabled buttons set `pointer-events-none`, so a tooltip on the button itself does not show once the control is disabled (`button.tsx`).

## Rejected in the thirty-fourth batch

- The indeterminate checkbox still drawing `CheckIcon` is already recorded (`checkbox.tsx`).

## Verified in the thirty-fifth batch

- **Medium.** Android `pickFolder` sets `pickPending` before `startActivityForResult` and clears it only in the result callback. If that launch returns or throws without the callback, every later pick rejects with “A native picker is already open” (`BabylonSlateScopedStoragePlugin.java`).
- **Medium.** Android backup is enabled, and the backup rules exclude only `babylonslate-secrets.xml`. Project files under app data are included (`AndroidManifest.xml`, `backup_rules.xml`, `data_extraction_rules.xml`).
- **Medium.** Desktop folder grants are written in place with `writeFile`. A crash during that write leaves a file `grantedFolders` cannot parse, and it then returns an empty list, so every previously picked folder fails the open check (`main.ts`).
- **Low.** The Android FileProvider `external-path` is `path="."`, so a content URI under that name can point at any file on external storage (`file_paths.xml`).

## Reported in the thirty-fifth batch, not re-checked

- Android `Filesystem.rename` deletes the destination before `renameTo`. A failed mobile save update would remove the current generation, and the temp name is not a valid save key (`save-game-mobile.ts`). The Android helper is not in this tree.
- iOS `pickFolder` stores the pending call and then presents the picker. A presentation that never calls the delegate leaves the next pick rejected (`BabylonSlateScopedStoragePlugin.swift`).

## Rejected in the thirty-fifth batch

- A leftover `.babylonslate-creating` marker wiping the next create of that name is already recorded (`project-service.ts`).

## Verified in the thirty-sixth batch

- **High.** Preview `workflow_dispatch` has no main-branch guard. Dispatching it on another ref checks out that ref, builds it with Pages write permission, and `deploy-pages` publishes it to the public site. The `pages` concurrency group cancels an in-progress main deploy (`preview.yml`).
- **Medium.** The resource lock is created empty, and the owner pid is written afterward. A waiter deletes an unreadable lock older than 10 seconds. The stalled owner’s `finally` then deletes that same path, which can be the next waiter’s lock, so two admissions run at once (`resource-admission.mjs`).
- **Medium.** Apple stage commands time out by signaling only the spawned process. Cleanup ignores every `security delete-keychain` error and then deletes the private directory (`private-command.mjs`, `apple-cleanup.mjs`).
- **Medium.** Required-check validation reads one page of check runs and does not follow `Link`. A commit status missing from that page is treated as a completed check whose conclusion is the status state, so a `success` status can satisfy a context whose latest run was not on the page (`preflight.mjs`).
- **Medium.** The signing scan requires the setting name to be followed immediately by `=`. `DEVELOPMENT_TEAM[sdk=iphoneos*] = ABCD123456;` does not match (`check-public-hygiene.mjs`).
- **Medium.** `.svg` files and any file containing a NUL byte skip content rules. A session link in an SVG, or after a NUL, is not reported, and a binary diff has no added lines to scan (`check-public-hygiene.mjs`).
- **Medium.** The pull-request range scan is the diff from the merge base to the head. A session link added and then removed on the same branch is absent from that diff and from commit-message scanning (`check-public-hygiene.mjs`).
- **Medium.** Public hygiene skips an issue comment that is not on a pull request, so that comment body is never scanned (`security.yml`).
- **Low.** The Pages smoke exits 0 when the live site returns HTTP 200, contains `id="root"`, and does not contain `Jekyll v`. The previous production page already matches (`preview.yml`).

## Verified in the thirty-seventh batch

- **High.** Import GUID remap rewrites `dependencies` and only Audio, Particle, Model, Skeleton, Animation, RenderTarget, Data, and InputType `Asset` fields. Sprite and tileset `textureGuid`, tilemap tileset ids, scene and prefab component fields, font fallbacks, and water `materialGuid` stay on the old ids (`guid-remap.ts`).
- **Medium.** Tilemap collision chains are built one chunk at a time. A solid region that crosses a chunk boundary becomes separate loops, and the shared edge is not cancelled (`tilemap-chains.ts`).
- **Medium.** One to seven external adds or deletes leave `classifyExternalChanges` as `none`. The returned `changedPaths` is only mtime changes, not the added or removed paths (`mtime-diff.ts`).
- **Medium.** Every `.json` import goes through `importFont`. A file that is not a font representation is still stored as a Font (`importers/index.ts`, `font.ts`).

## Reported in the thirty-seventh batch, not re-checked

- Convex hull unique and build run on the full point cloud before the 64-point cap (`convex-hull.ts`).
- Tilemap paint copies the whole map once per cell (`tilemap-paint.ts`).
- Sprite animation pixel sizes are read only from PNG bytes (`sprite-animation-payload.ts`).
- Project search decodes Scene, Graph, and Class bodies only (`search-index.ts`).
- Audio import stores the MIME from the extension, not the sniffed bytes (`audio.ts`).

## Rejected in the thirty-seventh batch

- `gltfJsonToGlb` encoding an empty BIN for a non-relative buffer URI, including a `data:` buffer, is already recorded (`glb-parse.ts`).
- OBJ import treating any same-stem non-model file as a sidecar is already recorded (`obj-import-batch.ts`).

## Verified in the thirty-eighth batch

- **Medium.** Scene editing says scale-gizmo sensitivity is 10. `GIZMO_SCALE_SENSITIVITY` is 1.5 (`scene-editing.md`, `gizmo-host.ts`).
- **Medium.** Scene editing says a new scene camera matches the editor orbit at radius 8, and 2D starts at `(0, 0, -8)`. Both radii are 12, and 2D starts at `(0, 0, -12)` (`scene-editing.md`, `project.ts`, `editor-camera.ts`).
- **Medium.** Scene editing says the actor menu is Open Actor, Frame Selection, Duplicate, and Delete. The menu also has Select or Deselect, Copy, and Paste (`scene-editing.md`, `scene-outliner-panel.tsx`).
- **Medium.** The component catalog says that menu is Open Actor, Select or Deselect, Duplicate, and Delete. It also has Frame Selection, Copy, and Paste (`components.md`, `scene-outliner-panel.tsx`).
- **Medium.** Scene editing says 2D Z-Order is the same stored value as Position Z. The Details field shows and writes the negated Z (`scene-editing.md`, `transform-property-rows.ts`).
- **Medium.** Scene editing says Field Of View and Orthographic Size both stay visible. Details shows only the slider for the current projection (`scene-editing.md`, `component-property-rows.ts`).
- **Medium.** The component catalog says New Asset groups are World, Scripting, 2D, Animation, Rendering, Audio, and AI. The menu also has Input and Data, and those come before Scripting (`components.md`, `content-browser-helpers.ts`).
- **Medium.** The debugger doc says the Stats, Console, and Inspector overlay buttons default on. Stats defaults on. Console and Inspector default off (`debugger.md`, `play-debugger-defaults.ts`).
- **Medium.** The debugger doc says the Play console is 58dvh, capped at 38rem. Play uses `min(40dvh, 22rem)`, and coarse pointers use `min(50dvh, 26rem)`. The component gallery sheet still uses the documented size (`debugger.md`, `debug-console.tsx`, `component-gallery.tsx`).

## Verified in the thirty-ninth batch

Bloat to remove. The engine is not released, so these paths exist only to accept older data.

- **Removal.** `fromSerializedGraph` still accepts graphs with no pin ends, and it rewrites `logMessage` nodes into `debug.log` (`serialize.ts`).
- **Removal.** Tilemaps still accept a single `tilesetGuid` and turn it into a tileset list with `firstGid` 1 (`tilemap-payload.ts`).
- **Removal.** `migrateMaxDimensionToDownsample` converts an old texture `maxDimension` into a downsample step (`texture-lod.ts`).
- **Removal.** `migrateSceneMeshesToActors` still converts scenes that store meshes outside actors (`migration.ts`).
- **Removal.** A material test keeps whole-actor `assignMaterial` commands that name only a slot id (`runtime-material-identity.test.ts`).

## Verified in the fortieth batch

- **Medium.** Material compile cost is compared with twice the frame budget. A compile that takes between one and two frames stays cheap and still auto-queues (`shader-graph.md`, `preview-state.ts`).
- **Medium.** The shader-graph page says Post Processing has no mesh vertex attributes. `input.uv` has no domain list, so it stays legal in Post Processing. Local vertex position and normal are surface-only (`shader-graph.md`, `catalog.ts`).
- **Medium.** The home Design card promises gesture contracts and links only to the performance budget. Gesture contracts are on the Gestures page (`index.md`, `sidebar.ts`).
- **Medium.** The architecture index still describes editor extensions as Editor Utility graphs and Skybox Creator. The page now leads with Engine and Project Extensions (`architecture/index.md`, `editor-extensions.md`).
- **Medium.** The architecture index still titles the materials page “Shader graph” and reduces it to shader IR. The page and sidebar call it Materials and Material Functions (`architecture/index.md`, `shader-graph.md`, `sidebar.ts`).
- **Low.** A new Text material previews on a plane. The page calls cube the document default (`shader-graph.md`, `document.ts`).
- **Low.** The page calls two landscape nodes Landscape Layers and Landscape Blend. The catalog titles are Landscape Paint Layers and Landscape Layer Blend (`shader-graph.md`, `catalog.ts`).
- **Low.** The architecture landing table omits Save Games and CI performance. Both are in that sidebar group (`architecture/index.md`, `sidebar.ts`).

## Rejected in the fortieth batch

- The Noise section still saying UV widens with zero Z is the same pad-with-`1` mismatch already recorded (`shader-graph.md`, `types.ts`).

## Verified in the forty-first batch

- **High.** Export does not build packed asset files. `writeLooseAssets` writes `assets/data-N.bin` and returns `packs: []`. `encodeBabpack` is never called (`export-game.ts`).
- **High.** Export does not concatenate class modules into one script bundle. `scripts.js` is `serializeScriptRegistry([])`, an empty bootstrap kept for the old filename, and each class is a separate `CompiledScript` sidecar (`export-game.ts`, `scripts.ts`). That empty bootstrap is compatibility bloat.
- **Medium.** Android call detection never reads the current audio mode. The listener does not replay it, and `interrupted` starts false. Opening the app during a call sends no interruption, and the later hangup does not resume (`BabylonSlateAudioLifecyclePlugin.java`).
- **Medium.** That listener treats only ringtone, in-call, and in-communication as active. Call screening and call redirect, which exist on the same API level as the listener, do not pause audio (`BabylonSlateAudioLifecyclePlugin.java`).
- **Medium.** The Play console input is a text field. The plan’s CodeMirror console input is not there (`debug-console.tsx`).
- **Medium.** The plan’s particle-material domains are `surface`, `postProcess`, and `interface`. Current domains are surface, landscape, post process, particle, and text. `interface` parses as surface (`catalog.ts`).
- **Low.** Android audio teardown unregisters the noisy receiver with no guard. If registration threw, destroy throws before Capacitor teardown (`BabylonSlateAudioLifecyclePlugin.java`).

## Reported in the forty-first batch, not re-checked

- The plan’s stats HUD lists a rolling graph, memory, draw calls, actor counts, and per-channel bridge bytes. Default Stats shows FPS and script/physics time (`stats-hud.tsx`).
- Session-report aggregation keeps the latest message and frame ids, not the first message plus timestamps (`diagnostics.ts`).
- Session-report rows show guid and node id, and every row is expanded (`preview-session-report.tsx`).
- The Play button badge is the compile-error count, not a failed-session flag (`editor-chrome-bar.tsx`).
- The plan’s one-fixture-per-diagnostic-code set only has two scripting fixtures (`packages/scripting/fixtures`).
- MSDF text does not use `@babylonjs/addons` or `@babylonjs/materials` (`packages/render/package.json`).

## Rejected in the forty-first batch

- The plan’s 60% coverage floor is the same physics gate already recorded at 50/50/45/50 (`testing.md`, `vitest.workspace.ts`).

## Verified in the forty-second batch

- **High.** Docs evidence links that are not JSON stay as relative hrefs. VitePress does not copy those png, mp4, and zip files, and the dead-link check ignores them, so the published page 404s. A Play screenshot in the qualification notes is one of them (`rewrite-repo-links.ts`, `renderer-qualification.md`).
- **Medium.** The render page says a file whose name contains `lut` imports as a color-grading LUT. The matcher requires `lut` as its own token, so `salute.png` stays an albedo (`render.md`, `image.ts`).
- **Medium.** The same page says the LUT guid is always an export root. It is packed only when color grading is enabled (`render.md`, `render-effects.ts`).
- **Medium.** The radius audit allowlist matches one whole value. A legal shorthand such as `var(--radius-sm) var(--radius-sm) 0 0` is reported as hardcoded (`style-audit.ts`).
- **Medium.** The test-kit golden refresh reads `UPDATE_GOLDEN`. The testing doc and the other goldens use `UPDATE_GOLDENS` (`harness.test.ts`, `testing.md`).
- **Medium.** Physics pairing treats Movement, and a Dynamic Runtime Mesh with collision enabled, as an implicit body and emits no missing-body warning. The physics page lists only Tilemap, Blocking Volume, Mesh collision, and Landscape (`pairing.ts`, `physics.md`).
- **Medium.** The qualification notes name `e2e/particle-lifecycle.spec.ts` and `e2e/post-process-owner-overrides.spec.ts`. Those files are not in the tree (`renderer-qualification.md`).

## Reported in the forty-second batch, not re-checked

- The qualification coverage matrix says authored post-process is unit-only, names a WebGL fallback reason that the spec does not show, and says the sustained route enumerates on CI (`renderer-qualification.md`).
- The engine plan’s New Asset list, Play Anyway bypass, palette row height, command list, Begin Play naming, Dockview 4 pin, validation debounce, and Grid Settings label disagree with the editor (`engineplan.md`).
- Issue-tracker status rows still say cylinders draw as boxes, UserInterface is packed, nested `parentId` is dropped, Play requires an open scene tab, and touch input is test-only (`issue-tracker.md`).
- Play and export load only scene-reached animation graphs, not every project graph (`anim-graph.md`).
- Engine plugin storage uses an HTTP catalog when the index loads, not an unpacked memory root (`plugins.md`).
- The bridge command list omits behaviour-tree, navmesh, and water loads, and omits `btState` (`bridge.md`).
- A 3D cylinder always uses `PhysicsShapeCylinder`. There is no convex-prism fallback (`havok-backend.ts`).
- Dark mode does not set the brand button’s active colors, so the pressed home button is white on white (`custom.css`).

## Rejected in the forty-second batch

- `editorTextureLodEnabled` defaulting off is already recorded. `vfs.md` repeats that default (`app-settings.ts`).
- Medium shadows using two cascades is already recorded. The engine plan repeats it (`shadows.ts`).
- The sustained-route sample-window name is already recorded (`play-sustained-route.spec.ts`).
- The remaining workflows did not add a new gate or publish finding.

## Verified in the forty-third batch

- **Medium.** Duplicating an actor does not keep component ids. Each copy gets `${id}-${classId}-${index}` (`place-actors.ts`). The September QA register still says the ids are retained (`qa-2026-09-register.md`).
- **Medium.** A graph edit with more than one command is one undo step. `applyBatch` stores a `CommandBatch` (`session.ts`). The register still says each diff command is its own history step.
- **Medium.** The debug inspector runs `possess` and `destroyactor`. The property grids stay read-only (`debug-inspect-dialog.tsx`). The register still says the dialog takes no action.
- **Medium.** An actor gets one Babylon light per `LightComponent` and `HemisphericFillLightComponent`, not one light for the actor (`scene-illumination.ts`).
- **Medium.** Engine settings write on change. Project settings call `scheduleDebouncedSave`, which waits `autoSaveIntervalMs` (default 120 seconds) (`settings-modal.tsx`, `document-context.tsx`).
- **Medium.** Verify is six jobs: `static`, `unit`, and four end-to-end shards. The agent instructions still say nine (`verify.yml`, `preflight.mjs`, `instructions.md`).

## Reported in the forty-third batch, not re-checked

- A right-click on an unselected content-browser tile replaces the selection instead of adding to it (`content-browser-workspace.tsx`).
- Play load forwards `projectDocument.settings.input` (`play-context.tsx`).
- Asset header dependencies include Scene and Class references (`content-browser-helpers.ts`).
- Pointer down focuses the play canvas unless free cam is on (`dom-input-capture.ts`).
- The debug menu labels are Stats, Console, and Inspector, not “Stats Button” (`play-debug-menu-items.tsx`).
- An empty class id is rejected in `runtime-host-actors.ts`, not in `driver.ts`.
- Undo goes through `undoActiveDocument`, not `stepActiveDocumentHistory` (`document-editing-service.ts`).

## Verified in the forty-fourth batch

- **High.** The editor camera export maps Blender `(x, y, z)` to `(x, z, -y)`, which keeps orientation, then reverses every triangle. The helper material leaves back-face culling on, so the shell is drawn from the inside (`create-editor-camera.py`, `editor-camera-model.ts`).
- **High.** Animation rule compilation does not resolve wildcard pins. A missing generic value stays unresolved and emits `null`. The scripting page says compilation applies the resolved view first, so a missing string is `""` (`compile.ts`, `scripting.md`).
- **High.** Call Function drops every input named `target`, including a real parameter of that name (`functions.ts`). The custom-event case of the same skip is already recorded.

## Reported in the forty-fourth batch, not re-checked

- A While Loop warns only when an unwired condition default is true, not when a wired constant True is connected (`validate.ts`).
- For Loop forces both bounds through `| 0`, so values outside int32 wrap (`compile.ts`).
- Set Material Instance and the texture setter emit the async context methods (`material.ts`).

## Rejected in the forty-fourth batch

- Exec outputs not fanning out is already recorded. `gestures.md` repeats the claim that exec pins allow multiple outgoing wires (`graph-connect.ts`).
- Call Interface dropping an argument whose id is `target` is already recorded (`interface.ts`).

## Verified in the forty-fifth batch

- **Medium.** A Texture or Audio search hit opens a document tab. `documentKindForAssetType` returns `texture` and `audio`. The search page says those hits open a Settings tab (`search-navigation.ts`, `document.ts`, `global-search.md`).
- **Medium.** The console catalog page says the core list is seven setters plus `help` and never names `renderpath`. That command is registered and can query or set the render path (`console-commands.md`, `commands.ts`).
- **Medium.** `stat threads` shows bridge messages per second. The console page describes it as main-versus-worker timings (`stats-hud.tsx`, `console-commands.md`).
- **Removal.** Shader assets still run the material migration chain, including `migrateLegacyShaderPayload`, and are rewritten to a Material header. The containers page says Shader has no migration (`migration.ts`, `containers.md`).
- **Medium.** Game Instance and Scene Subsystem event lists omit On Game Loaded. Both catalogs include `onGameLoaded` (`engine-script-api.ts`, `object-model.md`).
- **Medium.** Open Scene tabs stay mounted. They still count toward the warm-workspace cap of 3. The overview says inactive workspaces unmount after 2 minutes (`document-working-set.ts`, `overview.md`).
- **Low.** Move To stamps `acceptRadius` 0.5. The navigation page says the arrival default is 0.75, which is only the fallback when the property is missing (`catalog.ts`, `runtime-navigation.ts`, `navigation.md`).

## Reported in the forty-fifth batch, not re-checked

- The content-browser folder pane minimum is 162px. The overview says 160px (`content-browser-workspace.tsx`).
- Feature Test keeps the Basic 3D scene at `assets/main.scene.babasset` and reuses `assets/Mannequin/`. The page says every asset lives under `assets/FeatureTest/<Area>/` (`feature-test.md`).

## Rejected in the forty-fifth batch

- `renderpath` missing from `debugger.md` is already recorded. The console catalog omission above is the other page.
- The qualification notes through line 959 did not add a new mismatch.

## Verified in the forty-sixth batch

- **High.** Each iOS free-memory sample calls `mach_host_self()` twice and never releases the send right. After enough Play stats polls the process host port hits its reference cap and later host calls fail (`BabylonSlateMemoryPlugin.swift`).
- **Medium.** That free-memory total adds purgeable pages on top of free and inactive. Purgeable pages are already on those queues, so the HUD free figure is high (`BabylonSlateMemoryPlugin.swift`).
- **Medium.** iOS audio starts a `.playback` session, which ignores the silent switch. After an interruption ends, the plugin emits `audioInterruption` and does not call `setActive(true)` again (`BabylonSlateAudioLifecyclePlugin.swift`).
- **Low.** `os_proc_available_memory()` returns 0 when the jetsam limit is unknown. The plugin treats 0 as a real headroom value (`BabylonSlateMemoryPlugin.swift`).
- **Medium.** The Create Scene Layer graph node awaits `createSceneLayerAsync`. The scene-layer page says it calls the synchronous `createSceneLayer` (`scene-layer.ts`, `scene-layers.md`).
- **Medium.** A Scene Layer workspace starts unlit, but the viewport shading menu still offers PBR, CEL, Unlit, and Wireframe (`document-workspace.tsx`, `viewport-toolbar.tsx`).
- **Medium.** The class parent list also includes Render Target Capture, Scene Layer Actor, Scene Layer Actor Switcher, and Scene Streaming Actor. The registry page says its shorter list is every class parent (`content-browser-helpers.ts`, `asset-registry.md`).
- **Medium.** `updateScene` writes the open scene and its dirty flag without the edit session or the journal (`document-context.tsx`, `document-service.ts`). The command-layer page says there is no direct update path.

## Reported in the forty-sixth batch, not re-checked

- `e2e/p2-accept.spec.ts` covers import only. Killed-tab journal recovery is in `e2e/qa-recovery.spec.ts` (`command-layer.md`).
- `e2e/p18-editor-opt.spec.ts` does not cover idle unmount or the warm-workspace cap (`command-layer.md`).

## Verified in the forty-seventh batch

- **High.** The Android application theme references `@color/colorPrimary`, `@color/colorPrimaryDark`, and `@color/colorAccent`. No color resource defines them, so resource linking fails before an APK is produced (`styles.xml`, `AndroidManifest.xml`).
- **Medium.** Desktop smoke loads `dist/public/build-manifest.json` and the installer beside it. It never compares `sourceSha` to the current commit, so a leftover package from an earlier build still passes (`smoke-desktop.mjs`).
- **Medium.** Desktop packaging clears nothing under `dist/installers` or `dist/public`. It only refuses a leftover `dist/app`. A previous installer with the same name can be copied into the public output (`package-desktop.mjs`).
- **Medium.** The render page says the FrameGraph post-process adapter admits only GLSL. The task compiles `material.shaderLanguage` with no WebGL gate (`framegraph-post-process.ts`).
- **Medium.** A Text3D editor fingerprint is text, size, color, font, and alignment. Depth is parsed and left out of the key, and the mesh builder does not read it (`scene-loader.ts`).

## Verified in the forty-eighth batch

- **High.** Restoring `Info.plist` sits outside the archive cleanup. If that write throws, `cleanupApple()` does not run, so the distribution keychain, certificate, and provisioning profile stay on disk (`ios-archive.mjs`).
- **Medium.** The iOS upload gate requires the secrets, storage, and audio plugins. It does not require `BabylonSlateMemoryPlugin`, which sync adds. A config missing only that plugin still archives (`ios-archive.mjs`, `ios-sync.mjs`).
- **Medium.** iOS sync captures `cap sync` through a pipe and leaves Node’s 1 MiB buffer default. A longer CocoaPods log kills the sync after the Podfile may already have changed (`ios-sync.mjs`).
- **Medium.** An early archive failure whose message contains `ENOENT` is printed as an uncertain App Store upload. A missing manifest or icon does that before any upload, with `uploaded` still false (`ios-archive.mjs`).
- **Medium.** Android release rejects test mode only in that process. It signs the web bundle already in `dist` and does not rebuild it. The iOS archive has no equivalent check (`android-release.mjs`, `ios-archive.mjs`).
- **Medium.** The Apple distribution password is passed as `-P` on the `security import` argument list, so it is visible in the process list (`ios-archive.mjs`).
- **Low.** After iOS sync, the Podfile check only requires the text `end`. A file that lost `post_install` but still has a target `end` is accepted (`ios-sync.mjs`).

## Reported in the forty-eighth batch, not re-checked

- Capacitor `cap sync` can log a web-asset copy error and still exit 0, so sync then archive signs the previous native web copy. The Capacitor CLI source is not in this tree (`ios-sync.mjs`, `android-sync.mjs`).

## Verified in the forty-ninth batch

- **Medium.** The theming page says Project Settings Input colors devices with pin tokens and axis colors on 2D binding toggles. Settings has no Input category. Binding details show the words “X · Horizontal” and “Y · Vertical” and do not use those tokens (`theming.md`, `settings-modal.tsx`, `input-asset-panels.tsx`).
- **Low.** The testing page says the static job’s 15 minutes include test-artifact builds. That job typechecks, lints, and builds the docs site. Each end-to-end shard builds the browser bundle (`testing.md`, `verify.yml`).
- **Low.** The node Vitest project also includes UI, scripting, scripting-nodes, editor-kit, and the Playwright config test. The testing page’s package list leaves those out (`vitest.workspace.ts`, `testing.md`).
- **Low.** Code multiline editors use a fixed `720px` by `960px` cap. The theming page says they use `editor-dialog-large` with no fixed desktop cap (`multiline-text-field.tsx`, `theming.md`).
- **Low.** On a coarse pointer the launcher title bar is at least 44px tall and the status bar is 26px. The theming page says 28px and 22px (`homepage.css`, `theming.md`).
- **Low.** There is no `docs/architecture/distribution.md`. The distribution page is `docs/development/distribution.md`.

## Verified in the fiftieth batch

- **High.** Attaching MSDF to a Font merges representation flags from the header payload and leaves the document chunk as it was. A saved Font header does not keep the font payload, so that merge can drop `representations.source` and the fallbacks. An open Font editor then saves the header payload. A closed Font keeps the old document flags, so `representations.msdf` stays false while the new chunks are stored (`registry.ts`, `project-service.ts`, `asset-document-workspace.tsx`).
- **Medium.** New Asset cannot create a Font. Fonts come from import (`content-browser-helpers.ts`, `fonts.md`).
- **Medium.** Sprite blend mode is alpha test by default, alpha test and blend when visibility is between 0 and 1, and alpha blend only when `alwaysBlend` is set. The sprites page says blending is opted in through `alphaIndex`, which is draw order (`mesh-assets.ts`, `sorting.ts`, `sprites.md`).
- **Medium.** While Play free cam is on, the audio listener uses the game camera. The rendered camera is the free cam (`create-engine.ts`, `play-free-cam.ts`, `audio.md`).

## Verified in the fifty-first batch

- **Medium.** Play keeps only Animation Graphs referenced by the scenes in that session. An open graph that the scene does not reference is dropped. The anim-graph page says Compile, Play, and export also load every project Animation Graph. Export hydrates the graphs the closure packed, not every graph in the project (`play-content-service.ts`, `anim-graph.md`, `hydrate.ts`).
- **Medium.** A successful engine-plugin index load returns an HTTP catalog. The memory adapter created beside it is returned only when the index fetch fails, and that store is empty. The plugins page says the editor unpacks the index into a read-only memory root. The unpacked counter counts catalog entries and does not unpack archives (`engine-plugins.ts`, `plugins.md`).
- **Medium.** The bridge control list omits `loadBehaviourTrees`, `loadNavMesh`, and `loadWater`. The command list omits `btState`. Those messages are on the channel types (`bridge.md`, `channels.ts`).
- **Medium.** Template and derived libraries use OPFS on web and Electron, and Documents storage on iOS and Android. Electron projects use the Node adapter under user data. The vfs page says those libraries use the same tier as projects on every host (`template-storage.ts`, `derived-storage.ts`, `vfs.md`).
- **Low.** When every clip weight is 0, playback returns the first clip. The audio page says all-zero weights are equal (`audio-payload.ts`, `audio.md`).
- **Low.** The content-browser folder pane minimum is 162px. The overview says 160px (`content-browser-workspace.tsx`, `overview.md`).
- **Low.** The Feature Test page says every asset lives under `assets/FeatureTest/<Area>/`. The scaffold keeps the Basic 3D scene at `assets/main.scene.babasset` and reuses that scaffold’s Mannequin (`feature-test.md`, `feature-test/context.ts`).
- **Low.** The settings page’s focus-keep key list stops at the behaviour tree. The schema continues through scene landscape, foliage, scene layer, sprite animation, audio, input, particles, model, skeleton, animation, skybox, trace, and texture (`vfs.md`, `app-settings.ts`).
- **Low.** Dark mode sets the brand button background and hover to near-white with dark text, and does not set the active colors. The theme default keeps active text white and active background on brand-1, which dark mode sets to near-white (`custom.css`).
- **Low.** The checked-in A16 policy that should confirm a native 4096 import is never read. Nothing asks before that size (`a16-encode-fixtures.ts`).
- **Removal.** These readers exist so an older in-repo shape still loads. The engine is not released, so they are bloat:
  - Anim connections rewrite `in` / `out` and side-only handles (`migrateAnimHandle`).
  - A transition still stored as a string condition is rebuilt into a rule graph (`migrateConditionToRuleGraph`).
  - A scene Game Instance is copied onto the project when the project field is empty (`migrateGameInstanceClassFromScenes`).
  - An old layout object is wrapped as the main scene tab (`migrateLegacyLayout`). Restored `asset-settings` tabs are rewritten to the newer document kind (`migrateRestoredDocumentId`).
  - Scene v2 to v3 is an empty migration step. An old numeric shadow capacity is rewritten to manual local-light mode (`migration.ts`).
  - Web projects still resolve and copy the old OPFS directory name (`legacyDirectoryName`).
  - A manifest with no `scriptsFile` is given `scripts.js`. `ui` and `uiDesignerPresets` are stripped on parse (`parseGameManifest`).
  - A missing Prefab snap distance is filled from the saved grid size (`viewportSnapTranslate`).

## Reported in the fifty-first batch, not re-checked

No new unchecked claims were added in this pass. The items above were read in source.

## Rejected in the fifty-first batch

- Transport parity republishing one in-process buffer is already described in the testing page and the issue tracker. It is not a hidden defect (`transport-parity.test.ts`, `testing.md`).
- Scene Layer fallback calls `render()` on the retained blit scene. That is the prior image the scene-layer page describes (`scene-layer-compositor.ts`).
- `requireConfirmAboveDimension: 4096` is not a live `>` comparison. No caller reads it.

## Deeper pass

One hundred further reads were requested. Ninety-nine started. The UI-package second pass was blocked until a slot opened, then returned; its checked defects are in the thirty-fourth batch. The earlier assets-package read has now returned; its new defects are in the thirty-seventh batch. These reads were told not to edit this file and not to repeat findings already listed here.

They cover the previously unread tests (editor, render, runtime, e2e, assets, core, editor-kit, scripting-nodes, and the smaller packages), the docs that were not line-read (`render.md`, `perf-budget.md`, `renderer-qualification.md`, plus full passes of `scripting.md`, `shader-graph.md`, `testing.md`, `theming.md`, `distribution.md`, `particle-emitters.md`, and `engineplan.md`), and a second pass of the files that already produced the serious defects.

## Coverage still open

The assets-package read and the UI-package second pass have both returned. Render files `g`–`o` and names starting with `s`, including `snapshot-apply.ts`, are recorded.

Architecture docs `a`–`m` were read in full: `anim-graph.md`, `asset-registry.md`, `audio.md`, `behaviour-tree.md`, `bridge.md`, `command-layer.md`, `components.md`, `console-commands.md`, `containers.md`, `debugger.md`, `editor-extensions.md`, `exporter.md`, `fonts.md`, `global-search.md`, `index.md`, `input.md`, and `keybinds.md`. Earlier docs read: `navigation.md`, `object-model.md`, `overview.md`, `particles.md`, `physics.md`, `plugins.md`, `scene-editing.md`, `scene-layers.md`, `source-control.md`, `sprites.md`, `tilemaps.md`, `vfs.md`, `feature-test.md`, `gestures.md`, and `save-games.md`. The deeper pass has now line-read `render.md`, `perf-budget.md`, `renderer-qualification.md`, `scripting.md`, `shader-graph.md`, `testing.md`, `theming.md`, `distribution.md`, `particle-emitters.md`, and `engineplan.md`; only the mismatches checked above are recorded.

Package test files were often left unread by the production-source passes. The deeper wave was assigned those tests. Returned slices with no new product defect beyond this file include runtime tests `sn`–`z` and `sa`–`sm`, and render tests `t`–`z`. The fifty-first batch checked the still-open reports for animation-graph load scope, plugin catalog storage, bridge commands, template storage, audio weights, the folder minimum, Feature Test paths, focus-keep keys, and the docs brand button.
