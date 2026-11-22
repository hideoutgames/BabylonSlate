import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { SHARED_OUTLINE_GROUPS, SHARED_OUTLINE_MAX_WIDTH } from "./shared-outline";

/**
 * The shared outline stroke as one GLSL include, the only copy of its maths: the outline composition's own pass
 * (`hapticSharedOutlineCompose`) and the Display Color pass that composites the strokes itself (its `OUTLINE` stage)
 * both include it. `vec4 hapticSharedOutlineStroke(vec2 pixelUV)` returns the stroke over the pixel at `pixelUV`:
 * its style colour and coverage, or zero where no stroke lands, which the composition blends with `ALPHA_COMBINE`.
 * Every group whose `activeGroups` entry is zero is skipped before any of its textures is read.
 */
export const SHARED_OUTLINE_STROKE_INCLUDE = "hapticSharedOutlineStroke";

/** The uniforms the stroke reads, set each frame by `FrameGraphSharedOutlineTask.bindStroke`. */
export const SHARED_OUTLINE_STROKE_UNIFORMS: readonly string[] = [
  "screenSize", "tableSize", "maximumWidth", "maximumWidths", "reverseDepth", "activeGroups", "inverseProjection",
  "depthRange", "distanceFadeEnabled",
];

/** The samplers the stroke reads: the strict mask's depth, and each group's identity mask and style table. */
export const SHARED_OUTLINE_STROKE_SAMPLERS: readonly string[] = [
  "strictDepth", ...SHARED_OUTLINE_GROUPS.flatMap((group) => [`${group}Mask`, `${group}Style`]),
];

const offsets = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
// Keep one candidate body instead of eight copies of the fade calculation.
// These nearest, non-mipmapped buffers need no implicit texture derivatives.
// Round group bounds up for lower-precision style sampling, retaining the
// original view-wide cap so rounding neither removes nor adds edge pixels.
const candidates = SHARED_OUTLINE_GROUPS.map((group, groupIndex) => `if (activeGroups[${groupIndex}] > 0.5) {
    float center = decodeId(texture2DLodEXT(${group}Mask, pixelUV, 0.0).rgb);
    float best = 1e10;
    float chosen = 1e10;
    vec4 stroke = vec4(0.0);${group === "strict" ? `
    // This pixel's own depth, read at its first candidate: once per pixel, and not at all where no neighbour differs.
    float destinationDepth = 0.0;
    bool destinationRead = false;` : ""}
    for (int radius = 1; radius <= ${SHARED_OUTLINE_MAX_WIDTH}; ++radius) {
      if (float(radius) > min(maximumWidth, ceil(maximumWidths[${groupIndex}])) + 0.75) break;
      for (int direction = 0; direction < 8; ++direction) {
        vec2 delta = outlineOffsets[direction] * float(radius);
        vec2 uv = pixelUV + delta / screenSize;
        float id = decodeId(texture2DLodEXT(${group}Mask, uv, 0.0).rgb);
        if (id > 0.0 && id != center) {
          vec4 style = texture2DLodEXT(${group}Style, idUV(id), 0.0);
          float distance = length(delta);
          float width = style.a;
          float coverage = 1.0;
          bool visible = true;
          ${group === "strict" ? `float candidateDepth = texture2DLodEXT(strictDepth, uv, 0.0).r;
          if (!destinationRead) { destinationDepth = texture2DLodEXT(strictDepth, pixelUV, 0.0).r; destinationRead = true; }
          visible = reverseDepth > 0.5 ? candidateDepth >= destinationDepth : candidateDepth <= destinationDepth;
          if (distanceFadeEnabled > 0.5) {
            vec4 fade = texture2DLodEXT(strictStyle, idUV(id) + vec2(0.0, 0.5), 0.0);
            if (fade.x > 0.5) {
              vec4 position = inverseProjection * vec4(uv * 2.0 - 1.0, candidateDepth * depthRange.x + depthRange.y, 1.0);
              float cameraDistance = length(position.xyz) / max(abs(position.w), 1e-8);
              width *= 1.0 - smoothstep(fade.y, fade.z, cameraDistance);
              // Preserve the authored footprint at full width. As it shrinks, the
              // outer samples lose coverage first; the first pixel survives all
              // the way to width zero, including authored subpixel widths.
              float edge = max(0.0, distance - 1.0);
              coverage = clamp((width - edge) / max(clamp(style.a - edge, 0.0, 1.0), 1e-4), 0.0, 1.0);
            }
          }` : ""}
          float score = distance / max(width, 1e-4);
          if (visible && coverage > 0.0 && distance <= style.a + 0.75 && (score < best || (score == best && id < chosen))) {
            stroke = vec4(style.rgb, coverage); best = score; chosen = id;
          }
        }
      }
    }
    if (stroke.a > 0.0) result = stroke;
  }`).join("\n  ");

ShaderStore.IncludesShadersStore[SHARED_OUTLINE_STROKE_INCLUDE] = `
uniform vec2 screenSize;
uniform vec2 tableSize;
uniform float maximumWidth;
uniform vec3 maximumWidths;
uniform float distanceFadeEnabled;
uniform float reverseDepth;
uniform vec3 activeGroups;
uniform mat4 inverseProjection;
uniform vec2 depthRange;
uniform sampler2D strictDepth;
${SHARED_OUTLINE_GROUPS.map((group) => `uniform sampler2D ${group}Mask; uniform sampler2D ${group}Style;`).join("\n")}
const vec2 outlineOffsets[8] = vec2[8](${offsets.map(([x, y]) => `vec2(${x}.0, ${y}.0)`).join(", ")});
float decodeId(vec3 value) { return dot(floor(value * 255.0 + 0.5), vec3(1.0, 256.0, 65536.0)); }
vec2 idUV(float id) { return (vec2(mod(id, tableSize.x), floor(id / tableSize.x)) + 0.5) / tableSize; }
vec4 ${SHARED_OUTLINE_STROKE_INCLUDE}(vec2 pixelUV) {
  vec4 result = vec4(0.0);
  ${candidates}
  return result;
}
`;
