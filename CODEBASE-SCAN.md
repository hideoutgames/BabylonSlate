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

## Coverage still open

Large-file reads are still running for `water-material.ts`, `create-engine.ts`, `document-context.tsx`, `registry.ts`, `snapshot-apply.ts`, `script-host.ts`, and `driver.ts`, plus the remaining letter buckets. This note is updated as those reads are checked.
