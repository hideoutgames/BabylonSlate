import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const DEFAULT_RESOURCE_CAPACITY = Object.freeze({
  workers: 3,
  browsers: 1,
  memoryGiB: 6,
  reserveGiB: 4,
});

function invalid(path, reason) {
  return new Error(
    `Invalid local resource configuration at ${path}: ${reason}`,
  );
}

export function localResourceConfigPath(env = process.env) {
  if (env.BL_LOCAL_RESOURCE_CONFIG === "" || env.CI === "true") return null;
  if (env.BL_LOCAL_RESOURCE_CONFIG !== undefined) {
    if (!isAbsolute(env.BL_LOCAL_RESOURCE_CONFIG))
      throw invalid(
        env.BL_LOCAL_RESOURCE_CONFIG,
        "the configuration path must be absolute",
      );
    return resolve(env.BL_LOCAL_RESOURCE_CONFIG);
  }
  return env.LOCALAPPDATA
    ? join(env.LOCALAPPDATA, "BabylonSlate", "local-resources.json")
    : join(
        env.XDG_CONFIG_HOME || join(homedir(), ".config"),
        "babylonslate",
        "local-resources.json",
      );
}

function defaultCacheDirectory(env) {
  return env.LOCALAPPDATA
    ? join(env.LOCALAPPDATA, "BabylonSlate", "build-cache")
    : join(
        env.XDG_CACHE_HOME || join(homedir(), ".cache"),
        "babylonslate",
        "build-cache",
      );
}

/** Per-user settings are read for each new acquisition, independently of its worktree. */
export async function readLocalResourceConfig(env = process.env) {
  const path = localResourceConfigPath(env);
  const defaults = {
    path,
    profile: "standard",
    capacity: { ...DEFAULT_RESOURCE_CAPACITY },
    maxHeavy: 3,
    maxBypasses: 3,
    cacheDirectory: null,
  };
  if (!path) return defaults;
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return defaults;
    throw invalid(path, `cannot read file (${error.code ?? "I/O error"})`);
  }
  let config;
  try {
    config = JSON.parse(source.replace(/^\uFEFF/, ""));
  } catch {
    throw invalid(path, "expected valid JSON");
  }
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw invalid(path, "expected an object");
  const allowed = new Set([
    "version",
    "profile",
    "reserveGiB",
    "maxHeavy",
    "maxBypasses",
    "cacheDirectory",
  ]);
  if (Object.keys(config).some((key) => !allowed.has(key)))
    throw invalid(path, "unknown setting; check the documented field names");
  if (config.version !== 1) throw invalid(path, "version must be 1");
  if (!["standard", "low-memory"].includes(config.profile))
    throw invalid(path, "profile must be standard or low-memory");

  const lowMemory = config.profile === "low-memory";
  const reserveGiB =
    config.reserveGiB === undefined ? (lowMemory ? 3 : 4) : config.reserveGiB;
  const maxHeavy =
    config.maxHeavy === undefined ? (lowMemory ? 1 : 3) : config.maxHeavy;
  const maxBypasses = config.maxBypasses === undefined ? 3 : config.maxBypasses;
  if (!Number.isFinite(reserveGiB) || reserveGiB < 1 || reserveGiB > 64)
    throw invalid(path, "reserveGiB must be a number from 1 to 64");
  if (
    !Number.isInteger(maxHeavy) ||
    maxHeavy < 1 ||
    maxHeavy > DEFAULT_RESOURCE_CAPACITY.workers
  )
    throw invalid(path, "maxHeavy must be an integer from 1 to 3");
  if (!Number.isInteger(maxBypasses) || maxBypasses < 0 || maxBypasses > 10)
    throw invalid(path, "maxBypasses must be an integer from 0 to 10");
  const cacheDirectory =
    config.cacheDirectory === undefined
      ? lowMemory
        ? defaultCacheDirectory(env)
        : null
      : config.cacheDirectory;
  if (
    cacheDirectory !== null &&
    (typeof cacheDirectory !== "string" || !isAbsolute(cacheDirectory))
  )
    throw invalid(path, "cacheDirectory must be an absolute path or null");
  return {
    path,
    profile: config.profile,
    capacity: { ...DEFAULT_RESOURCE_CAPACITY, reserveGiB },
    maxHeavy,
    maxBypasses,
    cacheDirectory: cacheDirectory === null ? null : resolve(cacheDirectory),
  };
}
