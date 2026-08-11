# Self-hosted KTX2 transcoder

Place Babylon `KhronosTextureContainer2` decoder assets here for offline use:

- `babylon.ktx2Decoder.js`
- `uastc_astc.wasm`
- `uastc_bc7.wasm`
- `zstddec.wasm`

Configured via `@babylonslate/render` `configureKtx2Transcoder` — never a CDN.
Placeholder `.keep` files let the directory ship in git until binaries are vendored.
