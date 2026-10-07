# Self-hosted meshopt glTF decoder

Vendored Babylon meshopt decoder (never a CDN). `EXT_meshopt_compression`
GLBs decode through this URL.

| File | Role |
| --- | --- |
| `meshopt_decoder.js` | `MeshoptCompression.Configuration.decoder.url` |

Copied from `https://cdn.babylonjs.com/meshopt_decoder.js` (Babylon 9.20).
The editor serves it at `/meshopt/meshopt_decoder.js`.

## Provenance

| File | Upstream | SHA-256 |
| --- | --- | --- |
| `meshopt_decoder.js` | [zeux/meshoptimizer](https://github.com/zeux/meshoptimizer) `js/meshopt_decoder.js` at commit `9a13852db4212cdd21338513804a033ee71c2a51` (2024-01-31, after `v0.20`, before `v0.21`; header says "Built from meshoptimizer 0.20") | `a706bbac4cfbea66798936a2c35d1036f594fec955514508e9c14ec329f020fd` |

Verified 2026-10-07: the file is that commit's blob
(`1ddd6578557cd39cedb3aa71e631b03e3c922a48`, unchanged upstream until
2024-05-23) with its final newline removed, as Babylon's CDN serves it. The
npm `meshoptimizer@0.20.0` copy differs only in the copyright year and that
newline. A byte match with the Babylon CDN copy is **unverified** (the CDN was
not reachable from the checking session). This decoder is independent of the
workspace `meshoptimizer` dependency (`@babylonslate/render` Model LOD
simplifier).

## Refresh

1. Download `meshopt_decoder.js` from the Babylon CDN for the `@babylonjs/core`
   version in use (Babylon's `MeshoptCompression` expects its global
   `MeshoptDecoder` build).
2. Find the matching upstream commit: `git hash-object` of the file plus a
   trailing newline should equal a `js/meshopt_decoder.js` blob in
   zeux/meshoptimizer history.
3. Update the commit, blob and `sha256sum` values in this file.
