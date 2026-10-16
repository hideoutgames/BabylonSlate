# Audio

Imported Audio, mixer/channel routing, spatial attenuation, Play/player playback, baked environmental reverb and occupancy-grid wall muffling.

## Decisions

- One sound type: imported `Audio` (kind `audio`, `source` chunk). Mixer, channel and attenuation are optional user assets; with all refs at None, gain is `assetVolume × playCallVolume`.
- Runtime and graph packages only emit commands; playback lives on the main thread in `AudioService`. No Babylon or Web Audio imports in scripting, BT or runtime.
- Never auto-unlock at load. The first `pointerdown` / `touchstart` on the Play or player canvas unlocks; earlier commands queue (cap 32) and the overlay shows the unlock hint.
- Reverb is one shared parametric bus fed by baked probes; muffling is a DDA walk on the baked occupancy grid. Not triangle ray tracing, Recast or physics rays, and no per-voice convolver.
- Out of scope: streaming music, mic capture, acoustic zones/materials, triangle occlusion, waveform editing, DSP plugins, IR convolution.

## Ownership

| Package | Owns | Must not |
| --- | --- | --- |
| [`packages/assets/src/`](../../../packages/assets/src/) (`audio-payload.ts`, `audio-reverb.ts`, `audio-reverb-worker.ts`, `audio-waveform.ts`) | Payloads, normalizers, cycle checks, gain/attenuation math, budgets, `audioReverb` codec, occupancy bake | React, Babylon, Web Audio |
| [`packages/render/src/`](../../../packages/render/src/) (`audio-service.ts`, `audio-buffer-cache.ts`, `babylon-audio-backend.ts`, `parametric-reverb.ts`, `audio-lifecycle.ts`) | `AudioService`, PCM LRU, AudioV2 backend, listener/emitter follow, reverb bus | React, game worker |
| [`packages/bridge/src/`](../../../packages/bridge/src/) | Command types | Playback |
| [`packages/runtime/src/`](../../../packages/runtime/src/) | Emit commands, `AudioComponent` play-on-start/stop, BT Play Sound | Babylon, Web Audio |
| Editor / [`apps/player`](../../../apps/player/) | DockView editors, settings, unlock gesture, lazy clip loads | Direct Capacitor, per-host mixer |

Unit tests use `FakeAudioPlaybackBackend` (NullEngine cannot decode). Overlay Play and the player use the real AudioV2 backend.

## Formats

- **Audio**: `volume` 0..1 (1), `loop` (false), `audioChannelGuid` / `soundAttenuationGuid` (null), `clips` (default one `source` clip, cap 8; extra files are `source:<id>` chunks, not other Audio guids; `source` cannot be removed), `pitch` 0.25..4, `pitchRandom`, `pitchMin` / `pitchMax`. Old `{}` payloads normalize without rewriting.
- **AudioChannel** (`.channel.babasset`): no volume; `parentChannelGuid`, `effects` of `environmentReverb` / `muffleThroughWalls`. Keep both effect kinds when editing. Parent cycles fail validation; missing parents route to master.
- **AudioMixer** (`.mixer.babasset`): user asset, not a singleton; `globalVolume`, `channels: { channelGuid, volume }[]` (unique guids).
- **SoundAttenuation** (`.atten.babasset`): opts into 3D (`null` = non-spatial); radii, distance model, rolloff, spatialisation, optional cone and Doppler.
- Project Settings `audio`: `audioMixerGuid`, `occlusionEnabled`, reverb wet/decay/damping scales (0..2).
- Header `dependencies[]` list channel, attenuation, parent and mixer channels for references and delete guards.
- Scene `audioReverb` chunk: magic `BSAR`, v2 adds occupancy bitmap, ≤ 64 KiB. Export sidecar `audioReverb:<sceneGuid>`. Packed Audio uses a `BSAU` envelope.

## Gain and commands

- `outputGain = assetVolume × playCallVolume × channelGain × parentGains… × globalGain`, each clamped 0..1. Channel-less sounds never take channel gain or effects.
- Set Channel / Set Global Volume replace session values only and require a selected mixer containing the channel (`audio.no_mixer` / `audio.unknown_channel`). Stop or scene change reloads mixer defaults.
- Worker → main ([bridge.md](bridge.md)): `playSound`, `stopSound`, `setVoiceGain`, `setChannelVolume`, `setGlobalVolume`, `audioSimTime`. Main → worker: `audioVoiceEnded` for non-looping voices only → Event On Audio Finished.
- Loop when `command.loop` or `payload.loop`. Graph and BT Play Sound omit `loop`; `AudioComponent.loop` forces it. A looping voice is one Babylon voice; never retrigger it per tick.
- Voice ids: component guid (AudioComponent), `script:<n>` (graph Play Sound), `bt:${actor.guid}:${node.id}` (BT). Replaying an id stops the previous voice.
- `clipRoll` / `pitchRoll` come from a seeded per-session stream so traces replay the same clip and pitch. `startOffsetSeconds` / `restoredAtSeconds` are for trace restore only.
- There is no per-voice pause; AudioV2 pause is global and follows game pause.

## Spatial

- The worker sends identity only; the main thread follows applied snapshot poses (with quaternion for cones). Only emitters of live spatial voices are posed; with none, the render loop skips spatial sync.
- Listener = `scene.activeCamera` after snapshot apply. No listener picker or second listener actor.
- Distance falloff lives in AudioV2 `spatialMinDistance` / `spatialMaxDistance` (and `computeAttenuationGain` for tests). Never pre-multiply it into volume.
- Doppler is applied as `playbackRate` from radial velocity × factor, composed with pitch; a listener-only refresh must not rewrite it.

## Reverb bake

- Like nav bake: main-thread collect of static `MeshComponent` triangles (8 actors per yield), worker occupancy + flood fill + probes, 1,500 ms debounce, 8,000 ms timeout, geometry-hash cache.
- Background bakes never save authored edits; results for unsaved geometry stay staged in `ProjectService` until Save writes geometry and chunk together. A flush (Save, export) is never superseded.
- Save removes a stale reverb chunk when geometry changed without a matching result. Export packs only saved results; a reached Scene whose result could not be saved fails export.
- Do not `disconnect()` AudioV2 private `_outNode` / `_inNode` ports (it hung Play Stop); remove only the reverb graph's own edges.

## Budgets

Named constants in [`audio-payload.ts`](../../../packages/assets/src/audio-payload.ts): occupancy grid ≤ 24×24×16, voxel 2 units, 32 probes, 1 reverb bus with 4 comb / 2 all-pass taps, 32 queued pre-unlock commands, 256 MiB decoded PCM LRU (Engine Settings `audioByteCeiling`), 32 voices default (`audioMaxVoices`, 8–128), 8 clips per Audio. Muffle constants (700 Hz low-pass, saturates after 2 walls) live in [`audio-reverb.ts`](../../../packages/assets/src/audio-reverb.ts); 128 waveform bars in [`audio-waveform.ts`](../../../packages/assets/src/audio-waveform.ts).

## Preview and lifecycle

- Asset preview prefetches clip bytes on open and starts playback in the same turn as the Play click; WKWebView drops the gesture if Play awaits I/O.
- Play and previews share `attachAudioLifecycle`: user pause, hidden page, native inactivity and interruptions are independent pause sources; Babylon's automatic resume timer is disabled.
- Overlay Play and the player load Audio metadata at session start and clip chunks on first `playSound`.
