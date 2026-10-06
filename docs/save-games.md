# Save Games

Save Games persist selected gameplay data independently of project files. A project selects one typed **Save Game** definition, then scripts use the same save/load service in editor Play, Preview Build, and the exported web player. Editor previews use a separate namespace from players' saves.

## Author a definition

1. In Content Browser, choose **New Asset → Scripting → Save Game**.
2. In its **Fields** panel, add the values the game needs to retain. For a minimal example, create `coins` as Integer with default `0`, and `checkpoint` as String with default `start`.
3. Select the asset under **Project Settings → Save Games → Default Definition**.
4. Keep the default profile and slot for a one-save game, or supply names for multiple characters and manual saves.

Fields support Boolean, Integer, Float, String, Vector 3, Actor, Asset, and arrays of those types. Actor and Asset values persist stable IDs or `null`. Each field has an immutable ID separate from its editable name. Renaming a field preserves existing saves; deleting it and adding another creates a different field. New fields receive their declared defaults when an older save is loaded.

The definition's **Schema Version** describes gameplay data. It is separate from the save file format version and the project's release version. Increase it when old values need a migration, such as changing units or a field's type.

## Minimal save/load example

Use the `coins` and `checkpoint` fields above. In the project's selected **Game Instance** class, connect **On First Scene Loaded** to **Load Game**. This event runs once per session after the first scene is ready. Register any migrations in **On Init**, before loading. On Load Game's Failed branch, use **Error Code** to distinguish `missing` (start a new game) from a damaged or incompatible save (show an error). At a checkpoint, set the fields and call **Save Game**. Continue the success UI from **Completed**, and show **Error Message** from **Failed**. Empty Slot/Profile pins select the project defaults.

The same operations are available inside **Execute JavaScript** nodes. Turn on the node's **Async** option when using `await`. Connect this startup load body to **On First Scene Loaded**:

```js
const result = await ctx.loadGame();
if (!result.ok) {
  if (result.error.code === "missing") {
    const fresh = await ctx.newGame();
    if (!fresh.ok) {
      ctx.log("error", "Save", fresh.error.message);
      return;
    }
  } else {
    ctx.log("error", "Save", result.error.message);
    return;
  }
}
const data = ctx.getSaveData();
ctx.log("log", "Save", `${data.coins} coins at ${data.checkpoint}`);
```

A checkpoint body:

```js
const data = ctx.getSaveData();
data.coins += 1;
data.checkpoint = "bridge";
const result = await ctx.saveGame();
if (!result.ok) ctx.log("error", "Save", result.error.message);
```

Stop and restart Play with **Wipe Preview Saves On Play** off. The startup load should report the saved values. Repeat in Preview Build, then export the game: the exported player starts with its own independent save namespace. Export a preview save and import it into a matching game only when intentionally transferring test data.

| JavaScript API | Purpose |
| --- | --- |
| `ctx.getSaveData()` | Read or edit the current fields by name; this does not write storage. |
| `await ctx.newGame()` | Reset current gameplay save state without deleting slots. |
| `await ctx.saveGame({ slot: "manual-1", profile: "player-2" })` | Save to a named slot/profile. Both options are optional. |
| `await ctx.loadGame({ slot: "manual-1", profile: "player-2" })` | Load a named slot/profile. |
| `await ctx.listSaves({ profile: "player-2" })` | Return save metadata for a profile. |
| `await ctx.deleteSave({ slot: "manual-1", profile: "player-2" })` | Explicitly remove a slot and its retained originals. |

The default definition adds **Get/Set Save _Field Name_** nodes with stable field IDs and typed pins. The definition's **Generated Type** view provides a `SaveData` TypeScript interface for code tooling; the core `generateSaveGameTypes()` helper produces the same declaration. JavaScript remains JavaScript: use `data["Field Name"]` for names containing spaces, and update name-based code when renaming a field.

## Operations and errors

The service provides Get Save Data, New Game, Save Game, Load Game, List Saves, and Delete Save. No file paths, JSON authoring, accounts, or platform setup are needed for the normal workflow. Profile and slot names default to the project's configured values (`default` for both in a new project).

