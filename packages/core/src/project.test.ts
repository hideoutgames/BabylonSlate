import { describe, expect, it } from "vitest";
import {
  resolveActorDefaults,
  resolveActorTags,
  resolveGameInstanceDefaults,
  createDefaultScene,
  createEmptyProject,
  DEFAULT_CAMERA_FIELD_OF_VIEW,
  DEFAULT_CAMERA_ORTHOGRAPHIC_SIZE,
  DEFAULT_SORTING_LAYERS,
  MAIN_CLASS_FILE,
  MAIN_SCENE_FILE,
  PROJECT_FILE,
  nearestTextureFiltering,
  normalizeProjectSettings,
  projectSceneCameraFraming,
  normalizeRenderProjectSettings,
  type ProjectSettings,
} from "./project";
import { QUALITY_GROUPS, qualityGroupLabel, resolveRenderingQuality } from "./render-quality";

describe("project schema", () => {
  it("normalizes untrusted render defaults without retaining editor or session state", () => {
    const input = {
      mode: "cel",
      cel: { shadowBands: 5 },
      quality: { resolution: { scale: 0.8 } },
      width: Infinity, height: -2, customResolution: true,
      localQualityOverrides: { shadows: { enabled: false } },
      qualityOverrides: { resolution: { scale: 0.25 } },
      effects: { bloom: { enabled: true, weight: 0.4 } },
    };
    const normalized = normalizeRenderProjectSettings(input);
    expect(normalized).toMatchObject({
      mode: "cel",
      cel: { shadowBands: 5 },
      quality: { resolution: { scale: 0.8 } },
      width: 1920, height: 1080, customResolution: true,
      effects: { bloom: { enabled: true, weight: 0.4 } },
    });
    expect(normalized).not.toHaveProperty("localQualityOverrides");
    expect(normalized).not.toHaveProperty("qualityOverrides");
    input.cel.shadowBands = 2;
    expect(normalized.cel?.shadowBands).toBe(5);
    expect(normalizeRenderProjectSettings(null)).toEqual(normalizeProjectSettings(undefined).render);
    expect(normalizeRenderProjectSettings({ width: 0.25, height: 1.9 })).toMatchObject({ width: 1, height: 2 });
  });
  it("creates an empty project with expected paths", () => {
    const project = createEmptyProject("Demo");
    expect(project.metadata.name).toBe("Demo");
    expect(project.scenes).toContain(MAIN_SCENE_FILE);
    expect(project.graphs).toContain(MAIN_CLASS_FILE);
    expect(PROJECT_FILE).toBe("project.json");
    expect(project.settings.twoD.pixelsPerUnit).toBe(100);
    expect(project.settings.twoD.sortingLayers).toEqual([
      ...DEFAULT_SORTING_LAYERS,
    ]);
    expect(project.settings.physics.collisionLayers).toEqual(["Default"]);
    expect(project.settings.fonts).toEqual({
      defaultFontGuid: null,
      globalFallback: "sans-serif",
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
    expect(project.settings.render).toMatchObject({
      customResolution: true,
      width: 1920,
      height: 1080,
      blackBars: false,
    });
  });

  it("seeds a 3D default scene with an empty Actor and a possessing Default Camera", () => {
    const scene = createDefaultScene();
    const actor = scene.actors.find((entry) => entry.id === "actor-1");
    const camera = scene.actors.find((entry) =>
      entry.components.some((component) => component.classId === "CameraComponent"),
    );
    expect(actor?.name).toBe("Actor");
    expect(actor?.components).toEqual([]);
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
    expect(scene.settings.defaultCameraActorId).toBe(camera!.id);
    expect(camera!.transform.position[2]).toBeLessThan(0);
    expect(camera!.transform.position[1]).toBeGreaterThan(0);
    expect(camera!.transform.rotation).toEqual([0, 0, 0, 1]);
  });

  it("creates a 2D project without a cube and with pixel-perfect units", () => {
    const project = createEmptyProject("SideScroller", { kind: "2d" });
    expect(project.settings.twoD.pixelPerfect).toBe(true);
    const scene = createDefaultScene("2d");
    expect(scene.viewportMode).toBe("2d");
    expect(scene.settings.physicsWorld).toBe("2d");
    expect(scene.actors.some((actor) => actor.name === "Cube")).toBe(false);
    const camera = scene.actors.find((actor) =>
      actor.components.some((component) => component.classId === "CameraComponent"),
    );
    expect(camera).toBeDefined();
    expect(camera!.transform.position).toEqual([0, 0, -12]);
    expect(
      camera!.components[0]?.properties.attemptPossessViewTarget,
    ).toBe(true);
    expect(camera!.components[0]?.properties.projectionMode).toBe("orthographic");
    expect(scene.settings.defaultCameraActorId).toBe(camera!.id);
  });

  it("normalizes missing 2D settings and drops duplicate sorting layers", () => {
    const settings = normalizeProjectSettings({
      touchMinTargetPx: 48,
      twoD: {
        pixelsPerUnit: 0,
        pixelPerfect: true,
        sortingLayers: ["Default", " Default ", "", "UI", "Default"],
      } as Partial<ProjectSettings["twoD"]> as ProjectSettings["twoD"],
    });
    expect(settings.touchMinTargetPx).toBe(48);
    expect(settings.twoD.pixelsPerUnit).toBe(100);
    expect(settings.twoD.pixelPerfect).toBe(true);
    expect(settings.twoD.nearestTextures).toBe(false);
    expect(settings.twoD.sortingLayers).toEqual(["Default", "UI"]);
  });

  it("sets up a Pixel Art Optimized project and leaves other projects as they were", () => {
    const pixelArt = createEmptyProject("Pixels", { render: { width: 640, height: 360, blackBars: false }, pixelArt: true }).settings;
    expect(pixelArt.twoD).toMatchObject({ pixelPerfect: true, nearestTextures: true });
    expect(pixelArt.render).toMatchObject({ customResolution: true, width: 640, height: 360, blackBars: false, upscaling: "pixelated" });
    expect(pixelArt.render.quality?.resolution).toEqual({ profile: "high", scale: 1, preset: "custom" });
    expect(pixelArt.render.quality?.postprocessing).toMatchObject({ antiAliasing: "off", preset: "custom" });
    const plain = createEmptyProject("Plain").settings;
    expect(plain.twoD).toMatchObject({ pixelPerfect: false, nearestTextures: false });
    expect(plain.render.upscaling).toBe("smooth");
    expect(plain.render.quality?.postprocessing.antiAliasing).not.toBe("off");
  });

  it("frames a Pixel Art Optimized project's new scenes at one design pixel per texel, and no other project's", () => {
    const at = (width: number, height: number) =>
      projectSceneCameraFraming(createEmptyProject("Pixels", { kind: "2d", render: { width, height }, pixelArt: true }).settings);
    expect(at(640, 360)).toEqual({ orthographicSize: 1.8, cameraBounds2D: { width: 6.4, height: 3.6 } });
    expect(at(320, 180)).toEqual({ orthographicSize: 0.9, cameraBounds2D: { width: 3.2, height: 1.8 } });
    expect(projectSceneCameraFraming(createEmptyProject("Basic", { kind: "2d" }).settings)).toBeNull();
    expect(projectSceneCameraFraming(createEmptyProject("Plain").settings)).toBeNull();
    const scene = createDefaultScene("2d", at(640, 360));
    expect(scene.settings.cameraBounds2D).toEqual({ width: 6.4, height: 3.6 });
    expect(scene.actors[0]!.components[0]!.properties.orthographicSize).toBe(1.8);
    expect(createDefaultScene("2d").actors[0]!.components[0]!.properties.orthographicSize).toBe(DEFAULT_CAMERA_ORTHOGRAPHIC_SIZE);
  });

  it("fades distance fog in new 3D scenes into the default sky's horizon", () => {
    expect(createDefaultScene("3d").settings.fogColor).toEqual([0.68, 0.77, 0.95]);
    expect(createDefaultScene("2d").settings.fogColor).toEqual([0.5, 0.5, 0.5]);
  });

  it("starts 3D projects in Scene Linear with Neutral tone mapping, and 2D and pixel-art projects in Display Space", () => {
    const look = (settings: ProjectSettings) => [settings.render.effects?.colorPipeline.mode, settings.render.effects?.toneMapping];
    expect(look(createEmptyProject("Three").settings)).toEqual(["sceneLinear", "neutral"]);
    expect(look(createEmptyProject("Two", { kind: "2d" }).settings)).toEqual(["displaySpace", "neutral"]);
    expect(look(createEmptyProject("Pixels", { pixelArt: true }).settings)).toEqual(["displaySpace", "neutral"]);
    expect(createEmptyProject("Three").settings.render.effects?.volumetricLighting.density).toBe(0.003);
    expect(createEmptyProject("Three").settings.render.quality?.geometry).toMatchObject({ occlusionCulling: true, preset: "high" });
    expect(createEmptyProject("Two", { kind: "2d" }).settings.render.quality?.geometry).toMatchObject({ occlusionCulling: false, preset: "custom" });
  });

  it("filters textures nearest only when Nearest Texture Filtering and Pixel-Perfect Mode are both on", () => {
    // Saved settings are untrusted: only a literal true counts.
    const filtering = (pixelPerfect: unknown, nearestTextures: unknown) => nearestTextureFiltering(
      normalizeProjectSettings({ twoD: { pixelPerfect, nearestTextures } as unknown as ProjectSettings["twoD"] }).twoD);
    expect([filtering(true, true), filtering(false, true), filtering(true, false), filtering(true, "yes")])
      .toEqual([true, false, false, false]);
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

  it("resolves Tick On Pause off by default and from the nearest Class that sets it", () => {
    expect(resolveActorDefaults([]).tickOnPause).toBe(false);
    expect(resolveActorDefaults([{ generateHitEvents: false }, { tickOnPause: true }]).tickOnPause).toBe(true);
    expect(resolveActorDefaults([{ tickOnPause: false }, { tickOnPause: true }]).tickOnPause).toBe(false);
    expect(resolveGameInstanceDefaults([]).tickOnPause).toBe(false);
    expect(resolveGameInstanceDefaults([undefined, { tickOnPause: true }]).tickOnPause).toBe(true);
    expect(resolveGameInstanceDefaults([{ tickOnPause: false }, { tickOnPause: true }]).tickOnPause).toBe(false);
  });

  it("gives actors the Tags of the nearest Class that sets them, an empty set being a choice", () => {
    expect(resolveActorTags([])).toEqual({ Tags: [] });
    expect(resolveActorTags([{ tickOnPause: true }, { properties: { actorTags: { Tags: [2, 2, 5] } } }])).toEqual({ Tags: [2, 5] });
    expect(resolveActorTags([{ properties: { actorTags: { Tags: [] } } }, { properties: { actorTags: { Tags: [5] } } }])).toEqual({ Tags: [] });
  });

  it("defaults playFrameCap to 60 and keeps a positive override", () => {
    expect(normalizeProjectSettings(undefined).playFrameCap).toBe(60);
    expect(normalizeProjectSettings({}).playFrameCap).toBe(60);
    for (const playFrameCap of [0, -1, NaN, Infinity, -Infinity])
      expect(normalizeProjectSettings({ playFrameCap }).playFrameCap).toBe(60);
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

  it("defaults the Garbage Collection Interval to 60 ticks and keeps a whole number of at least one", () => {
    expect(normalizeProjectSettings(undefined).garbageCollectionIntervalTicks).toBe(60);
    for (const [value, expected] of [[120, 120], [2.6, 3], [1, 1], [0, 60], [-4, 60], ["30", 60], [Number.NaN, 60]] as const) {
      expect(normalizeProjectSettings({ garbageCollectionIntervalTicks: value as number }).garbageCollectionIntervalTicks).toBe(expected);
    }
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

  it("defaults compile on save and Auto-Save on with a two-minute interval", () => {
    const defaults = normalizeProjectSettings(undefined);
    expect(defaults.compileOnSave).toBe(true);
    expect(defaults.autoSave).toBe(true);
    expect(defaults.autoSaveIntervalMs).toBe(120_000);
    expect(
      normalizeProjectSettings({ compileOnSave: false, autoSaveIntervalMs: 5000 })
        .compileOnSave,
    ).toBe(false);
    expect(
      normalizeProjectSettings({ autoSaveIntervalMs: 0 }).autoSaveIntervalMs,
    ).toBe(120_000);
    // Off is kept, with the interval it returns to when turned on again.
    expect(normalizeProjectSettings({ autoSave: false, autoSaveIntervalMs: 5000 })).toMatchObject({
      autoSave: false,
      autoSaveIntervalMs: 5000,
    });
    expect(normalizeProjectSettings({ autoSave: "no" } as unknown as Partial<ProjectSettings>).autoSave).toBe(true);
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

  it("normalizes editorUtilityObjects to unique class ids", () => {
    expect(normalizeProjectSettings(undefined).editorUtilityObjects).toEqual([]);
    expect(normalizeProjectSettings({}).editorUtilityObjects).toEqual([]);
    expect(
      normalizeProjectSettings({
        editorUtilityObjects: ["  Tools  ", "Tools", "", "Inspector"],
      }).editorUtilityObjects,
    ).toEqual(["Tools", "Inspector"]);
  });

  it("defaults source control to Off, asking to lock on edit, with release after push", () => {
    expect(normalizeProjectSettings(undefined).sourceControl).toEqual({
      mode: "off",
      repositoryUrl: "",
      branch: "main",
      lockOnEdit: "ask",
      releaseLocksAfterPush: true,
    });
    expect(createEmptyProject("Demo").settings.sourceControl.mode).toBe("off");
    expect(
      normalizeProjectSettings({
        sourceControl: {
          mode: "manual",
          repositoryUrl: "  git@github.com:org/repo.git  ",
          branch: "  develop  ",
          lockOnEdit: "never",
          releaseLocksAfterPush: false,
        },
      }).sourceControl,
    ).toEqual({
      mode: "manual",
      repositoryUrl: "git@github.com:org/repo.git",
      branch: "develop",
      lockOnEdit: "never",
      releaseLocksAfterPush: false,
    });
    expect(
      normalizeProjectSettings({
        sourceControl: { mode: "integrated", branch: "" },
      } as unknown as Partial<ProjectSettings>).sourceControl,
    ).toMatchObject({ mode: "integrated", branch: "main", lockOnEdit: "ask", releaseLocksAfterPush: true });
  });

  it.each([
    ["ask", "ask"],
    ["always", "always"],
    ["never", "never"],
    ["sometimes", "ask"],
    [true, "ask"],
    [undefined, "ask"],
  ])("reads Lock On Edit %j as %s", (stored, expected) => {
    expect(
      normalizeProjectSettings({
        sourceControl: { mode: "manual", lockOnEdit: stored },
      } as unknown as Partial<ProjectSettings>).sourceControl.lockOnEdit,
    ).toBe(expected);
  });

  it("reads an unknown mode as Off and keeps only the current source control fields", () => {
    const settings = normalizeProjectSettings({
      sourceControl: {
        mode: "enabled",
        enabled: true,
        repositoryUrl: "https://github.com/org/repo.git",
        branch: "main",
        lockOnEdit: "always",
        pollIntervalMs: 15_000,
        token: "secret",
      },
    } as unknown as Partial<ProjectSettings>).sourceControl;
    expect(settings).toEqual({
      mode: "off",
      repositoryUrl: "https://github.com/org/repo.git",
      branch: "main",
      lockOnEdit: "always",
      releaseLocksAfterPush: true,
    });
  });

  it("keeps extension settings values that are plain text, numbers or toggles", () => {
    expect(
      normalizeProjectSettings({
        extensionSettings: {
          " discord ": { applicationId: "123", showElapsed: true, refresh: 15, nested: { a: 1 }, broken: Number.NaN },
          "": { applicationId: "lost" },
          empty: { nested: [] },
          invalid: "text",
        },
      } as unknown as Partial<ProjectSettings>).extensionSettings,
    ).toEqual({ discord: { applicationId: "123", showElapsed: true, refresh: 15 } });
    expect(normalizeProjectSettings({}).extensionSettings).toEqual({});
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
        bundleDebugger: false,
        fileCountWarn: 800,
        fileCountFail: 1000,
      },
    ]);
  });

  it("defaults export preset bundleDebugger off and file-count gates", () => {
    expect(
      normalizeProjectSettings({
        exportPresets: [{ id: "itch", name: "Itch" }],
      } as unknown as Partial<ProjectSettings>).exportPresets,
    ).toEqual([
      {
        id: "itch",
        name: "Itch",
        pluginOverrides: {},
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
      bundleDebugger: true,
      fileCountWarn: 10,
      fileCountFail: 20,
    });
  });

  it("defaults Always Package Folders to none and keeps each saved folder once, normalized", () => {
    expect(normalizeProjectSettings(undefined).alwaysPackageFolders).toEqual([]);
    expect(
      normalizeProjectSettings({
        alwaysPackageFolders: ["/assets/Weapons/", "assets//Weapons", " assets/UI ", "", 7],
      } as unknown as Partial<ProjectSettings>).alwaysPackageFolders,
    ).toEqual(["assets/Weapons", "assets/UI"]);
  });

  it("keeps fill Play layout when custom resolution is missing or off", () => {
    expect(normalizeProjectSettings(undefined).render).toMatchObject({
      customResolution: false,
      width: 1920,
      height: 1080,
      blackBars: false,
    });
    expect(
      normalizeProjectSettings({
        render: { customResolution: false, width: 1280, height: 720, blackBars: true },
      }).render,
    ).toMatchObject({
      customResolution: false,
      width: 1280,
      height: 720,
      blackBars: true,
    });
  });

  it("keeps Large World Rendering off unless a project saved it on", () => {
    expect(normalizeProjectSettings(undefined).render.largeWorldRendering).toBe(false);
    expect(createEmptyProject("Demo").settings.render.largeWorldRendering).toBe(false);
    for (const saved of ["true", 1, null, {}])
      expect(normalizeRenderProjectSettings({ largeWorldRendering: saved }).largeWorldRendering, String(saved)).toBe(false);
    const on = normalizeRenderProjectSettings({ largeWorldRendering: true });
    expect(on.largeWorldRendering).toBe(true);
    expect(normalizeRenderProjectSettings(JSON.parse(JSON.stringify(on))).largeWorldRendering).toBe(true);
  });

  it("starts new projects at High in every Scalability group, and keeps it on reload", () => {
    const labels = (settings: ProjectSettings) => {
      const effective = resolveRenderingQuality(settings.render);
      return QUALITY_GROUPS.map((group) => qualityGroupLabel(effective, group));
    };
    const created = createEmptyProject("Demo").settings;
    expect(labels(created)).toEqual(QUALITY_GROUPS.map(() => "high"));
    expect(normalizeProjectSettings(JSON.parse(JSON.stringify(created)))).toEqual(created);
    // Existing projects without saved quality keep the Medium-based fallback.
    expect(labels(normalizeProjectSettings(undefined))).not.toContain("high");
  });

  it("keeps a custom 1920×1080 black-bars override on new projects", () => {
    expect(
      createEmptyProject("Demo", {
        render: { customResolution: true, width: 1280, height: 720, blackBars: true },
      }).settings.render,
    ).toMatchObject({
      customResolution: true,
      width: 1280,
      height: 720,
      blackBars: true,
    });
  });
});
