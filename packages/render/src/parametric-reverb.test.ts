import { describe, expect, it } from "vitest";
import {
  AUDIO_REVERB_ALLPASS_COUNT,
  AUDIO_REVERB_COMB_COUNT,
} from "@babylonslate/assets";
import {
  connectParametricReverb,
  parametricReverbTopology,
} from "./parametric-reverb";

type MockNode = {
  kind: string;
  connections: MockNode[];
  connect: (dest: MockNode) => MockNode;
  disconnect: () => void;
  gain: { value: number };
  delayTime: { value: number };
  type: string;
  frequency: { value: number };
};

function mockAudioGraph(): {
  context: BaseAudioContext;
  input: AudioNode;
  output: AudioNode;
  nodes: MockNode[];
} {
  const nodes: MockNode[] = [];
  const create = (kind: string): MockNode => {
    const node: MockNode = {
      kind,
      connections: [],
      connect(dest) {
        this.connections.push(dest);
        return dest;
      },
      disconnect() {},
      gain: { value: 0 },
      delayTime: { value: 0 },
      type: "",
      frequency: { value: 0 },
    };
    nodes.push(node);
    return node;
  };
  return {
    context: {
      createGain: () => create("gain"),
      createDelay: () => create("delay"),
      createBiquadFilter: () => create("filter"),
    } as unknown as BaseAudioContext,
    input: create("input") as unknown as AudioNode,
    output: create("output") as unknown as AudioNode,
    nodes,
  };
}

describe("parametric reverb topology", () => {
  it("locks one shared bus to four combs and two all-passes", () => {
    const topology = parametricReverbTopology();
    expect(topology.combDelays).toHaveLength(AUDIO_REVERB_COMB_COUNT);
    expect(topology.allpassDelays).toHaveLength(AUDIO_REVERB_ALLPASS_COUNT);
    expect(topology.combDelays.every((delay) => delay > 0 && delay < 0.1)).toBe(
      true,
    );
    expect(topology.allpassDelays.every((delay) => delay > 0 && delay < 0.02)).toBe(
      true,
    );
  });

  it("wires dry unity plus Schroeder comb feedback and all-pass feedforward", () => {
    const graph = mockAudioGraph();
    const connected = connectParametricReverb(
      graph.context,
      graph.input,
      graph.output,
    );
    expect(connected.combCount).toBe(AUDIO_REVERB_COMB_COUNT);
    expect(connected.allpassCount).toBe(AUDIO_REVERB_ALLPASS_COUNT);
    expect(graph.nodes.filter((node) => node.kind === "delay")).toHaveLength(
      AUDIO_REVERB_COMB_COUNT + AUDIO_REVERB_ALLPASS_COUNT,
    );
    const feedforward = graph.nodes.filter(
      (node) => node.kind === "gain" && node.gain.value < 0,
    );
    expect(feedforward).toHaveLength(AUDIO_REVERB_ALLPASS_COUNT);
    connected.setWet(0.4);
    const wet = graph.nodes.find(
      (node) => node.kind === "gain" && node.gain.value === 0.4,
    );
    expect(wet).toBeDefined();
    connected.dispose();
  });
});
