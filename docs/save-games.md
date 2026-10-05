# Save Games

Save Games persist selected gameplay data independently of project files. A project selects one typed **Save Game** definition, then scripts use the same save/load service in editor Play, Preview Build, and the exported web player. Editor previews use a separate namespace from players' saves.

## Author a definition

1. In Content Browser, choose **New Asset → General → Save Game**.
2. In its **Fields** panel, add the values the game needs to retain. For a minimal example, create `coins` as Integer with default `0`, and `checkpoint` as String with default `start`.
3. Select the asset under **Project Settings → Save Games → Default Definition**.
4. Keep the default profile and slot for a one-save game, or supply names for multiple characters and manual saves.

Fields support Boolean, Integer, Float, String, Vector 3, Actor, Asset, and arrays of those types. Actor and Asset values persist stable IDs or `null`. Each field has an immutable ID separate from its editable name. Renaming a field preserves existing saves; deleting it and adding another creates a different field. New fields receive their declared defaults when an older save is loaded.

The definition's **Schema Version** describes gameplay data. It is separate from the save file format version and the project's release version. Increase it when old values need a migration, such as changing units or a field's type.

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

Save only state that affects gameplay. The optional **Save Game Component** selects actor transforms, actor/script variables, and component variables; assets keep their stable GUIDs. Persisted spawned actors must be registered with stable identities. A saved actor reference must resolve after actors have been restored, before **On Game Loaded** runs.

Actor persistence currently targets the active world scene. Load rejects a save belonging to a different active scene; switch to the correct scene before loading. Additively streamed scenes and overlay SceneLayers are excluded because their instance identities do not yet provide a stable save contract. Store cross-scene progress in definition fields.

The save system does not serialize Babylon scenes, GPU resources, arbitrary JavaScript closures, active timers, or every engine subsystem. Data-only fields work without actor persistence.

## Schema migrations

Migration functions receive a detached document with `schemaVersion`, `fields` keyed by stable field IDs, and optional runtime `state`. Register each migration against the version it upgrades; each step advances one schema version. Functions may mutate the document or return a replacement, synchronously or asynchronously.

Migrations run on a validated copy before applying data. A failed migration leaves the original stored generations intact. Loading a migrated save does not rewrite its source; save explicitly after accepting the migrated game state. The first save after a schema upgrade archives the previous original, retained until explicit delete/reset. A field rename and an added field with a default do not require hand-written JSON conversion.

New Game and Load Game preserve the identity of the record returned by Get Save Data while replacing its contents. Failed loads do not replace those contents. A newer incompatible save is not silently downgraded to an older compatible generation.

## Editor save tools

**Project Settings → Save Games** manages preview save data. Select a profile/slot to inspect, export, or delete it; import a save to test recovery. **Reset Preview Saves** removes local test saves in the editor namespace. **Wipe Preview Saves On Play** supports repeatable playtesting. These controls must not erase the exported player's namespace.

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

No row below claims a completed run until its evidence has been recorded.

| Coverage | Status | Evidence / limits |
| --- | --- | --- |
| Core saves, corruption, interrupted writes, storage failure, concurrency, migrations | Pending | Focused automated tests required. |
| Runtime selected state, spawned actors, references, staged load | Pending | Runtime tests required. |
| Editor definition/default selection and save tools | Pending | Browser Computer Use workflow required. |
| Overlay Play, Preview Build, exported web player parity | Pending | Actual exported-player round trip required. |
| Native desktop filesystem adapter | Pending | Unit filesystem evidence is separate from installed Windows/macOS/Linux validation. |
| Physical iOS/Android app-private storage | Unverified | No physical device run recorded. |
| A16 iPad save/load latency and frame-time impact | Unverified | Desktop browser tests do not qualify mobile performance. |
| Native exported games | Unsupported by current exporter | Existing native packages host the editor. |

## Platform references

Implementation follows the existing Slate runtime scheduler. Babylon's [deterministic lockstep hooks](https://github.com/BabylonJS/Documentation/blob/master/content/features/featuresDeepDive/animation/advanced_animations.md#deterministic-lockstep) describe where physics and animation steps meet; they do not replace Slate's simulation boundary.

The browser adapter uses [OPFS](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/getDirectory), [commit-on-close writable streams](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createWritable), and [Web Locks](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API). See [persistence requests](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist) and [quota/eviction rules](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria) for the limits of browser retention.

Native locations follow [Electron application paths](https://www.electronjs.org/docs/latest/api/app#appgetpathname), [Capacitor filesystem directories](https://capacitorjs.com/docs/apis/filesystem#directory), and [Android app-specific storage](https://developer.android.com/training/data-storage/app-specific). Capacitor's public filesystem API does not promise fsync-level power-loss durability; preserve a previous generation and verify interruption behavior on each target host.
