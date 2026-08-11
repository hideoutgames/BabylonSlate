# Self-hosted KTX2 transcoder

Vendored Babylon `KhronosTextureContainer2` decoder assets (never a CDN):

| File | Role |
| --- | --- |
| `babylon.ktx2Decoder.js` | Decoder bootstrap |
| `msc_basis_transcoder.js` / `.wasm` | MSC Basis transcoder |
| `uastc_astc.wasm` | UASTC → ASTC |
| `uastc_bc7.wasm` | UASTC → BC7 |
| `zstddec.wasm` | Zstd supercompression |

Configured via `@babylonslate/render` `configureKtx2Transcoder` in `createEngine`.
Encode uses a separate Basis encoder under `/basis/` (`encode-worker.js`).
