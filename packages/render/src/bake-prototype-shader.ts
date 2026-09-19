/** Pinned three-gpu-pathtracer 0.0.24 adapter. Anchor drift is an actionable failure. */
export function patchBakePrototypeShader(source: string): string {
  function replace(anchor: string, replacement: string) {
    if (source.split(anchor).length !== 2) {
      throw new Error(`Unsupported three-gpu-pathtracer shader: expected one ${anchor.slice(0, 70)} anchor`);
    }
    source = source.replace(anchor, replacement);
  }

  replace("// globals", `// globals
    uniform sampler2D bakePositions;
    uniform sampler2D bakeNormals;
    uniform int bakeMode;
    int bakeBounce = 0;
    float bakeContribution( bool direct ) {
      return ( bakeMode == 0 || ( direct ? bakeMode == 1 : bakeMode == 2 ) ) ? 1.0 : 0.0;
    }
    float bakeHitContribution() {
      return bakeBounce == 0 ? 0.0 : bakeContribution( bakeBounce == 1 );
    }`);
  const evaluate = "float bsdfResult( vec3 worldWo, vec3 worldWi, SurfaceRecord surf, inout vec3 color ) {";
  replace(evaluate, `${evaluate}
    if ( bakeBounce == 0 ) {
      float pdf = max( dot( surf.normal, worldWi ), 0.0 ) / PI;
      color = vec3( pdf );
      return pdf;
    }`);
  const sample = "ScatterRecord bsdfSample( vec3 worldWo, SurfaceRecord surf ) {";
  replace(sample, `${sample}
    if ( bakeBounce == 0 ) {
      vec3 wi = diffuseDirection( normalize( surf.normalInvBasis * worldWo ), surf );
      ScatterRecord result;
      result.pdf = max( wi.z, 0.0 ) / PI;
      result.specularPdf = 0.0;
      result.color = vec3( result.pdf );
      result.direction = normalize( surf.normalBasis * wi );
      return result;
    }`);
  replace("Ray ray = getCameraRay();", `vec4 receiver = texelFetch( bakePositions, ivec2( gl_FragCoord.xy ), 0 );
    if ( receiver.a == 0.0 ) { gl_FragColor = vec4( 0.0 ); return; }
    vec3 receiverNormal = texelFetch( bakeNormals, ivec2( gl_FragCoord.xy ), 0 ).xyz;
    Ray ray;
    ray.origin = receiver.xyz + receiverNormal * 0.001;
    ray.direction = -receiverNormal;`);
  const loop = "for ( int i = 0; i < bounces; i ++ ) {";
  replace(loop, `${loop}
    bakeBounce = i;`);
  const hit = "int hitType = traceScene( ray, state.fogMaterial, surfaceHit );";
  replace(hit, `${hit}
    // The supplied receiver must be the first nearby hit, not an unrelated occluder.
    if ( i == 0 && ( hitType == NO_HIT || abs( surfaceHit.dist - 0.001 ) > 0.0002 ) ) {
      gl_FragColor = vec4( 0.0 ); break;
    }`);
  const scatter = "scatterRec = bsdfSample( - ray.direction, surf );";
  replace(scatter, `if ( i == 0 ) {
      surf.normal = receiverNormal;
      surf.normalBasis = getBasisFromNormal( receiverNormal );
      surf.normalInvBasis = inverse( surf.normalBasis );
    }
    ${scatter}`);

  // Gate accumulation only. Every estimator still consumes the same random numbers
  // and every mode follows the same path, including Russian roulette / MIS weights.
  for (const term of [
    "lightRec.emission * state.throughputColor * misWeight",
    "lightRec.emission * state.throughputColor",
    "sampleBackground( ray.direction, rand2( 2 ) ) * state.throughputColor",
    "environmentIntensity * envColor * state.throughputColor * misWeight",
    "( surf.emission * state.throughputColor )",
  ]) {
    replace(`gl_FragColor.rgb += ${term};`, `gl_FragColor.rgb += ( ${term} ) * bakeHitContribution();`);
  }
  // Preserve the upstream multiline non-MIS environment expression exactly as found.
  const environment = /gl_FragColor\.rgb \+=\s+environmentIntensity \*\s+sampleEquirectColor\( envMapInfo\.map, envRotation3x3 \* ray\.direction \) \*\s+state\.throughputColor;/g;
  const environmentMatches = [...source.matchAll(environment)];
  if (environmentMatches.length !== 1) throw new Error("Unsupported path tracer environment accumulation");
  replace(environmentMatches[0][0], "gl_FragColor.rgb += environmentIntensity * sampleEquirectColor( envMapInfo.map, envRotation3x3 * ray.direction ) * state.throughputColor * bakeHitContribution();");
  replace(
    "gl_FragColor.rgb += directLightContribution( - ray.direction, surf, state, hitPoint );",
    "gl_FragColor.rgb += directLightContribution( - ray.direction, surf, state, hitPoint ) * bakeContribution( i == 0 );",
  );
  replace("gl_FragColor.a *= opacity;", `// Unit-albedo Lambertian outgoing radiance is irradiance / PI.
    gl_FragColor.rgb *= PI;
    gl_FragColor.a *= opacity;`);
  return source;
}
