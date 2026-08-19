import {
  pin,
  type NodeDefinition,
  EXEC,
  FLOAT,
  COLOR,
  VEC3,
  ROTATOR,
  type GraphPin,
} from "@babylonslate/scripting";

const WHITE = { x: 1, y: 1, z: 1, w: 1 };
const ORIGIN = { x: 0, y: 0, z: 0 };
const UNIT_X = { x: 1, y: 0, z: 0 };
const UNIT_Y = { x: 0, y: 1, z: 0 };
const HALF = { x: 0.5, y: 0.5, z: 0.5 };
const ZERO_ROT = { pitch: 0, yaw: 0, roll: 0 };

function debugDrawPins(geometry: GraphPin[]): GraphPin[] {
  return [
    pin("execIn", "exec", "in", EXEC),
    pin("execOut", "then", "out", EXEC),
    ...geometry,
    pin("color", "Color", "in", COLOR, "data", true, WHITE),
    pin("duration", "Duration", "in", FLOAT, "data", true, 0),
  ];
}

function emitDraw(kind: string, fields: readonly string[]): NodeDefinition["codegen"] {
  return (ctx) => {
    const parts = fields
      .map((field) => `${field}: ${ctx.input(field)}`)
      .join(", ");
    ctx.emit(
      `ctx.drawDebug({ kind: ${JSON.stringify(kind)}, ${parts}, color: ${ctx.input("color")}, duration: ${ctx.input("duration")} });`,
    );
  };
}

function drawNode(
  id: string,
  title: string,
  kind: string,
  geometry: GraphPin[],
  fields: readonly string[],
): NodeDefinition {
  return {
    id,
    title,
    category: "debug",
    developmentOnlyByDefault: true,
    pins: () => debugDrawPins(geometry),
    codegen: emitDraw(kind, fields),
  };
}

export const debugDrawNodes: NodeDefinition[] = [
  drawNode(
    "debug.drawLine",
    "Draw Debug Line",
    "line",
    [
      pin("start", "Start", "in", VEC3, "data", true, ORIGIN),
      pin("end", "End", "in", VEC3, "data", true, UNIT_X),
      pin("thickness", "Thickness", "in", FLOAT, "data", true, 1),
    ],
    ["start", "end", "thickness"],
  ),
  drawNode(
    "debug.drawPoint",
    "Draw Debug Point",
    "point",
    [
      pin("position", "Position", "in", VEC3, "data", true, ORIGIN),
      pin("size", "Size", "in", FLOAT, "data", true, 0.1),
    ],
    ["position", "size"],
  ),
  drawNode(
    "debug.drawBox",
    "Draw Debug Box",
    "box",
    [
      pin("center", "Center", "in", VEC3, "data", true, ORIGIN),
      pin("extent", "Extent", "in", VEC3, "data", true, HALF),
      pin("rotation", "Rotation", "in", ROTATOR, "data", true, ZERO_ROT),
    ],
    ["center", "extent", "rotation"],
  ),
  drawNode(
    "debug.drawSphere",
    "Draw Debug Sphere",
    "sphere",
    [
      pin("center", "Center", "in", VEC3, "data", true, ORIGIN),
      pin("radius", "Radius", "in", FLOAT, "data", true, 0.5),
      pin("segments", "Segments", "in", FLOAT, "data", true, 12),
    ],
    ["center", "radius", "segments"],
  ),
  drawNode(
    "debug.drawCircle",
    "Draw Debug Circle",
    "circle",
    [
      pin("center", "Center", "in", VEC3, "data", true, ORIGIN),
      pin("radius", "Radius", "in", FLOAT, "data", true, 0.5),
      pin("rotation", "Rotation", "in", ROTATOR, "data", true, ZERO_ROT),
    ],
    ["center", "radius", "rotation"],
  ),
  drawNode(
    "debug.drawRectangle",
    "Draw Debug Rectangle",
    "rectangle",
    [
      pin("center", "Center", "in", VEC3, "data", true, ORIGIN),
      pin("width", "Width", "in", FLOAT, "data", true, 1),
      pin("height", "Height", "in", FLOAT, "data", true, 1),
      pin("rotation", "Rotation", "in", ROTATOR, "data", true, ZERO_ROT),
    ],
    ["center", "width", "height", "rotation"],
  ),
  drawNode(
    "debug.drawSquare",
    "Draw Debug Square",
    "square",
    [
      pin("center", "Center", "in", VEC3, "data", true, ORIGIN),
      pin("size", "Size", "in", FLOAT, "data", true, 1),
      pin("rotation", "Rotation", "in", ROTATOR, "data", true, ZERO_ROT),
    ],
    ["center", "size", "rotation"],
  ),
  drawNode(
    "debug.drawCone",
    "Draw Debug Cone",
    "cone",
    [
      pin("origin", "Origin", "in", VEC3, "data", true, ORIGIN),
      pin("direction", "Direction", "in", VEC3, "data", true, UNIT_Y),
      pin("length", "Length", "in", FLOAT, "data", true, 1),
      pin("angle", "Angle", "in", FLOAT, "data", true, 30),
    ],
    ["origin", "direction", "length", "angle"],
  ),
  drawNode(
    "debug.drawCylinder",
    "Draw Debug Cylinder",
    "cylinder",
    [
      pin("start", "Start", "in", VEC3, "data", true, ORIGIN),
      pin("end", "End", "in", VEC3, "data", true, UNIT_Y),
      pin("radius", "Radius", "in", FLOAT, "data", true, 0.25),
    ],
    ["start", "end", "radius"],
  ),
  drawNode(
    "debug.drawArrow",
    "Draw Debug Arrow",
    "arrow",
    [
      pin("start", "Start", "in", VEC3, "data", true, ORIGIN),
      pin("end", "End", "in", VEC3, "data", true, UNIT_Y),
      pin("size", "Size", "in", FLOAT, "data", true, 0.2),
    ],
    ["start", "end", "size"],
  ),
  drawNode(
    "debug.drawFrustum",
    "Draw Debug Frustum",
    "frustum",
    [
      pin("origin", "Origin", "in", VEC3, "data", true, ORIGIN),
      pin("rotation", "Rotation", "in", ROTATOR, "data", true, ZERO_ROT),
      pin("fov", "FOV", "in", FLOAT, "data", true, 90),
      pin("aspect", "Aspect", "in", FLOAT, "data", true, 16 / 9),
      pin("near", "Near", "in", FLOAT, "data", true, 0.1),
      pin("far", "Far", "in", FLOAT, "data", true, 10),
    ],
    ["origin", "rotation", "fov", "aspect", "near", "far"],
  ),
  drawNode(
    "debug.drawCoordinateSystem",
    "Draw Debug Coordinate System",
    "coordinateSystem",
    [
      pin("origin", "Origin", "in", VEC3, "data", true, ORIGIN),
      pin("rotation", "Rotation", "in", ROTATOR, "data", true, ZERO_ROT),
      pin("scale", "Scale", "in", FLOAT, "data", true, 1),
    ],
    ["origin", "rotation", "scale"],
  ),
];
