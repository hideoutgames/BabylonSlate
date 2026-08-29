# Self-hosted Draco glTF decoder

Vendored Babylon glTF Draco decoder files (never a CDN). Marketplace GLBs
(`KHR_draco_mesh_compression`) decode through these URLs.

| File | Role |
| --- | --- |
| `draco_wasm_wrapper_gltf.js` | Wasm glue (`DracoDecoder.DefaultConfiguration.wasmUrl`) |
| `draco_decoder_gltf.wasm` | Decoder wasm (`wasmBinaryUrl`) |
| `draco_decoder_gltf.js` | JS fallback (`fallbackUrl`) |

Copied from `https://cdn.babylonjs.com/draco_*_gltf.*` (Babylon 9.20).
The editor serves them at `/draco/`.
