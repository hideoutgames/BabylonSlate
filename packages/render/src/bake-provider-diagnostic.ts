/** Native camera transport control for the bounded provider-selection browser proof. */
import { BufferAttribute, BufferGeometry, Color, Mesh, MeshBasicMaterial, MeshPhysicalMaterial, PerspectiveCamera, PointLight, Scene, WebGLRenderer } from "three";
import { WebGLPathTracer } from "three-gpu-pathtracer";
import { readBakePixels, waitForBakeGpu } from "./bake-prototype-gpu";

export async function diagnoseNativeBakeTransport(report: (phase: string) => void) {
  const started = performance.now();
  const checkpoint = async () => {
    if (performance.now() - started > 30_000) throw new Error("Native transport control exceeded 30 seconds");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  };
  const canvas = document.createElement("canvas");
  const renderer = new WebGLRenderer({ canvas, antialias: false });
  const gl = renderer.getContext() as WebGL2RenderingContext;
  renderer.setSize(4, 4, false);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array([-0.5, 0, -0.5, -0.5, 0, 0.5, 0.5, 0, 0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 0, -0.5]), 3));
  geometry.computeVertexNormals();
  const material = new MeshPhysicalMaterial({ color: new Color(0.5, 0.5, 0.5), roughness: 1, metalness: 0, specularIntensity: 0 });
  const scene = new Scene();
  scene.add(new Mesh(geometry, material));
  const light = new PointLight(0xffffff, 4, 0, 2);
  light.position.set(0, 2, 0);
  scene.add(light);
  const camera = new PerspectiveCamera(50, 1, 0.01, 100);
  camera.position.set(0, 0.7, 0.7);
  camera.lookAt(0, 0, 0);
  let tracer: WebGLPathTracer | undefined;
  try {
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    report(`renderer ${debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER))}`);
    renderer.setClearColor(0x4080bf, 1);
    renderer.clear();
    report("clear fence submitted");
    await waitForBakeGpu(gl, checkpoint);
    report("clear fence completed");
    const raster = new MeshBasicMaterial({ color: 0xffffff });
    try {
      scene.overrideMaterial = raster;
      renderer.render(scene, camera);
      report("raster fence submitted");
      await waitForBakeGpu(gl, checkpoint);
      report("raster fence completed");
    } finally {
      scene.overrideMaterial = null;
      raster.dispose();
    }
    report("native constructing");
    tracer = new WebGLPathTracer(renderer);
    tracer.renderDelay = 0;
    tracer.renderToCanvas = false;
    tracer.rasterizeScene = false;
    tracer.bounces = 3;
    tracer.transmissiveBounces = 0;
    tracer.tiles.set(1, 1);
    tracer.setScene(scene, camera);
    report("native sampling");
    let reportedSamples = -1;
    while (tracer.samples < 1) {
      tracer.renderSample();
      if (tracer.samples !== reportedSamples) {
        reportedSamples = tracer.samples;
        report(`native tile submitted, samples ${tracer.samples}, compiling ${tracer.isCompiling}, target ${tracer.target.width}x${tracer.target.height}`);
      }
      await waitForBakeGpu(gl, checkpoint);
    }
    report(`native completed ${tracer.target.width}x${tracer.target.height}`);
    const pixels = new Float32Array(4 * 4 * 4);
    await readBakePixels(renderer, tracer.target, pixels, checkpoint);
    report("native readback complete");
    return { pixels: [...pixels], elapsedMs: performance.now() - started };
  } finally {
    tracer?.dispose();
    geometry.dispose();
    material.dispose();
    renderer.dispose();
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
