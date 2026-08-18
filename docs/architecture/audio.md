# Audio engine (P16)

Shared surface for imported Audio, mixer/channel routing, spatial attenuation, overlay Play / packaged player playback, automatic environmental reverb, and cheap occupancy-grid wall muffling (engineplan §2.6). Implementation spans `@babylonslate/assets` (payloads, gain math, bake) and `@babylonslate/render` (`AudioService`). Runtime and graph packages emit commands only. Real-device listening is manual; CI proves routing, gain, unlock, spatial parameters, bake identity, and teardown.

There is **no second sound type**. Imported `Audio` stays kind `audio` with a `source` chunk. Mixer, channel, and attenuation are user-created assets.

## Author path

- **Import** a WAV / MP3 / OGG. New Asset does not create sounds (the Audio group says so). Imported Audio opens a DockView document (`audio`: Preview / Details / Clips).
- **Place Actors → Project** tile for that Audio. That binds `audioAssetGuid` with Play On Start. The engine **Audio** speaker stays empty until an asset is picked.
- **Play**, then **click the game view** to enable audio. Overlay Play and the bundled-debugger player show **Click the game view to enable audio** while play-on-start is queued and AudioV2 is still locked. Do not auto-unlock at load. Overlay **Pause** pauses live AudioV2 voices (it does not stop or dispose them). Console `pause` stays sim-only.
- Mixer, channel, and attenuation are optional. Playback is `assetVolume × playCallVolume` with those refs at None.

Also:

- Mixer **Add Channel** opens the AudioChannel picker and commits a row only after a guid. Empty table: Global Volume still applies.
- **Set Channel Volume** only addresses channels on the selected mixer table (`audio.unknown_channel` otherwise, even if the channel asset exists).
- Snapshot poses include actor orientation so attenuation cones aim with the emitter.

## Package

| Package | Owns | Must not |
| --- | --- | --- |
| `assets` | Payloads, normalisers, migrations, cycle check, gain/attenuation math, `audioReverb` chunk codec, occupancy bake (pure) + worker | React, Babylon, Web Audio |
| `render` | `AudioService`, decoded-buffer LRU, AudioV2 backend, listener/emitter follow, one parametric reverb bus | React; game worker |
| `bridge` | Command types | Playback |
| `runtime` | Emit commands; `AudioComponent` play-on-start/stop; BT PlaySound host | Babylon / Web Audio |
| `scripting` + `scripting-nodes` | `assetRef` pin; Play Sound / Set Channel Volume / Set Global Volume | Babylon |
| Editor / player | DockView editors, catalogs, Project Settings mixer / occlusion / reverb scales, first-gesture unlock, packed `audioBytes` | Direct Capacitor / per-host mixer |

Unit tests inject `FakeAudioPlaybackBackend` (`NullEngine` cannot decode/play). Overlay Play and `apps/player` use the real Babylon AudioV2 backend (`babylon-audio-backend.ts`, coverage-excluded like `create-engine.ts`).

## Assets

| Type | Created by | Suffix | Editor |
| --- | --- | --- | --- |
| `Audio` | Import (WAV / MP3 / OGG) | `.babasset` | DockView Preview (Play/Stop, Loop, waveform), Details (Volume, Loop, Randomize Pitch, Pitch unless randomize is on, Pitch Min/Max, Channel, Attenuation), Clips (read-only names, editable weights) |
| `AudioMixer` | New Asset | `.mixer.babasset` | DockView Details (`audio-mixer`) |
| `AudioChannel` | New Asset | `.channel.babasset` | DockView Details (`audio-channel`) |
| `SoundAttenuation` | New Asset | `.atten.babasset` | DockView Details (`sound-attenuation`) with an SVG falloff **plot** (numeric UI, not artwork) |

