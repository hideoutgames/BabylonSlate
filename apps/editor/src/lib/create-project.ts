import type { ProjectAppearance } from "@haptic/core";
import type { NewRepositoryRequest, PublishOutcome } from "../services/source-control-publish";
import type { NewProjectExecuteJavaScriptReview } from "./engine-plugin-library";

// Descriptor + noun + head noun reads as a compound name in any combination,
// for example "Walnut Apple Sauce" or "Velvet Comet Parade".
const NAME_DESCRIPTORS = [
  "Amber", "Brass", "Cedar", "Copper", "Crimson", "Dusty", "Electric", "Fuzzy",
  "Golden", "Hidden", "Honey", "Lucky", "Maple", "Midnight", "Misty", "Neon",
  "Paper", "Quiet", "Rusty", "Silver", "Sunny", "Tiny", "Velvet", "Walnut",
] as const;
const NAME_NOUNS = [
  "Apple", "Badger", "Biscuit", "Button", "Cactus", "Comet", "Cricket",
  "Dragon", "Falcon", "Ferret", "Garden", "Lantern", "Meadow", "Otter",
  "Pebble", "Pepper", "Pickle", "Pixel", "Rabbit", "Rocket", "Thunder",
  "Tulip", "Turnip", "Waffle",
] as const;
const NAME_HEADS = [
  "Arcade", "Bakery", "Canyon", "Carnival", "Castle", "Club", "Express",
  "Factory", "Festival", "Harbor", "Island", "Junction", "Kingdom", "Market",
  "Parade", "Quest", "Rally", "Sauce", "Society", "Station", "Tavern",
  "Valley", "Voyage", "Workshop",
] as const;

function pick<T>(words: readonly T[], random: () => number): T {
  return words[Math.min(words.length - 1, Math.floor(random() * words.length))]!;
}

/** Random three-word project name that is free among `existingNames`. */
export function randomProjectName(
  existingNames: readonly string[],
  random: () => number = Math.random,
): string {
  const taken = (name: string) => createProjectNameIssue(name, existingNames);
  let name = "";
  for (let attempt = 0; attempt < 24; attempt++) {
    name = [
      pick(NAME_DESCRIPTORS, random),
      pick(NAME_NOUNS, random),
      pick(NAME_HEADS, random),
    ].join(" ");
    if (!taken(name)) return name;
  }
  for (let suffix = 2; ; suffix++) {
    if (!taken(`${name} ${suffix}`)) return `${name} ${suffix}`;
  }
}

/** Folder name written to storage; empty when the display name is blank. */
export function normalizeProjectFolderName(displayName: string): string {
  return displayName.trim();
}

export type CreateProjectNameIssue = "Name required." | "Name already exists.";

/** Validation copy for the Create Project name field. */
export function createProjectNameIssue(
  displayName: string,
  existingFolderNames: readonly string[],
): CreateProjectNameIssue | null {
  const folder = normalizeProjectFolderName(displayName);
  if (!folder) return "Name required.";
  const wanted = folder.toLowerCase();
  const taken = existingFolderNames.some(
    (name) => normalizeProjectFolderName(name).toLowerCase() === wanted,
  );
  return taken ? "Name already exists." : null;
}

/** Built-in starters: Blank, Basic 3D (id `empty`), Basic 2D, and Feature Test. */
export const BUILT_IN_STARTER_KINDS = ["blank", "empty", "2d", "feature-test"] as const;

export type BuiltInStarterKind = (typeof BUILT_IN_STARTER_KINDS)[number];

export function isBuiltInStarterKind(id: string): id is BuiltInStarterKind {
  return (BUILT_IN_STARTER_KINDS as readonly string[]).includes(id);
}

/**
 * The broad steps of creating or opening a project, which the launcher card
 * names: `creating` the project's files, `source-control` (a Remote New
 * Project's repository, first commit and push) and `opening` it in the editor.
 */
export type LaunchPhase = "creating" | "source-control" | "opening";

export type CreateProjectOptions = {
  /** Remote: once the project opens, publish it to this new repository, as Project Settings' Publish does. */
  repository?: NewRepositoryRequest;
  /** Reports each step for the launcher card. */
  onPhase?: (phase: LaunchPhase) => void;
  appearance?: ProjectAppearance;
  /** Native only: pick an external folder, then scaffold into it. */
  pickFolder?: boolean;
  /** Built-in starter; omitted creates Basic 3D. */
  kind?: BuiltInStarterKind;
  renderWidth?: number;
  renderHeight?: number;
  blackBars?: boolean;
  /** Pixel Art Optimized (`pixelArtProjectSettings`). */
  pixelArt?: boolean;
  /**
   * Asks whether the project includes the Engine Plugins library's plugins (not bundled with Haptic)
   * that hold Execute JavaScript; omitted (no UI to ask with), they are left out.
   */
  reviewExecuteJavaScript?: NewProjectExecuteJavaScriptReview;
};

/**
 * Whether a Remote New Project must be created in App Documents: on iOS and
 * Android Haptic's Git cannot run in a chosen folder, which another Git app
 * syncs (`other-git-client`). Desktop adopts any folder it publishes.
 */
export function remoteNeedsAppStorage(hostPlatform: string): boolean {
  return hostPlatform === "ios" || hostPlatform === "android";
}

/**
 * What a New Project did: `created` a project and opened it, `opened` the
 * project a picked folder already held, or nothing (`refused`, by a session
 * that would not close).
 */
export type CreateProjectOutcome = "created" | "opened" | "refused";

/**
 * A Remote New Project's last step, once its project is open: publishes it to
 * the new repository with `publish` (Publish to a new repository, as Project
 * Settings' Publish does), naming the step first. Only a project this create
 * made is published. Resolves to why the project stayed Local, for the
 * editor to show, or null: an Integrated project whose push failed shows that
 * in the status bar instead. Never rejects, as the project is already open.
 */
export async function publishCreatedProject(
  outcome: CreateProjectOutcome,
  options: CreateProjectOptions | undefined,
  publish: (repository: NewRepositoryRequest) => Promise<PublishOutcome>,
): Promise<string | null> {
  const repository = options?.repository;
  if (!repository || outcome === "refused") return null;
  if (outcome === "opened") return "The folder you chose already had a project, so Haptic opened it and created no repository.";
  options.onPhase?.("source-control");
  try {
    const published = await publish(repository);
    return published.status === "local" ? published.message : null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
