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

## Provenance

Every file is byte-identical (SHA-256) to the npm release **9.29.0**, matching
`@babylonjs/core` 9.29.0 (verified 2026-10-07). Only `babylon.ktx2Decoder.js`
changed between 9.20.0 and 9.29.0; the transcoder and `.wasm` files are identical.

| File | Source (npm tarball path) | SHA-256 |
| --- | --- | --- |
| `babylon.ktx2Decoder.js` | `babylonjs-ktx2decoder@9.29.0` `package/babylon.ktx2Decoder.js` | `789882a6e94808db692a6228cdbc18af730185ce50b96b8d92345f52612a3abd` |
| `msc_basis_transcoder.js` | `@babylonjs/ktx2decoder@9.29.0` `package/wasm/msc_basis_transcoder.js` | `b8906bae7e55606aba070642eb3bce790a2b5aea774874e120e9fd41f7c7d60b` |
| `msc_basis_transcoder.wasm` | `@babylonjs/ktx2decoder@9.29.0` `package/wasm/msc_basis_transcoder.wasm` | `29becbf0eef2ce9f6d72109ad217704ec3799c432da0c26e3893b793ecab6bdc` |
| `uastc_astc.wasm` | `@babylonjs/ktx2decoder@9.29.0` `package/wasm/uastc_astc.wasm` | `6846c972b4a52d938866f43896fd2b2450052da807cdd1285e898be80614d612` |
| `uastc_bc7.wasm` | `@babylonjs/ktx2decoder@9.29.0` `package/wasm/uastc_bc7.wasm` | `be442ab8c0cbf734ded98e6ad38112aaba23c83bfeecac4213ded54631fc4eef` |
| `uastc_r8_unorm.wasm` | `@babylonjs/ktx2decoder@9.29.0` `package/wasm/uastc_r8_unorm.wasm` | `0467c98b150a630e5a51f7810843e8b7fd9aad22e3888baf70aad255c55d02bc` |
| `uastc_rg8_unorm.wasm` | `@babylonjs/ktx2decoder@9.29.0` `package/wasm/uastc_rg8_unorm.wasm` | `fb45a2c103c59cec21c3708a6534d43cd4381669f66d3292dd8a6e4e1956d773` |
| `uastc_rgba8_srgb_v2.wasm` | `@babylonjs/ktx2decoder@9.29.0` `package/wasm/uastc_rgba8_srgb_v2.wasm` | `1f4d2e8bfef4e31679b23d473e1c410c29f7e485a739e76c5b357628f4190874` |
| `uastc_rgba8_unorm_v2.wasm` | `@babylonjs/ktx2decoder@9.29.0` `package/wasm/uastc_rgba8_unorm_v2.wasm` | `b7470b26a847994cdeb9226eeba1e3711688e378ee438b7dd941e83cb598b694` |
| `zstddec.wasm` | `@babylonjs/ktx2decoder@9.29.0` `package/wasm/zstddec.wasm` | `67d12d34f82ef700ec3a3795a77590252858c70330908a87ed1e73efc268cb4b` |

## Refresh

Neither package is a workspace dependency; fetch the release matching
`@babylonjs/core`. Both tarballs are named `babylonjs-ktx2decoder-<version>.tgz`,
so pack them into separate directories of a scratch directory outside the
repository (`DEST` is this directory's absolute path):

```sh
mkdir umd esm
(cd umd && npm pack babylonjs-ktx2decoder@<version> && tar xzf *.tgz)
(cd esm && npm pack @babylonjs/ktx2decoder@<version> && tar xzf *.tgz)
cp umd/package/babylon.ktx2Decoder.js "$DEST"/
cp esm/package/wasm/msc_basis_transcoder.js esm/package/wasm/*.wasm "$DEST"/
sha256sum "$DEST"/*.js "$DEST"/*.wasm
```

Copy only the files listed above (`KTX2_TRANSCODER_RELATIVE_FILES` in
`@babylonslate/assets`), then update the version and hashes in this file.
