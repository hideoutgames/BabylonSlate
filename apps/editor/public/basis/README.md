# Self-hosted Basis Universal encoder

Texture compression (source image → KTX2) for the editor's encode queue
(never a CDN). Decoding uses the separate transcoder under `/ktx2/`.

| File | Role |
| --- | --- |
| `encode-worker.js` | Classic worker: decodes and block-aligns the source, then Basis-encodes (`editorEncodeWorkerUrl()`) |
| `basis_encoder.js` / `.wasm` | Basis Universal encoder module loaded by the worker; Node tests load it through `createNodeBasisEncodeFn` |

## Provenance

| File | Upstream | SHA-256 |
| --- | --- | --- |
| `basis_encoder.js` | [BinomialLLC/basis_universal](https://github.com/BinomialLLC/basis_universal) tag `1.16.3` (commit `7a2094b807fcd8eb8e505d8c48a19b0690fd3404`, 2022-02-24), `webgl/encoder/build/basis_encoder.js` | `30d31fc68388341a0c3ff9fc2bbe75702c03285f3cd72e2e70b27016740837ec` |
| `basis_encoder.wasm` | Same tag, `webgl/encoder/build/basis_encoder.wasm` | `62ce0364ea8f4969e1e4277ce275213dcce5b234c8c96586da06e3879010341c` |
| `encode-worker.js` | Project-authored; mirrors `textureEncodeSize` in `@babylonslate/assets` | — |

Both encoder files are byte-identical to the upstream tag.

## Refresh

1. Download `basis_encoder.js` and `basis_encoder.wasm` from
   `webgl/encoder/build/` at the chosen basis_universal tag and check them with
   `sha256sum`.
2. Check that the worker's encoder API use (`BASIS` module init and
   `BasisEncoder`) still matches, then run `apps/editor/src/lib/encode-worker.test.ts`
   and `packages/assets/src/a16-encode-smoke.test.ts` (real encode).
3. Update the tag, commit and hashes in this file.
