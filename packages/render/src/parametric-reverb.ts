import {
  AUDIO_REVERB_ALLPASS_COUNT,
  AUDIO_REVERB_COMB_COUNT,
} from "@babylonslate/assets";

/** Fixed Schroeder delay taps (seconds). Lengths are the P16 comb / all-pass counts. */
export const PARAMETRIC_REVERB_COMB_DELAYS = [0.0297, 0.0371, 0.0411, 0.0437];
export const PARAMETRIC_REVERB_ALLPASS_DELAYS = [0.005, 0.0017];

export type ParametricReverbGraph = {
  combCount: number;
  allpassCount: number;
  setWet: (wet: number) => void;
  dispose: () => void;
};

export function parametricReverbTopology(): {
  combDelays: number[];
  allpassDelays: number[];
} {
  return {
    combDelays: PARAMETRIC_REVERB_COMB_DELAYS.slice(0, AUDIO_REVERB_COMB_COUNT),
    allpassDelays: PARAMETRIC_REVERB_ALLPASS_DELAYS.slice(
      0,
      AUDIO_REVERB_ALLPASS_COUNT,
    ),
  };
}

function schroederAllpass(
  context: BaseAudioContext,
  input: AudioNode,
  delayTime: number,
  nodes: AudioNode[],
): AudioNode {
  const delay = context.createDelay(1);
  delay.delayTime.value = delayTime;
  const feedback = context.createGain();
  feedback.gain.value = 0.5;
  const feedforward = context.createGain();
  feedforward.gain.value = -0.5;
  const output = context.createGain();
  output.gain.value = 1;
  input.connect(delay);
  delay.connect(feedback);
  feedback.connect(delay);
  delay.connect(output);
  input.connect(feedforward);
  feedforward.connect(output);
  nodes.push(delay, feedback, feedforward, output);
  return output;
}

export type ParametricReverbOptions = {
  /**
   * When true (default), also connect a unity dry path. Skip this when the
   * host already routes the send bus to the main mix (Babylon AudioV2).
   */
  dryPassThrough?: boolean;
};

/**
 * Dry pass-through plus one shared delay/comb/all-pass wet branch.
 * `input` is the reverb-send bus output; `output` is the main mix.
 */
export function connectParametricReverb(
  context: BaseAudioContext,
  input: AudioNode,
  output: AudioNode,
  options?: ParametricReverbOptions,
): ParametricReverbGraph {
  const { combDelays, allpassDelays } = parametricReverbTopology();
  const nodes: AudioNode[] = [];
  const wet = context.createGain();
  wet.gain.value = 0;
  input.connect(wet);
  nodes.push(wet);
  if (options?.dryPassThrough !== false) {
    const dry = context.createGain();
    dry.gain.value = 1;
    input.connect(dry);
    dry.connect(output);
    nodes.push(dry);
  }

  const combOut = context.createGain();
  combOut.gain.value = 1 / Math.max(1, combDelays.length);
  nodes.push(combOut);
  for (const delayTime of combDelays) {
    const delay = context.createDelay(1);
    delay.delayTime.value = delayTime;
    const feedback = context.createGain();
    feedback.gain.value = 0.7;
    const damping = context.createBiquadFilter();
    damping.type = "lowpass";
    damping.frequency.value = 3000;
    wet.connect(delay);
    delay.connect(damping);
    damping.connect(feedback);
    feedback.connect(delay);
    damping.connect(combOut);
    nodes.push(delay, feedback, damping);
  }

  let stage: AudioNode = combOut;
  for (const delayTime of allpassDelays) {
    stage = schroederAllpass(context, stage, delayTime, nodes);
  }
  stage.connect(output);

  return {
    combCount: combDelays.length,
    allpassCount: allpassDelays.length,
    setWet: (value) => {
      wet.gain.value = Math.min(1, Math.max(0, value));
    },
    dispose: () => {
      for (const node of nodes) node.disconnect();
    },
  };
}
