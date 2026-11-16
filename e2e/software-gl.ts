/** Functional fixtures only: the software rasteriser never qualifies device performance. */
export const SOFTWARE_GL_ARGS = [
  process.platform === "win32" ? "--use-angle=d3d11-warp" : "--use-angle=swiftshader",
];
