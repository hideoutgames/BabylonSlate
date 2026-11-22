/**
 * Babylon side effects that Haptic's Engines rely on and that no imported Babylon class module registers itself.
 * Haptic imports Babylon by module, never from the `@babylonjs/core` root (which registers everything), so each
 * engine extension and scene augmentation the renderer calls must be imported once, here or in the module that
 * uses it. `create-engine.ts` loads this module before it constructs an Engine, and each module that builds a FrameGraph
 * or calls the multiple-render-target extension loads it too, for an Engine made without `createEngine`: under
 * `sideEffects`, importing one module of `@haptic/render` evaluates only what that module imports.
 */
// registerView, unRegisterView, _renderViews and inputElement: Scene and Play views (registered-view-admission).
import "@babylonjs/core/Engines/AbstractEngine/abstractEngine.views";
// setAlphaEquation (borrowed draws restore it).
import "@babylonjs/core/Engines/AbstractEngine/abstractEngine.alpha";
// GPU frame time on WebGL2: getGPUFrameTimeCounter and captureGPUFrameTime over timer queries (engine-gpu-timing).
import "@babylonjs/core/Engines/AbstractEngine/abstractEngine.timeQuery";
import "@babylonjs/core/Engines/Extensions/engine.query";
// Multiple render targets: texture layouts and attachments of the geometry pass and logical buffers, with the
// patched deferred attachment restore.
import "@babylonjs/core/Engines/Extensions/engine.multiRender";
// Registered at load rather than by the first DynamicTexture, CubeTexture or AnimationGroup.
import "@babylonjs/core/Engines/Extensions/engine.dynamicTexture";
import "@babylonjs/core/Engines/AbstractEngine/abstractEngine.cubeTexture";
import "@babylonjs/core/Animations/animatable";
// The pass post-process an image larger than the maximum texture size is rescaled with.
import "@babylonjs/core/PostProcesses/passPostProcess";
// createEffectForParticles: NodeMaterial particle effects (material-compiler, particle-system-factory).
import "@babylonjs/core/Particles/particleSystemComponent";
