import type { PropertyRow } from "@haptic/editor-kit";
import {
  CAMERA_SHAKE_PATTERNS,
  CAMERA_SHAKE_PATTERN_LABELS,
  type CameraShakePattern,
  type CameraShakePayload,
} from "@haptic/core";

/** The Camera Shake fields that name a curve asset, and the curve type each accepts. */
export const CAMERA_SHAKE_CURVE_FIELDS = {
  intensityCurveGuid: "FloatCurve",
  locationCurveGuid: "VectorCurve",
  rotationCurveGuid: "VectorCurve",
  fovCurveGuid: "FloatCurve",
} as const;
export type CameraShakeCurveField = keyof typeof CAMERA_SHAKE_CURVE_FIELDS;

const ROTATION_AXES = ["Pitch", "Yaw", "Roll"];

/**
 * The Camera Shake Inspector rows: timing, the Noise and Sine Wave channels or the Curves pattern's curves, and the
 * Intensity Curve. `pick` opens the asset picker for a curve field; `assetName` labels a picked curve.
 */
export function cameraShakeDetailRows(
  shake: CameraShakePayload,
  /** `field` marks a continuous edit whose scrub is one undo step. */
  commit: (next: CameraShakePayload, field?: string) => void,
  pick: (field: CameraShakeCurveField) => void,
  assetName: (guid: string) => string | undefined,
): PropertyRow[] {
  const number = (id: keyof CameraShakePayload & string, label: string, unit: string, description?: string): PropertyRow => ({
    id, kind: "number", label, unit, min: 0, value: shake[id] as number,
    ...(description ? { description } : {}),
    onChange: (value) => commit({ ...shake, [id]: value }, id),
  });
  const curve = (field: CameraShakeCurveField, label: string, description?: string): PropertyRow => {
    const guid = shake[field];
    return {
      id: field, kind: "asset", label, value: guid,
      ...(guid ? { displayLabel: assetName(guid) ?? "Missing Curve", displayType: CAMERA_SHAKE_CURVE_FIELDS[field] === "FloatCurve" ? "Float Curve" : "Vector Curve" } : {}),
      placeholder: "None",
      assetTypes: [CAMERA_SHAKE_CURVE_FIELDS[field]],
      ...(description ? { description } : {}),
      onPick: () => pick(field),
      onChange: (value) => commit({ ...shake, [field]: value }),
    };
  };
  const rows: PropertyRow[] = [
    {
      id: "pattern", kind: "enum", label: "Pattern", value: shake.pattern,
      options: CAMERA_SHAKE_PATTERNS.map((value) => ({ value, label: CAMERA_SHAKE_PATTERN_LABELS[value] })),
      onChange: (pattern) => commit({ ...shake, pattern: pattern as CameraShakePattern }),
    },
    number("duration", "Duration", "s", "0 plays until a script stops it."),
    number("blendInTime", "Blend In Time", "s"),
    number("blendOutTime", "Blend Out Time", "s", "Also how long Stop Camera Shake takes to fade it out."),
  ];
  if (shake.pattern === "curves") {
    rows.push(
      curve("locationCurveGuid", "Location Curve", "Offset along the view's right, up and forward axes over the shake's seconds."),
      curve("rotationCurveGuid", "Rotation Curve", "Pitch, yaw and roll in degrees (X, Y, Z) over the shake's seconds."),
      curve("fovCurveGuid", "Field Of View Curve", "Field Of View change in degrees over the shake's seconds."),
    );
  } else {
    const { locationAmplitude: la, locationFrequency: lf, rotationAmplitude: ra, rotationFrequency: rf } = shake;
    rows.push(
      {
        id: "locationAmplitude", kind: "vector3", label: "Location Amplitude", unit: "m", value: [la.x, la.y, la.z],
        description: "Along the view's right, up and forward axes.",
        onChange: ([x, y, z]) => commit({ ...shake, locationAmplitude: { x: x!, y: y!, z: z! } }, "locationAmplitude"),
      },
      {
        id: "locationFrequency", kind: "vector3", label: "Location Frequency", unit: "Hz", value: [lf.x, lf.y, lf.z],
        onChange: ([x, y, z]) => commit({ ...shake, locationFrequency: { x: x!, y: y!, z: z! } }, "locationFrequency"),
      },
      {
        id: "rotationAmplitude", kind: "vector3", label: "Rotation Amplitude", unit: "°", axes: ROTATION_AXES, value: [ra.pitch, ra.yaw, ra.roll],
        onChange: ([pitch, yaw, roll]) => commit({ ...shake, rotationAmplitude: { pitch: pitch!, yaw: yaw!, roll: roll! } }, "rotationAmplitude"),
      },
      {
        id: "rotationFrequency", kind: "vector3", label: "Rotation Frequency", unit: "Hz", axes: ROTATION_AXES, value: [rf.pitch, rf.yaw, rf.roll],
        onChange: ([pitch, yaw, roll]) => commit({ ...shake, rotationFrequency: { pitch: pitch!, yaw: yaw!, roll: roll! } }, "rotationFrequency"),
      },
      number("fovAmplitude", "Field Of View Amplitude", "°", "An orthographic view zooms instead."),
      number("fovFrequency", "Field Of View Frequency", "Hz"),
    );
  }
  rows.push(curve("intensityCurveGuid", "Intensity Curve", "Multiplies the strength over the shake's seconds. None is full strength."));
  return rows;
}
