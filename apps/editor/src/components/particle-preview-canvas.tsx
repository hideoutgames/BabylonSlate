import { useEffect, useRef, useState } from "react";
import { Texture, type Engine } from "@babylonjs/core";
import type {
  ParticleEmitterPayload,
  ParticleSystemPayload,
} from "@babylonslate/assets";
import {
  ParticleService,
  ResourceCache,
  createMaterialPreviewPresenter,
  createParticleMaterialResolver,
  createParticlePreviewScene,
  type MaterialPreviewPresenter,
  type MaterialPreviewScene,
  type ParticleServiceDiagnostic,
} from "@babylonslate/render";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@babylonslate/ui/components/empty";
import { useDocuments } from "../context/document-context";
import { useOptionalPlay } from "../context/play-context";
import {
  particleMaterialGuidsFromLibrary,
  type PlayParticleLibrary,
} from "../lib/play-particles";

async function loadTextureBytes(
  readAssetChunk: (path: string, chunkId: string) => Promise<Uint8Array | null>,
  path: string,
): Promise<Uint8Array | null> {
  const pixels = await readAssetChunk(path, "pixels");
  if (pixels && pixels.byteLength > 0) return pixels;
  const source = await readAssetChunk(path, "source");
  return source && source.byteLength > 0 ? source : null;
}

function libraryLook(
  library: PlayParticleLibrary,
): "no-emitters" | "no-texture" | "ok" {
  if (library.emitters.size === 0) return "no-emitters";
  for (const emitter of library.emitters.values()) {
    if (emitter.textureGuid) return "ok";
  }
  return "no-texture";
}

function PreviewStatusEmpty({
  title,
  description,
  testId,
}: {
  title: string;
  description: string;
  testId: string;
}) {
  return (
    <Empty data-testid={testId}>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
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
  const { assetRegistry, readAssetChunk, collectPlayMaterialLibrary } =
    useDocuments();
  const [engine, setEngine] = useState<Engine | null>(null);
  const [booted, setBooted] = useState(false);
  const [skipped, setSkipped] = useState<ParticleServiceDiagnostic | null>(
    null,
  );

  useEffect(() => {
    setEngine(play?.ensureSharedEngine() ?? null);
  }, [play]);

  const look = libraryLook(library);
  const libraryKey = JSON.stringify({
    emitters: [...library.emitters.entries()],
    systems: [...library.systems.entries()],
  });

  useEffect(() => {
    setBooted(false);
    setSkipped(null);
    const canvas = canvasRef.current;
    if (!canvas || !engine || !readAssetChunk) return;
    if (look !== "ok") return;
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
    let materials: ReturnType<typeof createParticleMaterialResolver> | null =
      null;
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
      const diagnostics: ParticleServiceDiagnostic[] = [];
      try {
        host = createParticlePreviewScene(engine);
        presenter = createMaterialPreviewPresenter(host, canvas);
        cache = new ResourceCache();
        const resolveTexture = (guid: string) => {
          const data = bytes.get(guid);
          if (!data || !cache) return null;
          const texture = cache.getTexture(guid, engine, data);
          return texture instanceof Texture ? texture : null;
        };
        const extraGuids = particleMaterialGuidsFromLibrary(nextLibrary);
        const libraryDocs = collectPlayMaterialLibrary
          ? await collectPlayMaterialLibrary(undefined, [], extraGuids)
          : {
              documents: new Map(),
              functions: new Map(),
              textureGuids: [],
            };
        materials = createParticleMaterialResolver({
          scene: host.scene,
          documents: libraryDocs.documents,
          functions: libraryDocs.functions,
          resolveTexture,
        });
        service = new ParticleService({
          scene: host.scene,
          resolveTexture,
          resolveMaterial: materials.resolve,
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
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
        materials?.dispose();
        cache?.dispose();
        if (!cancelled) {
          setSkipped({
            code: "particle.apply_failed",
            message: "Particle Emitter failed to apply; slot skipped.",
          });
          setBooted(true);
        }
        return;
      }
      if (cancelled) {
        presenter?.dispose();
        host?.dispose();
        service?.dispose();
        materials?.dispose();
        cache?.dispose();
        return;
      }
      if ((service?.stats().systems ?? 0) === 0) {
        presenter.dispose();
        host.dispose();
        service.dispose();
        materials.dispose();
        cache.dispose();
        setSkipped(
          diagnostics[0] ?? {
            code: "particle.missing_texture",
            message: "Particle Emitter has no Texture; slot skipped.",
          },
        );
        setBooted(true);
        return;
      }
      presenter.present();
      setBooted(true);
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
      materials?.dispose();
      presenter?.dispose();
      host?.dispose();
      cache?.dispose();
    };
  }, [
    assetRegistry,
    collectPlayMaterialLibrary,
    engine,
    libraryKey,
    look,
    readAssetChunk,
    systemGuid,
  ]);

  if (look === "no-emitters" || skipped?.code === "particle.unknown_emitter") {
    return (
      <PreviewStatusEmpty
        testId="particle-preview-empty"
        title="Missing Emitter"
        description="Particle System references a Particle Emitter that could not be loaded."
      />
    );
  }
  if (look === "no-texture" || skipped?.code === "particle.missing_texture") {
    return (
      <PreviewStatusEmpty
        testId="particle-preview-empty"
        title="No Texture"
        description="Pick a Texture on the Particle Emitter. Billboard quads sample that Texture."
      />
    );
  }

  return (
    <div className="relative h-full w-full">
      <canvas
        ref={canvasRef}
        className="h-full w-full"
        data-testid={testId}
      />
      {!booted ? (
        <div className="absolute inset-0">
          <PreviewStatusEmpty
            testId="particle-preview-loading"
            title="Loading Preview"
            description="Starting the particle Preview on the shared Engine."
          />
        </div>
      ) : null}
    </div>
  );
}
