# Renderer qualification

## Current continuation status — 22 September 2026

Computer Use on build `6cc7cce3` reached OutlineComponent authoring in Chrome
153 on the NVIDIA RTX 2060 (effective WebGL2, DPR 1.5, 720×272 drawing buffer).
The magenta width-4 component was visible, but changing Project Settings to CEL
failed scene loading: the mask renderer rejected `engineDefaultMaterial:CEL`.
This is a **FAIL**, not completed Route A acceptance. The repair admits the
engine's native CEL adapter with its original hooks and retains StandardMaterial
coverage semantics. The two-API geometry fixture now includes default CEL and
CEL alpha-cutout silhouettes. At `1e64c251`, the three changed TypeScript files
passed scoped lint and the editor typecheck passed. Browser verification and a
hands-on rerun were pending at that checkpoint; the later results below supersede
that pending status. [Actual failed scene](../assets/renderer-qualification/2026-09-22-computer-use-cel/native-cel-load-failure.png).

At `0dc42902`, both geometry API cases (including native CEL coverage) and both
compiled Scalability Play cases passed. The eight selected area-light/export
cases produced seven passes and one failure: loose WebGPU settings export did
not present its first frame. The isolated `cfe71bbe` rerun reproduced that failure;
browser error messages were empty and the player had already stopped. Export
qualification now captures the existing session shutdown diagnostics through
the test-build handle, including failures that stop before boot completion.
The seven passes cover area-light authoring/history/reopen, both prepared-emission
exports, both native/graph receiver cases, packed WebGL2 settings export and the
separate injected WebGPU-failure fallback. They do not certify loose WebGPU output.

The isolated export call stack located a first-frame ordering defect: applying
resolution quality in `Scene.onBeforeRenderObservable` resized WebGPU attachments,
which synchronously emitted `beginFrame` and re-entered registered-view admission
while the scene's FrameGraph was installed. Quality application now precedes
shader/graph preparation and the host draw boundary. A focused host regression
models the native resize notification and requires actual 384×216 output before
presentation; the loose WebGPU export remains the integration acceptance case.

At `6688d680`, the four selected loading/output unit cases passed, followed by
all five selected browser cases: three standalone settings variants and both
Scalability Play APIs. Five changed files passed scoped lint; the scoped editor
typecheck passed. The initial unit attempt used NullEngine's fixed scale-1 getter;
its driver boundary was corrected to model native scale storage before this pass.
The browser cases verify 384×216 and 240×135 output, actual component pixels,
preserved effects after resizing, scene transitions, compiled settings/reset and
reload. These are effective WARP WebGL2/SwiftShader WebGPU functional results:
[WebGL2 output](../assets/renderer-qualification/2026-09-22-settings-repair/webgl2-standalone-final-diagnostics.json),
[WebGPU output](../assets/renderer-qualification/2026-09-22-settings-repair/webgpu-standalone-final-diagnostics.json),
[injected fallback](../assets/renderer-qualification/2026-09-22-settings-repair/fallback-standalone-final-diagnostics.json),
[WebGL2 graph](../assets/renderer-qualification/2026-09-22-settings-repair/webgl2-play-compiled-scalability.json),
[WebGPU graph](../assets/renderer-qualification/2026-09-22-settings-repair/webgpu-play-compiled-scalability.json),
[WebGPU CEL pixels](../assets/renderer-qualification/2026-09-22-settings-repair/webgpu-authored-cel.png).
The earlier loose-export failures remain historical failures, superseded for this
path by the repaired five-case run. Manual acceptance and hardware cost remain open.

### Computer Use Route A checkpoint on `6688d680`

The actual editor build loaded in Chrome 153 on Windows with effective WebGL2
through ANGLE/D3D11 on NVIDIA RTX 2060. DPR was 1.5; the viewport and drawing
buffer were both 720×272, scale 1, with dynamic resolution disabled. The served
artifact SHA-256 was `188d13502d7beb9d718b62665d62ea4cb4fb486fc1303565f9fb600ba15d1de1`.
This is hardware functional evidence, not a timing or physical-A16 result.

Normal inspector, outliner, history and pointer interactions produced these
**PASS** observations after presented frames:

- Native CEL reopened successfully after the earlier scene-load repair. Disabling
  the magenta width-4 component revealed the global dark outline after deselection
  ([global default](../assets/renderer-qualification/2026-09-22-computer-use-cel/global-revealed.png)).
- A duplicated actor retained independent green width-2 settings. An opaque box
  hid the strict magenta outline while editor selection survived
  ([fully hidden](../assets/renderer-qualification/2026-09-22-computer-use-cel/strict-hidden-selection.png)).
  Enabling Render Through Meshes exposed only the authored contribution
  ([through-mesh](../assets/renderer-qualification/2026-09-22-computer-use-cel/through-mesh-selection.png)).
- Removing that component preserved the other consumers
  ([survivors](../assets/renderer-qualification/2026-09-22-computer-use-cel/component-removed-survivors.png));
  undo/redo/undo restored its color, width and visibility setting. Separate actor
  deletion followed by undo/redo/undo restored the neighboring actor.
- Saving and reopening retained magenta width 4 and green width 2 with strict
  visibility. Moving the occluder to X=1.4 exposed only the visible magenta edge
  ([partial occlusion](../assets/renderer-qualification/2026-09-22-computer-use-cel/partial-occlusion.png)).
  Pointer orbit changed the visible outlines around the opaque blocker
  ([orbit](../assets/renderer-qualification/2026-09-22-computer-use-cel/orbit-occlusion.png)).

Selecting WebGPU in Project Settings recreated the engine. The renderer confirmed
native **WebGPU / NVIDIA / turing**, forward, at the same dimensions and scale
([diagnostics](../assets/renderer-qualification/2026-09-22-computer-use-cel/webgpu-diagnostics.json)).
The same pointer/inspector route passed
[adjoining silhouettes](../assets/renderer-qualification/2026-09-22-computer-use-cel/webgpu-adjoining.png),
[strict hidden geometry with selection](../assets/renderer-qualification/2026-09-22-computer-use-cel/webgpu-strict-hidden.png),
[intentional through-mesh](../assets/renderer-qualification/2026-09-22-computer-use-cel/webgpu-through-mesh.png)
and [survivors after component removal](../assets/renderer-qualification/2026-09-22-computer-use-cel/webgpu-survivors.png).
Disabling both components, deselecting, then disabling global outlines removed
the visible silhouettes. The settled ledger contained only the existing 65,536
area-light bytes; depth and postprocess were zero, with zero pending bytes
([disabled pixels](../assets/renderer-qualification/2026-09-22-computer-use-cel/webgpu-disabled.png),
[retirement diagnostics](../assets/renderer-qualification/2026-09-22-computer-use-cel/webgpu-disabled-diagnostics.json)).
Direct GPU timing was unsupported on this WebGPU adapter. Individual diagnostic
CPU samples are not a controlled performance comparison.

This compact primitive route does not replace the automated shared-instance,
animation/material/LOD matrix. The remaining texture-preparation and Class Graph
routes, independent output acceptance and hardware cost remain open. Retrying
normal Texture import in Chrome still failed at `fileChooser.setFiles` with
`Not allowed`; no Texture preparation pass is claimed. The PR is unmerged.

The normal Class editor was used to add and wire Begin Play → Set Scalability
Preset (Low) → Set Render Scale (0.8), compile without diagnostics, save, and
place the Class through Add Actor → Project. Play on native WebGPU changed the
actual buffer from 1280×527 to 1024×421; stopping left Save All disabled. This
qualifies this authored chain, not the still-pending manual changed-event,
effective-readback and reset chain:
[saved graph](../assets/renderer-qualification/2026-09-22-computer-use-cel/scalability-authored-chain.png),
[presented output](../assets/renderer-qualification/2026-09-22-computer-use-cel/scalability-authored-play.png).

The authorized T3 fallback uses Chromium 150 on the same RTX 2060 through
ANGLE/D3D11. Its first hardware cost run failed with Scene rendering preparation
timed out; no complete timing report was returned. The fixture now retains
phase, completed samples and failure diagnostics in a DOM progress record so
the failure can be reproduced without losing its location. This remains a FAIL,
not desktop performance qualification.

The local `perf-gpu` project also admits the explicit shared-outline cost file.
Its full Chromium/D3D11 launch options are preserved locally; CI still selects
software WebGPU. Reproduce with `BL_TEST_PROFILE=shared` and
`pnpm --silent agent:wait local --script test:e2e -- e2e/shared-outline-cost.spec.ts --config playwright.perf.config.ts --project perf-gpu`.
The first T3 failure does not certify this separate host. After selection cleanup,
`afff8b31` passed the shared-host and overlay-transform files (35 tests), six-file
lint, the render-package typecheck and the admitted editor/player build.

At `f59c85ad`, native-GPU cost qualification produced **one PASS, one FAIL**.
[WebGPU](../assets/renderer-qualification/2026-09-22-hardware-cost/webgpu.json)
confirmed NVIDIA/turing, fixed 640×360 scale 1, all 12 consumer/count comparisons
and eight retirement cycles. At 192 instances the CPU median/p95 was 1.095/1.370 ms
off, 2.310/2.880 ms all, and 0.790/1.020 ms off-restored. This run shows ordering
and warmup variance; it is not a causal speedup claim. All consumers used four
drawing passes/seven records, 5,543,552 accounted bytes, and returned to zero
after deactivation. WebGPU direct GPU timings were unavailable. Cadence near
16.9 ms does not establish headroom. The primitive fixture excludes editor gizmo
cost and cannot establish A16 behavior.

