import type { Completion, CompletionContext } from "@codemirror/autocomplete";

const GLSL_FUNCTIONS = "abs acos asin atan ceil clamp cos cross degrees distance dot exp exp2 floor fract inversesqrt length log log2 max min mix mod normalize pow radians reflect refract round sign sin smoothstep sqrt step tan texture textureLod transpose dFdx dFdy fwidth".split(" ");
const GLSL_KEYWORDS = "return if else for while break continue discard true false const in out inout".split(" ");
const GLSL_TYPES = "float int bool vec2 vec3 vec4 ivec2 ivec3 ivec4 bvec2 bvec3 bvec4 mat2 mat3 mat4".split(" ");

/** Small local completion source; authored code is never executed to get hints. */
export function codeCompletions(context: CompletionContext, language: "glsl" | "javascript", names: readonly string[]) {
  const word = context.matchBefore(/[A-Za-z_][A-Za-z0-9_]*/);
  if (!word && !context.explicit) return null;
  const options: Completion[] = names.filter((name) => /^[A-Za-z_$][\w$]*$/.test(name)).map((label) => ({ label, type: "variable", boost: 10 }));
  if (language === "glsl") {
    options.push(...GLSL_FUNCTIONS.map((label) => ({ label, type: "function" })), ...GLSL_KEYWORDS.map((label) => ({ label, type: "keyword" })), ...GLSL_TYPES.map((label) => ({ label, type: "type" })));
  }
  const declarations = context.state.doc.toString().matchAll(language === "glsl" ? /\b(?:float|int|bool|[ib]?vec[234]|mat[234])\s+([A-Za-z_]\w*)/g : /\b(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g);
  for (const match of declarations) options.push({ label: match[1]!, type: "variable" });
  return { from: word?.from ?? context.pos, options: [...new Map(options.map((option) => [option.label, option])).values()], validFor: /^[\w$]*$/ };
}