Every asynchronous operation returns one of:

```ts
{ ok: true, value: /* operation result */ }
{ ok: false, error: { code: /* below */, message: string } }
```

| Code | Meaning and appropriate handling |
| --- | --- |
| `missing` | No save exists in the selected profile/slot. Offer a new game. |
| `corrupt` | Stored generations failed validation. Preserve them and offer recovery/import or an explicit deletion. |
| `incompatible` | Definition, schema, or format cannot be loaded by this build. Keep the save for a compatible build. |
| `storage-full` | Storage rejected the write for lack of capacity. The previous valid generation remains available. |
| `unavailable` | The storage backend cannot be used. Report the error; this never silently switches to temporary memory. |
| `invalid` | The requested operation or gameplay value is invalid. Correct the request before retrying. |
| `apply-failed` | Validated data could not be restored to the runtime. Report the failure; do not pretend loading succeeded. |

**New Game** resets in-memory save fields to defaults; the runtime also resets registered placed actors and removes registered spawned actors. It does not erase existing slots. Damaged or incompatible slots require an explicit deletion before replacement; starting a new game is not consent to discard them. Use checkpoint saves after meaningful progress. App exit and backgrounding are not reliable opportunities to finish an asynchronous write.

## Gameplay state

Save only state that affects gameplay. **Add Component → General → Save Game** selects actor transforms, actor/script variables, and component variables with individual checkboxes, including inherited variables. Assets keep their stable GUIDs. Persisted spawned actors must be registered with stable identities; use `ctx.registerSaveActor(actor, persistentId)` to assign a custom identity before that actor's first capture. Transform saves include stable parent references. Missing or cyclic parents reject the load. Actor references resolve after actors have been restored, before **On Game Loaded** runs.

Actor persistence currently targets the active world scene. Load rejects a save belonging to a different active scene; switch to the correct scene before loading. Additively streamed scenes and overlay SceneLayers are excluded because their instance identities do not yet provide a stable save contract. Store cross-scene progress in definition fields.

The save system does not serialize Babylon scenes, GPU resources, arbitrary JavaScript closures, active timers, or every engine subsystem. Data-only fields work without actor persistence.

Selected actor/component variables support nested Maps with string or finite-number keys, preserving numeric and string keys separately. Map values can contain arrays, plain data, other Maps, and saved actor/component references. Cycles, unsupported keys, and malformed Map data reject the operation without replacing the checkpoint. This does not add Map fields to Save Game definitions.

## Schema migrations

Migration functions receive a detached document with `schemaVersion`, `fields` keyed by stable field IDs, and optional runtime `state`. Register each migration against the version it upgrades; each step advances one schema version. Functions may mutate the document or return a replacement, synchronously or asynchronously.

Migrations run on a validated copy before applying data. A failed migration leaves the original stored generations intact. Loading a migrated save does not rewrite its source; save explicitly after accepting the migrated game state. The first save after a schema upgrade archives the previous original, retained until explicit delete/reset. A field rename and an added field with a default do not require hand-written JSON conversion.

For a version 1 → 2 migration, register **Register Save Migration** with From Version `1` during initialization, before Load Game. **Event Save Migration** exposes From Version; its typed **Get/Set Migration _Field Name_** nodes update the staged data by stable field ID. Generic **Get/Set Migration Field** nodes also access historical fields removed from the current definition. If any custom migration applies, register every intermediate version; use a no-op callback for a step that needs no conversion. An incomplete chain rejects the load and subsequent save without replacing the older data. When no custom migration applies, added defaults and stable-ID renames upgrade automatically.

Actor migration fields contain persistent ID strings, including array elements, because restored actors do not exist yet. Normal typed Save field nodes resolve those IDs to live Actor references.

The JavaScript equivalent, for a field whose units changed from whole coins to hundredths, is:

```js
// Copy the actual ID from the definition's Field ID row.
const coinsId = "replace-with-coins-field-id";
ctx.registerSaveMigration(1, (snapshot) => {
  snapshot.fields[coinsId] = Number(snapshot.fields[coinsId] ?? 0) * 100;
});
```

