import { useEffect, useRef, useState } from "react";
import {
  AmbientLight,
  DirectionalLight,
  Group,
  Mesh,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  Texture,
  WebGLRenderer,
  type Material,
  type Object3D,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

function disposeObject(root: Object3D) {
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    object.geometry.dispose();
    for (const material of Array.isArray(object.material)
      ? object.material
      : [object.material])
      materials.add(material);
  });
  for (const material of materials) {
    for (const value of Object.values(material))
      if (value instanceof Texture) textures.add(value);
    material.dispose();
  }
  for (const texture of textures) texture.dispose();
}

/** Decorative launcher canvas. No engine state or editor imports. */
export default function HomepageSculpture({
  onReady,
  paused = false,
}: {
  onReady?: () => void;
  paused?: boolean;
}) {
  const readyCallback = useRef(onReady);
  readyCallback.current = onReady;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const motionRef = useRef<() => void>(() => {});
  useEffect(() => {
    motionRef.current();
  }, [paused]);
  const host = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({
        alpha: true,
        antialias: true,
        powerPreference: "low-power",
      });
    } catch {
      readyCallback.current?.();
      return;
    }
    let disposed = false;
    let frame = 0;
    let lastFrame = 0;
    let elapsed = 0;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const scene = new Scene();
    const camera = new PerspectiveCamera(32, 1, 0.1, 40);
    camera.position.set(0, 0, 9.2);
    const pivot = new Group();
    scene.add(pivot, new AmbientLight(0xffffff, 1.2));
    const key = new DirectionalLight(0xdce5ff, 4);
    key.position.set(-3, 5, 6);
    scene.add(key);
    const rim = new DirectionalLight(0x8c9abe, 3);
    rim.position.set(4, -1, 2);
    scene.add(rim);
    const pmrem = new PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    const environment = pmrem.fromScene(room, 0.04);
    scene.environment = environment.texture;
    room.dispose();
    pmrem.dispose();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setClearColor(0x000000, 0);
    element.appendChild(renderer.domElement);
    const target = { x: 0, y: 0 };
    const resize = () => {
      const { width, height } = element.getBoundingClientRect();
      renderer.setSize(width, height, false);
      camera.aspect = width / Math.max(height, 1);
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    const pointer = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" || reduced.matches) return;
      const rect = element.getBoundingClientRect();
      target.x = (event.clientX - rect.left) / rect.width - 0.5;
      target.y = (event.clientY - rect.top) / rect.height - 0.5;
    };
    const leave = () => {
      target.x = 0;
      target.y = 0;
    };
    element.addEventListener("pointermove", pointer);
    element.addEventListener("pointerleave", leave);
    const draw = (time: number) => {
      if (disposed || document.hidden || pausedRef.current) return;
      frame = requestAnimationFrame(draw);
      if (time - lastFrame < 1000 / 30 - 1) return;
      elapsed += Math.min((time - lastFrame) / 1000, 0.05);
      lastFrame = time;
      pivot.rotation.x += (0.13 + target.y * 0.2 - pivot.rotation.x) * 0.06;
      pivot.rotation.y += (-0.28 + target.x * 0.3 - pivot.rotation.y) * 0.06;
      pivot.rotation.z = -0.1 + Math.sin(elapsed * 0.35) * 0.035;
      pivot.position.y = Math.sin(elapsed * 0.7) * 0.09;
      renderer.render(scene, camera);
    };
    const motion = () => {
      cancelAnimationFrame(frame);
      if (!reduced.matches && !document.hidden && !pausedRef.current)
        frame = requestAnimationFrame(draw);
      else renderer.render(scene, camera);
    };
    motionRef.current = motion;
    document.addEventListener("visibilitychange", motion);
    reduced.addEventListener("change", motion);
    const controller = new AbortController();
    const deadline = window.setTimeout(() => controller.abort(), 12000);
    void fetch(`${import.meta.env.BASE_URL}launcher/slate-object.glb`, {
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error("Model unavailable");
        return response.arrayBuffer();
      })
      .then((data) => new GLTFLoader().parseAsync(data, ""))
      .then((gltf) => {
        if (disposed) {
          disposeObject(gltf.scene);
          return;
        }
        clearTimeout(deadline);
        pivot.add(gltf.scene);
        pivot.rotation.set(0.13, -0.28, -0.1);
        resize();
        setReady(true);
        readyCallback.current?.();
        motion();
      })
      .catch(() => {
        clearTimeout(deadline);
        if (!disposed) readyCallback.current?.();
        /* Release the loading cover even when the model is unavailable. */
      });
    return () => {
      disposed = true;
      motionRef.current = () => {};
      controller.abort();
      clearTimeout(deadline);
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("visibilitychange", motion);
      reduced.removeEventListener("change", motion);
      element.removeEventListener("pointermove", pointer);
      element.removeEventListener("pointerleave", leave);
      disposeObject(pivot);
      environment.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, []);
  return (
    <div
      ref={host}
      className="homepage-sculpture"
      data-ready={ready}
      aria-hidden="true"
    />
  );
}
