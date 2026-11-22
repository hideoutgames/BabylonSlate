import type { PropertyRow } from "@haptic/editor-kit";
import {
  DEFAULT_SOUND_ATTENUATION_FALLOFF,
  SOUND_ATTENUATION_FALLOFFS,
  SOUND_ATTENUATION_FALLOFF_LABELS,
  clampAudioGain,
  type SoundAttenuationFalloff,
  type SoundAttenuationPayload,
} from "@haptic/assets";

const DEFAULT_CONE = {
  innerAngle: 90,
  outerAngle: 120,
  outerGain: 0,
};

const DEFAULT_DOPPLER = {
  enabled: true,
  factor: 1,
};

/** What Custom falls off as while it has no curve. */
const FALLBACK_LABEL = SOUND_ATTENUATION_FALLOFF_LABELS[DEFAULT_SOUND_ATTENUATION_FALLOFF];

/**
 * The Sound Attenuation Details rows. Editing one radius past the other stops at it (Inner Radius never passes Max
 * Radius), so a scrub never swaps the two. `pickCurve` opens the Float Curve picker for a Custom falloff;
 * `assetName` labels the picked curve (undefined when the project has no such asset).
 */
export function soundAttenuationDetailRows(
  attenuation: SoundAttenuationPayload,
  /** `field` marks a continuous edit whose scrub is one undo step. */
  commit: (next: SoundAttenuationPayload, field?: string) => void,
  pickCurve: () => void,
  assetName: (guid: string) => string | undefined,
): PropertyRow[] {
  const rows: PropertyRow[] = [
    {
      id: "innerRadius",
      kind: "number",
      label: "Inner Radius",
      value: attenuation.innerRadius,
      min: 0,
      onChange: (innerRadius) =>
        commit({ ...attenuation, innerRadius: Math.min(innerRadius, attenuation.maxRadius) }, "innerRadius"),
    },
    {
      id: "maxRadius",
      kind: "number",
      label: "Max Radius",
      value: attenuation.maxRadius,
      min: 0,
      onChange: (maxRadius) =>
        commit({ ...attenuation, maxRadius: Math.max(maxRadius, attenuation.innerRadius) }, "maxRadius"),
    },
    {
      id: "falloff",
      kind: "enum",
      label: "Falloff",
      description: "How the volume falls from Inner Radius to Max Radius. Custom follows a Float Curve.",
      value: attenuation.falloff,
      options: SOUND_ATTENUATION_FALLOFFS.map((value) => ({ value, label: SOUND_ATTENUATION_FALLOFF_LABELS[value] })),
      onChange: (falloff) => commit({ ...attenuation, falloff: falloff as SoundAttenuationFalloff }),
    },
  ];

  if (attenuation.falloff === "custom") {
    const guid = attenuation.falloffCurveGuid;
    const name = guid ? assetName(guid) : undefined;
    rows.push({
      id: "falloffCurveGuid",
      kind: "asset",
      label: "Falloff Curve",
      description: "X runs from 0 at Inner Radius to 1 at Max Radius; Y is the volume, from 0 to 1.",
      value: guid,
      ...(guid ? { displayLabel: name ?? "Missing Curve", displayType: "Float Curve" } : {}),
      placeholder: "None",
      assetTypes: ["FloatCurve"],
      ...(guid && name !== undefined ? {} : { status: `Falls off as ${FALLBACK_LABEL} until a Float Curve is picked.` }),
      onPick: pickCurve,
      onChange: (falloffCurveGuid) => commit({ ...attenuation, falloffCurveGuid }),
    });
  }

  rows.push(
    {
      id: "spatialisation",
      kind: "enum",
      label: "Spatialisation",
      value: attenuation.spatialisation,
      options: [
        { value: "equalPower", label: "Equal Power" },
        { value: "hrtf", label: "HRTF" },
      ],
      onChange: (spatialisation) =>
        commit({
          ...attenuation,
          spatialisation:
            spatialisation as SoundAttenuationPayload["spatialisation"],
        }),
    },
    {
      id: "coneEnabled",
      kind: "boolean",
      label: "Cone",
      value: attenuation.cone !== null,
      onChange: (enabled) =>
        commit({
          ...attenuation,
          cone: enabled ? { ...(attenuation.cone ?? DEFAULT_CONE) } : null,
        }),
    },
  );

  if (attenuation.cone) {
    const cone = attenuation.cone;
    rows.push(
      {
        id: "coneInnerAngle",
        kind: "number",
        label: "Inner Angle",
        value: cone.innerAngle,
        min: 0,
        max: 360,
        onChange: (innerAngle) =>
          commit({ ...attenuation, cone: { ...cone, innerAngle: Math.min(innerAngle, cone.outerAngle) } }, "cone.innerAngle"),
      },
      {
        id: "coneOuterAngle",
        kind: "number",
        label: "Outer Angle",
        value: cone.outerAngle,
        min: 0,
        max: 360,
        onChange: (outerAngle) =>
          commit({ ...attenuation, cone: { ...cone, outerAngle: Math.max(outerAngle, cone.innerAngle) } }, "cone.outerAngle"),
      },
      {
        id: "coneOuterGain",
        kind: "number",
        label: "Outer Gain",
        value: cone.outerGain,
        min: 0,
        max: 1,
        onChange: (outerGain) =>
          commit({
            ...attenuation,
            cone: { ...cone, outerGain: clampAudioGain(outerGain, 0) },
          }, "cone.outerGain"),
      },
    );
  }

  rows.push({
    id: "dopplerEnabled",
    kind: "boolean",
    label: "Doppler",
    value: attenuation.doppler?.enabled === true,
    onChange: (enabled) =>
      commit({
        ...attenuation,
        doppler: enabled
          ? { ...(attenuation.doppler ?? DEFAULT_DOPPLER), enabled: true }
          : null,
      }),
  });

  if (attenuation.doppler?.enabled) {
    const doppler = attenuation.doppler;
    rows.push({
      id: "dopplerFactor",
      kind: "number",
      label: "Doppler Factor",
      value: doppler.factor,
      min: 0,
      onChange: (factor) =>
        commit({ ...attenuation, doppler: { ...doppler, factor } }, "doppler.factor"),
    });
  }

  return rows;
}
