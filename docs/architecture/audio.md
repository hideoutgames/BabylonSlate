# Audio engine (P16)

Shared surface for imported Audio, mixer/channel routing, spatial attenuation, overlay Play / packaged player playback, and automatic environmental reverb (engineplan §2.6). Implementation spans `@babylonslate/assets` (payloads, gain math, bake) and `@babylonslate/render` (`AudioService`). Runtime and graph packages emit commands only. Real-device listening is manual; CI proves routing, gain, unlock, spatial parameters, bake identity, and teardown.

There is **no second sound type**. Imported `Audio` stays kind `audio` with a `source` chunk. Mixer, channel, and attenuation are user-created assets.

## Author path

- **Import** a WAV / MP3 / OGG. New Asset does not create sounds (the Audio group says so).
- **Place Actors → Project** tile for that Audio. That binds `audioAssetGuid` with Play On Start. The engine **Audio** speaker stays empty until an asset is picked.
- **Play**, then **click the game view** to enable audio. Chrome shows **Click the game view to enable audio** while play-on-start is queued and AudioV2 is still locked. Do not auto-unlock at load.
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
| Editor / player | DockView editors, catalogs, Project Settings mixer, first-gesture unlock, packed `audioBytes` | Direct Capacitor / per-host mixer |

Unit tests inject `FakeAudioPlaybackBackend` (`NullEngine` cannot decode/play). Overlay Play and `apps/player` use the real Babylon AudioV2 backend (`babylon-audio-backend.ts`, coverage-excluded like `create-engine.ts`).

## Assets

| Type | Created by | Suffix | Editor |
| --- | --- | --- | --- |
| `Audio` | Import (WAV / MP3 / OGG) | `.babasset` | Compact `asset-settings` (metadata, preview Play/Stop that pauses and resets, Blob MIME from source bytes, Volume, Channel + Attenuation pickers) |
| `AudioMixer` | New Asset | `.mixer.babasset` | DockView Details (`audio-mixer`) |
| `AudioChannel` | New Asset | `.channel.babasset` | DockView Details (`audio-channel`) |
| `SoundAttenuation` | New Asset | `.atten.babasset` | DockView Details (`sound-attenuation`) with an SVG falloff **plot** (numeric UI, not artwork) |

**Audio payload** (old `{}` normalises without rewriting the `audio` chunk): `volume` `0..1` default `1`; `audioChannelGuid` / `soundAttenuationGuid` `string \| null` default `null`.

**AudioChannel** has no volume: `parentChannelGuid`, `effects: [{ kind: "environmentReverb", enabled }]`. Parent cycles fail validation; missing/rejected parent routes to master with one diagnostic.

**AudioMixer** is a user asset, not a singleton: `globalVolume` default `1`; `channels: { channelGuid, volume }[]` (duplicate `channelGuid` invalid).

**SoundAttenuation** opts Audio into 3D (`null` = non-spatial): `innerRadius` default `1`, `maxRadius` default `50` (`maxRadius >= innerRadius`, both `>= 0`); `distanceModel` `linear \| inverse \| exponential`; `rolloff` default `1`; `spatialisation` `equalPower \| hrtf`; optional `cone` and `doppler`.

**Project Settings** `audio.audioMixerGuid` default `null` (None).

Header `dependencies[]` on save include channel, attenuation, parent, and mixer channel-table guids (Show References / remap / delete guards).

## Gain

Every factor is clamped `0..1`:

`outputGain = assetVolume × playCallVolume × channelGain × parentChannelGain… × globalGain`

- No mixer + no channel: `assetVolume × playCallVolume` only.
- Channel-less sound never takes channel gain or channel effects; a selected mixer still applies `globalGain`.
- Channel with no mixer: non-gain effects/routing may resolve; no invented channel/master gain.
- Set Channel / Set Global **replace** session values (do not edit assets). Play stop / scene change reloads mixer defaults. Without a selected mixer, or with a channel absent from the mixer table, the nodes warn (`audio.no_mixer` / `audio.unknown_channel`) and no-op. A channel that exists only in the library is not enough.

## Commands

Worker → main (ordered). Main thread resolves Audio / Mixer / Channel / Attenuation from the Play audio library (same pattern as `textureBytes`).

```ts
| { type: "playSound"; assetGuid: string; volume: number; frameId: number;
    emitterActorGuid?: string | null; loop?: boolean; voiceId?: string }
| { type: "stopSound"; voiceId: string }
| { type: "setChannelVolume"; channelGuid: string; volume: number }
| { type: "setGlobalVolume"; volume: number }
```

