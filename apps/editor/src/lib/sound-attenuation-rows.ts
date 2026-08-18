import type { PropertyRow } from "@babylonslate/editor-kit";
import {
  clampAudioGain,
  type SoundAttenuationPayload,
} from "@babylonslate/assets";

const DEFAULT_CONE = {
  innerAngle: 90,
  outerAngle: 120,
  outerGain: 0,
};

const DEFAULT_DOPPLER = {
  enabled: true,
  factor: 1,
};

export function soundAttenuationDetailRows(
  attenuation: SoundAttenuationPayload,
  commit: (next: SoundAttenuationPayload) => void,
): PropertyRow[] {
  const rows: PropertyRow[] = [
    {
      id: "innerRadius",
      kind: "number",
      label: "Inner Radius",
      value: attenuation.innerRadius,
      min: 0,
      onChange: (innerRadius) => commit({ ...attenuation, innerRadius }),
    },
    {
      id: "maxRadius",
      kind: "number",
      label: "Max Radius",
      value: attenuation.maxRadius,
      min: 0,
      onChange: (maxRadius) => commit({ ...attenuation, maxRadius }),
    },
    {
      id: "distanceModel",
      kind: "enum",
      label: "Distance Model",
      value: attenuation.distanceModel,
      options: [
        { value: "linear", label: "Linear" },
        { value: "inverse", label: "Inverse" },
        { value: "exponential", label: "Exponential" },
      ],
      onChange: (distanceModel) =>
        commit({
          ...attenuation,
          distanceModel: distanceModel as SoundAttenuationPayload["distanceModel"],
        }),
    },
    {
      id: "rolloff",
      kind: "number",
      label: "Rolloff",
      value: attenuation.rolloff,
      min: 0,
      onChange: (rolloff) => commit({ ...attenuation, rolloff }),
    },
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
  ];

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
          commit({ ...attenuation, cone: { ...cone, innerAngle } }),
      },
      {
        id: "coneOuterAngle",
        kind: "number",
        label: "Outer Angle",
        value: cone.outerAngle,
        min: 0,
        max: 360,
        onChange: (outerAngle) =>
          commit({ ...attenuation, cone: { ...cone, outerAngle } }),
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
          }),
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
        commit({ ...attenuation, doppler: { ...doppler, factor } }),
    });
  }

  return rows;
}