Keep migrations focused on their supplied document; graph Functions can share conversion logic. Mutating unrelated gameplay objects or dispatching gameplay events from a custom migration callback is outside the service's staged-data rollback contract.

New Game and Load Game preserve the identity of the record returned by Get Save Data while replacing its contents. Failed loads do not replace those contents. A newer incompatible save is not silently downgraded to an older compatible generation.

## Editor save tools

**Project Settings → Save Games** manages preview save data. Select a profile/slot to inspect, export, or delete it; import a save to test recovery. **Reset Preview Saves** removes local test saves in the editor namespace. **Wipe Preview Saves On Play** supports repeatable playtesting. These controls must not erase the exported player's namespace.

Reset remains available when the default definition is missing or invalid. Inspection and import require a valid definition.

Preview Build forwards save storage requests to the editor host, so it shares Overlay Play's preview slots and reset controls on web, Electron, and Capacitor. Its iframe uses a scoped session bridge instead of independently selecting a storage backend.

Inspection does not run game scripts or custom migrations. Inspect a save requiring those migrations in Play; the manager can still export a structurally valid older save for backup.

**Request Persistent Storage** asks the browser to reduce automatic eviction. The browser can deny it, private browsing may restrict storage, and users can still clear site data. Export saves that need an independent backup. Import validates the file before committing it as a new generation.

## Storage and recovery

- Namespace saves by stable project ID, execution mode, profile, and slot. Renaming a project must not change its save identity.
- Capture a consistent snapshot at the runtime simulation boundary, then perform asynchronous encoding/checksumming and storage work. Async API completion does not establish zero frame cost: capture, cloning, and JSON work still need device measurements.
- Serialize conflicting operations. Web Locks coordinate same-origin tabs/windows around the full read/choose/write transaction, while native hosts need equivalent host-owned coordination.
- Keep two alternating checksummed generations. Verify both on load and recover from the older valid one if the newest is damaged. Never overwrite the sole valid generation during a failed save.
- Validate format, definition, schema, field values, and runtime state before applying a load. Missing, corrupt, and incompatible data are distinct outcomes.

| Host | Save location | Qualification boundary |
| --- | --- | --- |
| Web editor and exported web player | Origin Private File System (OPFS), separate editor/player namespaces | Subject to browser permissions, quota, eviction, and user deletion. |
| Electron editor on Windows/macOS/Linux | A dedicated subdirectory of application `userData` | Native adapter behavior requires platform verification. |
| Capacitor editor on iOS/Android | Application-private storage; iOS Library/Application Support and Android internal files | Physical-device storage failure and interruption behavior remain separate acceptance work. |