**Audio payload** (old `{}` normalises without rewriting the `audio` chunk): `volume` `0..1` default `1`; `loop` default `false`; `audioChannelGuid` / `soundAttenuationGuid` `string \| null` default `null`; `clips` (omitted/empty → `[{ chunkId: "source", name: "<asset file stem>", weight: 1 }]`, cap 8); `pitch` default `1` (clamp `0.25..4`); `pitchRandom` default `false`; `pitchMin` / `pitchMax` default `1`. Import writes the source clip name from the file stem. Empty source names fill from the asset header name on first Details/Clips commit (`fillEmptySourceClipName`). Clip names are read-only in the editor; only Weight / Add / Remove are editable. The `source` clip cannot be removed. Extra files land as `source:<id>` chunks — not a playlist of other Audio guids. `pickWeightedAudioClip` treats weights `>= 0` (all-zero → equal). Decode cache key is `${guid}:${chunkId}`. Playback rate is `pitch × dopplerRate`; `syncListener` must not overwrite it. Play loops when `command.loop === true` **or** `payload.loop === true`. Graph / BT Play Sound omit `loop` and inherit the asset flag. `AudioComponent.loop` still forces loop on a one-shot asset. To play a looping asset once, uncheck asset Loop. Details hide the **Pitch** row when `pitchRandom` is on (min/max stay).

**AudioChannel** has no volume: `parentChannelGuid`, `effects: [{ kind: "environmentReverb" \| "muffleThroughWalls", enabled }]`. Old channels with only reverb gain a disabled muffle row. Parent cycles fail validation; missing/rejected parent routes to master with one diagnostic. `AudioService.setLibrary` sanitizes the Play library the same way: missing channel/attenuation refs and cyclic parents become `null` with one diagnostic each. Channel Details toggles must keep both effect kinds (`setAudioChannelEffect`).

**AudioMixer** is a user asset, not a singleton: `globalVolume` default `1`; `channels: { channelGuid, volume }[]` (duplicate `channelGuid` invalid).

**SoundAttenuation** opts Audio into 3D (`null` = non-spatial): `innerRadius` default `1`, `maxRadius` default `50` (`maxRadius >= innerRadius`, both `>= 0`); `distanceModel` `linear \| inverse \| exponential`; `rolloff` default `1`; `spatialisation` `equalPower \| hrtf`; optional `cone` and `doppler`.

**Project Settings** `audio`: `audioMixerGuid` default `null` (None); `occlusionEnabled` default `true`; `reverbWetScale` / `reverbDecayScale` / `reverbDampingScale` default `1`, clamp `0..2`. Overlay Play, Preview Build, and packed `game.json` thread these into `AudioService.setProjectAudioSettings`.

Header `dependencies[]` on save include channel, attenuation, parent, and mixer channel-table guids (Show References / remap / delete guards).

## Gain

Every factor is clamped `0..1`:

`outputGain = assetVolume × playCallVolume × channelGain × parentChannelGain… × globalGain`

- No mixer + no channel: `assetVolume × playCallVolume` only.
- Channel-less sound never takes channel gain or channel effects; a selected mixer still applies `globalGain`.
- Channel with no mixer: non-gain effects/routing may resolve; no invented channel/master gain.
- Set Channel / Set Global **replace** session values (do not edit assets) and apply immediately to voices that are already playing (`setVoiceGain`). Play stop / scene change reloads mixer defaults. Without a selected mixer, or with a channel absent from the mixer table, the nodes warn (`audio.no_mixer` / `audio.unknown_channel`) and no-op. A channel that exists only in the library is not enough.

## Commands

Worker → main (ordered). Main thread resolves Audio / Mixer / Channel / Attenuation from the Play audio library (same pattern as `textureBytes`).

```ts
| { type: "playSound"; assetGuid: string; volume: number; frameId: number;
    emitterActorGuid?: string | null; loop?: boolean; voiceId?: string }
| { type: "stopSound"; voiceId: string }
| { type: "setChannelVolume"; channelGuid: string; volume: number }
| { type: "setGlobalVolume"; volume: number }
```

`AudioComponent` properties: `audioAssetGuid`, `playOnStart`, `loop`, `volume` (`playCallVolume`). Play-on-start emits `playSound` with `emitterActorGuid` = the owning actor. Graph **Play Sound** uses `self` as emitter and does not send `loop` (the Audio asset’s Loop flag applies). Missing Actor + attenuation → non-spatial + one diagnostic.

## Unlock and cache

