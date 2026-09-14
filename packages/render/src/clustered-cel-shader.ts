import { checkedShader } from "./checked-shader";

/** Preserve CEL's per-child peak, total and selected highlight inside a cluster. */
export function celClusteredLighting(source: string): string {
  const start = source.indexOf("lightingInfo computeClusteredLighting(");
  if (start < 0)
    throw new Error("Babylon clustered CEL lighting hook is missing.");
  const head = checkedShader(
    source.slice(0, start),
    "clustered CEL result",
  ).replace(
    "{vec3 diffuse;",
    "{vec3 diffuse;float slateCelPeak;float slateCelTotal;",
  ).value;
  const body = checkedShader(source.slice(start), "clustered CEL children")
    .replace(
      "lightingInfo result;ivec2 tilePosition",
      `lightingInfo result;
result.diffuse=vec3(0.0);
result.slateCelPeak=0.0;result.slateCelTotal=0.0;
#ifdef SPECULARTERM
result.specular=vec3(0.0);
#endif
ivec2 tilePosition`,
    )
    .replace(
      "result.diffuse+=info.diffuse;",
      `float incoming=slateCelStrength(info.diffuse);
float wins=incoming>result.slateCelPeak+max(1.0,result.slateCelPeak)*0.00001 ? 1.0 : 0.0;
result.slateCelPeak=max(result.slateCelPeak,incoming);
result.slateCelTotal+=incoming;
result.diffuse=slateCelAccumulate(result.diffuse,info.diffuse,wins);`,
    )
    .replace(
      "result.specular+=info.specular;",
      "result.specular=slateCelAccumulate(result.specular,info.specular,wins);",
    ).value;
  return head + body;
}
