/**
 * Repository `engine-content/` files the FeatureTest starter imports. Node-free
 * so the Vite copy plugin and the browser scaffold share one list.
 */

/** Curated Kenney Holiday Pack models (CC0). Each one references `Textures/colormap.png`. */
export const FEATURE_TEST_HOLIDAY_MODELS = [
  "cabin-door-rotate",
  "hanukkah-menorah-candles",
  "lantern",
  "present-a-cube",
  "rocks-medium",
  "snow-pile",
  "snowman",
  "train-locomotive",
  "tree-snow-a",
] as const;

export type FeatureTestHolidayModel = (typeof FEATURE_TEST_HOLIDAY_MODELS)[number];

export const HOLIDAY_PACK_DIR = "engine-content/kenney-assets/Holiday Pack";
export const HOLIDAY_COLORMAP_PATH = `${HOLIDAY_PACK_DIR}/Textures/colormap.png`;
/** Geist (SIL OFL 1.1); `OFL.txt` ships beside it. */
export const GEIST_FONT_PATH = "engine-content/fonts/Geist/Geist-Latin-Variable.woff2";
export const GEIST_LICENSE_PATH = "engine-content/fonts/Geist/OFL.txt";
export const SKYBOX_NET_PATH = "engine-content/skybox/cubemap_layout.png";

export function holidayModelPath(stem: FeatureTestHolidayModel): string {
  return `${HOLIDAY_PACK_DIR}/${stem}.glb`;
}

/** Required repository files that the editor build must publish. */
export const FEATURE_TEST_ENGINE_CONTENT: readonly string[] = [
  ...FEATURE_TEST_HOLIDAY_MODELS.map(holidayModelPath),
  HOLIDAY_COLORMAP_PATH,
  GEIST_FONT_PATH,
  GEIST_LICENSE_PATH,
  SKYBOX_NET_PATH,
];

/**
 * Optional, human-supplied CC0 media. The repository ships none of these: a
 * missing slot leaves the matching feature authored but silent or ungraded.
 * Each slot lists accepted file names in priority order.
 */
export const FEATURE_TEST_OPTIONAL_SLOTS = {
  /** Looping sound for spatial Audio Components. */
  loopAudio: [
    "engine-content/feature-test/audio/FT_Loop.ogg",
    "engine-content/feature-test/audio/FT_Loop.wav",
    "engine-content/feature-test/audio/FT_Loop.mp3",
  ],
  /** Short one-shot sound for UI and gameplay cues. */
  oneShotAudio: [
    "engine-content/feature-test/audio/FT_OneShot.ogg",
    "engine-content/feature-test/audio/FT_OneShot.wav",
    "engine-content/feature-test/audio/FT_OneShot.mp3",
  ],
  /** Color grading LUT strip: width = size × size, height = size (for example 256 × 16). */
  colorGradingLut: ["engine-content/feature-test/lut/FT_Grade_lut.png"],
} as const satisfies Record<string, readonly string[]>;

export type FeatureTestOptionalSlot = keyof typeof FEATURE_TEST_OPTIONAL_SLOTS;

/** Published list of optional files present at build time (written by the copy plugin). */
export const FEATURE_TEST_SLOTS_MANIFEST = "engine-content/feature-test/slots.json";