[WebGL2](../assets/renderer-qualification/2026-09-22-hardware-cost/webgl2-failure.json)
confirmed RTX 2060/D3D11 but timed out preparing the first global contribution
at 12 instances, before mask submission. Its off-only sample is not an outline
cost comparison. The next diagnostic revision records native shader compilation
state and console errors to distinguish compiler failure from pending readiness.

The diagnostic rerun at `83765fee` reproduced the WebGL2 deadline with no shader
console error; the surviving native world and mask Effects were ready. Composition
now samples explicit mip level zero, matching WGSL and the unmipped mask/style/depth
targets. This removes implicit texture derivatives from the bounded branch/loop
sampling without changing filtering or identity/depth precision. The native
WebGL2 cost case and survivor-pixel cases must pass before this is accepted as
the driver-path repair; the original readiness deadline is unchanged.
The `b3956b34` native WebGL2 rerun still timed out at the same step, so explicit
LOD alone is not a demonstrated repair. A preparation-only diagnostic probe now
retains each pending task and outline subpass readiness before retirement removes
the failed graph. It does not draw or run inside measured steady-state samples.
At `36532517` this narrowed the failure to the strict geometry mask: composition
and all preceding FrameGraph tasks were ready. Per-submesh diagnostic records
are retained by the next probe; no composition repair is claimed from this result.
The next probe located the first regular instance's repeatedly unready mask
program. Its submesh belongs to the instance while its rendering mesh is the
shared source. Pruning incorrectly tested membership in the source's submesh
array, retiring a live pending program on every readiness probe. Cleanup now
checks the owning mesh's membership and both mesh lifetimes. A focused regression
holds native shader readiness pending across pruning, then releases the program
with its instance. The temporary task probe and ineffective composition LOD
experiment were removed before verifying the ownership repair.

Latest integration checkpoint: normal merge `106abcaf` incorporates main
`93638dde`, retaining both catalog search aliases and Scalability descriptions
through the shared result row. At `3bc0146b`, the scoped editor typecheck passed
and the two explicit files `packages/graph-ui/src/node-palette.test.tsx` and
`packages/render/src/shared-outline-material.test.ts` passed 23 tests. Eight
selected catalog/cost-fixture files passed lint at `106abcaf`; the subsequent
cost-fixture instrumentation import repair was included in the passing editor
typecheck. Earlier rendering results below remain scoped to their revisions.

Build/browser admission initially required 4 GiB including the retained 2 GiB
reserve while free memory ranged from roughly 3.2 to 3.9 GiB. Queued attempts
were withdrawn when they blocked smaller work; no other agent's processes were
stopped. Capacity later admitted the `6cc7cce3` editor/player build and four
browser cases: **three passed, one failed**. Both geometry APIs passed; the
WebGL2 cost/lifecycle case passed on default SwiftShader; the default WebGPU
cost case could not obtain an adapter. The import repair also passed scoped lint
at this revision. Hands-on acceptance, real-GPU cost, export/settings acceptance
and required current-head CI remain pending. PR #651 remains draft and unmerged.

The shared renderer, editor selection host, authored OutlineComponent, default CEL
outlines, typed settings/Graph controls and runtime/export wiring are implemented
on PR #651 but **not accepted**. Earlier tables below describe their recorded
revisions, not the current implementation. Following the two-API ownership and
geometry fixtures and the native WebGL2/WebGPU manual survivor checks, the old
selection renderer and its implementation-specific tests are retired. The shared
host retains a triangle-versus-line/wireframe regression; editor overlay styling
remains unchanged. This does not complete the outstanding delivery routes.

| Requirement | Latest evidence | Remaining |
| --- | --- | --- |
| Shared ownership and pixels | `b05d4467`: both API cases passed all 43 presented states after repairing regular-instance readiness; software adapters | Hands-on acceptance and current integrated geometry qualification |
| Materials, animation, LOD | `6cc7cce3`: both geometry cases passed on effective software WebGL2/WebGPU after the readiness and morph-data repairs; 18 readiness unit cases passed `19fea64c` | Hands-on authoring and integrated export acceptance |
| Authored/UI/settings | `531e7039`: five explicit UI files, 93 passes; `5308c759`: 75 passes across 11 unchanged core/runtime/render files | Hands-on authoring/history/reopen and new standalone export pixels |
| Owner/runtime/Class regressions | `eea6009e`: four shared-owner cases and one Class inheritance case passed; failed parent/child lifecycle repaired and passed at `531e7039` | Browser authoring and runtime lifecycle acceptance |
| Main integration | Normal merge retains snapshot membership/pose separation and rendering bindings; `ec1926c1`: two snapshot files, 67 passes; `bf2dc011`: eight selected outline/area-light cases passed | Current affected browser and CI gates |
| Static checks | Scoped editor typecheck passed `3bc0146b`; editor/player build and final cost-fixture lint passed `6cc7cce3`; prior scoped checks remain revision-scoped | Required current-head CI |
| Computer Use | Chrome connected; retained parented/scaled area-light Play/save/reopen captures below are from `90267c2b` | Routes A/C and remainder of B on the completed build; texture import permission remains unresolved |
| Cost/device | Previous shadow evidence retained; no new outline hardware cost claim | Fixed-quality desktop comparison and bounded lifecycle exercise; physical A16 remains deferred |
| Delivery | Existing branch and draft PR #651 remain unmerged | Complete acceptance, review and exact-head required CI before guarded merge |

The `b205b472` browser run used WARP WebGL2 and SwiftShader WebGPU, both software
renderers. Its evidence is retained as failures, not hardware timing or release
acceptance: [WebGL ownership](../assets/renderer-qualification/2026-09-22-generalized-outline-failures/ownership-webgl2.json),
[WebGPU ownership](../assets/renderer-qualification/2026-09-22-generalized-outline-failures/ownership-webgpu.json),
[WebGL geometry](../assets/renderer-qualification/2026-09-22-generalized-outline-failures/geometry-webgl2.json),
[WebGPU geometry](../assets/renderer-qualification/2026-09-22-generalized-outline-failures/geometry-webgpu.json).
The [native reference](../assets/renderer-qualification/2026-09-22-generalized-outline-failures/geometry-webgl2-position-and-color-morph-native.png)
and [outlined frame](../assets/renderer-qualification/2026-09-22-generalized-outline-failures/geometry-webgl2-position-and-color-morph-outlined.png)
show why direct fixture edits must revalidate readiness before capture.

The later `b05d4467` production ownership run passed on effective WARP WebGL2
and SwiftShader WebGPU: independently removable consumers, membership order,
same-instance overlap, strict occlusion, high identities, 48 styles, resizing,
unchanged requests and all-disabled retirement. These are automated functional
results, not Computer Use acceptance or representative hardware cost:
[WebGL2 diagnostics](../assets/renderer-qualification/2026-09-22-shared-ownership/ownership-webgl2.json),
[WebGPU diagnostics](../assets/renderer-qualification/2026-09-22-shared-ownership/ownership-webgpu.json),
[WebGL2 presented instances](../assets/renderer-qualification/2026-09-22-shared-ownership/ownership-webgl2-three-disjoint-instances.png),
[WebGPU presented instances](../assets/renderer-qualification/2026-09-22-shared-ownership/ownership-webgpu-three-disjoint-instances.png).
Its two geometry failures remain failures. The subsequent readiness repair
synchronizes Babylon's lazy texture matrices and active morph influences before
strict readiness probes. The later `6cc7cce3` rerun passed both geometry cases:
[WebGL2 geometry](../assets/renderer-qualification/2026-09-22-geometry-and-cost/webgl2-shared-outline-geometry-qualification.json),
[WebGPU geometry](../assets/renderer-qualification/2026-09-22-geometry-and-cost/webgpu-shared-outline-geometry-qualification.json).
The actual [native morph frame](../assets/renderer-qualification/2026-09-22-geometry-and-cost/webgl2-position-and-color-morph-native.png)
and [outlined morph frame](../assets/renderer-qualification/2026-09-22-geometry-and-cost/webgl2-position-and-color-morph-outlined.png)
were visually compared: both now show the moved receiver with a matching outline.

At `19fea64c`, `packages/render/src/scene-perf.test.ts` passed all 18 cases,
including PBR/Standard lazy morph activation and requested hot-swap behavior.
The earlier four-case selection is a subset, not four additional tests.
The two geometry browser cases queued without admission for almost six minutes
and were cancelled without execution. Available memory remained below the
4 GiB build/browser-plus-reserve requirement; smaller checks were admitted.

The host reserve remains **2 GiB**, explicitly confirmed by the user. All runs
use shared admission and one worker. One browser attempt was cancelled during
the transition from queue to build; its verified owned process tree was stopped
and its retained ticket removed only after confirming no descendants remained.
That attempt and the following blocked invocation are not passes.

## Production outline qualification gate

