# Self-hosted Havok wasm

Vendored `@babylonjs/havok` `HavokPhysics.wasm` (never a CDN). Play posts this
URL on the worker `load` control message so `HavokPhysics({ locateFile })` can
feed `HavokPlugin` on the worker-local NullEngine Scene.

| File | Role |
| --- | --- |
| `HavokPhysics.wasm` | Havok Physics wasm binary (`@babylonjs/havok` 1.3.14) |

Copied from `node_modules/@babylonjs/havok/lib/esm/HavokPhysics.wasm`.
The editor serves it at `/havok/HavokPhysics.wasm`.

## Provenance

| File | Source | SHA-256 |
| --- | --- | --- |
| `HavokPhysics.wasm` | npm `@babylonjs/havok@1.3.14` `lib/esm/HavokPhysics.wasm` | `026917766f534c156286f07975850978dabf17c42e742bbfaaebbcb2215e4e11` |

Byte-identical to the installed workspace dependency (verified 2026-10-07).
To refresh, bump `@babylonjs/havok`, copy the file from `node_modules` again,
and update the version and `sha256sum` value here.
