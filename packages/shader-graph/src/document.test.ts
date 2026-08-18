import { describe, expect, it } from "vitest";
import {
  MATERIAL_FUNCTION_SCHEMA_VERSION,
  MATERIAL_SCHEMA_VERSION,
  createDefaultMaterialDocument,
  createDefaultMaterialFunctionDocument,
  materialDependencies,
  migrateLegacyShaderPayload,
  normalizeMaterialDocument,
  normalizeMaterialFunctionDocument,
  setMaterialDomain,
} from "./document";

describe("material document", () => {
  it("creates a surface material whose default graph reaches the output", () => {
    const doc = createDefaultMaterialDocument("Rock");
    expect(doc.schemaVersion).toBe(MATERIAL_SCHEMA_VERSION);
    expect(doc.name).toBe("Rock");
    expect(doc.domain).toBe("surface");
    const terminal = doc.nodes.find((node) => node.type === "output.surface");
    expect(terminal).toBeDefined();
    expect(
      doc.edges.some((edge) => edge.targetNodeId === terminal!.id),
    ).toBe(true);
  });

  it("defaults the preview to a cube with no custom mesh", () => {
    const doc = createDefaultMaterialDocument();
    expect(doc.preview).toEqual({ mesh: "cube", customMeshGuid: null });
  });

  it("normalizes a custom preview without a picked model back to cube", () => {
    const doc = normalizeMaterialDocument({
      preview: { mesh: "custom", customMeshGuid: null },
    });
    expect(doc.preview).toEqual({ mesh: "cube", customMeshGuid: null });
  });

  it("fills missing fields when normalizing an unknown payload", () => {
    const doc = normalizeMaterialDocument({}, "Fallback");
    expect(doc.name).toBe("Fallback");
    expect(doc.domain).toBe("surface");
    expect(doc.blendMode).toBe("opaque");
    expect(Array.isArray(doc.nodes)).toBe(true);
    expect(Array.isArray(doc.edges)).toBe(true);
  });

  it("keeps an explicit post-process domain and its terminal", () => {
    const doc = normalizeMaterialDocument({
      schemaVersion: MATERIAL_SCHEMA_VERSION,
      name: "Blur",
      domain: "postProcess",
      nodes: [],
      edges: [],
    });
    expect(doc.domain).toBe("postProcess");
    expect(doc.nodes.some((node) => node.type === "output.postProcess")).toBe(
      true,
    );
  });

  it("creates an interface material with Color wired and Opacity defaulted", () => {
    const doc = createDefaultMaterialDocument("HudGlow", "interface");
    expect(doc.domain).toBe("interface");
    expect(doc.shadingModel).toBe("unlit");
    expect(doc.nodes.some((node) => node.type === "output.interface")).toBe(
      true,
    );
    expect(doc.nodes.some((node) => node.type === "input.uv")).toBe(true);
    expect(
      doc.edges.some((edge) => edge.targetPinId === "color"),
    ).toBe(true);
  });

  it("keeps an explicit interface domain and its terminal", () => {
    const doc = normalizeMaterialDocument({
      schemaVersion: MATERIAL_SCHEMA_VERSION,
      name: "HudGlow",
      domain: "interface",
      nodes: [],
      edges: [],
    });
    expect(doc.domain).toBe("interface");
    expect(doc.nodes.some((node) => node.type === "output.interface")).toBe(
      true,
    );
  });

  it("migrates a legacy Shader payload into a surface material", () => {
    const legacy = {
      name: "Surface",
      postProcess: false,
      nodes: [
        { id: "uv", type: "input.uv", position: { x: 0, y: 0 }, properties: {} },
        {
          id: "out",
          type: "output.fragment",
          position: { x: 280, y: 0 },
          properties: {},
        },
      ],
      edges: [
        {
          id: "e0",
          sourceNodeId: "uv",
          sourcePinId: "uv",
          targetNodeId: "out",
          targetPinId: "color",
        },
      ],
    };
    const doc = migrateLegacyShaderPayload(legacy);
    expect(doc.schemaVersion).toBe(MATERIAL_SCHEMA_VERSION);
    expect(doc.domain).toBe("surface");
    expect(doc.nodes.some((node) => node.type === "output.surface")).toBe(true);
    expect(doc.nodes.some((node) => node.type === "output.fragment")).toBe(
      false,
    );
  });

  it("drops the legacy UV to color edge that was never a valid connection", () => {
    const doc = migrateLegacyShaderPayload({
      name: "Surface",
      postProcess: false,
      nodes: [
        { id: "uv", type: "input.uv", position: { x: 0, y: 0 }, properties: {} },
        {
          id: "out",
          type: "output.fragment",
          position: { x: 280, y: 0 },
          properties: {},
        },
      ],
      edges: [
        {
          id: "e0",
          sourceNodeId: "uv",
          sourcePinId: "uv",
          targetNodeId: "out",
          targetPinId: "color",
        },
      ],
    });
    expect(
      doc.edges.some(
        (edge) => edge.sourceNodeId === "uv" && edge.targetPinId === "color",
      ),
    ).toBe(false);
  });

  it("migrates a legacy post-process Shader payload by domain", () => {
    const doc = migrateLegacyShaderPayload({
      name: "Vignette",
      postProcess: true,
      nodes: [
        {
          id: "out",
          type: "output.postProcess",
          position: { x: 0, y: 0 },
          properties: {},
        },
      ],
      edges: [],
    });
    expect(doc.domain).toBe("postProcess");
    expect(doc.nodes.filter((node) => node.type === "output.postProcess")).toHaveLength(
      1,
    );
  });

  it("migrates an empty imported Material stub into a texture-fed graph", () => {
    const doc = migrateLegacyShaderPayload({}, { textureGuids: ["tex-1"] });
    expect(doc.domain).toBe("surface");
    const sample = doc.nodes.find((node) => node.type === "texture.sample");
    expect(sample).toBeDefined();
    expect(materialDependencies(doc).textures).toEqual(["tex-1"]);
  });

  it("collects texture, function and preview mesh dependencies deterministically", () => {
    const doc = createDefaultMaterialDocument();
    doc.preview = { mesh: "custom", customMeshGuid: "model-9" };
    doc.nodes.push(
      {
        id: "tex-b",
        type: "param.texture",
        position: { x: 0, y: 0 },
        properties: { textureGuid: "tex-b" },
      },
      {
        id: "tex-a",
        type: "param.texture",
        position: { x: 0, y: 0 },
        properties: { textureGuid: "tex-a" },
      },
      {
        id: "call",
        type: "function.call",
        position: { x: 0, y: 0 },
        properties: { functionGuid: "fn-1" },
      },
    );
    const deps = materialDependencies(doc);
    expect(deps.textures).toEqual(["tex-a", "tex-b"]);
    expect(deps.functions).toEqual(["fn-1"]);
    expect(deps.meshes).toEqual(["model-9"]);
    expect(deps.all).toEqual(["fn-1", "model-9", "tex-a", "tex-b"]);
  });

  it("creates a material function with matching interface and plumbing nodes", () => {
    const fn = createDefaultMaterialFunctionDocument("Tint");
    expect(fn.schemaVersion).toBe(MATERIAL_FUNCTION_SCHEMA_VERSION);
    expect(fn.inputs.length).toBeGreaterThan(0);
    expect(fn.outputs.length).toBeGreaterThan(0);
    expect(fn.nodes.some((node) => node.type === "function.input")).toBe(true);
    expect(fn.nodes.some((node) => node.type === "function.output")).toBe(true);
  });

  it("keeps stable function pin ids when normalizing", () => {
    const fn = normalizeMaterialFunctionDocument({
      schemaVersion: MATERIAL_FUNCTION_SCHEMA_VERSION,
      name: "Tint",
      inputs: [{ id: "in_color", name: "Renamed Color", type: "vec3" }],
      outputs: [{ id: "out_value", name: "Result", type: "vec3" }],
      nodes: [],
      edges: [],
    });
    expect(fn.inputs[0]?.id).toBe("in_color");
    expect(fn.inputs[0]?.name).toBe("Renamed Color");
    expect(fn.outputs[0]?.id).toBe("out_value");
  });
});

