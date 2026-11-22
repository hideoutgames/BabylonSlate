import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
// Babylon's reflection blur, which the paired program is derived from: importing it registers it in the shader store.
import "@babylonjs/core/Shaders/screenSpaceReflection2Blur.fragment";
import { ambientOcclusionBlurSource } from "./ambient-occlusion-shader";

/**
 * The ambient occlusion blur and the reflection blur of one axis in one pass: one fragment program writes the
 * reflection blur's target as colour attachment 0 and the occlusion blur's as attachment 1. Neither blur reads the
 * other's chain (the occlusion blur X reads the occlusion march and the depth, the reflection blur X the trace), so
 * drawing them together, after the trace, is exact. Each blur's code is its own pass's: the occlusion blur's from the
 * same generator as its own shader (`ambientOcclusionBlurSource`), the reflection blur's derived from Babylon's own
 * shader as the store holds it (`reflectionBlurSource`), with only how each ends a pixel and its clashing names
 * changed. A tile-based GPU then loads, clears and stores one pass instead of two, twice per frame.
 *
 * A temporary measurement switch, `worlddebug pairedblurs on`, off by default until a native GPU proves the bytes and
 * the device Profile its saving: afterwards it becomes the only path, or it is removed.
 */

/** The paired pass of `axis`: its task's name. */
export const pairedBlurName = (axis: "X" | "Y") => `Paired blurs ${axis}`;

/** Babylon's reflection blur in the shader store, and the strength `SpatialEffects` gives it. */
export const REFLECTION_BLUR_SHADER = "screenSpaceReflection2BlurPixelShader";
export const REFLECTION_BLUR_STRENGTH = 0.03;

/** The paired program's occlusion input: the reflection blur keeps Babylon's `textureSampler`, the task's source. */
export const PAIRED_OCCLUSION_SAMPLER = "hapticOcclusionBlurSampler";
/** Its uniforms (Babylon adds the post-process `scale`) and samplers (Babylon adds `textureSampler`). */
export const PAIRED_BLUR_UNIFORMS: readonly string[] = ["aoBlurStep", "texelOffsetScale"];
export const PAIRED_BLUR_SAMPLERS: readonly string[] = [PAIRED_OCCLUSION_SAMPLER, "depthSampler"];

const REFLECTION_OUTPUT = "hapticBlurReflection";
const OCCLUSION_OUTPUT = "hapticBlurOcclusion";
/** Babylon's global tap weights, renamed: the occlusion blur's main declares a local `weights`. */
const REFLECTION_WEIGHTS = "hapticReflectionBlurWeights";

/** `text` with each of the `count` occurrences of `from` replaced; throws when it has another count. */
function replaceExactly(text: string, from: string, to: string, count: number): string {
  const parts = text.split(from);
  if (parts.length - 1 !== count)
    throw new Error(`Babylon's reflection blur shader holds "${from}" ${parts.length - 1} times, not ${count}: the paired blur cannot be derived from it.`);
  return parts.join(to);
}

/**
 * Babylon's reflection blur (`screenSpaceReflection2Blur.fragment`) in parts: its declarations and functions, and its
 * main's body. Every change is a replacement that must find its pattern the stated number of times, else it throws, so
 * a Babylon upgrade that changes the shader fails here (and in its test) instead of drawing something else:
 * - its `varying vec2 vUV;` is left out (the occlusion blur declares it);
 * - its global `weights` (declaration and `processSample`'s read) is renamed;
 * - main's early `{gl_FragColor=colorFull;return;}` assigns the output and opens an `else` holding the rest of the body,
 *   which the body's end closes, so the pixel's other blur still runs and no helper gains a `return`;
 * - main's last `gl_FragColor=` assigns the output.
 * The taps, their weights and their order are Babylon's text, unchanged.
 */
export function reflectionBlurSource(source = ShaderStore.ShadersStore[REFLECTION_BLUR_SHADER]): { header: string; body: string } {
  if (!source) throw new Error(`Babylon's reflection blur shader (${REFLECTION_BLUR_SHADER}) is not in the shader store.`);
  const sides = source.split("void main()");
  if (sides.length !== 2) throw new Error("Babylon's reflection blur shader does not hold one main.");
  const main = sides[1]!.trim();
  if (!main.startsWith("{") || !main.endsWith("}")) throw new Error("Babylon's reflection blur shader's main is not one block.");
  let header = replaceExactly(sides[0]!, "varying vec2 vUV;", "", 1);
  header = replaceExactly(header, "weights[", `${REFLECTION_WEIGHTS}[`, 2);
  let body = replaceExactly(main.slice(1, -1), "{gl_FragColor=colorFull;return;}", `{${REFLECTION_OUTPUT}=colorFull;} else {`, 1);
  body = replaceExactly(body, "gl_FragColor=vec4(", `${REFLECTION_OUTPUT}=vec4(`, 1);
  body += "\n}";
  if (/gl_FragColor|gl_FragData|\breturn\b|\bdiscard\b/.test(header + body))
    throw new Error("Babylon's reflection blur shader writes or ends its pixel in a way the paired blur does not change.");
  return { header, body };
}

/**
 * The paired program: the occlusion blur's declarations (reading `PAIRED_OCCLUSION_SAMPLER`), the reflection blur's
 * declarations and functions, both outputs, and main running each blur's body in a block of its own, the reflection's
 * first. Neither body returns, discards or writes `gl_FragColor`; the `layout(location = 0) out` declaration also stops
 * Babylon adding its own output.
 */
export function pairedBlurShader(reflection = reflectionBlurSource()): string {
  const occlusion = ambientOcclusionBlurSource(PAIRED_OCCLUSION_SAMPLER, (value) => `${OCCLUSION_OUTPUT} = ${value};`);
  return `${occlusion.header}${reflection.header}
layout(location = 0) out vec4 ${REFLECTION_OUTPUT};
layout(location = 1) out vec4 ${OCCLUSION_OUTPUT};
void main() {
{${reflection.body}}
{${occlusion.body}}
}
`;
}

/**
 * The reflection blur's `texelOffsetScale` for a target of `width` x `height` along `direction`, computed in the order
 * Babylon's `ThinSSRBlurPostProcess.bind` computes it, so the float the uniform holds is the same.
 */
export function reflectionBlurOffset(width: number, height: number, direction: { x: number; y: number },
  strength = REFLECTION_BLUR_STRENGTH): [number, number] {
  return [(1 / width) * direction.x * strength, (1 / height) * direction.y * strength];
}