`AudioComponent` properties: `audioAssetGuid`, `playOnStart`, `loop`, `volume` (`playCallVolume`). Play-on-start emits `playSound` with `emitterActorGuid` = the owning actor. Graph **Play Sound** uses `self` as emitter. Missing Actor + attenuation → non-spatial + one diagnostic.

## Unlock and cache

First `pointerdown` / `touchstart` on overlay Play and the packaged player calls `audioService.unlockAsync()`. Commands before unlock enqueue (cap 32, ordered) and drain after the gesture. Overlay chrome shows **Click the game view to enable audio** (`play-audio-unlock-hint`) while `queued > 0` and still locked. Decode / missing-context → one diagnostic; the game keeps running.

`AudioBufferCache` is guid-keyed PCM with active-voice pins and a **64 MiB** LRU, separate from the ~512 MB texture `ResourceCache`. Max concurrent voices: 32.

## Spatial

Worker emits identity only (`emitterActorGuid` / `voiceId`). Main thread follows interpolated snapshot poses (same as mesh apply), including actor **quaternion** so cones orient. Listener is the active Play camera, once per rendered frame (position **and** orientation). No scene listener picker. Inner radius = full gain, max radius = silent, monotonic between — that curve lives in `computeAttenuationGain` (unit tests) and in Babylon AudioV2 `spatialMinDistance` / `spatialMaxDistance` on the real backend. `AudioService` must not pre-multiply the same falloff into `volume` or voices attenuate twice. Optional Doppler is authored on the asset; Web Audio removed PannerNode Doppler, so snapshot follow applies `playbackRate` from radial emitter velocity × `doppler.factor`. The render loop's later `syncListener` call must not rewrite that rate (dt would be 0). Sound Attenuation Details expose cone angles and Doppler next to radii/model/rolloff/spatialisation.

## Reverb bake

Mirrors nav bake: main-thread collect of **static** `MeshComponent` triangles (chunked, 8 actors per yield), worker occupancy + flood-fill + sparse probes, debounce 1_500 ms after the last static geometry edit, cancel, geometry-hash cache, timeout 8_000 ms. Dynamic rigid bodies do not invalidate.

Versioned Scene extra chunk `audioReverb` (magic `BSAR`, same extra-chunk pattern as `navmesh`). Save/export await the current result or write a marked dry fallback (`audio.reverb_bake_failed`); they never hang. Export packs a sidecar `type: "AudioReverb"`, guid `audioReverb:<sceneGuid>`. Packed Audio is a **BSAU** envelope (JSON payload + source bytes).

Channels with `environmentReverb.enabled` send to **one** shared delay/comb/all-pass bus (`AUDIO_REVERB_COMB_COUNT` = 4, `AUDIO_REVERB_ALLPASS_COUNT` = 2). Comb taps use feedback + damping; all-pass taps are Schroeder (delay + negative feedforward). Listener interpolates ≤2 probes. No per-voice convolver. Channel-less stays dry. Dry fallback → wet 0. AudioV2 keeps the bus→main dry route at unity; the parametric graph is an extra wet send (`dryPassThrough: false`). `setReverbWet` drives that wet gain. If the send cannot attach, wet falls back to scaling the whole bus volume. Do not `disconnect()` AudioV2 private `_outNode` / `_inNode` ports — that hung Play Stop.

## A16 budgets

Named constants in `packages/assets/src/audio-payload.ts`:

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

## Scripting and BT

`assetRef(assetType)` is a guid-string pin family (literal default; Inspector `AssetPicker` with `allowedTypes`). **Play Sound** / **Set Channel Volume** / **Set Global Volume** sit on Class and Actor palettes. BT **PlaySound** succeeds when the Audio guid is in the Play library and fails when missing. No Babylon imports in scripting / BT packages.

## Test hatch

Test-mode `window.__babylonslateAudioStats` (`audioStats` from `@babylonslate/render`) exposes `unlocked`, `queued`, `voices`, `lastGain`, `lastDistance`, `wet`, `accountedBytes` — same idea as `uiHostStats`. Playwright: `e2e/p16-audio.spec.ts`. Cross-package gain/unlock/reverb proofs: `packages/render/src/p16-acceptance.test.ts`.

## Out of P16

Streaming music, mic capture, authored acoustic zones/materials, runtime occlusion/ray tracing, waveform editing, DSP plugins, IR convolution, converting Texture/Model/Audio `asset-settings` to DockView, P17 idle-unmount, BT RotateToFace / PlayAnimation (P18).

See [render.md](render.md), [bridge.md](bridge.md), [scripting.md](scripting.md), [exporter.md](exporter.md). Spec: [engineplan.md](../engineplan.md) §2.6.