First `pointerdown` / `touchstart` on overlay Play (`play-canvas`) and the packaged player (`player-canvas`) calls `audioService.unlockAsync()`. `AudioService` warms the AudioV2 engine at boot (suspended) so the gesture turn only `resume()`s / `unlockAsync()`s — it does not `await CreateAudioEngineAsync` on the click. Commands before unlock enqueue (cap 32, ordered) and drain after the gesture. Overlay chrome and the bundled-debugger player show **Click the game view to enable audio** (`play-audio-unlock-hint`) while `queued > 0` and still locked. Decode / missing-context → one diagnostic; the game keeps running. There is no `[audio] …` play-log-tail line; `showaudiodebug` is the now-playing overlay.

Asset-document preview **prefetches** clip bytes when the tab opens and starts playback **in the same turn** as Play (unlock + backend `play`, no `await readAssetChunk` before start). WKWebView drops the user-gesture if Play awaits I/O first. Cache miss → `audio.preview_missing_source`; play failure surfaces `audio.play_failed` instead of swallowing. Document preview is non-spatial (no Play listener). Preview Play uses `payload.loop`; when Loop is off, `onVoiceEnded` flips the transport back to Play. After prefetch (not on the Play click), `decodeAudioData` builds a read-only PCM peak plot (`extractAudioWaveformPeaks`, 128 bars) for the first / last-played clip. Decode failure leaves an empty well; Play still works. Overlay Play / Preview Build / `apps/player` load **every** clip chunk (`guid` and `guid:chunk` keys); BSAU with a clip table after JSON stays compatible with the old “rest is one source” pack.

Preview Build’s iframe uses `outline-none` / `focus-visible:outline-none`; the packaged player also sets `canvas:focus { outline: none }` so a click does not draw a browser focus ring. Packing already includes Audio (BSAU); `export-game-inputs` loads documents as kind `audio`.

`AudioBufferCache` is guid-keyed PCM with active-voice pins and a **64 MiB** LRU, separate from the ~512 MB texture `ResourceCache`. Max concurrent voices: 32.

## Spatial

Worker emits identity only (`emitterActorGuid` / `voiceId`). Main thread follows interpolated snapshot poses (same as mesh apply), including actor **quaternion** so cones orient. Listener is `scene.activeCamera` after snapshot apply: **possessed camera**, else Scene Default Camera, else the Play fallback named `"camera"`. Pose is world space (`globalPosition` + `absoluteRotation`). No scene listener picker and no second listener actor. Inner radius = full gain, max radius = silent, monotonic between — that curve lives in `computeAttenuationGain` (unit tests) and in Babylon AudioV2 `spatialMinDistance` / `spatialMaxDistance` on the real backend. `AudioService` must not pre-multiply the same falloff into `volume` or voices attenuate twice. Optional Doppler is authored on the asset; Web Audio removed PannerNode Doppler, so snapshot follow applies `playbackRate` from radial emitter velocity × `doppler.factor`, composed with authored pitch. The render loop's later `syncListener` call must not rewrite that rate (dt would be 0). Sound Attenuation Details expose cone angles and Doppler next to radii/model/rolloff/spatialisation.

## Reverb bake

Mirrors nav bake: main-thread collect of **static** `MeshComponent` triangles (chunked, 8 actors per yield), worker occupancy + flood-fill + sparse probes, debounce 1_500 ms after the last static geometry edit, cancel, geometry-hash cache, timeout 8_000 ms. Dynamic rigid bodies do not invalidate.

Versioned Scene extra chunk `audioReverb` (magic `BSAR`, same extra-chunk pattern as `navmesh`). **v2** appends a bit-packed occupancy bitmap after the probes (~1 KiB at 24×24×16); v1 chunks omit occupancy and stay unoccluded until Save rebakes. Stay under 64 KiB. Save/export await a current result for **every** Scene asset in the Play library (open or closed), not only open tabs, or write a marked dry fallback (`audio.reverb_bake_failed`); they never hang. Export packs a sidecar `type: "AudioReverb"`, guid `audioReverb:<sceneGuid>`. Packed Audio is a **BSAU** envelope (JSON payload + source bytes, or JSON + a length-prefixed clip table).