The focused `e2e/shared-outline-cost.spec.ts` fixture records a fixed 640×360
output at scale 1, 12/192 shared-source actors, each consumer separately and all
consumers together, then repeated membership/resize retirement. It uses the
available local adapter without forcing software and records its actual identity;
hosted CI forces the existing software adapters for functional lifetime checks only.
It separates synchronous CPU work, optional whole-engine WebGL GPU queries,
presentation cadence and an explicitly estimated geometry upper bound. Stable
uploads and zero retired outline allocations are asserted; no frame-rate budget
or hardware performance pass is inferred. At `6cc7cce3`, its WebGL2 case passed
on SwiftShader (no GPU timer samples); default WebGPU failed adapter acquisition.
The [functional cost/lifecycle report](../assets/renderer-qualification/2026-09-22-geometry-and-cost/webgl2-shared-outline-cost.json)
records 1→5 total draw calls and 0→4 outline drawing passes for off→all consumers,
about 5.53–5.54 MB accounted allocations when active and zero after retirement.
Software cadence slowed from roughly 16.7 ms to 50 ms with all consumers; this
is not a real-GPU or A16 cost claim. Hands-on gizmo, scene-transition and Play
lifecycle acceptance remain separate.

### Runtime ownership repair — 22 September 2026

The targeted run at `eea6009e` passed the four shared-owner cases and the
compiled Class inheritance case, but failed the runtime parent/child lifecycle
case. Foreign actor subtrees are now excluded before identifying hidden model
placeholders, so attaching a child actor cannot remove the parent's own outline.
The runtime lifecycle case and scoped render typecheck passed at `531e7039`.
Five selected UI files passed 93 cases at the same revision. The editor/player
build passed at `b205b472`; its four selected browser cases produced one pass
(WebGPU ownership) and three failures (WebGL2 instance pixels; both LOD fixture
references). Generalized browser and manual acceptance remain pending. The machine-wide host reserve stays at the user-confirmed 2 GiB.

The September 2026 rendering handoff starts from `ce1162f25cbac930be4789789de6269856e1eb58` (reviewed baseline `bc110765198020d6d9a14a0a67ee357a18148080` plus the WebGPU optional vertex-stream fix). Babylon remains pinned to 9.20.0 with the existing repository patch. The production mesh-outline selection implementation remains in place while the native replacement is qualified.

### Continuation checkpoint — 22 September 2026

