# October 2026 QA retest dispositions

Investigation starts at `94f3692a2` (7 October). The supplied Run-1 retest and new findings are the source; original steps for the abbreviated numbered findings were not supplied. A passing unit or software-rendered browser check does not establish real-GPU appearance. The implementation and verification below apply to the described cases, not every possible project.

## Run-1 retest

| Report | Disposition |
| --- | --- |
| #1–4, #6–7, #9–10, #13, #18, #30–33, #36–37 reported resolved | No speculative changes to resolved behavior. Relevant existing controls remain in the selected checks. |
| #5 duplicate rename | Duplicate actor **labels** are supported: IDs retain identity and Outliner/pickers disambiguate labels. Content Browser asset names reject collisions; rename now preserves suffixes and also rejects conflicting or engine Class identities. |
| #8 dirty after Undo | Compare content with the latest saved baseline; Undo to that content is clean, Redo is dirty. Concurrent saves retain later edits. |
| #11 Details disabled | The last remaining dock cannot be hidden, avoiding an empty workspace. No missing Details wiring found; other contexts require reproduction steps. |
| #12 no Sprite actor | Added Sprite to Place Actors and direct placement from Sprite assets, using SpriteComponent. |
| #14–16 gameplay / Game Instance / shader graph | Intended: gameplay lives in Class event graphs; scene Game Instance displays the project-owned setting; Material is the shader graph editor. |
| #17 animation variable types | Intended restricted Animation Graph schema: Bool, Int, Float, String, Tag and Tag Container. Full Class variable types are not an animation parameter contract. |
| #19 Windows / Focus disabled | Intended for pinned Content Browser, which is not a DockView document. All real asset editor kinds are wired to the window catalog. |
| #20 2D/3D dirties scene | Intended authored setting: changes runtime camera defaults, physics and other scene behavior; saved and undoable. |
| #21 Circle radius 0 / Play at 20% | Details reject/clamp with visible feedback. Invalid stored Collider primitives now fail during scene realization with actor/component context, before native physics boot, through the normal loading failure path. |
| #22 not retested | Insufficient information: no description or steps supplied. |
| #23 silent clamping | Numeric edits show invalid-expression feedback or a status explaining the applied bound. Existing supported clamping remains. |
| #24 empty settings / Auto-Save 0 | Invalid or empty drafts explain restoration. Auto-Save intervals below one second are rejected with feedback rather than silently changed to one. |
| #25 both settings need Save All | Engine settings already persist immediately; project settings intentionally use Save All. The dialog now states the distinction. |
| #26 silent auto-save | Status bar distinguishes automatic saving, saved content and failure; rejected saves are caught and retained for retry. New edits continue to show unsaved state. |
| #27 slider writes x.1 | Orthographic Size inherited a step of 1 anchored at minimum 0.1. Explicit step 0.1 permits whole values and tenths. |
| #28 Ortho Size in Perspective | Show Ortho Size only for Orthographic, and FOV only for Perspective. |
| #29 Near/Far messages always visible | Ordering errors appear for invalid edits, not as permanent descriptions of valid values. |
| #34 duplicate states | Added/pasted animation states get unique names; duplicate/empty authored names get diagnostics. |
| #35 error badge | Found and fixed stale diagnostics across document switches, including asynchronous publications from previous visits. The original report lacks a precise reproduction. |
| #38 unnamed delete confirm | Existing confirmation already names assets; legacy empty headers now fall back to their filenames. |

## New findings

| Report | Disposition |
| --- | --- |
| Blocker: rename/move prevents project opening | Layouts store stable asset GUIDs and repair tab paths at load. Missing legacy path-only tabs are skipped instead of aborting the project. Rename and move browser checks cover cold reopening with saved Scene and Class tabs. |
| Fog does nothing | Authored PBR/Unlit surfaces omitted FogBlock. They now apply scene fog before image processing; overlays stay unfogged. GLSL and WGSL require their corresponding color conversion helpers. |
| Default Camera ignored | A valid explicit scene Default Camera takes precedence over automatic Attempt Possess View Target. Explicit gameplay possession remains supported. |
| Black shaded PBR sides in Basic 3D | Consistent with authored Sun lighting and no environment/ambient fill. Skybox does not supply IBL. Preserve lighting policy; real-GPU reproduction remains unavailable on this host. |
| Class rename detaches instances | Rename repairs typed Class references in saved and open documents and project settings, preserving unrelated data and unsaved content. Read-only referrers/identity collisions block the operation; write failures attempt full rollback. |
| Unicode name mangled / suffix dropped | Preserve Unicode and each supported compound asset suffix. Reject invalid path characters visibly instead of substituting them. |
| Right-click extends selection | Unselected context target replaces selection; a selected target retains the selected group. Move/Delete therefore match the displayed selection. |
| Interrupted creation leaves ghost | Caught failures already cleaned owned projects. A durable creation marker now identifies abruptly interrupted app-owned scaffolds and enables clean same-name retries. Unmarked old partial folders cannot safely be identified for automatic deletion. |
| No actor copy/paste | Outliner Copy/Paste and Cmd/Ctrl+C/V copy selected subtrees between scenes within the project session. New actor/component IDs, internal links and one-step Undo are preserved; external scene-object references are removed. |
| Escape commits Details | Shared numeric/text fields restore their edit baseline on Escape. Live preview remains; cancellation can leave an empty/coalesced history entry. |
| First characters dropped under load | Delayed select-all no longer reselects a field after typing has already changed its value. |
| Enter in New Folder/Rename | Enter submits valid names, excluding IME composition. |
| `..` / `a/b` folders | Validate single names before storage; visible errors replace raw exceptions and implicit nested directories. |
| Folder creation destination | Existing behavior already targets the viewed breadcrumb directory. Interaction coverage verifies that selecting a child tile does not redirect creation. |
| Recover during scene loading / graph wording | Queue recovery until the pending scene read settles. Banner says document edits. A fully replayed no-op journal is cleared only while all content stays saved. |
| Infinite loops | Warn on unconditional synchronous execution cycles and literal-True While loops. Runtime guard reports explicit asset/graph/node identity and remains contained during startup, ticks and shutdown. Arbitrary data-dependent/JavaScript termination cannot generally be determined at compile time. |
| Stats checked but HUD hidden | The menu controls availability of the overlay button; HUD starts collapsed by design. Labels now say Stats Button, Console Button and Inspector Button. |
| Folder menu lacks Rename | Rename already existed; correcting accidental context multi-selection restores its availability. |
| Material seed nodes overlap | Increase spacing between initial Color and Output nodes, including PostProcess seeds. |
| Emissive clipped / Escape discards color | Current picker uses a viewport-bounded portal with scrolling and fixed actions. The 1100×420 browser check passes; clipping was not reproduced. Escape intentionally cancels its uncommitted draft; Done applies it. |
| PNG thumbnails dark/solid | Encode thumbnails as PNG to retain alpha; use the transparency background and lazily repair old JPEG texture thumbnails when source pixels are available. |

## Verification boundaries

Focused unit, editor interaction, runtime and browser checks are recorded with delivery. Selected checks protect persistence/rename rollback, invalid input and cancellation, scene history/recovery/clipboard, compilation/runtime diagnostics, fog compilation and loading failures. Eight desktop Chromium checks passed at `077823eb2`: rename/move cold reopening, two recovery cases, two numeric persistence cases, fog pixels in editor/Play, and short-viewport Emissive popup reachability. Required PR CI remains the merge gate. No hardware GPU is exposed in this environment; PBR appearance and platform-specific GPU qualification remain unverified.
