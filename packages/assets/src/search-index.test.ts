import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { encodeAssetDocument } from "./asset-document";
import { encodeBabasset } from "./babasset";
import { projectContentRoot } from "./content-root";
import { AssetRegistry } from "./registry";
import { ProjectSearchIndex } from "./search-index";

const decodeAssetDocument = vi.hoisted(() => vi.fn());

vi.mock("./asset-document", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./asset-document")>();
  decodeAssetDocument.mockImplementation((...args: unknown[]) =>
    (
      actual.decodeAssetDocument as (
        ...inner: unknown[]
      ) => ReturnType<typeof actual.decodeAssetDocument>
    )(...args),
  );
  return { ...actual, decodeAssetDocument };
});

async function createStorage(): Promise<MemoryStorageAdapter> {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject("search.babproject");
  return storage;
}

async function writeDocument(
  storage: MemoryStorageAdapter,
  path: string,
  document: {
    guid: string;
    type: string;
    name: string;
    payload: Record<string, unknown>;
    parentClass?: string | null;
  },
): Promise<void> {
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (dir) await storage.mkdir(dir, true);
  const bytes = await encodeAssetDocument({
    type: document.type,
    name: document.name,
    guid: document.guid,
    version: 1,
    payload: document.payload,
  });
  await storage.writeBinary(path, bytes);
}

async function writeTexture(
  storage: MemoryStorageAdapter,
  path: string,
  options: { guid: string; name: string; payloadBytes: Uint8Array },
): Promise<void> {
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (dir) await storage.mkdir(dir, true);
  const bytes = await encodeBabasset({
    header: {
      guid: options.guid,
      type: "Texture",
      name: options.name,
      engineVersion: "0.0.0",
      version: 1,
      mode: "thin",
      dependencies: [],
      parentClass: null,
      payload: {},
    },
    chunks: [
      {
        id: "payload",
        kind: "payload",
        mime: "application/octet-stream",
        data: options.payloadBytes,
      },
    ],
  });
  await storage.writeBinary(path, bytes);
}

