/**
 * Where a game session runs, as its host reports it on Play load. Exported games are
 * web pages, so the platform is the device's operating system, not the Haptic host.
 */

/** Get Platform's values: the `engine:Platform` enum members. */
export const DEVICE_PLATFORMS = ["iOS", "Android", "Windows", "macOS", "Linux", "Other"] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];
export const ENGINE_PLATFORM_ENUM_ID = "engine:Platform";

export type GameEnvironment = {
  platform: DevicePlatform;
  /** The device has a touch screen. */
  touchDevice: boolean;
  /** Editor Play, Simulate or an Editor Utility Object; false in Preview Build and exported games. */
  inEditor: boolean;
  /** Development Only nodes run: everywhere except a release export (no bundled debugger). */
  developmentBuild: boolean;
};

/** What a host knows before Play reports its environment, such as an in-process test. */
export const DEFAULT_GAME_ENVIRONMENT: GameEnvironment = {
  platform: "Other",
  touchDevice: false,
  inEditor: false,
  developmentBuild: true,
};

export type UserAgentFacts = {
  userAgent: string;
  /** `navigator.maxTouchPoints`: iPadOS reports a Mac user agent, and touch support gives it away. */
  maxTouchPoints?: number;
};

/** The operating system a browser user agent names. Android precedes Linux, which its user agent also names. */
export function devicePlatformFromUserAgent(facts: UserAgentFacts): DevicePlatform {
  const agent = facts.userAgent;
  if (/iPhone|iPad|iPod/.test(agent)) return "iOS";
  if (/Macintosh|Mac OS X/.test(agent)) return (facts.maxTouchPoints ?? 0) > 1 ? "iOS" : "macOS";
  if (/Android/.test(agent)) return "Android";
  if (/Windows/.test(agent)) return "Windows";
  if (/Linux|X11|CrOS/.test(agent)) return "Linux";
  return "Other";
}

/** What a browser reports about its device: Get Platform from the user agent, Is Touch Device from touch points. */
export function browserDeviceFacts(nav: Partial<UserAgentFacts> | undefined): Pick<GameEnvironment, "platform" | "touchDevice"> {
  const maxTouchPoints = nav?.maxTouchPoints ?? 0;
  return {
    platform: devicePlatformFromUserAgent({ userAgent: nav?.userAgent ?? "", maxTouchPoints }),
    touchDevice: maxTouchPoints > 0,
  };
}

/** A load message's environment, with unknown fields at their defaults. */
export function normalizeGameEnvironment(value: unknown): GameEnvironment {
  const input = value && typeof value === "object" ? value as Partial<Record<keyof GameEnvironment, unknown>> : {};
  const flag = (key: "touchDevice" | "inEditor" | "developmentBuild") =>
    typeof input[key] === "boolean" ? input[key] as boolean : DEFAULT_GAME_ENVIRONMENT[key];
  return {
    platform: normalizeDevicePlatform(input.platform),
    touchDevice: flag("touchDevice"),
    inEditor: flag("inEditor"),
    developmentBuild: flag("developmentBuild"),
  };
}

/** A Get Platform value from untrusted input, such as a load message. */
export function normalizeDevicePlatform(value: unknown): DevicePlatform {
  return (DEVICE_PLATFORMS as readonly unknown[]).includes(value) ? (value as DevicePlatform) : "Other";
}
