import { useEffect, useRef, useState } from "react";
import { Texture, type Engine } from "@babylonjs/core";
import {
  createDefaultParticleSystemPayload,
  normalizeParticleEmitterPayload,
  type ParticleEmitterPayload,
  type ParticleSystemPayload,
} from "@babylonslate/assets";
import {
  ParticleService,
  ResourceCache,
  createMaterialPreviewPresenter,
  createParticlePreviewScene,
  type MaterialPreviewPresenter,
  type MaterialPreviewScene,
} from "@babylonslate/render";
import { useDocuments } from "../context/document-context";
import { useOptionalPlay } from "../context/play-context";
import type { PlayParticleLibrary } from "../lib/play-particles";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function loadTextureBytes(
  readAssetChunk: (path: string, chunkId: string) => Promise<Uint8Array | null>,
  path: string,
): Promise<Uint8Array | null> {
  const pixels = await readAssetChunk(path, "pixels");
  if (pixels && pixels.byteLength > 0) return pixels;
  const source = await readAssetChunk(path, "source");
  return source && source.byteLength > 0 ? source : null;
}

export function ParticlePreviewCanvas({
  library,
  systemGuid,
  testId,
}: {
  library: PlayParticleLibrary;
  systemGuid: string;
  testId: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const play = useOptionalPlay();
  const { assetRegistry, readAssetChunk } = useDocuments();
  const [engine, setEngine] = useState<Engine | null>(null);

  useEffect(() => {
    setEngine(play?.ensureSharedEngine() ?? null);
  }, [play]);

  const libraryKey = JSON.stringify({
    emitters: [...library.emitters.entries()],
    systems: [...library.systems.entries()],
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !engine || !readAssetChunk) return;
    const snapshot = JSON.parse(libraryKey) as {
      emitters: Array<[string, ParticleEmitterPayload]>;
      systems: Array<[string, ParticleSystemPayload]>;
    };
    const nextLibrary: PlayParticleLibrary = {
      emitters: new Map(snapshot.emitters),
      systems: new Map(snapshot.systems),
    };
    let cancelled = false;
    let host: MaterialPreviewScene | null = null;
    let presenter: MaterialPreviewPresenter | null = null;
    let service: ParticleService | null = null;
    let cache: ResourceCache | null = null;
    let frame = 0;
    void (async () => {
      const bytes = new Map<string, Uint8Array>();
      const assets = assetRegistry?.list() ?? [];
      for (const emitter of nextLibrary.emitters.values()) {
        const guid = emitter.textureGuid;
        if (!guid || bytes.has(guid)) continue;
        const asset = assets.find((entry) => entry.header.guid === guid);
        if (!asset) continue;
        const loaded = await loadTextureBytes(readAssetChunk, asset.path);
        if (loaded) bytes.set(guid, loaded);
      }
      if (cancelled) return;
      try {
        host = createParticlePreviewScene(engine);
        presenter = createMaterialPreviewPresenter(host, canvas);
        cache = new ResourceCache();
        service = new ParticleService({
          scene: host.scene,
          resolveTexture: (guid) => {
            const data = bytes.get(guid);
            if (!data || !cache) return null;
            const texture = cache.getTexture(guid, engine, data);
            return texture instanceof Texture ? texture : null;
          },
        });
        service.setLibrary(nextLibrary);
        service.handleCommand({
          type: "assignParticle",
          slotId: 0,
          actorGuid: "preview",
          componentId: "preview",
          particleSystemGuid: systemGuid,
          play: true,
        });
      } catch {
        presenter?.dispose();
        host?.dispose();
        service?.dispose();
        cache?.dispose();
        return;
      }
      if (cancelled) {
        presenter?.dispose();
        host?.dispose();
        service?.dispose();
        cache?.dispose();
        return;
      }
      const tick = () => {
        presenter?.present();
        frame = window.requestAnimationFrame(tick);
      };
      frame = window.requestAnimationFrame(tick);
    })();
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      service?.dispose();
      presenter?.dispose();
      host?.dispose();
      cache?.dispose();
    };
  }, [assetRegistry, engine, libraryKey, readAssetChunk, systemGuid]);

  return (
    <canvas
      ref={canvasRef}
      className="h-full w-full"
      data-testid={testId}
    />
  );
}

export function emitterPreviewLibrary(
  emitter: ParticleEmitterPayload,
): PlayParticleLibrary {
  return {
    emitters: new Map([["preview-em", emitter]]),
    systems: new Map([
      [
        "preview-sys",
        {
          ...createDefaultParticleSystemPayload(),
          emitterGuids: ["preview-em"],
        },
      ],
    ]),
  };
}

export function systemPreviewLibrary(
  system: ParticleSystemPayload,
  emitters: ReadonlyMap<string, ParticleEmitterPayload>,
): PlayParticleLibrary {
  const used = new Map<string, ParticleEmitterPayload>();
  for (const guid of system.emitterGuids) {
    const emitter = emitters.get(guid);
    if (emitter) used.set(guid, emitter);
  }
  return {
    emitters: used,
    systems: new Map([["preview-sys", system]]),
  };
}

export function emittersFromRegistry(
  assets: ReadonlyArray<{
    header: { guid: string; type: string; payload?: Record<string, unknown> };
  }>,
  openPayloads: ReadonlyMap<string, unknown>,
): Map<string, ParticleEmitterPayload> {
  const emitters = new Map<string, ParticleEmitterPayload>();
  for (const asset of assets) {
    if (asset.header.type !== "ParticleEmitter") continue;
    const payload =
      openPayloads.get(asset.header.guid) ?? asset.header.payload ?? {};
    emitters.set(
      asset.header.guid,
      normalizeParticleEmitterPayload(asRecord(payload)),
    );
  }
  return emitters;
}