describe("ProjectSearchIndex", () => {
  it("returns no rows for an empty query", async () => {
    const storage = await createStorage();
    await writeDocument(storage, "assets/main.scene.babasset", {
      guid: "scene-1",
      type: "Scene",
      name: "Main",
      payload: {
        name: "Main",
        viewportMode: "3d",
        actors: [{ id: "actor-1", name: "Cube", classId: "Actor", components: [] }],
      },
    });
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const index = new ProjectSearchIndex(storage);
    await index.rebuild(registry);

    expect(index.query("")).toEqual([]);
    expect(index.query("   ")).toEqual([]);
  });

  it("indexes asset headers and scene actors without loading texture payloads", async () => {
    const storage = await createStorage();
    await writeTexture(storage, "assets/hero.babasset", {
      guid: "tex-1",
      name: "HeroTex",
      payloadBytes: new Uint8Array(512).fill(9),
    });
    await writeDocument(storage, "assets/main.scene.babasset", {
      guid: "scene-1",
      type: "Scene",
      name: "Main",
      payload: {
        name: "Main",
        viewportMode: "3d",
        actors: [
          {
            id: "actor-1",
            name: "Cube",
            classId: "Actor",
            components: [
              {
                id: "component-1",
                classId: "MeshComponent",
                properties: { meshKind: "box" },
              },
            ],
          },
        ],
      },
    });

    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    expect(registry.accountedPayloadBytes).toBe(0);

    const index = new ProjectSearchIndex(storage);
    await index.rebuild(registry);

    expect(registry.accountedPayloadBytes).toBe(0);

    const texHits = index.query("herotex");
    expect(texHits.some((hit) => hit.kind === "asset" && hit.label === "HeroTex")).toBe(
      true,
    );

    const actorHits = index.query("cube");
    expect(actorHits.some((hit) => hit.kind === "actor" && hit.label === "Cube")).toBe(
      true,
    );
    const actor = actorHits.find((hit) => hit.kind === "actor");
    expect(actor?.target).toEqual({
      kind: "scene-actor",
      scenePath: "assets/main.scene.babasset",
      actorId: "actor-1",
    });

    const componentHits = index.query("meshcomponent");
    expect(
      componentHits.some(
        (hit) => hit.kind === "component" && hit.target.kind === "scene-component",
      ),
    ).toBe(true);
  });

  it("indexes graph nodes, variable names, and skips ExecuteJavaScript bodies", async () => {
    const storage = await createStorage();
    await writeDocument(storage, "assets/main.graph.babasset", {
      guid: "graph-1",
      type: "Graph",
      name: "MainGraph",
      payload: {
        nodes: [
          {
            id: "log-1",
            type: "logMessage",
            data: { message: "Hello from BabylonSlate" },
          },
          {
            id: "var-1",
            type: "variables.get",
            data: { variableName: "health" },
          },
          {
            id: "var-2",
            type: "variables.getValidated",
            data: { variableName: "targetActor" },
          },
          {
            id: "js-1",
            type: "debug.executeJavaScript",
            data: { body: "uniqueBodyTokenShouldNotMatch" },
          },
        ],
        edges: [],
      },
    });

    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const index = new ProjectSearchIndex(storage, {
      nodeTitles: {
        logMessage: "Log",
        "variables.get": "Get Variable",
        "variables.getValidated": "Validated Get",
        "debug.executeJavaScript": "Execute JavaScript",
      },
    });
    await index.rebuild(registry);

    const hello = index.query("hello from");
    expect(hello.some((hit) => hit.kind === "graph-node" && hit.target.kind === "graph-node")).toBe(
      true,
    );
    expect(
      hello.find((hit) => hit.kind === "graph-node")?.target,
    ).toMatchObject({
      kind: "graph-node",
      graphPath: "assets/main.graph.babasset",
      nodeId: "log-1",
    });

    const variables = index.query("health");
    expect(variables.some((hit) => hit.kind === "variable" && hit.label === "health")).toBe(
      true,
    );
    expect(
      index
        .query("targetActor")
        .some((hit) => hit.kind === "variable" && hit.label === "targetActor"),
    ).toBe(true);

    expect(index.query("uniqueBodyTokenShouldNotMatch")).toEqual([]);
  });

  it("indexes logic graph nodes stored on Class assets", async () => {
    const storage = await createStorage();
    await writeDocument(storage, "assets/hero.class.babasset", {
      guid: "class-1",
      type: "Class",
      name: "Hero",
      payload: {
        nodes: [
          {
            id: "log-1",
            type: "logMessage",
            data: { message: "Class owned hello" },
          },
        ],
        edges: [],
      },
    });
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const index = new ProjectSearchIndex(storage, {
      nodeTitles: { logMessage: "Log" },
    });
    await index.rebuild(registry);
    expect(
      index.query("class owned hello").some(
        (hit) =>
          hit.kind === "graph-node" &&
          hit.target.kind === "graph-node" &&
          hit.target.graphPath === "assets/hero.class.babasset",
      ),
    ).toBe(true);
  });

  it("indexes catalog class ids and Class asset headers", async () => {
    const storage = await createStorage();
    await writeDocument(storage, "assets/my-hero.babasset", {
      guid: "class-1",
      type: "Class",
      name: "MyHero",
      payload: {},
    });
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const index = new ProjectSearchIndex(storage, {
      catalogClassIds: ["Actor", "MeshComponent"],
    });
    await index.rebuild(registry);

    expect(index.query("actor").some((hit) => hit.kind === "class")).toBe(true);
    expect(
      index.query("myhero").some(
        (hit) =>
          hit.kind === "class" &&
          hit.target.kind === "class" &&
          hit.target.path === "assets/my-hero.babasset",
      ),
    ).toBe(true);
  });

  it("upserts in-memory document content and removes deleted assets", async () => {
    const storage = await createStorage();
    await writeDocument(storage, "assets/main.scene.babasset", {
      guid: "scene-1",
      type: "Scene",
      name: "Main",
      payload: {
        actors: [{ id: "actor-1", name: "Cube", classId: "Actor", components: [] }],
      },
    });
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const index = new ProjectSearchIndex(storage);
    await index.rebuild(registry);

    const asset = registry.getByGuid("scene-1")!;
    index.upsertDocument(asset, {
      actors: [{ id: "actor-2", name: "SphereHero", classId: "Actor", components: [] }],
    });

    expect(index.query("cube")).toEqual([]);
    expect(index.query("spherehero").some((hit) => hit.kind === "actor")).toBe(true);

    index.removeAsset("assets/main.scene.babasset");
    expect(index.query("spherehero")).toEqual([]);
    expect(index.query("main").every((hit) => hit.kind !== "asset")).toBe(true);
  });

  it("caps result count and prefers label prefix matches", async () => {
    const storage = await createStorage();
    await storage.mkdir("assets", true);
    for (let i = 0; i < 12; i++) {
      await writeDocument(storage, `assets/n${i}.babasset`, {
        guid: `g-${i}`,
        type: "Enum",
        name: i === 0 ? "Needle" : `OtherNeedle${i}`,
        payload: {},
      });
    }
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const index = new ProjectSearchIndex(storage, { limit: 5 });
    await index.rebuild(registry);

    const hits = index.query("needle");
    expect(hits).toHaveLength(5);
    expect(hits[0]?.label).toBe("Needle");
  });

  it("indexes class documents from a plugin content root storage", async () => {
    const project = await createStorage();
    const engine = new MemoryStorageAdapter("opfs");
    await engine.openDocumentsProject("engine-plugins");
    await writeDocument(engine, "starter/assets/StarterActor.class.babasset", {
      guid: "hero-1",
      type: "Class",
      name: "StarterActor",
      parentClass: "Actor",
      payload: {
        nodes: [
          {
            id: "n1",
            type: "flow.event.beginPlay",
            position: { x: 0, y: 0 },
            data: {},
          },
        ],
        edges: [],
      },
    });
    const registry = new AssetRegistry(project);
    await registry.mountRoot(projectContentRoot());
    await registry.mountRoot({
      id: "plugin:engine-1",
      kind: "plugin",
      pathPrefix: "starter/assets",
      readOnly: true,
      storage: engine,
    });
    const index = new ProjectSearchIndex(project);
    await index.rebuild(registry);
    const hits = index.query("StarterActor");
    expect(hits.some((hit) => hit.label === "StarterActor")).toBe(true);
  });

  it("does not decode Scene or Class chunks until rebuild", async () => {
    const storage = await createStorage();
    await storage.mkdir("assets", true);
    for (let i = 0; i < 200; i++) {
      const kind = i % 2 === 0 ? "Scene" : "Class";
      await writeDocument(storage, `assets/doc-${i}.babasset`, {
        guid: `doc-${i}`,
        type: kind,
        name: `Doc${i}`,
        payload:
          kind === "Scene"
            ? {
                actors: [
                  {
                    id: `actor-${i}`,
                    name: `Hero${i}`,
                    classId: "Actor",
                    components: [],
                  },
                ],
              }
            : {
                nodes: [
                  {
                    id: `node-${i}`,
                    type: "logMessage",
                    data: { message: `Node${i}` },
                  },
                ],
                edges: [],
              },
      });
    }
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    expect(decodeAssetDocument).not.toHaveBeenCalled();

    const index = new ProjectSearchIndex(storage);
    expect(index.size).toBe(0);
    expect(index.query("hero198")).toEqual([]);
    expect(decodeAssetDocument).not.toHaveBeenCalled();

    await index.rebuild(registry);
    expect(decodeAssetDocument.mock.calls.length).toBe(200);
    expect(
      index.query("hero198").some((hit) => hit.kind === "actor"),
    ).toBe(true);
    expect(
      index.query("node199").some((hit) => hit.kind === "graph-node"),
    ).toBe(true);
  });

  it("overlays open-document JSON so unsaved names win, then a second rebuild sees the new snapshot", async () => {
    const storage = await createStorage();
    await writeDocument(storage, "assets/main.scene.babasset", {
      guid: "scene-1",
      type: "Scene",
      name: "Main",
      payload: {
        actors: [{ id: "actor-1", name: "Cube", classId: "Actor", components: [] }],
      },
    });
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const index = new ProjectSearchIndex(storage);

    await index.rebuild(registry, {
      openDocuments: [
        {
          path: "assets/main.scene.babasset",
          payload: {
            actors: [
              {
                id: "actor-1",
                name: "UnsavedHero",
                classId: "Actor",
                components: [],
              },
            ],
          },
        },
      ],
    });
    expect(index.query("cube")).toEqual([]);
    expect(
      index.query("unsavedhero").some((hit) => hit.kind === "actor"),
    ).toBe(true);

    await index.rebuild(registry, {
      openDocuments: [
        {
          path: "assets/main.scene.babasset",
          payload: {
            actors: [
              {
                id: "actor-1",
                name: "SecondName",
                classId: "Actor",
                components: [],
              },
            ],
          },
        },
      ],
    });
    expect(index.query("unsavedhero")).toEqual([]);
    expect(
      index.query("secondname").some((hit) => hit.kind === "actor"),
    ).toBe(true);
  });

  it("keeps the previous snapshot when an in-flight rebuild is aborted", async () => {
    const storage = await createStorage();
    await writeDocument(storage, "assets/main.scene.babasset", {
      guid: "scene-1",
      type: "Scene",
      name: "Main",
      payload: {
        actors: [{ id: "actor-1", name: "Cube", classId: "Actor", components: [] }],
      },
    });
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const index = new ProjectSearchIndex(storage);
    await index.rebuild(registry);
    expect(index.query("cube").some((hit) => hit.kind === "actor")).toBe(true);

    await writeDocument(storage, "assets/main.scene.babasset", {
      guid: "scene-1",
      type: "Scene",
      name: "Main",
      payload: {
        actors: [
          { id: "actor-1", name: "SphereHero", classId: "Actor", components: [] },
        ],
      },
    });
    await registry.reindexPath("assets/main.scene.babasset");

    const controller = new AbortController();
    const pending = index.rebuild(registry, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(index.query("cube").some((hit) => hit.kind === "actor")).toBe(true);
    expect(index.query("spherehero")).toEqual([]);

    await index.rebuild(registry);
    expect(index.query("cube")).toEqual([]);
    expect(
      index.query("spherehero").some((hit) => hit.kind === "actor"),
    ).toBe(true);
  });
});

afterEach(() => {
  decodeAssetDocument.mockClear();
});