Channels with `environmentReverb.enabled` send to **one** shared delay/comb/all-pass bus (`AUDIO_REVERB_COMB_COUNT` = 4, `AUDIO_REVERB_ALLPASS_COUNT` = 2). Comb taps use feedback + damping; all-pass taps are Schroeder (delay + negative feedforward). Listener interpolates ≤2 probes for **wet, decay, and damping**, then Project Settings scales multiply those values (clamp product `0..1`). `setReverbProfile` writes comb feedback from decay and the damping low-pass; `setReverbWet` is a wet-only shortcut (default decay 0.4, damping 0.5). No per-voice convolver. Channel-less stays dry. Dry fallback → wet 0. AudioV2 keeps the bus→main dry route at unity; the parametric graph is an extra wet send (`dryPassThrough: false`). If the send cannot attach, wet falls back to scaling the whole bus volume. Do not `disconnect()` AudioV2 private `_outNode` / `_inNode` ports — that hung Play Stop.

## Wall muffling

Additive on Done P16. **Not** triangle ray tracing / Recast / physics rays. Spatial voices whose channel (or parent) has `muffleThroughWalls` enabled run a DDA walk on the baked occupancy grid each listener/snapshot sync (Play-view listener from Spatial). Occupied voxels along the segment count as walls; saturate after two (`occlusionFactor` `0..1`). Non-spatial, missing emitter, channel-less, missing occupancy, or Project Settings **Occlusion** off → factor `0`. One shared ~700 Hz lowpass bus; per-voice extra send mixed by the factor. Fake backend records `muffles.get(voiceId)`.

## A16 budgets

Named constants in `packages/assets/src/audio-payload.ts` (waveform bar count in `audio-waveform.ts`):

| Constant | Value |
| --- | --- |
| Occupancy grid | max 24 × 24 × 16 cells |
| Voxel size | 2 world units |
| Max probes | 32 |
| `audioReverb` chunk | 64 KiB |
| Bake worker timeout | 8_000 ms |
| Geometry collect slice | 8 static mesh actors per yield |
| Background debounce | 1_500 ms |
| Shared reverb buses | 1 |
| Comb / all-pass taps | 4 / 2 |
| Crossfading profiles | 2 |
| Pre-unlock command queue | 32 |
| Decoded PCM LRU | 64 MiB |
| Max concurrent voices | 32 |
| Max clips per Audio | 8 |
| Waveform preview bars | 128 |
| Muffle lowpass | 700 Hz |
| Walls to saturate muffle | 2 |

## Scripting and BT

`assetRef(assetType)` is a guid-string pin family (literal default; Inspector `AssetPicker` with `allowedTypes`). **Play Sound** / **Set Channel Volume** / **Set Global Volume** sit on Class and Actor palettes. BT **PlaySound** succeeds when the Audio guid is in the Play library and fails when missing. No Babylon imports in scripting / BT packages.

## Test hatch

Test-mode `window.__babylonslateAudioStats` (`audioStats` from `@babylonslate/render`) exposes `unlocked`, `queued`, `voices`, `lastGain`, `lastDistance`, `wet`, `accountedBytes`, and `debugVoices` when `showaudiodebug` is on — same idea as `uiHostStats`. Playwright: `e2e/p16-audio.spec.ts` (overlay Play unlock plus Preview Build iframe unlock). Cross-package gain/unlock/reverb proofs: `packages/render/src/p16-acceptance.test.ts`.

`showaudiodebug [on|off]` is a debug-tier flag (same bool parser as `showfps`) that **applies**. Runtime emits `{ type: "setShowAudioDebug"; enabled }`; `AudioService` publishes a per-voice snapshot and a DOM overlay (not Babylon GUI) polls it with `requestAnimationFrame` so it still draws while sim is paused. Per voice: asset guid, clip name, gain, pitch, loop, spatial vs not, listener–emitter distance, inner/max radius, and **inside radius** (`distance <= maxRadius` when spatial and pose known; `n/a` otherwise). Empty list: `No playing voices`. Off: overlay unmounted. Overlay Play and the bundled-debugger player both mount it.

## Out of P16

Streaming music, mic capture, authored acoustic zones/materials, **triangle** runtime occlusion/ray tracing, waveform **editing**, DSP plugins, IR convolution, converting Texture/Model `asset-settings` to DockView, P18 idle-unmount, BT RotateToFace / PlayAnimation (P19). Voxel DDA muffling on the existing occupancy bake is additive (still no triangle rays). Audio Preview may draw a read-only PCM peak plot; that is not waveform editing.

See [render.md](render.md), [bridge.md](bridge.md), [scripting.md](scripting.md), [exporter.md](exporter.md). Spec: [engineplan.md](../engineplan.md) §2.6.
