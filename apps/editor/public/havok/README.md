# Self-hosted Havok wasm

Vendored `@babylonjs/havok` `HavokPhysics.wasm` (never a CDN). Play posts this
URL on the worker `load` control message so `HavokPhysics({ locateFile })` can
feed `HavokPlugin` on the worker-local NullEngine Scene.

| File | Role |
| --- | --- |
| `HavokPhysics.wasm` | Havok Physics wasm binary (`@babylonjs/havok` 1.3.14) |

Copied from `node_modules/@babylonjs/havok/lib/esm/HavokPhysics.wasm`.
The editor serves it at `/havok/HavokPhysics.wasm`.
