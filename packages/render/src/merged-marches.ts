/**
 * The half-resolution marches of the spatial geometry pass (Screen-Space Shadows, ambient occlusion, volumetric fog) in
 * one pass: one fragment program writes each march's target as a colour attachment of its own (`ScreenShadowsGraph`).
 * Each march's code is its own pass's, moved: its declarations, functions and main's body come from the same generator
 * as its own shader (`MarchSource`), and only how the body ends a pixel differs (`MarchEnds`). So every target holds the
 * bytes its own pass wrote, while a tile-based GPU loads, clears and stores one pass instead of three.
 */

/** How a march's main body ends a pixel. */
export interface MarchEnds {
  /**
   * Ends the pixel early with `value`. Written only as the whole body of an `if` block at the top level of main, never
   * inside a loop: in the merged program it closes that block and opens an `else` holding the rest of the body.
   */
  early(value: string): string;
  /** The body's last statement: the pixel's value. */
  last(value: string): string;
}

/** A march's fragment shader in parts: its declarations, its functions and its main's body. */
export interface MarchSource {
  header: string;
  functions: string;
  body: string;
}

/** A march that can run in the merged pass: its shader's parts and its program's inputs. */
export interface MergedMarch {
  /** Its own pass's name, and its target's. */
  name: string;
  source(ends: MarchEnds): MarchSource;
  uniforms: readonly string[];
  samplers: readonly string[];
  uniformBuffers: readonly string[];
}

/** The merged pass's name. */
export const MERGED_MARCHES_NAME = "Half-resolution marches";

/**
 * Per march, in attachment order (x, y, z, w): above 0.5 it marches this frame; otherwise its attachment keeps the clear's
 * zero, which no reader samples (an idle march's readers read a placeholder or leave its term out).
 */
export const MERGED_MARCH_RUNS = "hapticMarchRuns";

/** Declarations every march repeats: declared once, first. */
const SHARED_DECLARATIONS = ["varying vec2 vUV;", "uniform sampler2D depthSampler;"];

/** A merged program's march output `index`. */
const output = (index: number) => `hapticMarch${index}`;

/**
 * The merged program: each march's declarations (the shared ones once), functions and body, in `marches` order, its
 * body inside a uniform branch on its `MERGED_MARCH_RUNS` component, writing colour attachment `index`. An early end
 * assigns the march's output and skips the rest of its body through an `else`, so no march's end stops another's, and
 * the merge adds no function and no `return` (an early `return` in a helper crashed Chrome's GPU process at link under
 * ANGLE's Direct3D 11); the marches' own functions are moved as they are. No march writes `gl_FragColor` or discards.
 */
export function mergedMarchShader(marches: readonly MergedMarch[]): string {
  if (marches.length < 2 || marches.length > 4) throw new Error("A merged march pass takes two to four marches.");
  let header = `${SHARED_DECLARATIONS.join("\n")}\nuniform vec4 ${MERGED_MARCH_RUNS};\n`;
  let functions = "";
  let outputs = "";
  let main = "";
  marches.forEach((march, index) => {
    let opened = 0;
    const target = output(index);
    const source = march.source({
      early: (value) => {
        opened++;
        return `${target} = ${value}; } else { {`;
      },
      last: (value) => `${target} = ${value};`,
    });
    let own = source.header;
    for (const line of SHARED_DECLARATIONS) {
      if (own.split(line).length !== 2) throw new Error(`${march.name} does not declare "${line}" once.`);
      own = own.replace(line, "");
    }
    if (/gl_FragColor|gl_FragData|\bdiscard\b/.test(source.functions + source.body))
      throw new Error(`${march.name} writes its pixel outside its ends or discards.`);
    header += `${own}\n`;
    functions += `\n${source.functions}\n`;
    outputs += `layout(location = ${index}) out vec4 ${target};\n`;
    main += `${target} = vec4(0.0);\nif (${MERGED_MARCH_RUNS}.${"xyzw"[index]} > 0.5) {\n${source.body}\n${"}".repeat(opened)}\n}\n`;
  });
  return `${header}${functions}${outputs}void main() {\n${main}}\n`;
}

/** The merged program's uniforms, samplers and uniform buffers: every march's, each once. */
export function mergedMarchInputs(marches: readonly MergedMarch[]) {
  const once = (names: readonly string[]) => [...new Set(names)];
  return {
    uniforms: once([MERGED_MARCH_RUNS, ...marches.flatMap((march) => march.uniforms)]),
    samplers: once(marches.flatMap((march) => march.samplers)),
    uniformBuffers: once(marches.flatMap((march) => march.uniformBuffers)),
  };
}
