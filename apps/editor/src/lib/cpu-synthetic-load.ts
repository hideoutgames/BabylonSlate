/**
 * A fixed synthetic CPU load for the Feature Test Check's Profile: the same work every run, on the main thread, so a
 * row's time for it says how fast the CPU ran then, apart from what the scene asked of it (as the GPU probes'
 * synthetic load does for the GPU). Two kernels over preallocated typed arrays, made once and only read after:
 * `compute`, integer and float arithmetic over 128 KiB (in cache), and `memory`, a dependent walk over a 8 MiB chain of
 * cache lines (memory latency). Each returns a value the caller keeps, so neither can be optimised away.
 */

/** 16 Ki doubles and 16 Ki ints: 192 KiB, within a phone's or a desktop's L2. */
const COMPUTE_LENGTH = 1 << 14;
/** Passes over the compute arrays: about 6.5 million iterations, some 5 to 10 ms on a desktop. */
const COMPUTE_PASSES = 400;
/** 64-byte cache lines in the memory walk's 8 MiB. */
const MEMORY_LINES = 1 << 17;
/** Int32 entries per cache line. */
const LINE_INTS = 16;

let computeFloats: Float64Array | null = null;
let computeInts: Int32Array | null = null;
let memoryChain: Int32Array | null = null;

/** A deterministic 32-bit generator (xorshift), the same sequence every run. */
function generator(seed: number): () => number {
  let state = seed | 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function arrays(): { floats: Float64Array; ints: Int32Array; chain: Int32Array } {
  if (!computeFloats || !computeInts || !memoryChain) {
    const next = generator(0x2545f491);
    computeFloats = new Float64Array(COMPUTE_LENGTH);
    computeInts = new Int32Array(COMPUTE_LENGTH);
    for (let index = 0; index < COMPUTE_LENGTH; index++) {
      computeFloats[index] = (next() % 1000) / 997 + 0.5;
      computeInts[index] = next() | 0;
    }
    // One cycle through every line in a shuffled order: each step's address depends on the one before.
    const order = new Int32Array(MEMORY_LINES);
    for (let line = 0; line < MEMORY_LINES; line++) order[line] = line;
    for (let line = MEMORY_LINES - 1; line > 0; line--) {
      const other = next() % (line + 1);
      const held = order[line]!;
      order[line] = order[other]!;
      order[other] = held;
    }
    memoryChain = new Int32Array(MEMORY_LINES * LINE_INTS);
    for (let at = 0; at < MEMORY_LINES; at++) memoryChain[order[at]! * LINE_INTS] = order[(at + 1) % MEMORY_LINES]! * LINE_INTS;
  }
  return { floats: computeFloats, ints: computeInts, chain: memoryChain };
}

/** The in-cache arithmetic kernel; its result depends on every iteration. */
export function cpuComputeKernel(): number {
  const { floats, ints } = arrays();
  let hash = 0x811c9dc5 | 0;
  let sum = 0;
  for (let pass = 0; pass < COMPUTE_PASSES; pass++) {
    for (let index = 0; index < COMPUTE_LENGTH; index++) {
      hash = Math.imul(hash ^ ints[index]!, 0x01000193);
      sum = sum * 0.9999 + floats[index]! * ((hash & 7) + 1);
    }
  }
  return (hash >>> 0) + sum;
}

/** The memory-latency kernel: one walk round the whole chain, each load waiting on the last. */
export function cpuMemoryKernel(): number {
  const { chain } = arrays();
  let at = 0;
  let steps = 0;
  for (let step = 0; step < MEMORY_LINES; step++) {
    at = chain[at]!;
    steps += at & 1;
  }
  return at + steps;
}

/** One row's synthetic CPU load: the compute kernel's fastest and median repeat, the memory walk's, in ms. */
export interface CpuSyntheticLoad {
  minMs: number;
  medianMs: number;
  memoryMs: number;
  /** What the kernels returned, kept so they are not optimised away; the same every run. */
  value: number;
}

/** Compute repeats per row: their minimum is the CPU's speed, their median its steadiness. */
export const CPU_SYNTHETIC_REPEATS = 5;

/**
 * Runs the load once for a row on `now`'s clock: one untimed run of each kernel (warming the JIT and the caches), then
 * the compute kernel `CPU_SYNTHETIC_REPEATS` times and the memory walk once. About 70 ms on a desktop.
 */
export function runCpuSyntheticLoad(now: () => number): CpuSyntheticLoad {
  let value = cpuComputeKernel() + cpuMemoryKernel();
  for (let repeat = 0; repeat < CPU_SYNTHETIC_REPEATS; repeat++) {
    const started = now();
    value += cpuComputeKernel();
    repeatTimes[repeat] = now() - started;
  }
  const started = now();
  value += cpuMemoryKernel();
  const memoryMs = now() - started;
  repeatTimes.sort();
  return { minMs: repeatTimes[0]!, medianMs: repeatTimes[CPU_SYNTHETIC_REPEATS >> 1]!, memoryMs, value };
}

/** The compute repeats' times, reused by every row. */
const repeatTimes = new Float64Array(CPU_SYNTHETIC_REPEATS);
