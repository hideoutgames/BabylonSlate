/** Functional fixtures only; these software adapters never qualify device performance. */
export const SOFTWARE_WEBGPU_ARGS = [
  "--enable-unsafe-webgpu",
  process.platform === "win32" ? "--use-angle=d3d11-warp" : "--use-angle=swiftshader",
  "--use-webgpu-adapter=swiftshader",
  ...(process.platform === "linux" ? [
    "--enable-features=Vulkan", "--use-vulkan=swiftshader", "--disable-vulkan-surface",
  ] : []),
];
