import { displayProjectName } from "./display-project-name";
import type { ProjectAppearance } from "@babylonslate/core";

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

/** Display name shown in the Create Project dialog. */
export function defaultCreateProjectDisplayName(
  testMode: boolean,
  existingNames: readonly string[] = [],
  random: () => number = Math.random,
): string {
  return testMode ? "TestProject" : randomProjectName(existingNames, random);
}

/** Folder name written to storage; empty when the display name is blank. */
export function normalizeProjectFolderName(displayName: string): string {
  return displayProjectName(displayName.trim());
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

export type CreateProjectOptions = {
  appearance?: ProjectAppearance;
  /** Native only: pick an external folder, then scaffold into it. */
  pickFolder?: boolean;
  /** Built-in starter: Blank, Basic 3D (legacy empty), or Basic 2D. */
  kind?: "blank" | "empty" | "2d";
  renderWidth?: number;
  renderHeight?: number;
  blackBars?: boolean;
};