describe("switching material domain", () => {
  it("replaces the surface terminal with the post-process terminal", () => {
    const doc = setMaterialDomain(
      createDefaultMaterialDocument("Rock"),
      "postProcess",
    );
    expect(doc.domain).toBe("postProcess");
    expect(doc.nodes.some((node) => node.type === "output.surface")).toBe(false);
    expect(doc.nodes.some((node) => node.type === "output.postProcess")).toBe(
      true,
    );
  });

  it("drops edges into the terminal it removed", () => {
    const doc = setMaterialDomain(
      createDefaultMaterialDocument("Rock"),
      "postProcess",
    );
    expect(doc.edges).toEqual([]);
  });

  it("removes nodes that are illegal in the new domain", () => {
    const post = createDefaultMaterialDocument("Blur", "postProcess");
    const surface = setMaterialDomain(post, "surface");
    expect(
      surface.nodes.some((node) => node.type === "input.sceneColor"),
    ).toBe(false);
    expect(
      surface.nodes.some((node) => node.type === "input.screenUv"),
    ).toBe(false);
  });

  it("creates a particle-domain graph with Particle Color into the particle terminal", () => {
    const doc = createDefaultMaterialDocument("Sparks", "particle");
    expect(doc.domain).toBe("particle");
    expect(doc.nodes.some((node) => node.type === "input.particleColor")).toBe(
      true,
    );
    expect(doc.nodes.some((node) => node.type === "output.particle")).toBe(true);
    expect(doc.nodes.some((node) => node.type === "output.surface")).toBe(false);
  });

  it("normalizes domain particle without collapsing it to surface", () => {
    expect(normalizeMaterialDocument({ domain: "particle" }).domain).toBe(
      "particle",
    );
  });

  it("switches a surface material to the particle terminal", () => {
    const doc = setMaterialDomain(
      createDefaultMaterialDocument("Rock"),
      "particle",
    );
    expect(doc.domain).toBe("particle");
    expect(doc.nodes.some((node) => node.type === "output.surface")).toBe(false);
    expect(doc.nodes.some((node) => node.type === "output.particle")).toBe(true);
  });

  it("keeps nodes that are legal in both domains", () => {
    const doc = createDefaultMaterialDocument("Rock");
    doc.nodes.push({
      id: "wave",
      type: "math.sin",
      position: { x: 0, y: 0 },
      properties: {},
    });
    const post = setMaterialDomain(doc, "postProcess");
    expect(post.nodes.some((node) => node.id === "wave")).toBe(true);
  });

  it("is a no-op when the domain is unchanged", () => {
    const doc = createDefaultMaterialDocument("Rock");
    expect(setMaterialDomain(doc, "surface")).toBe(doc);
  });

  it("switches a surface material to the interface terminal", () => {
    const doc = setMaterialDomain(
      createDefaultMaterialDocument("Rock"),
      "interface",
    );
    expect(doc.domain).toBe("interface");
    expect(doc.nodes.some((node) => node.type === "output.surface")).toBe(false);
    expect(doc.nodes.some((node) => node.type === "output.interface")).toBe(
      true,
    );
  });

  it("drops scene samples when switching post-process to interface", () => {
    const iface = setMaterialDomain(
      createDefaultMaterialDocument("Blur", "postProcess"),
      "interface",
    );
    expect(iface.nodes.some((node) => node.type === "input.sceneColor")).toBe(
      false,
    );
    expect(iface.nodes.some((node) => node.type === "input.screenUv")).toBe(
      false,
    );
  });

  it("defaults Custom GLSL nodes to an a + b expression", () => {
    const doc = normalizeMaterialDocument({
      nodes: [
        {
          id: "glsl",
          type: "custom.glsl",
          position: { x: 0, y: 0 },
          properties: {},
        },
      ],
    });
    const node = doc.nodes.find((entry) => entry.id === "glsl");
    expect(node?.properties.body).toBe("a + b");
  });

  it("migrates a legacy glsl property onto the Custom GLSL body", () => {
    const doc = normalizeMaterialDocument({
      nodes: [
        {
          id: "glsl",
          type: "custom.glsl",
          position: { x: 0, y: 0 },
          properties: { glsl: "a * b" },
        },
      ],
    });
    const node = doc.nodes.find((entry) => entry.id === "glsl");
    expect(node?.properties.body).toBe("a * b");
    expect(node?.properties.glsl).toBeUndefined();
  });
});
