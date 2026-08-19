import { describe, expect, it } from "vitest";
import {
  createDefaultGraph,
  createDefaultScene,
  createEmptyProject,
  DEFAULT_CAMERA_FIELD_OF_VIEW,
  DEFAULT_CAMERA_ORTHOGRAPHIC_SIZE,
  DEFAULT_SORTING_LAYERS,
  MAIN_CLASS_FILE,
  MAIN_GRAPH_FILE,
  MAIN_SCENE_FILE,
  PROJECT_FILE,
  normalizeGraphMembers,
  normalizeGraphComponents,
  normalizeProjectSettings,
  migrateGameInstanceClassFromScenes,
  resolveGameInstanceClass,
  type ProjectSettings,
} from "./project";

describe("project schema", () => {
  it("creates an empty project with expected paths", () => {
    const project = createEmptyProject("Demo");
    expect(project.metadata.name).toBe("Demo");
    expect(project.scenes).toContain(MAIN_SCENE_FILE);
    expect(project.graphs).toContain(MAIN_CLASS_FILE);
    expect(MAIN_GRAPH_FILE).toBe("assets/main.graph.babasset");
    expect(PROJECT_FILE).toBe("project.json");
    expect(project.settings.twoD.pixelsPerUnit).toBe(100);
    expect(project.settings.twoD.sortingLayers).toEqual([
      ...DEFAULT_SORTING_LAYERS,
    ]);
    expect(project.settings.physics.collisionLayers).toEqual(["Default"]);
    expect(project.settings.input.actions.some((a) => a.name === "Jump")).toBe(
      true,
    );
    const jumpPad = project.settings.input.actions
      .find((a) => a.name === "Jump")
      ?.bindings.find((b) => b.device === "gamepadButton")?.code;
    const confirmPad = project.settings.input.actions
      .find((a) => a.name === "Confirm")
      ?.bindings.find((b) => b.device === "gamepadButton")?.code;
    expect(jumpPad).toBe("0:0");
    expect(confirmPad).toBe("0:1");
    expect(jumpPad).not.toBe(confirmPad);
    expect(
      project.settings.input.actions
        .find((a) => a.name === "Jump")
        ?.bindings.some((binding) => binding.device === "touch" && binding.code === "Jump"),
    ).toBe(true);
    const moveCodes = project.settings.input.axes
      .find((axis) => axis.name === "Move")
      ?.bindings.filter((binding) => binding.device === "touch")
      .map((binding) => binding.code);
    expect(moveCodes).toEqual(
      expect.arrayContaining(["joystick-x", "joystick-y", "dpad-x", "dpad-y"]),
    );
    expect(project.settings.fonts).toEqual({
      defaultFontGuid: null,
      globalFallback: "sans-serif",
    });
    expect(project.settings.ui).toEqual({
      designResolution: { width: 1920, height: 1080 },
      scaleRule: "shortestSide",
    });
    expect(project.settings.audio).toEqual({
      audioMixerGuid: null,
      occlusionEnabled: true,
      reverbWetScale: 1,
      reverbDecayScale: 1,
      reverbDampingScale: 1,
    });
    expect(project.settings.startupSceneGuid).toBeNull();
    expect(project.settings.gameInstanceClass).toBeNull();
    expect(project.settings.playFrameCap).toBe(60);
    expect(project.settings.playPreview).toEqual({
      followSystem: true,
      aspectWidth: 16,
      aspectHeight: 9,
    });
    expect(project.settings.render).toEqual({
      customResolution: true,
      width: 1920,
      height: 1080,
      blackBars: false,
    });
  });

  it("creates default scene and graph structures", () => {
    expect(createDefaultScene().actors.length).toBeGreaterThan(0);
    expect(createDefaultGraph().nodes.length).toBeGreaterThan(0);
  });

  it("seeds a 3D default scene with a cube and a possessing Default Camera", () => {
    const scene = createDefaultScene();
    const cube = scene.actors.find((actor) => actor.id === "actor-1");
    const camera = scene.actors.find((actor) =>
      actor.components.some((component) => component.classId === "CameraComponent"),
    );
    expect(cube?.name).toBe("Cube");
    expect(
      scene.actors.some((actor) => actor.id === "actor-skybox" && actor.locked),
    ).toBe(true);
    expect(
      scene.actors.some(
        (actor) =>
          actor.id === "actor-sun" &&
          actor.components[0]?.properties.lightKind === "directional",
      ),
    ).toBe(true);
    expect(camera).toBeDefined();
    const cameraComponent = camera!.components.find(
      (component) => component.classId === "CameraComponent",
    );
    expect(cameraComponent?.properties.attemptPossessViewTarget).toBe(true);
    expect(cameraComponent?.properties.fieldOfView).toBe(DEFAULT_CAMERA_FIELD_OF_VIEW);
    expect(cameraComponent?.properties.orthographicSize).toBe(
      DEFAULT_CAMERA_ORTHOGRAPHIC_SIZE,
    );
    expect(cameraComponent?.properties.projectionMode).toBe("perspective");
    expect(scene.settings.mainCameraActorId).toBe(camera!.id);
    expect(scene.settings.mainCameraComponentId).toBe(cameraComponent!.id);
    expect(camera!.transform.position[2]).toBeLessThan(0);
    expect(camera!.transform.position[1]).toBeGreaterThan(0);
    expect(camera!.transform.rotation).toEqual([0, 0, 0, 1]);
  });

  it("creates a 2D project without a cube and with pixel-perfect units", () => {
    const project = createEmptyProject("SideScroller", { kind: "2d" });
    expect(project.settings.twoD.pixelPerfect).toBe(true);
    expect(project.settings.twoD.integerZoomSteps).toBe(true);
    const scene = createDefaultScene("2d");
    expect(scene.viewportMode).toBe("2d");
    expect(scene.settings.physicsWorld).toBe("2d");
    expect(scene.actors.some((actor) => actor.name === "Cube")).toBe(false);
    const camera = scene.actors.find((actor) =>
      actor.components.some((component) => component.classId === "CameraComponent"),
    );
    expect(camera).toBeDefined();
    expect(camera!.transform.position).toEqual([0, 0, -8]);
    expect(
      camera!.components[0]?.properties.attemptPossessViewTarget,
    ).toBe(true);
    expect(camera!.components[0]?.properties.projectionMode).toBe("orthographic");
    expect(scene.settings.mainCameraActorId).toBe(camera!.id);
  });

  it("normalizes graph class members and drops invalid rows", () => {
    expect(normalizeGraphComponents(undefined)).toEqual([]);
    expect(
      normalizeGraphComponents([
        { id: "mesh-1", classId: "MeshComponent", properties: { meshKind: "box" } },
        { id: "", classId: "LightComponent", properties: {} },
        { id: "light-1", classId: "  ", properties: {} },
        { classId: "CameraComponent", properties: {} },
        { id: "sprite-1", classId: "SpriteComponent" },
        {
          id: "offset-1",
          classId: "MeshComponent",
          properties: { meshKind: "sphere" },
          transform: { position: [2, 0, 0] },
        },
      ]),
    ).toEqual([
      {
        id: "mesh-1",
        classId: "MeshComponent",
        properties: { meshKind: "box" },
        parentId: null,
        transform: {
          position: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
      },
      {
        id: "sprite-1",
        classId: "SpriteComponent",
        properties: {},
        parentId: null,
        transform: {
          position: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
      },
      {
        id: "offset-1",
        classId: "MeshComponent",
        properties: { meshKind: "sphere" },
        parentId: null,
        transform: {
          position: [2, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
      },
    ]);
    expect(normalizeGraphMembers(undefined)).toEqual([]);
    expect(
      normalizeGraphMembers([
        { id: "fn-1", kind: "function", name: " Jump " },
        { id: "", kind: "variable", name: "Health" },
        { kind: "event", name: "Tick" },
        { id: "bad", kind: "graphs", name: "Nope" },
        { id: "var-1", kind: "variable", name: "Health" },
      ]),
    ).toEqual([
      { id: "fn-1", kind: "function", name: "Jump", pins: [] },
      { id: "var-1", kind: "variable", name: "Health", typeId: "float" },
    ]);
    expect(
      normalizeGraphMembers([
        {
          id: "var-2",
          kind: "variable",
          name: "Speed",
          typeId: "vec3",
          defaultValue: "1",
        },
        {
          id: "fn-2",
          kind: "function",
          name: "Hit",
          pins: [{ name: "amount", typeId: "float", direction: "in" }],
        },
        { id: "if-1", kind: "interface", name: "Damageable", assetGuid: "guid-1" },
        {
          id: "loc-1",
          kind: "variable",
          name: "Temp",
          typeId: "int",
          functionId: "fn-2",
          defaultValue: 4,
        },
      ]),
    ).toEqual([
      {
        id: "var-2",
        kind: "variable",
        name: "Speed",
        typeId: "vec3",
        defaultValue: "1",
      },
      {
        id: "fn-2",
        kind: "function",
        name: "Hit",
        pins: [{ name: "amount", typeId: "float", direction: "in" }],
      },
      {
        id: "if-1",
        kind: "interface",
        name: "Damageable",
        assetGuid: "guid-1",
      },
      {
        id: "loc-1",
        kind: "variable",
        name: "Temp",
        typeId: "int",
        defaultValue: 4,
        functionId: "fn-2",
      },
    ]);
  });

  it("round-trips Class variable Single/Array/Map containers and drops unknown values", () => {
    expect(
      normalizeGraphMembers([
        {
          id: "var-array",
          kind: "variable",
          name: "Hits",
          typeId: "rotator",
          container: "array",
        },
        {
          id: "var-map",
          kind: "variable",
          name: "ByName",
          typeId: "float",
          container: "map",
          keyTypeId: "string",
        },
        {
          id: "var-legacy",
          kind: "variable",
          name: "Health",
          typeId: "float",
          container: "set",
        },
        {
          id: "var-object-map",
          kind: "variable",
          name: "Actors",
          typeId: "actor",
          container: "map",
          keyTypeId: "object",
          keyTypeClassId: "Hero",
        },
      ]),
    ).toEqual([
      {
        id: "var-array",
        kind: "variable",
        name: "Hits",
        typeId: "rotator",
        container: "array",
      },
      {
        id: "var-map",
        kind: "variable",
        name: "ByName",
        typeId: "float",
        container: "map",
        keyTypeId: "string",
      },
      { id: "var-legacy", kind: "variable", name: "Health", typeId: "float" },
      {
        id: "var-object-map",
        kind: "variable",
        name: "Actors",
        typeId: "actor",
        container: "map",
        keyTypeId: "object",
        keyTypeClassId: "Hero",
      },
    ]);
  });

  it("persists overridable, implementsInterface, and overrides on functions", () => {
    expect(
      normalizeGraphMembers([
        {
          id: "fn-3",
          kind: "function",
          name: "Apply Damage",
          pins: [],
          overridable: true,
          implementsInterface: {
            assetGuid: " iface-1 ",
            methodName: " Apply Damage ",
          },
          overrides: { classId: " Actor ", name: " Apply Damage " },
        },
        {
          id: "fn-4",
          kind: "function",
          name: "Jump",
          pins: [],
          overridable: false,
        },
      ]),
    ).toEqual([
      {
        id: "fn-3",
        kind: "function",
        name: "Apply Damage",
        pins: [],
        overridable: true,
        implementsInterface: {
          assetGuid: "iface-1",
          methodName: "Apply Damage",
        },
        overrides: { classId: "Actor", name: "Apply Damage" },
      },
      { id: "fn-4", kind: "function", name: "Jump", pins: [] },
    ]);
  });

  it("persists typeClassId on object and class variables without inventing one", () => {
    expect(
      normalizeGraphMembers([
        {
          id: "var-obj",
          kind: "variable",
          name: "Target",
          typeId: "object",
          typeClassId: " Hero ",
        },
        {
          id: "var-class",
          kind: "variable",
          name: "Kind",
          typeId: "class",
          typeClassId: "Actor",
          defaultValue: "Hero",
        },
        {
          id: "var-class-open",
          kind: "variable",
          name: "OpenKind",
          typeId: "class",
          defaultValue: "Hero",
        },
        { id: "var-plain", kind: "variable", name: "Health", typeId: "object" },
      ]),
    ).toEqual([
      {
        id: "var-obj",
        kind: "variable",
        name: "Target",
        typeId: "object",
        typeClassId: "Hero",
      },
      {
        id: "var-class",
        kind: "variable",
        name: "Kind",
        typeId: "class",
        typeClassId: "Actor",
        defaultValue: "Actor",
      },
      {
        id: "var-class-open",
        kind: "variable",
        name: "OpenKind",
        typeId: "class",
        defaultValue: "BObject",
      },
      { id: "var-plain", kind: "variable", name: "Health", typeId: "object" },
    ]);
  });

  it("persists typeClassId on function and event pins and keeps event pins", () => {
    expect(
      normalizeGraphMembers([
        {
          id: "fn-1",
          kind: "function",
          name: "Possess",
          pins: [
            { name: "pawn", typeId: "object", direction: "in", typeClassId: " Pawn " },
            { name: "kind", typeId: "class", direction: "in" },
          ],
        },
        {
          id: "ev-1",
          kind: "event",
          name: "On Hit",
          pins: [
            { name: "other", typeId: "object", direction: "out", typeClassId: "Actor" },
          ],
        },
      ]),
    ).toEqual([
      {
        id: "fn-1",
        kind: "function",
        name: "Possess",
        pins: [
          { name: "pawn", typeId: "object", direction: "in", typeClassId: "Pawn" },
          { name: "kind", typeId: "class", direction: "in" },
        ],
      },
      {
        id: "ev-1",
        kind: "event",
        name: "On Hit",
        pins: [
          { name: "other", typeId: "object", direction: "out", typeClassId: "Actor" },
        ],
      },
    ]);
  });

  it("normalizes missing 2D settings and drops duplicate sorting layers", () => {
    const settings = normalizeProjectSettings({
      touchMinTargetPx: 48,
      twoD: {
        pixelsPerUnit: 0,
        pixelPerfect: true,
        integerZoomSteps: true,
        sortingLayers: ["Default", " Default ", "", "UI", "Default"],
      },
    });
    expect(settings.touchMinTargetPx).toBe(48);
    expect(settings.twoD.pixelsPerUnit).toBe(100);
    expect(settings.twoD.pixelPerfect).toBe(true);
    expect(settings.twoD.sortingLayers).toEqual(["Default", "UI"]);
  });

  it("defaults physics collision layers to Default and caps at 32 unique names", () => {
    expect(normalizeProjectSettings(undefined).physics.collisionLayers).toEqual([
      "Default",
    ]);
    const settings = normalizeProjectSettings({
      physics: {
        collisionLayers: [
          "Default",
          " Default ",
          "",
          "Enemy",
          "Default",
          ...Array.from({ length: 40 }, (_, i) => `Layer${i}`),
        ],
      },
    });
    expect(settings.physics.collisionLayers[0]).toBe("Default");
    expect(settings.physics.collisionLayers).toContain("Enemy");
    expect(settings.physics.collisionLayers).toHaveLength(32);
    expect(new Set(settings.physics.collisionLayers).size).toBe(32);
  });

  it("defaults playFrameCap to 60 and keeps a positive override", () => {
    expect(normalizeProjectSettings(undefined).playFrameCap).toBe(60);
    expect(normalizeProjectSettings({}).playFrameCap).toBe(60);
    expect(normalizeProjectSettings({ playFrameCap: 0 }).playFrameCap).toBe(60);
    expect(normalizeProjectSettings({ playFrameCap: 30 }).playFrameCap).toBe(30);
  });

  it("defaults playPreview to follow-system 16:9 and keeps a positive override", () => {
    expect(normalizeProjectSettings(undefined).playPreview).toEqual({
      followSystem: true,
      aspectWidth: 16,
      aspectHeight: 9,
    });
    expect(normalizeProjectSettings({}).playPreview.followSystem).toBe(true);
    expect(
      normalizeProjectSettings({
        playPreview: { followSystem: false, aspectWidth: 0, aspectHeight: 0 },
      }).playPreview,
    ).toEqual({
      followSystem: false,
      aspectWidth: 16,
      aspectHeight: 9,
    });
    expect(
      normalizeProjectSettings({
        playPreview: { followSystem: false, aspectWidth: 21, aspectHeight: 9 },
      }).playPreview,
    ).toEqual({
      followSystem: false,
      aspectWidth: 21,
      aspectHeight: 9,
    });
  });

  it("preserves aspect when a followSystem-only patch is merged", () => {
    const current = normalizeProjectSettings({
      playPreview: { followSystem: true, aspectWidth: 4, aspectHeight: 3 },
    });
    expect(
      normalizeProjectSettings({
        ...current,
        playPreview: { ...current.playPreview, followSystem: false },
      }).playPreview,
    ).toEqual({
      followSystem: false,
      aspectWidth: 4,
      aspectHeight: 3,
    });
  });

  it("defaults infinite loop detection on with a one-million loopCount", () => {
    const defaults = normalizeProjectSettings(undefined);
    expect(defaults.infiniteLoopDetection).toBe(true);
    expect(defaults.loopCount).toBe(1_000_000);
    expect(normalizeProjectSettings({}).infiniteLoopDetection).toBe(true);
    expect(
      normalizeProjectSettings({ infiniteLoopDetection: false, loopCount: 50 })
        .infiniteLoopDetection,
    ).toBe(false);
    expect(
      normalizeProjectSettings({ infiniteLoopDetection: false, loopCount: 50 })
        .loopCount,
    ).toBe(50);
    expect(normalizeProjectSettings({ loopCount: 0 }).loopCount).toBe(1_000_000);
    expect(normalizeProjectSettings({ loopCount: -3 }).loopCount).toBe(1_000_000);
  });

  it("defaults compile on save and a two-minute autosave interval", () => {
    const defaults = normalizeProjectSettings(undefined);
    expect(defaults.compileOnSave).toBe(true);
    expect(defaults.autoSaveIntervalMs).toBe(120_000);
    expect(
      normalizeProjectSettings({ compileOnSave: false, autoSaveIntervalMs: 5000 })
        .compileOnSave,
    ).toBe(false);
    expect(
      normalizeProjectSettings({ autoSaveIntervalMs: 0 }).autoSaveIntervalMs,
    ).toBe(120_000);
  });

  it("normalizes a missing startup scene guid to null and keeps a stored guid", () => {
    expect(normalizeProjectSettings(undefined).startupSceneGuid).toBeNull();
    expect(normalizeProjectSettings({}).startupSceneGuid).toBeNull();
    expect(
      normalizeProjectSettings({ startupSceneGuid: "" }).startupSceneGuid,
    ).toBeNull();
    expect(
      normalizeProjectSettings({ startupSceneGuid: "scene-guid-1" })
        .startupSceneGuid,
    ).toBe("scene-guid-1");
  });

  it("normalizes a missing Audio mixer guid to null and keeps a stored guid", () => {
    expect(normalizeProjectSettings(undefined).audio.audioMixerGuid).toBeNull();
    expect(normalizeProjectSettings({}).audio.audioMixerGuid).toBeNull();
    expect(
      normalizeProjectSettings({ audio: { audioMixerGuid: "" } }).audio
        .audioMixerGuid,
    ).toBeNull();
    expect(
      normalizeProjectSettings({ audio: { audioMixerGuid: "mixer-1" } }).audio
        .audioMixerGuid,
    ).toBe("mixer-1");
  });

  it("fills UserInterface design resolution and scale rule when omitted", () => {
    expect(normalizeProjectSettings(undefined).ui).toEqual({
      designResolution: { width: 1920, height: 1080 },
      scaleRule: "shortestSide",
    });
    expect(
      normalizeProjectSettings({
        ui: {
          designResolution: { width: 1280, height: 720 },
          scaleRule: "fitWidth",
        },
      }).ui,
    ).toEqual({
      designResolution: { width: 1280, height: 720 },
      scaleRule: "fitWidth",
    });
    expect(
      normalizeProjectSettings({
        ui: { designResolution: { width: 0, height: -4 }, scaleRule: "nope" },
      } as never).ui,
    ).toEqual({
      designResolution: { width: 1920, height: 1080 },
      scaleRule: "shortestSide",
    });
  });

  it("defaults Audio occlusion on and keeps an explicit off switch", () => {
    expect(normalizeProjectSettings(undefined).audio.occlusionEnabled).toBe(true);
    expect(normalizeProjectSettings({}).audio.occlusionEnabled).toBe(true);
    expect(
      normalizeProjectSettings({ audio: { audioMixerGuid: "mixer-1" } }).audio
        .occlusionEnabled,
    ).toBe(true);
    expect(
      normalizeProjectSettings({ audio: { occlusionEnabled: false } }).audio
        .occlusionEnabled,
    ).toBe(false);
  });

  it("defaults Audio reverb scales to 1 and clamps them to 0..2", () => {
    expect(normalizeProjectSettings(undefined).audio).toMatchObject({
      reverbWetScale: 1,
      reverbDecayScale: 1,
      reverbDampingScale: 1,
    });
    expect(
      normalizeProjectSettings({
        audio: { reverbWetScale: 3, reverbDecayScale: -1, reverbDampingScale: 0.5 },
      }).audio,
    ).toMatchObject({
      reverbWetScale: 2,
      reverbDecayScale: 0,
      reverbDampingScale: 0.5,
    });
  });

  it("normalizes a missing Game Instance class to null and keeps a stored id", () => {
    expect(normalizeProjectSettings(undefined).gameInstanceClass).toBeNull();
    expect(normalizeProjectSettings({}).gameInstanceClass).toBeNull();
    expect(
      normalizeProjectSettings({ gameInstanceClass: "  " }).gameInstanceClass,
    ).toBeNull();
    expect(
      normalizeProjectSettings({ gameInstanceClass: "MyGame" }).gameInstanceClass,
    ).toBe("MyGame");
  });

  it("copies Game Instance from a scene when the project field is empty", () => {
    const settings = normalizeProjectSettings({});
    expect(
      migrateGameInstanceClassFromScenes(settings, [
        { settings: { gameInstanceClass: null } },
        { settings: { gameInstanceClass: "MyGame" } },
      ]).gameInstanceClass,
    ).toBe("MyGame");
    expect(
      migrateGameInstanceClassFromScenes(
        { ...settings, gameInstanceClass: "Keep" },
        [{ settings: { gameInstanceClass: "MyGame" } }],
      ).gameInstanceClass,
    ).toBe("Keep");
  });

  it("prefers the project Game Instance over a scene value", () => {
    expect(
      resolveGameInstanceClass(
        { gameInstanceClass: "ProjectGame" },
        { settings: { gameInstanceClass: "SceneGame" } },
      ),
    ).toBe("ProjectGame");
    expect(
      resolveGameInstanceClass(
        { gameInstanceClass: null },
        { settings: { gameInstanceClass: "SceneGame" } },
      ),
    ).toBe("SceneGame");
  });

  it("normalizes editorUtilityObjects to unique class ids", () => {
    expect(normalizeProjectSettings(undefined).editorUtilityObjects).toEqual([]);
    expect(normalizeProjectSettings({}).editorUtilityObjects).toEqual([]);
    expect(
      normalizeProjectSettings({
        editorUtilityObjects: ["  Tools  ", "Tools", "", "Inspector"],
      }).editorUtilityObjects,
    ).toEqual(["Tools", "Inspector"]);
  });

  it("defaults pluginOverrides to an empty map and exportPresets to an empty list", () => {
    const defaults = normalizeProjectSettings(undefined);
    expect(defaults.pluginOverrides).toEqual({});
    expect(defaults.exportPresets).toEqual([]);
    expect(createEmptyProject("Demo").settings.pluginOverrides).toEqual({});
    expect(createEmptyProject("Demo").settings.exportPresets).toEqual([]);
  });

  it("defaults source control to disabled with a 60s poll and auto-lock", () => {
    expect(normalizeProjectSettings(undefined).sourceControl).toEqual({
      enabled: false,
      repositoryUrl: "",
      branch: "main",
      autoLockOnEdit: true,
      pollIntervalMs: 60_000,
    });
    expect(createEmptyProject("Demo").settings.sourceControl.enabled).toBe(
      false,
    );
    expect(
      normalizeProjectSettings({
        sourceControl: {
          enabled: true,
          repositoryUrl: "  git@github.com:org/repo.git  ",
          branch: "  develop  ",
          autoLockOnEdit: false,
          pollIntervalMs: 15_000,
        },
      }).sourceControl,
    ).toEqual({
      enabled: true,
      repositoryUrl: "git@github.com:org/repo.git",
      branch: "develop",
      autoLockOnEdit: false,
      pollIntervalMs: 15_000,
    });
    expect(
      normalizeProjectSettings({
        sourceControl: { enabled: true, pollIntervalMs: 0, branch: "" },
      } as unknown as Partial<ProjectSettings>).sourceControl,
    ).toMatchObject({
      enabled: true,
      branch: "main",
      autoLockOnEdit: true,
      pollIntervalMs: 60_000,
    });
  });

  it("drops a token field from source control project settings", () => {
    const settings = normalizeProjectSettings({
      sourceControl: {
        enabled: true,
        repositoryUrl: "https://github.com/org/repo.git",
        branch: "main",
        autoLockOnEdit: true,
        pollIntervalMs: 60_000,
        token: "ghp_secret",
      },
    } as unknown as Partial<ProjectSettings>).sourceControl;
    expect(settings).toEqual({
      enabled: true,
      repositoryUrl: "https://github.com/org/repo.git",
      branch: "main",
      autoLockOnEdit: true,
      pollIntervalMs: 60_000,
    });
    expect(settings).not.toHaveProperty("token");
  });

  it("normalizes pluginOverrides keyed by guid", () => {
    expect(
      normalizeProjectSettings({
        pluginOverrides: {
          "  plug-1  ": { enabled: true },
          "plug-2": { enabled: false },
          "": { enabled: true },
          "plug-3": {},
        },
      } as unknown as Partial<ProjectSettings>).pluginOverrides,
    ).toEqual({
      "plug-1": { enabled: true },
      "plug-2": { enabled: false },
    });
  });

  it("normalizes export preset plugin overrides", () => {
    expect(
      normalizeProjectSettings({
        exportPresets: [
          {
            id: " web ",
            name: "Web",
            pluginOverrides: { "plug-1": { enabled: false } },
          },
          { id: "", name: "Skip" },
          {
            id: "web",
            name: "Duplicate",
            pluginOverrides: { "plug-1": { enabled: true } },
          },
        ],
      } as unknown as Partial<ProjectSettings>).exportPresets,
    ).toEqual([
      {
        id: "web",
        name: "Web",
        pluginOverrides: { "plug-1": { enabled: false } },
        packed: true,
        bundleDebugger: false,
        fileCountWarn: 800,
        fileCountFail: 1000,
      },
    ]);
  });

  it("defaults export preset packed on, bundleDebugger off, and file-count gates", () => {
    expect(
      normalizeProjectSettings({
        exportPresets: [{ id: "itch", name: "Itch" }],
      } as unknown as Partial<ProjectSettings>).exportPresets,
    ).toEqual([
      {
        id: "itch",
        name: "Itch",
        pluginOverrides: {},
        packed: true,
        bundleDebugger: false,
        fileCountWarn: 800,
        fileCountFail: 1000,
      },
    ]);
    expect(
      normalizeProjectSettings({
        exportPresets: [
          {
            id: "dev",
            name: "Dev",
            packed: false,
            bundleDebugger: true,
            fileCountWarn: 10,
            fileCountFail: 20,
          },
        ],
      } as unknown as Partial<ProjectSettings>).exportPresets[0],
    ).toEqual({
      id: "dev",
      name: "Dev",
      pluginOverrides: {},
      packed: false,
      bundleDebugger: true,
      fileCountWarn: 10,
      fileCountFail: 20,
    });
  });

  it("keeps fill Play layout when custom resolution is missing or off", () => {
    expect(normalizeProjectSettings(undefined).render).toEqual({
      customResolution: false,
      width: 1920,
      height: 1080,
      blackBars: false,
    });
    expect(
      normalizeProjectSettings({
        render: { customResolution: false, width: 1280, height: 720, blackBars: true },
      }).render,
    ).toEqual({
      customResolution: false,
      width: 1280,
      height: 720,
      blackBars: true,
    });
  });

  it("keeps a custom 1920×1080 black-bars override on new projects", () => {
    expect(
      createEmptyProject("Demo", {
        render: { customResolution: true, width: 1280, height: 720, blackBars: true },
      }).settings.render,
    ).toEqual({
      customResolution: true,
      width: 1280,
      height: 720,
      blackBars: true,
    });
  });
});
