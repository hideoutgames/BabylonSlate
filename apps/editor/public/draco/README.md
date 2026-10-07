# Self-hosted Draco glTF decoder

Vendored Babylon glTF Draco decoder files (never a CDN). Marketplace GLBs
(`KHR_draco_mesh_compression`) decode through these URLs.

| File | Role |
| --- | --- |
| `draco_wasm_wrapper_gltf.js` | Wasm glue (`DracoDecoder.DefaultConfiguration.wasmUrl`) |
| `draco_decoder_gltf.wasm` | Decoder wasm (`wasmBinaryUrl`) |
| `draco_decoder_gltf.js` | JS fallback (`fallbackUrl`) |

Copied from `https://cdn.babylonjs.com/draco_*_gltf.*` (Babylon 9.20; the decoder configuration is unchanged through 9.29).
The editor serves them at `/draco/`.

## Provenance

Upstream is [google/draco](https://github.com/google/draco) **1.5.6** (tag
`1.5.6`, commit `9f856abaafb4b39f1f013763ff061522e0261c6f`, 2023-02-07), path
`javascript/`. Babylon's CDN serves those builds with a global-export patch.
Checked 2026-10-07 against the upstream tag; a byte match with the Babylon CDN
copy is **unverified** (the CDN was not reachable from the checking session).

| File | Relation to upstream `javascript/<file>` at 1.5.6 | SHA-256 |
| --- | --- | --- |
| `draco_decoder_gltf.wasm` | Byte-identical (also `draco3dgltf@1.5.6` npm `package/draco_decoder_gltf.wasm`) | `a680d927bed9cb864ddbd63521868891af2bfbe755092761b4837487618df8ac` |
| `draco_decoder_gltf.js` | Upstream bytes plus an appended `else` branch that assigns `DracoDecoderModule` to `self`/`global`/`this` | `7708de68a2a2476befe1d5c19fa750a1911ae9c8d90ed2dcf116887a30b7ff7f` |
| `draco_wasm_wrapper_gltf.js` | Upstream except the final export statement, which also assigns `DracoDecoderModule` to `self`/`global`/`this` | `81f4b0efec08cdc233595c5a35a45c4591611b23aa15882f3a0c648af2d2bf49` |

## Refresh

1. Download the three files from the Babylon CDN for the `@babylonjs/core`
   version in use, so the JS keeps Babylon's global-export patch.
2. Identify the Draco release: compare `draco_decoder_gltf.wasm` with
   `javascript/draco_decoder_gltf.wasm` in google/draco tags (or
   `npm pack draco3dgltf@<version>`), and diff the two JS files against the
   same tag to confirm only the export patch differs.
3. Update the version, commit and `sha256sum` values in this file.