The current exporter produces a web player. Electron and Capacitor package the editor; this repository does not currently export native games. Native host adapters do not by themselves establish native exported-game support. See [Exporter](architecture/exporter.md#export-game-vs-export-project).

## Verification coverage

Automated checks below passed in the implementation workspace. Runtime, save-node catalog, save manager, and scoped core/runtime/editor TypeScript checks were confirmed at revision `31610d712`. Browser checks used Chromium 151 on Linux, Playwright browser controls, and screenshot review; a dedicated Computer Use tool was unavailable. Browser revisions are recorded below; the final editor-tested tree is published as `142e0d7d3`.

| Coverage | Status | Evidence / limits |
| --- | --- | --- |
| Core saves, corruption, interrupted writes, storage failure, concurrency, migrations | Passed automated checks | [Service tests](../packages/core/src/save-game.test.ts), [storage RPC tests](../packages/core/src/save-game-rpc.test.ts), and [script API/migration tests](../packages/runtime/src/script-host-save-game.test.ts); storage faults injected at the adapter boundary. |
| Runtime selected state, spawned actors, references, staged load | Passed automated checks | [Runtime tests](../packages/runtime/src/save-game-runtime.test.ts), including rollback, class asset identity and actor fields; `31610d712`. |
| Editor definition/default selection and save tools | Passed automated checks | [Definition panels](../apps/editor/src/panels/save-game-panels.test.tsx), [save manager](../apps/editor/src/components/project-save-games-settings.test.tsx), and [typed-node catalog](../apps/editor/src/lib/save-game-catalog.test.ts); manager/catalog rerun at `31610d712`. |
| Preview iframe storage routing and isolation | Passed automated checks | [Preview bridge tests](../packages/exporter/src/preview-save-storage.test.ts): shared host storage, preview reset, namespace restrictions, trusted messages and reload cleanup. |
| Packed-player save/load and worker storage routing | Passed automated checks | [Player boot tests](../apps/player/src/boot.test.ts): in-process restart and worker RPC with injected storage; browser OPFS round trip remains separate. |
| Browser definition authoring and touch layout | Passed browser checks | [Workflow tests](../e2e/save-game-workflow.spec.ts): desktop and iPad-landscape Chromium coarse-input emulation; screenshots reviewed. Revision `30fe2278f`, identical tree published as `142e0d7d3`. |
| Overlay Play and Preview Build storage parity | Passed browser checks | [Parity tests](../e2e/save-game-parity.spec.ts): two Play sessions restored counts 1 then 2; Preview Build continued at 3. Revision `30fe2278f`. |
| Packed and loose exported web players | Passed browser checks | [Parity tests](../e2e/save-game-parity.spec.ts): OPFS cold reload in both formats; packed player also verified two same-origin tabs committing sequences 3/4 and checksum-corruption fallback preserving previous bytes. Revision `e5e6fe057`. |
| Web and mobile storage adapter contracts | Passed automated checks | [Adapter tests](../packages/vfs/src/save-game-storage.test.ts) use browser/native filesystem boundary doubles; these do not qualify installed browsers or devices. |
| Linux Node filesystem and desktop IPC | Passed automated checks | [Node filesystem tests](../packages/vfs/src/save-game-node.test.ts), [desktop lease tests](../apps/desktop/src/desktop-save-games.test.ts), and [IPC security tests](../apps/desktop/src/packaged-security.test.ts). |
| Installed Windows/macOS/Linux native applications | Unverified | Linux Node filesystem evidence does not qualify packaged native apps or other operating systems. |
| Physical iOS/Android app-private storage | Unverified | No physical device run recorded. |
| A16 iPad save/load latency and frame-time impact | Unverified | Desktop browser tests do not qualify mobile performance. |
| Native exported games | Unsupported by current exporter | Existing native packages host the editor. |

## Platform references

Implementation follows the existing Slate runtime scheduler. Babylon's [deterministic lockstep hooks](https://github.com/BabylonJS/Documentation/blob/master/content/features/featuresDeepDive/animation/advanced_animations.md#deterministic-lockstep) describe where physics and animation steps meet; they do not replace Slate's simulation boundary.

The browser adapter uses [OPFS](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/getDirectory), [commit-on-close writable streams](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createWritable), and [Web Locks](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API). See [persistence requests](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist) and [quota/eviction rules](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria) for the limits of browser retention.

Native locations follow [Electron application paths](https://www.electronjs.org/docs/latest/api/app#appgetpathname), [Capacitor filesystem directories](https://capacitorjs.com/docs/apis/filesystem#directory), and [Android app-specific storage](https://developer.android.com/training/data-storage/app-specific). Capacitor's public filesystem API does not promise fsync-level power-loss durability; preserve a previous generation and verify interruption behavior on each target host.

For the pinned Capacitor Filesystem 8.1.2 dependencies, replacement removes the destination before moving: [iOS IONFilesystemLib 1.1.2](https://github.com/ionic-team/ion-ios-filesystem/blob/1.1.2/IONFilesystemLib/IONFILEManager.swift#L266) and [Android ionfilesystem 1.1.0](https://github.com/ionic-team/ion-android-filesystem/blob/1.1.0/src/main/kotlin/io/ionic/libs/ionfilesystemlib/helper/IONFILELocalFilesHelper.kt#L205). Android may fall back to copying. The mobile adapter therefore replaces only the inactive generation; it does not claim an atomic native rename.