Ownership resumed on the existing `zeron/babylonslate-rendering-handoff` branch
and [draft PR #651](https://github.com/hideoutgames/BabylonSlate/pull/651), with
clean inspected head `31fdadcf08399661be1bbcb5e290eb38441e226b`. Existing commits,
implementation and revision-scoped evidence are retained.

The continuation now authorizes a bounded-pass shared-outline extension if the
pinned failure is reproduced and no smaller native-compatible correction meets
the full contract. This is a new, narrow implementation authorization, not a
retroactive approval or acceptance of the previous design. It retains Babylon
9.20.0, existing FrameGraph/view ownership and the shared resource ledger. The
production selection replacement, OutlineComponent and default CEL outlines
remain unimplemented at this checkpoint; the authorization does not qualify them.

| Requirement | Retained evidence / implementation | Remaining requirement |
| --- | --- | --- |
| Coordinated outlines | Existing selection renderer retained; stock failure reproduced again below | Production shared owner, independent styles/membership, strict CEL occlusion, all three consumers, authoring/export/hydration and lifecycle qualification |
| Rectangular lights | Native/graph PBR/CEL receiver and transform cases; authored component, guides and shared resources | Hands-on dimension/color/intensity/gizmo route; asymmetric textured orientation and remaining supported receiver cases |
| Prepared emission and exports | Version 3 cancellable, validated processor; cached uploads; real packed/loose player lifecycle cases | Hands-on replace/clear/cancel/source-invalidation route; independent output acceptance with the completed outline system |
| Light authoring and inheritance | Automated discovery, preparation, history, duplicate/remove/reopen at `a523e5ee`; real compiler inheritance and independent spawn/despawn at `66f6291f` | Computer Use routes and additional parented/scaled textured authoring |
| Settings and Scalability | Saved Class compilation/Play events at `686dc574`; standalone retained setters at `562fe445`; requested/effective separation and session reset | Manual graph authoring and visible application; new outline fields; remaining per-field rendered checks (the settings fixture disables shadow casting) |
| Output size and effects | Actual 384×216 / 240×135 locked-output scaling and prepared FXAA resize regression at `96b2331a` | Preserve these checks through the new integration and manual routes |
| Performance and ownership | Shadow invalidation repair; equal-output RTX 2060 CPU comparison below | Equal-quality outline baseline/individual/all-consumer cost, bounded lifecycle and allocation retirement; no demonstrated GPU/A16 headroom |
| Hosts and release | Historical desktop software-API functional coverage | Computer Use acceptance, current-head required CI/reviews and merge; physical A16 qualification remains **DEFERRED** |

The selected immediate verification scope was only
`e2e/native-outline-qualification.spec.ts`, through the admitted shared runner
with one worker. Both harness cases passed at the clean inspected head in
7.5 seconds, reproducing the limitation at 128×96: WARP WebGL2 retained
204 → 204 → 204 CEL red pixels, while effective SwiftShader WebGPU produced
204 → 204 → 0. Clearing the component removed the shared instance-selection
buffer on both APIs. These are two successful **stock-limitation reproductions**,
not production outline acceptance or hardware timing results.

The fresh stock attachments are retained in the repository:
[WebGL2 diagnostics](../assets/renderer-qualification/2026-09-22-stock/webgl2.json),
[WebGPU diagnostics](../assets/renderer-qualification/2026-09-22-stock/webgpu.json),
and the presented states for each API:
[WebGL2 initial](../assets/renderer-qualification/2026-09-22-stock/webgl2-1.png),
[all consumers](../assets/renderer-qualification/2026-09-22-stock/webgl2-2.png),
[component cleared](../assets/renderer-qualification/2026-09-22-stock/webgl2-3.png);
[WebGPU initial](../assets/renderer-qualification/2026-09-22-stock/webgpu-1.png),
[all consumers](../assets/renderer-qualification/2026-09-22-stock/webgpu-2.png),
[component cleared](../assets/renderer-qualification/2026-09-22-stock/webgpu-3.png).
The latter two WebGPU captures were visually compared: the component removal
also loses the unchanged global CEL red outline, while the independent green
selection remains. The images are actual fixture attachments, not regenerated
illustrations or production acceptance.

Retained artifacts are available under the OS temporary
`BabylonSlate-rendering-handoff-evidence` directory: native/settings PNG and JSON
captures, `area-2c788764`, and `perf-before-1f2768d2` / `perf-after-a909bff9`.
Their images and profiles were enumerated but not inspected during this
checkpoint. Machine-local availability alone is not durable handoff evidence;
portable fixtures remain in `e2e/`, and this document records their provenance.

Computer Use was attempted immediately. `cua.getState()` returned no enabled
surfaces, and `cua.createBrowserTab` for both `iab` and `chrome` returned
`Browser is not available`. The user-authorized T3 browser was then opened
to a blank tab; no acceptance was performed there. After the user opened Chrome,
a repeated `cua.getState()` found the Chrome extension and
`cua.createBrowserTab` succeeded. A working Chrome Computer Use session is now
established. Build/API qualification and all hands-on routes remain **PENDING**
at this checkpoint. Automated fixtures do not establish a Computer Use pass.

Initial Computer Use authoring used the retained application inputs validated at
`31fdadcf` (artifact key `9543eab34dc8365e1c59ee0b5d7eee9abed340f468d75c575e8c153caeb4c5b9`,
original build metadata `a909bff9`; the intervening changes were documentation).
Chrome's native page log confirms Babylon 9.20.0 / WebGL2. The presented viewport
was 720×272 CSS and drawing-buffer pixels at browser DPR 1.5; adapter identity
has not yet been collected for this manual session. The test project was created
through Homepage. Ground, a box and an emitter were added through Place Actors;
Add Component exposed the explicit unshadowed/through-walls limitation. Inspector
edits retained width 3, height 2, orange `#ff8040`, and intensity 12. Pointer drags
changed emitter X from 0 to 1.85 and its stored rotation from (35,0,0) to
(63.34,180,180), with visible illumination and guides. Duplication retained those
light properties; Remove Component followed by Undo restored them; Save All
finished disabled with a clean scene tab. These individual steps passed.
[Actual gizmo capture](../assets/renderer-qualification/2026-09-22-computer-use/area-light-gizmo.png)
and [saved duplicate capture](../assets/renderer-qualification/2026-09-22-computer-use/area-light-duplicate-saved.png)
are retained. Route B as a whole remains **PENDING**: texture preparation,
asymmetric orientation, parenting, Play and reopen are not established by these
initial steps. Routes A/C and native WebGPU manual qualification also remain pending.

The next Computer Use segment ran the integrity-checked production artifact for
`90267c2bd41846e6924d54cf367fff51dd4b0057` (key
`5ed00cf36afd408b3c33a38fec982e640be153b44b47b75f8e3e85f8f9277875`).
It reopened the same project, parented Emitter Copy under Emitter using an
Outliner pointer drag, reset the child transform to position (0,1,0), rotation
(0,0,0), scale (1,1,1), and changed parent scale to (1.5,0.75,1). The parent light
component was disabled while its child remained enabled. Width 3, height 2,
orange color and intensity 12 persisted. Play presented illuminated floor/box
pixels without editor guides. Stop followed by application reload and normal
project reopen retained the parent/child hierarchy and child properties; Save All
remained disabled. These steps **PASS**, but do not qualify textured orientation.
Actual captures: [parented editor](../assets/renderer-qualification/2026-09-22-computer-use/area-light-parented-scaled.png),
[Play](../assets/renderer-qualification/2026-09-22-computer-use/area-light-parented-play.png),
[reopened child](../assets/renderer-qualification/2026-09-22-computer-use/area-light-parented-reopened.png).

Normal Content Browser Import opened a multiple-file chooser, but Computer Use
`setFiles` failed with Chrome's `Not allowed` error. The extension's **Allow
access to file URLs** permission was requested from the user. The ordinary
Texture/Prepare Emission, asymmetric orientation, replace/clear and cancellation
subroute is **BLOCKED** at this point; no automated substitute is counted as a
manual pass. Numeric source fixtures are retained in
`e2e/fixtures/area-emission-asymmetric.png` and `area-emission-swapped.png` for
reproduction once import is available. The manual session has not yet collected
the owning Engine adapter identity, so it establishes no hardware cost or native
WebGPU coverage. A pre-existing DockView context-menu enterprise-module console
error was observed; no rendering error was shown in this Play segment.

The user approved a machine-wide 1 GiB host reserve while retaining shared mode,
one heavy phase, bounded queue fairness and all source/artifact checks. Old-policy
queued jobs have cleared. Checks remain serialized and explicitly selected; this
resource adjustment does not convert queued, cancelled or stale work into passes.
The user subsequently retained a 2 GiB machine-wide reserve; the 1 GiB setting
above records the earlier run only. Subsequent verification will use the updated
host policy from `main` after normal integration.

Security scanning classified the historical evidence's `buildKey` SHA-256 values
as generic credentials. They identify public build artifacts, not access tokens.
The exception requires both one of the four exact stock/shared-outline JSON paths
and one of those two exact hashes. Future captures name the field `artifactSha256`;
other content and credential values remain scanned, including commit history.

The bounded candidate is now opt-in through the production Scene render
coordinator; its [design and limits](../architecture/render.md#shared-outline-candidate-22-september-2026)
describe ownership, formats and the four-draw/seven-record maximum. It has not
replaced editor selection or gained authored component/global controls. At
`ccf3c585`, four selected admission/coordinator unit cases and the render package
typecheck passed. These tests establish atomic rejection and explicit graph
ownership, not rendered acceptance. The candidate browser cases and changed-file
lint were queued, then cancelled before execution because shared memory
admission had not admitted them and review found repairs to make.

The next candidate revision fixes default-material masking, transfers every
per-pass DrawWrapper before retiring effects, preserves WebGPU buffer bindings
when invalidating cached draw bundles, and removes an unsafe fixed depth
tolerance. Its two-API pixel fixture now covers close partial occlusion,
default-material geometry, actual ObjectRenderer identities and disposal after
preparation before the first draw. These additions remain unverified until their
recorded run; successful stock-bug reproduction remains separate evidence.

### Shared production slice — 22 September 2026

At `90267c2bd41846e6924d54cf367fff51dd4b0057`, both selected cases in
`e2e/shared-outline.spec.ts` passed through the admitted shared runner with one
worker (12.5 seconds). Each case captured 43 presented states using the actual
Scene render coordinator. Windows 10.0.19045 / Chromium used WARP WebGL2 and
effective SwiftShader WebGPU, at 240×120 pixels, scale 1 and DPR 1 (three resize
cycles also used 320×160). These are software-adapter functional results; they
do not establish hardware cost, Computer Use acceptance or A16 headroom.

The production assertions require surviving pixels after removal of each
consumer, reversed membership/consumer order, overlapping consumers on one
instance, component/selection precedence, strict full/partial/close occlusion,
intentional through-mesh visibility, default-material meshes and exact IDs
2048/2049/65535. Identical requests and color/width edits retain ObjectRenderers,
textures and instance-upload counts. Forty-eight styles retain the same bounded
pass count. All disabled states return accounted targets/buffers to zero after
retirement, including a separate prepared-but-never-drawn scene. No page errors,
console errors or GPU/shader validation diagnostics were recorded.

Portable diagnostics include every measured state:
[WebGL2](../assets/renderer-qualification/2026-09-22-shared-outline/webgl2.json)
and [WebGPU](../assets/renderer-qualification/2026-09-22-shared-outline/webgpu.json).
The initial three-consumer captures
([WebGL2](../assets/renderer-qualification/2026-09-22-shared-outline/webgl2-three-disjoint-instances.png),
[WebGPU](../assets/renderer-qualification/2026-09-22-shared-outline/webgpu-three-disjoint-instances.png))
and strict/through overlap captures
([WebGL2](../assets/renderer-qualification/2026-09-22-shared-outline/webgl2-through-component-keeps-global-strict.png),
[WebGPU](../assets/renderer-qualification/2026-09-22-shared-outline/webgpu-through-component-keeps-global-strict.png))
were visually inspected and agree across APIs. Additional removal, overlap,
close-occluder, high-ID and disabled captures are retained beside those files.

Four selected ownership/coordinator unit cases passed at `c512b76d`; the render
package typecheck passed at `49c45f10`; the twelve changed TypeScript files passed
lint at `96fc594c`. The later package-export repair changed no production logic;
the successful browser build checked the editor/player consumers. An earlier
build failed on that missing export, and an earlier lint run failed on an unused
image binding; neither is counted as passing. The user authorized reducing the
machine-wide host reserve to 1 GiB while retaining shared mode, one heavy phase,
fair admission and source/environment/toolchain validation. Checks were serialized.

This satisfies the initial regular-mesh/instance vertical-slice gate only.
Generalized submaterial/animation/alpha coverage, authored products, runtime
and export integration, hands-on routes and measured desktop cost remain open.

`e2e/native-outline-qualification.spec.ts` runs the stock `FrameGraphSelectionOutlineLayerTask` with disjoint CEL/component instances sharing one source and a third selection consumer. It captures the native output before and after clearing the component consumer, plus the surviving selection-buffer state. The fixture deliberately isolates ownership with depth occlusion disabled; it does **not** qualify global CEL visibility. A passing harness means the evidence was captured and the pinned limitation reproduced, **not** that outlines satisfy release acceptance. Run just this file with the shared browser runner; the JSON attachment lists blockers and actual API, mask type, dimensions and browser. Screenshots come from the actual presented canvas.

Physical iPad A16 testing is **deferred by the user for this delivery (21 September 2026)**. No physical-device baseline, equal-quality before/after timings, sustained thermal behavior or device mask-format qualification has been measured. Desktop WebGL/WebGPU captures are functional evidence only. Do not enable a costly default based on these runs or substitute an alternate outline renderer without the requested product approval.

### Recorded desktop evidence — 21 September 2026

Build `48314f7f090ef8fd404dca5dc62344337c54e77c`, Babylon 9.20.0, Windows 10.0.19045 x64, Intel i5-9400F, Chromium 151.0.7922.34, DPR 1. WebGL2 used ANGLE D3D11 WARP (Microsoft Basic Render Driver); WebGPU used Google SwiftShader. The JSON attachments include the build fingerprint, fixture source hash, requested/effective API, adapter, dimensions and settings. These are software-adapter functional runs, not timing benchmarks.

| Native fixture observation | WebGL2 | WebGPU |
| --- | --- | --- |
| CEL red pixels with editor selection active | 204 | 204 |
| CEL red pixels after adding a disjoint component consumer | 204 | 204 |
| CEL red pixels after clearing only the component consumer | 204 | **0** |
| Shared instance-selection buffer after that clear | **Removed** | **Removed** |

The fixture uses 128×96 pixels, scale 1, a float32 native mask (`mainTextureType = 1`), and three warm-up draws after readiness per membership state. WebGL2 retaining its previous pixels does not establish safe buffer ownership. WebGPU visibly loses the unchanged CEL outline. At that revision, this failure supported the pending request for a shared bounded-pass extension; it did not establish approval. The later authorization is recorded in the continuation checkpoint above. Depth occlusion, per-thin-instance ownership, mask-ID precision at scale, deformation and transparency remain unqualified.

The same build passed three standalone settings cases: packed WebGL2, loose WebGPU, and packed requested-WebGPU with an injected adapter failure and effective WebGL2. Each boots authored CEL with five bands, specular off, environment disabled, shadows disabled, FXAA, a 480×270 output, scale 0.8 and cap 30. Presented pixels change under a live PBR request and return exactly when CEL is restored. Scale 0.5 and cap 20 survive a transition whose second-scene geometry is verified; reload restores 0.8/30. The stored manifest retains project defaults. The rejected adapter's diagnostic contains `qualification adapter failure`. This verifies the tested fields, not every rendering setting or every host.

Reproduce only these fixtures with the admitted runner:

```powershell
$env:BL_TEST_PROFILE='shared'
pnpm --silent agent:wait local --script test:e2e -- e2e/native-outline-qualification.spec.ts e2e/render-settings-export.spec.ts --project desktop-chrome
```

The player fixture generates and serves actual packed/loose exports with two primitive scenes from `e2e/preview-scene-fixture.ts`; it does not use editor caches or an editor iframe. Five harness tests passed. Two of those deliberately document the native outline failure. PNG and JSON attachments live in the Playwright result, including authored-CEL/runtime-PBR images and the three native membership states.

Targeted local verification (no full suite or coverage sweep):

| Scope | Recorded result |
| --- | --- |
| `packages/core/src/project.test.ts`, `packages/exporter/src/export-game.test.ts` | 64 passed at `48314f7f`; includes malformed frame caps, minimum dimensions, normalized export/boot defaults and editor-field exclusion |
| Editor `export-game.test.ts`, `export-baked-lighting.test.ts`; player `artifact.test.ts`, `hydrate.test.ts`, `boot.test.ts`, `player-backend.test.ts` | 55 passed at `82e9aff3`; reused for the unchanged option rename and caller contracts; later normalization is covered by the row above and standalone cases |
| `packages/core/src/render-quality.test.ts`, `packages/runtime/src/execute-console.test.ts` | 46 passed at `d0e684a7`; unchanged since, including 80 repeated quality requests producing four renderer updates |
| Typechecks | Core/exporter/editor at `48314f7f`; player at `02e08c9f`; runtime at `335a1d8c`; no workspace-wide typecheck |
| Lint and diff | Changed-file lint plus scoped reruns for repaired files passed; `git diff --check` passed |

Earlier fixture failures (material-name assumptions, reading the cleared canvas, including the live HUD in screenshots, and assuming a console test-hook member) were corrected before the recorded browser pass. They are not evidence of passing player behavior. Required CI has not certified this incomplete handoff.

### Remaining handoff work and release gates

The stricter output-size regression at `96b2331a` passed all three standalone
settings cases above. Earlier readback established the requested scaling level
but missed that a locked output stayed at 480×270. The repaired view now renders
384×216 at scale 0.8 and 240×135 at 0.5. A related effects-only graph resize bug
was reproduced (old color target versus resized depth) and repaired; each case
now requires the prepared FXAA task after scaling and scene transitions. These
are correctness results, not equal-quality performance savings. Targeted graph
resize/effect/transaction cases, the render package typecheck and six changed
TypeScript files' lint passed at that revision. Eight framebuffer/admission
cases passed at `502cb4ea`; the later repair changes effect graph invalidation,
not that per-view sizing contract.

| Priority / work | Status and next requirement |
| --- | --- |
| P0 physical A16 baseline and budgets | **Deferred by user; not a current delivery gate.** No A16 CPU/GPU/p50/p95/p99, input latency, sustained memory or remaining-headroom claims. Agree the representative scene and explicit 60 fps (16.7 ms) or 30 fps (33.3 ms) target, then measure equal content/quality before and after. CPU and GPU headroom must be reported separately. |
| P0 settings contract | Shared authored/export/boot normalization, actual output scaling, saved Class Play and standalone retained-setter cases are implemented; see the later dated evidence below. Complete per-field rendered application and hands-on host/backend acceptance remain. See the [application inventory](../architecture/render.md#rendering-handoff-application-contract). |
| P1 editor/component/global CEL outlines | **Native ownership gate failed; narrow shared-extension implementation authorized on 22 September.** Production selection remains the existing mesh-outline implementation. No OutlineComponent/global outline schema or default-on switch is advertised. Implementation, lifecycle, strict occlusion, compositing, style grouping, coverage and zero-work-disabled acceptance remain. |
| P1 Class Graph scalability | Shared typed session transactions, safe-boundary renderer application, acknowledgements, coalescing, events and the Scalability node category are implemented. Compiled Class graphs exercise all presets and retained setters in both Play backends and standalone exports. Outline controls await the outline implementation. |
| P1 measured headroom | A desktop before/after CPU profile identified and removed redundant shadow-flag material invalidation at identical content, output and quality. Capped frame cadence stayed unchanged. Absolute CPU/GPU frame headroom, pass/memory savings and A16 comparisons remain **unmeasured**. |
| P2 rectangular area light | Authored component, transforms, debug visualization, explicit unshadowed policy, cancellable cached emission processing, export/boot assets and shared GPU ownership are implemented. Later evidence below records automated receiver/transform, authoring/history/reopen, compiler inheritance and standalone lifecycle passes. Hands-on acceptance, asymmetric textured orientation and remaining supported material cases are still required. |
| P0 release | **Not accepted.** The requested production feature set is incomplete. A16 hardware testing is deferred by user; browser acceptance remains required. |

Future A16 qualification should cover empty, representative authored, many objects/instances, many lights, dense overlap, animated characters, and repeated selection/inspector/gizmo interaction runs in editor and standalone player. Existing performance-room tooling below covers only part of that matrix. Direct GPU timer values must be distinguished from estimates; unavailable measurements stay unavailable. Do not derive universal actor/light counts or treat reduced resolution as equal-quality savings.

**Existing sustained route: tooling landed, runs pending.** The route (`e2e/play-sustained-route.spec.ts`, `BL_PERF_SUSTAINED=1`) enumerates on CI and skips without the env flag; no machine with enough free memory has completed a full session yet. Nothing on this page is A16/iOS PWA qualification — desktop Chromium observations only. Budgets live in [perf-budget.md](perf-budget.md); the engine-level design is in [render.md](../architecture/render.md).

## Engine follow-up: deferred local verification

On 2026-09-22 the user requested skipping checks that cannot fit the machine's available memory and recording them for later. The team's queued particle check was cancelled before execution; no running check or unrelated process was stopped. `BL_TEST_PROFILE=shared` remains required. The shared `local-resources.json` had a 3 GiB reserve at deferral and changed externally to 2 GiB during source integration; this team left it unchanged. Read the current shared configuration when resuming. Do not bypass admission or repeatedly queue these checks while they cannot fit.

Physical A16 verification is waived for this follow-up. Local browser/native verification is deferred where listed below, not counted as passed. No desktop or software-WebGPU result establishes device performance. Required CI and merge gates remain unchanged.

| Delivery | Recorded source/evidence | Pickup |
| --- | --- | --- |
| A: snapshot synchronization | `3d0031bd`, `t3code/engine-ownership-performance`. Four explicit unit files passed 192 cases at `ba76a60f`; scoped render typecheck/lint passed. Two desktop Play/Preview pixel cases passed at `2c1f29ae`. Snapshot-attributable global dirty/cleanup counts fell from 120 per 120 samples to zero. | No local check was deferred for A. [PR #657](https://github.com/hideoutgames/BabylonSlate/pull/657) remains unmerged, awaiting the normal Verify slot and current-head CI. |
| B: native physics lifecycle | `82ae49a0`, `agent/engine-physics-lifecycle-b`. Earlier real-Havok removal/resource cases passed, but the immediate teleport ray failed and a compound trigger case hung before the latest corrections. Those corrections are unverified. | Resume the isolated native trigger and teleport/constraint/controller cases first, then the explicit lifecycle/transaction files, affected Rapier/runtime callers and scoped static checks. Keep native detachment/teleport gates open. |
| C: dirty physics preparation | Frozen baseline fixture `de96b6d3`, `agent/engine-physics-dirty-c`; implementation is on a separate branch. The new five-case preparation fixture has not run. | Run `packages/runtime/src/physics-sync-preparation.test.ts` at the frozen baseline before comparing the implementation. Validate native B before treating C as deliverable. |
| D: texture leases and stable sprites | Source `b8a11880`, notes `5fe391b3`, `agent/engine-texture-leases-d`. Earlier batch: 68 passed, 7 failed. Fixture repairs and subsequent upload/admission fixes are unverified; the earlier typecheck at `0e675860` does not certify the current head. | [Exact unit, editor, static and browser commands](https://github.com/hideoutgames/BabylonSlate/blob/5fe391b36d555041c4e79bbcca2def0c4a152c7c/docs/architecture/render.md#texture-ownership-verification-pickup). Includes the 10,000-selection WebGL2/WebGPU fixture. |
| E: model/text visual lifetimes | Source `64599304`, notes `233b75ba`, `agent/engine-visual-lifecycle-e`. Baseline: 5 failures/6 passes; implementation at `e36439b1`: 18/18 in the same two files. Later editor staging, multipart budgets and additional ownership changes are unverified. | [Exact segmented native/consumer/browser commands](https://github.com/hideoutgames/BabylonSlate/blob/233b75ba/docs/architecture/render.md#visual-ownership-verification-pickup), plus scoped static checks. Combine the AssetContainer and physics patch hunks before final integration verification. |
| F: particles | `79a00663`, `agent/engine-particles-f`. 49 cases passed across earlier checkpoints. Two follow-up cases at `150ee60a` were cancelled while queued, with no execution. Later clock-ordering, D integration and browser changes are unverified. | [Particle pickup commands and evidence](https://github.com/hideoutgames/BabylonSlate/blob/79a006630853b990d971a5e805ac70e1382771ed/docs/architecture/particles.md). Resume the two selected lifecycle cases, scoped render/editor checks and four CPU/GPU × WebGL2/WebGPU browser cases. Particle-specific exported-player lifecycle verification remains open. |

The first native-physics probes, from the B worktree, are deliberately bounded and sequential:

```powershell
$env:BL_TEST_PROFILE = 'shared'
pnpm --silent agent:wait local --script test --timeout-seconds 60 '--' packages/physics/src/havok-transactions.test.ts -t 'ends retired trigger' --disableConsoleIntercept
pnpm --silent agent:wait local --script test --timeout-seconds 60 '--' packages/physics/src/havok-transactions.test.ts -t 'teleports falling|keeps constraints|retains controller|defers contact' --disableConsoleIntercept
```

Before resuming, compare the working head with the recorded checkpoint and select checks affected by intervening source, dependency or configuration changes. Keep failed, cancelled and unexecuted results separate from passes. Record exact source, command, backend and resource/operation counts for each resumed batch. B–F have no delivery PR yet; the work remains unmerged and is not verified complete.

Status: **tooling landed, runs pending.** The sustained route (`e2e/play-sustained-route.spec.ts`, `BL_PERF_SUSTAINED=1`) enumerates on CI and skips without the env flag; no machine with enough free memory has completed a full session yet. Nothing on this page is A16/iOS PWA qualification — desktop Chromium observations only. Budgets live in [perf-budget.md](perf-budget.md); the engine-level design is in [render.md](../architecture/render.md).

## Coverage matrix

"CI" means the standard e2e suite (Chromium, SwiftShader/software WebGPU via `SOFTWARE_WEBGPU_ARGS`). "Local-only (env gate)" specs enumerate but skip without their flag. "Unit" means Vitest coverage with no browser run.

### Backend

| Backend | Coverage |
| --- | --- |
| WebGL2 | Default for the whole suite; explicit packed/proof runs in `color-pipeline.spec.ts`, `framegraph-forward.spec.ts`, `framegraph-post-process.spec.ts`, `framegraph-post-process-lifetime.spec.ts`, `player-backend.spec.ts`, `webgpu-backend.spec.ts` (transitions include WebGL2 legs) |
| WebGPU | `color-pipeline.spec.ts`, `framegraph-forward.spec.ts`, `framegraph-post-process.spec.ts`, `framegraph-post-process-lifetime.spec.ts`, `framegraph-shadows.spec.ts`, `scene-post-process-coordinator.spec.ts`, `player-backend.spec.ts`, `webgpu-backend.spec.ts`, `webgpu-previews.spec.ts`, `environment-lighting-webgpu.spec.ts`, `baked-parity.spec.ts` — all through software WebGPU on CI |

### Render path

| Path | Coverage |
| --- | --- |
| `forward` | `framegraph-forward.spec.ts` (opt-in graph preserves surface pixels and ownership, both backends); `clustered-path-selection.spec.ts` (explicit forward request) |
| `clusteredForward` | `clustered-lights.spec.ts` (native and graph PBR/CEL pixels, WebGL2); `clustered-lights-webgpu.spec.ts` (same parity under WebGPU storage-buffer masks); `clustered-path-selection.spec.ts` (editor selection, Play, packed player Auto→clustered) |
| `auto` | `clustered-path-selection.spec.ts` (auto resolves `clusteredForward` in editor, Play and packed player; session `renderpath` request is global and non-persistent); `render-path-settings.spec.ts` (project-wide pipeline settings retained through reopen) |

### Style

| Style | Coverage |
| --- | --- |
| PBR | Default everywhere |
| CEL | `cel-render-mode.spec.ts`, `cel-hard-steps.spec.ts` (both backends), `cel-shadow-lifecycle.spec.ts`, `clustered-lights.spec.ts`, `clustered-lights-webgpu.spec.ts` (clustered CEL tie sequence under WGSL), `framegraph-forward.spec.ts` (pbr and cel captures), `baked-parity.spec.ts`, `webgpu-backend.spec.ts` (WebGPU CEL proof) |

### Features

| Feature | Coverage |
| --- | --- |
| Shadows | `shadow-refresh.spec.ts`, `cel-shadow-lifecycle.spec.ts`, `framegraph-shadows.spec.ts`, `webgpu-backend.spec.ts` (WebGPU shadow proof), `rendering-baseline.spec.ts` (shadow passes/bytes) |
| Project post-processing effects | `color-pipeline.spec.ts` (bloom/effects chain in packed WebGL2 + WebGPU player and editor viewport) |
| Authored post-process stack | `framegraph-post-process.spec.ts`, `framegraph-post-process-lifetime.spec.ts`, `scene-post-process-coordinator.spec.ts`, `scene-post-process-host.spec.ts`, `post-process-owner-overrides.spec.ts` |
| Baked lighting | `baked-parity.spec.ts` (synthetic-atlas PBR/CEL parity, dielectric + metallic environment specular/diffuse cells on both backends), `baked-player.spec.ts` (Preview Build), `baked-runtime.spec.ts`; authoring side `scene-bake.spec.ts`, `scene-bake-job.spec.ts`, `bake-provider.spec.ts`, `bake-uv.spec.ts` — the quality-tier bake variants are local-only (`BL_BAKE_QUALITY_E2E=1`) |
| SceneLayers | `scene-layer-rendering.spec.ts` (viewport + Play); `runtime-owner-continuity.spec.ts` (moving global layer retained across loading, Play + Preview Build) |
| Particles | `p17-particles.spec.ts` (authored emitter/system, Play billboards, teardown, save/reopen) |

### Hosts

| Host | Coverage |
| --- | --- |
| Editor viewport | `viewport-shading.spec.ts`, `cel-render-mode.spec.ts`, `rendering-baseline.spec.ts`, `color-pipeline.spec.ts` (bloom), `webgpu-backend.spec.ts`, `viewport-guides.spec.ts` |
| Play | `p4-play.spec.ts`, `qa-animation-overlap.spec.ts`, `tilemap-rendering.spec.ts`, `qa-play-controls.spec.ts`, `play-debug-console.spec.ts`, `runtime-owner-continuity.spec.ts`, `scene-layer-rendering.spec.ts`, `clustered-path-selection.spec.ts` |
| Preview Build | `p14-preview-build.spec.ts`, `baked-player.spec.ts`, `tilemap-rendering.spec.ts`, `runtime-owner-continuity.spec.ts`, `clustered-path-selection.spec.ts` (packed player) |
| Exported player | `p14-export.spec.ts` (unzip-serve-boot-tick), `player-backend.spec.ts` (packed `apps/player` over HTTP, both backends) |

### Recovery

| Event | Coverage |
| --- | --- |
| Context loss | Unit only (`create-engine.play.test.ts`, `rgbd-texture-lifetime.test.ts` — `noteRestore`, texture release, material invalidation). **Not covered** in e2e: no spec forces a real `WEBGL_lose_context` on a live session |
| Backend switch | `webgpu-backend.spec.ts` (WebGPU→WebGL2→WebGPU through Project Settings, one Engine, undo/redo and Play after) |
| Backend fallback | `webgl2-fallback.spec.ts` (WebGPU requested while `requestAdapter` returns null, rejects, or `navigator.gpu` is absent → one WebGL2 Engine, presented viewport, explicit reason in Project Settings, Play afterwards, no loading-deadline failures), `player-backend.spec.ts` (packed WebGPU player without an adapter presents WebGL2 with `data-backend-fallback`) |
| Scene reload | `runtime-scene-loading.spec.ts` (repeated transitions + Stop, Play + Preview Build), `runtime-owner-continuity.spec.ts` (`changescene` under held paint, both hosts), `rendering-transitions.spec.ts` (viewport blocking reloads) |
| WebContent termination | Unit only (`session-liveness.test.ts` — liveness record, exit detection, pruning). Capacitor's native handler reloads the WebView; OS delivery on a real device is untested |

## Sustained route

`e2e/play-sustained-route.spec.ts` reuses the performance-room fixture (`e2e/play-performance-fixture.ts`): a deterministic room — floor, three walls, 96 static casters, 16 physics-driven spheres, sun plus six shadow-casting points and two spots — in the minimal test project at the selected quality.

Sequence per run: overlay Play on the editor's shared Engine, 60 s warm-up, then `ceil(minutes / sample)` windows of `BL_PERF_SAMPLE_MS` (default 30 s each, default total 20 min); the same again through a Preview Build (the packed player host on its own Engine). Each window records:

- rAF cadence: fps, interval median/p95/p99, longest, stalls over 33/50/100 ms;
- `longtask` entries (count, total ms);
- canvas CSS/backbuffer dimensions and `devicePixelRatio`;
- `renderDiagnostics()` on the host's test hook: draw calls, `cpuMs`, `gpuMs` (with `gpuAttribution`), the last pressure `FramePressureSample`, `scalingLevel`, scene resource counts (meshes/materials/textures/cachedTextures), accounted `gpuReservations`, shadow passes/bytes, pipeline status and quality limits;
- worker tick rate; `document.visibilityState`.

Artifacts: one JSON attachment per window, a `play-sustained-route` JSON report (env, quality profile, render mode, requested backend, boot timings, per-host engine adapter strings, browser version, headless flag, viewport, page errors) and a `play-sustained-summary` text digest (one line per window). The spec asserts only that the route ran — windows produced samples, the page stayed visible, zero page errors — **it never asserts a frame rate**.

### Running it

```text
BL_PERF_SUSTAINED=1 BL_PERF_QUALITY=low pnpm run test:e2e e2e/play-sustained-route.spec.ts --config playwright.perf.config.ts --project perf-gpu
```

`perf-gpu` is full headless Chromium on the machine's real adapter through ANGLE D3D11; `perf-software` is the ordinary SwiftShader project. Knobs:

| Env | Default | Effect |
| --- | --- | --- |
| `BL_PERF_SUSTAINED` | off | `1` opts in; otherwise the spec skips (CI no-op) |
| `BL_PERF_SUSTAINED_MINUTES` | `20` | Sampled duration **per host** after warm-up |
| `BL_PERF_SUSTAINED_WARMUP_MS` | `60000` | Warm-up per host before sampling |
| `BL_PERF_SAMPLE_MS` | `30000` | Window length |
| `BL_PERF_QUALITY` | `low` | `low`/`medium`/`high`/`ultra` profile written into the project |
| `BL_PERF_RENDER_MODE` | `pbr` | `cel` selects the CEL project |
| `BL_PERF_BACKEND` | project default | `webgl2`/`webgpu` via the project GPU-backend setting |
| `BL_PERF_LABEL` | — | Free-form run label copied into the report |

## Environment and adapter caveats

- **Not device qualification.** `perf-gpu` measures desktop Chromium on ANGLE D3D11; CI and `perf-software` measure SwiftShader (CPU rasterization, GPU-bound). Neither is the A16/WKWebView/iOS-PWA target; iPad WebGPU symptoms could not be reproduced on Chromium/D3D12. The report embeds `engine.getInfo()`/`getGlInfo()` adapter strings, the probe adapter, browser version and headless flag so no run can be mistaken for device evidence.
- **rAF cadence is a presentation proxy.** `pressure.presentationMs` is the interval between the view's own presented frames — only `playMode` handles report it; editor/prefab viewports feed `cpuMs` only. `gpuMs` is attributed to the view only while it is the Engine's sole rendering view (`gpuAttribution` says which); `cpuMs` is `scene.render()` CPU, not total presentation cost.
- **SwiftShader skews the mix.** CPU-rasterized frames hide CPU-side regressions and exaggerate fill cost; the dynamic-resolution valve will step down on long software runs — that is the valve working, and `scalingLevel` in each window records it.
- **Memory admission.** A full session needs sustained memory headroom; that is why runs are pending on this machine rather than failing.
- **No state between hosts.** The Play and Preview Build windows measure the same scene on two different Engines sequentially; they are not concurrent-load data.

## Acceptance thresholds

From [perf-budget.md](perf-budget.md); read each sustained window against them — the route reports, the reader judges.

| Signal | Budget | Where it lands in the report |
| --- | --- | --- |
| Frame pacing | project `playFrameCap` (default 60 → 16.7 ms interval) | `intervals.medianMs`/`p95Ms`/`p99Ms` per window; a real-adapter run should sit near the cap after warm-up |
| Stalls | counted, not budgeted; the #633 recovery reference showed ~0–7 per 30 s at 60 fps | `stallsOver33Ms`/`50`/`100` |
| Long tasks | zero on a healthy run | `longTasks.count`/`totalMs` |
| Tick | < 8 ms combined, ~5 Hz stats cadence | `tickHz` (~60 while uncapped) plus the diagnostics snapshot |
| Draw calls | low hundreds; `DRAW_CALL_WARN_CEILING` 400 | `drawCalls` in `diagnostics` |
| Memory | accounted textures under `TEXTURE_BYTE_CEILING` (2 GB); geometry warn at `GEOMETRY_BYTE_CEILING` (512 MB) | `gpuReservations.reservedBytes`, `resources.cachedTextures` |
| Leak signal | no growth across windows | `resources.*`, `gpuReservations`, `shadowMapBytes` stable window-over-window |
| Resolution | valve may step down under pressure and must not wedge | `scalingLevel`, `width`×`height`, `pressure` per window |

A window that misses the pacing budget is a measurement to explain, not a spec failure — the assertion set stays at "the route ran clean" so the run always produces evidence instead of a red build.
# Rectangular light browser fixture

`e2e/area-rect-light.spec.ts` exercises the production `SceneRenderCoordinator`
with native PBR and authored Material Graph receivers in PBR/CEL modes. It
requests Forward and Clustered Forward, retains actual effective-path readback,
compares enabled/disabled and 180-degree rotation pixels, checks an unlit control,
and blocks external network requests. The fixture and its PNG/JSON attachments
are functional evidence only. On `61c33a05`, both explicit browser cases passed
on Windows 10.0.19045 / Chromium with D3D11 WARP (WebGL2) and SwiftShader
(WebGPU), at 240 by 160 and scale 1 after three draws per capture. Captures use
the presented bitmap, preserving WebGPU channel/row order. WebGL2 PBR and CEL
both retained Clustered Forward with the rectangular light as a conventional
contribution (4 draws versus 3 for Forward). WebGPU explicitly fell back to
Forward for a Clustered Forward request, as required by the existing backend
policy. CEL diffuse retained discrete levels; the unlit control stayed unchanged.
Disabled and 180-degree turned-away lighting matched, and restoring orientation
restored identical pixels. No external asset request occurred. These checks do
not establish physical-device budgets, textured emission or every lifecycle case.

Textured qualification separately compares worker-prepared pixels to the native
processor and compares rendered uploads using identical input pixels. The latter
requires identical presented images, avoiding a loose brightness tolerance that
could mask wrong sampler bindings. The separation matters for CEL: a one-byte
preprocessing quantization difference can move a pixel across a hard band edge.
WebGL draw-time evidence identifies each receiver's bound emission texture.

At `5c57f21a`, both textured browser cases passed on the same software-backed
Windows/Chromium environment. The 32×16 numeric source differed from Babylon's
prepared base pixels by at most one channel value (WebGL2 mean 0.3113/255,
WebGPU mean 0.0016/255). Matched-input uploads produced identical presented
images on each backend. The sampler qualification exposed and fixed repeated
LTC sampler registration and missing dynamic emission bindings in graph materials.
This is correctness evidence, not a measured performance improvement. Five
targeted unit files passed 72 tests at that revision; the two lighting/shadow
files passed 39 tests at `29b57983` after shared sampler admission was added.

Processor v3 supersedes that initial source-sampling policy. An odd-sized
1537×769 stripe fixture at `b471eff2` exposed backend-dependent native mip
generation: the v2/native comparison failed on WebGL2 (mean 17.4680/255,
maximum 127), while WebGPU passed. This is recorded as a failure, not folded into
the successful small-image qualification. The repair defines deterministic
768-square import filtering (area averaging down, mirrored linear sampling up),
then applies the pinned mirrored padding and progressive blur.

At `2c788764`, the native encoding/blur matched **exactly** on both backends for
32×16, 2048×512 and 1537×769 inputs after that canonical source filtering.
The source filter itself has separate average-preservation and cancellation
regressions. The two receiver browser cases and two actual standalone export
cases passed; matched-input lighting still produced identical presented images.
The four emission unit cases, 18 compositor lifecycle cases (`6961e532`), and
live spawned-light asset arrival/removal regression (`a975d574`) passed. Assets
and render typechecks passed at `2c788764`; changed-file lint had zero errors and
four existing Fast Refresh warnings in Play context. This does not qualify
Computer Use interaction, every receiver type or the full handoff.

`e2e/area-light-export.spec.ts` uses the editor's real export collector, served
packed WebGL2 and loose WebGPU players, a uniform numeric prepared texture and
four scenes. It checks texture/uniform/disabled pixels, repeated scene disposal,
GPU reservation recovery, reload and absence of external resource requests.
Its results must be recorded separately from the in-editor GPU fixture.

Both standalone cases passed at `06bc0b0a`. Prepared lighting accounted for
5,657,940 managed GPU bytes (two LTC tables and one RGBA8 emission mip chain),
uniform lighting for 65,536 bytes, and a scene without rectangular lights for
zero area-light bytes. Three unload/reload cycles and page reload restored
identical pixels. No external request occurred and the player contained no
emission-processing worker. Captures await the actual scene-load transaction's
first presented frame; an absent loading dialog is not a readiness signal.
These are accounted resource sizes, not measurements of total device memory.

At `156735af`, both receiver browser cases also passed equivalent-pixel checks
for scaled dimensions, mirrored X, and a 90-degree rotated non-uniform parent
with a counter-rotated emitter. Mirroring the forward axis matched the
turned-away result. Shear and degenerate scale disabled the emitter with the
expected diagnostic; restoring the transform restored identical pixels without
replacing its native owner. This does not yet qualify animated textured mirror
orientation or arbitrary custom receiver shaders.

At `a523e5ee`, `e2e/area-light-authoring.spec.ts` passed in desktop Chromium:
component discovery, width undo/redo, actual Prepare Emission worker processing,
Texture assignment, duplicate/resource sharing, component removal/undo and
project reopen. Two duplicated emitters retained one emission upload (5,657,940
accounted area-light bytes); removing one did not destroy the survivor's texture.
Captured inspector and Texture editor images were inspected. Earlier harness
failures used an unsupported right-click menu entry and compared optional
identity transforms before/after normalization; neither is recorded as a pass.

At `66f6291f`, the selected component-only Class compiler/runtime case passed:
an empty child inherits the parent's rectangular emitter and attachment,
two spawned instances receive distinct component identities, and despawning
one preserves the other. A manually assembled runtime-only fixture initially
omitted the compiler's effective component templates; the final regression
uses the actual Class compiler. The existing native-variable width setter case
also passed during that targeted investigation.

## Saved Class scalability qualification

At `562fe445`, the three explicit cases in `e2e/render-settings-export.spec.ts`
passed: packed WebGL2, loose WebGPU, and deliberately failed WebGPU startup
falling back to WebGL2. The normal backend cases execute all four presets and
retained setters for shadows, lighting, texture sampling/budget, resolution,
frame cap, post-processing, effects, CEL appearance and environment. Assertions
cover physical buffer size, active FXAA tasks, requested/effective render path,
invalid atomic requests, clamping and reset. Artistic CEL settings survive Low.
The fixture disables light shadow casting so this settings test does not claim
image qualification of every shadow mode.

At `686dc574`, both cases in `e2e/scalability-play.spec.ts` passed on Windows
10.0.19045 / Chromium, using D3D11 WARP WebGL2 and SwiftShader WebGPU. These
load saved Class assets through the editor compiler and execute their commands
in Play. An actor Class receives Settings Changed and reads Get Effective
Scalability; both outputs report the same presented revision. The fixture checks
all presets and retained individual setters, 300-by-180 output for the custom
transaction, reset, and a new Play session after stopping with a clustered
request active. Save All stays disabled: scripted settings did not dirty the
project. Play now owns a reference-counted render-path session, restores the
editor preference on final release, and unsubscribes disposed view listeners.

Focused local validation: six `packages/runtime/src/scalability.test.ts` cases
passed at `74766aa0`; three selected render-path/construction-rollback cases in
`packages/render/src/create-engine.play.test.ts` passed at `686dc574` (118 other
cases were not selected). Render, editor and runtime package typechecks passed,
and eight changed TypeScript files passed ESLint with one existing Play-overlay
hook-dependency warning. These results do not cover outline settings, which are
not implemented, or establish physical-device performance. Computer Use still
has no connected browser; these are automated browser tests.

## Desktop CPU profiling: redundant shadow invalidation

A same-content comparison used `e2e/play-performance-route.spec.ts` and the
unchanged `playPerformanceRoom` fixture (96 static casters, 16 settling physics
spheres, sun, six points and two spots). The before build was `1f2768d2`; after
was `a909bff9`. Both ran on Windows 10.0.19045, Intel i5-9400F, Chromium
151.0.7922.34, ANGLE D3D11 / NVIDIA RTX 2060, requested WebGL2, CEL, Medium,
DPR 1, 1280-by-720 CSS and drawing buffer. Medium's dynamic-resolution policy
remained enabled; both measured windows retained the same full dimensions.
The workload warmed for 10 seconds after ticking began, then recorded a
250-microsecond-interval V8 CPU profile and two 30-second cadence windows.

| Observation | Before | After |
| --- | --- | --- |
| Profile wall duration | 10,636.00 ms | 10,637.08 ms |
| `_markSubMeshesAsDirty` sampled self time | 508.34 ms | 0 sampled ms |
| Profile idle samples, weighted by elapsed interval | 5,435.98 ms | 6,054.64 ms |
| Browser cadence p50, both windows | 16.72 ms | 16.72 ms |
| Browser cadence p95, windows 1 / 2 | 16.905 / 16.895 ms | 16.900 / 16.900 ms |
| Browser cadence p99, windows 1 / 2 | 16.960 / 16.945 ms | 16.950 / 16.965 ms |
| Average browser cadence, both windows | 59.81 fps | 59.81 fps |
| Long tasks / intervals over 33.4 ms | 0 / 0 | 0 / 0 |
| End-of-window JS heap, windows 1 / 2 | 114.26 / 96.02 MB | 164.58 / 197.21 MB |
| Direct GPU time, draw/pass counts, GPU bytes in this route | Not collected | Not collected |

The profiles trace the removed work through native `shadowEnabled` setters
around the graph object pass. Lights without an admitted map now preserve that
flag, while lights with maps keep the native pass-isolation behavior. The final
Play canvas PNGs were byte-identical (SHA-256
`1f712e2aa8c9f131824ba4f6364154dfc36aba955eb2e80b51f9a9f5e5b97524`).
This is one before/after profiling pair, not a statistical frame-time win.
Sampled self time is not total render CPU time; browser cadence is a presentation
proxy. Heap readings depend on garbage-collection timing and show no demonstrated
memory reduction. No separate CPU/GPU millisecond headroom or A16 budget is
established by this route. Input latency and the full requested scene matrix
still need qualification.

The focused regression first failed at `2973fd66` with four receiver-dirty calls
across two settled renders. All 11 managed-shadow unit cases passed at
`0118786d`. A subsequent build type error in the new membership Set was fixed
with an explicit `Light` type; the eight selected cases in
`e2e/framegraph-shadows.spec.ts` and `e2e/area-rect-light.spec.ts` passed at
`a909bff9`, including WebGL2/WebGPU, backbuffer/texture output, clustered promotion
and demotion, and shared memory admission. The same build passed the after
profiling route. Changed-file ESLint passed; the browser build's player/editor
TypeScript checks passed. No broader local suite was run.

Reproduce the profiling route with the shared runner (one run at a time):

```powershell
$env:BL_TEST_PROFILE='shared'
$env:BL_PERF_ROUTE='1'
$env:BL_PERF_QUALITY='medium'
$env:BL_PERF_RENDER_MODE='cel'
$env:BL_PERF_BACKEND='webgl2'
$env:BL_PERF_PROFILE='1'
pnpm --silent agent:wait local --script test:e2e '--' e2e/play-performance-route.spec.ts --config playwright.perf.config.ts --project perf-gpu
```

Raw JSON, CPU profiles and canvas captures are retained locally under the OS
temporary `BabylonSlate-rendering-handoff-evidence/perf-before-1f2768d2` and
`perf-after-a909bff9` directories. This report records desktop evidence only;
physical A16 qualification remains deferred by user.


## Engine ownership follow-up baseline

- Implementation starts at `bf109267b4adf42fe118847f29af1888a8ad1f5e`, after reviewed `ce1162f25cbac930be4789789de6269856e1eb58`. The intervening test-mode and WebGL2-fallback PRs do not change snapshot/physics ownership. Retain the merged #648 vertex-stream patch and existing renderer selection.
- Installed dependencies: Babylon `9.20.0`, Havok `1.3.14`. Packaged and vendored Havok WASM SHA-256: `026917766f534c156286f07975850978dabf17c42e742bbfaaebbcb2215e4e11`. Babylon patch file SHA-256: `2b1f1007a95b4543415a9f67ae023c662b1852b4140a34e710ff68a947bb06f9`; lockfile patch identity: `613782859a2d2336c9cc03314b9e992b211e6607c435e03848d9aa127f314375`.
- Deliveries: A snapshot preparation; B native physics ownership and explicit transforms; C change-driven physics preparation; D installed asset identity, texture leases and stable sprites; E transactional models/text; F particle preparation/playback. Each delivery records targeted evidence separately. No batching, second renderer or general resource framework.
- `snapshot-steady-state.test.ts` measures direct synchronizer preparation for 256 warmed actors with 120 identical, 120 new-frame/unchanged, and 120 moving samples. Native dirty/cleanup calls are counted only inside synchronization; normal render queue resets are excluded. Timing distributions are evidence, not noisy pass/fail thresholds.
- Local browser validation is the requested platform scope; physical A16 verification was explicitly waived. NullEngine evidence does not establish browser output or device performance. Browser/backend results remain unexecuted until recorded for the relevant delivery.

### Delivery A local evidence

Baseline fixture commit `2974e67327a6d486a940f3b40e25d74b75bd2d52`; implementation `ba76a60fa58a1e550ede1f510870a02130b3cd1b`. Windows x64, Node 24.19.0, Babylon NullEngine 9.20.0, texture-free native materials, fixed camera, 256 actors, three warmup renders. Each phase directly applies 120 samples; rendering and fixture mutation are outside the timer.

| Phase | Before median / p95 / p99 (ms) | After median / p95 / p99 (ms) | Global dirty / active cleanup / group cleanup, before → after |
| --- | --- | --- | --- |
| Identical | 0.174 / 0.809 / 1.650 | 0.117 / 0.389 / 0.664 | 120 / 120 / 120 → 0 / 0 / 0 |
| New frame, unchanged values | 0.125 / 0.157 / 0.206 | 0.084 / 0.173 / 0.290 | 120 / 120 / 120 → 0 / 0 / 0 |
| Position and rotation changes | 0.340 / 0.709 / 1.446 | 0.282 / 1.256 / 2.451 | 120 / 120 / 120 → 0 / 0 / 0 |

These single-run timing distributions were collected while other development processes were active. Medians improved but some tails increased; this is not an isolated browser/device speedup claim. The acceptance result is elimination of the named native operations, stable mesh/material identities, and preserved transforms. The existing coordinator already cached strict readiness in the baseline; this change preserves that behavior rather than claiming a readiness redesign.

- Baseline: the new file had five expected failures for dirty/cleanup calls and flag writes; its coordinator readiness case passed. An earlier fixture using the editor checker texture timed out on NullEngine upload readiness and was corrected before the recorded comparison.
- Passed at the implementation commit: `pnpm --silent agent:wait local --script test -- packages/render/src/snapshot-steady-state.test.ts packages/render/src/snapshot-apply.test.ts packages/render/src/create-engine.play.test.ts packages/render/src/bone-attachment.test.ts` — four files, 192 tests. This covers caller deduplication/command invalidation, stale snapshots, SceneLayers, camera possession, bone attachments, structural failure and transform/readiness behavior.
- Render-package `tsc --noEmit` and ESLint for the two changed TypeScript files passed through shared resource admission. Documentation-only evidence updates reuse those unchanged-source results.
- The warmed measurement case was rerun with `--disableConsoleIntercept` to retain successful timing output; six unrelated cases in that measurement-only invocation were filtered out, not counted as new passes.
- Browser: `pnpm --silent agent:wait local --script test:e2e -- e2e/scene-layer-rendering.spec.ts --project=desktop-chrome` passed both Play and exported Preview Build pixel cases at `2c1f29ae28c795acffe40cf4a78dbee94d3f5879`, with one browser worker. The earlier queued attempt was cancelled and is not counted. This fixture uses project-default rendering settings and does not independently qualify WebGPU or capture an adapter identity; dedicated WebGPU and sustained-device performance are not claimed.
