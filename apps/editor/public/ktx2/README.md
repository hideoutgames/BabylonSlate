# Self-hosted KTX2 transcoder

Vendored Babylon `KhronosTextureContainer2` decoder assets (never a CDN):

| File | Role |
| --- | --- |
| `babylon.ktx2Decoder.js` | Decoder bootstrap |
| `msc_basis_transcoder.js` / `.wasm` | MSC Basis transcoder |
| `uastc_astc.wasm` | UASTC → ASTC |
| `uastc_bc7.wasm` | UASTC → BC7 |
| `uastc_rgba8_unorm_v2.wasm` / `uastc_rgba8_srgb_v2.wasm` | UASTC → RGBA (GPUs without ASTC/BC7) |
| `uastc_r8_unorm.wasm` / `uastc_rg8_unorm.wasm` | UASTC → R8 / RG8 |
| `zstddec.wasm` | Zstd supercompression |

Configured via `@babylonslate/render` `configureKtx2Transcoder` in `createEngine`.
Encode uses a separate Basis encoder under `/basis/` (`encode-worker.js`).

Current files match `babylonjs-ktx2decoder@9.29.0` and `@babylonjs/ktx2decoder@9.29.0` (the transcoder and `.wasm` files are unchanged since 9.20.0).

To refresh, fetch the npm releases matching `@babylonjs/core` ad hoc (`npm pack`; neither is a workspace dependency):
`babylon.ktx2Decoder.js` from `babylonjs-ktx2decoder`, and `msc_basis_transcoder.js` plus the `.wasm` files from `wasm/` in `@babylonjs/ktx2decoder`.
