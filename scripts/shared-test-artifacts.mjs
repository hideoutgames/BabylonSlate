import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const FILE_MANIFEST = ".test-build-files.json";
const BUILD_MARKER = ".test-build.json";

function* environmentReferences(value) {
  // A nested reference in the key itself can construct a new inherited name.
  // Defaults may nest, but dynamic keys cannot be safely fingerprinted here.
  for (const match of value.matchAll(/\$\{([^{}]*?)(?=\$\{)/g))
    if (!/(:\+|\+|:-|-)/.test(match[1]))
      throw new Error(
        "Constructed dotenv keys are unsupported for test builds; use literal variable names.",
      );
  // Match the key prefix before a Vite expansion operator. Matching an entire
  // braced expression would lose its outer key when the fallback is nested.
  for (const match of value.matchAll(
    /\$\{([^{}]*?)(?=:\+|\+|:-|-|})|\$([A-Za-z_][A-Za-z0-9_]*)/g,
  ))
    yield match[1] ?? match[2];
}

/** Only a digest is recorded; dotenv values and inherited credentials stay local. */
export async function buildEnvironmentFingerprint(root, environment) {
  const hash = createHash("sha256");
  const names = new Set([
    "NODE_ENV",
    "NODE_OPTIONS",
    "BABYLONSLATE_DISTRIBUTION",
    ...Object.keys(environment).filter((name) => name.startsWith("VITE_")),
  ]);
  const overlap =
    Math.max(1, ...Object.keys(environment).map((name) => name.length)) + 3;
  for (const app of ["editor", "player"]) {
    for (const name of [
      ".env",
      ".env.local",
      ".env.production",
      ".env.production.local",
    ]) {
      const path = `apps/${app}/${name}`;
      try {
        let tail = "";
        let size = 0;
        const content = createHash("sha256");
        for await (const bytes of createReadStream(join(root, path))) {
          content.update(bytes);
          size += bytes.length;
          // Retain only enough overlap to recognize an inherited variable split
          // between chunks; even an unusually large env file stays bounded.
          const text = tail + bytes.toString("utf8");
          for (const name of environmentReferences(text))
            if (Object.hasOwn(environment, name)) names.add(name);
          tail = text.slice(-overlap);
        }
        hash.update(JSON.stringify([path, size, content.digest("hex")]));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        hash.update(JSON.stringify([path, null]));
      }
    }
  }
  const effective = {
    ...environment,
    NODE_ENV: environment.NODE_ENV ?? "production",
    VITE_TEST_MODE: "true",
    VITE_BASE_PATH: "/",
  };
  names.add("VITE_TEST_MODE");
  names.add("VITE_BASE_PATH");
  // Vite expands inherited values recursively, including fallback expressions.
  // A visited set also terminates cycles without retaining any value in metadata.
  const pending = [...names];
  for (let index = 0; index < pending.length; index++) {
    const value = effective[pending[index]];
    if (typeof value !== "string") continue;
    for (const name of environmentReferences(value)) {
      if (Object.hasOwn(effective, name) && !names.has(name)) {
        names.add(name);
        pending.push(name);
      }
    }
  }
  hash.update(
    JSON.stringify(
      [...names].sort().map((name) => [name, effective[name] ?? null]),
    ),
  );
  // The checkout lock alone cannot identify a worktree's installed resolutions.
  try {
    hash.update(
      JSON.stringify(
        await fileHash(join(root, "node_modules/.pnpm/lock.yaml")),
      ),
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    hash.update("no-installed-lock");
  }
  return hash.digest("hex");
}

async function fileHash(path) {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { size, sha256: hash.digest("hex") };
}

async function artifactFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const files = [];
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink())
      throw new Error("Test artifacts cannot contain symbolic links");
    if (
      !prefix &&
      (entry.name === FILE_MANIFEST || entry.name === BUILD_MARKER)
    )
      continue;
    if (entry.isDirectory())
      files.push(...(await artifactFiles(join(directory, entry.name), path)));
    else if (entry.isFile())
      files.push({ path, ...(await fileHash(join(directory, entry.name))) });
    else throw new Error("Unsupported test artifact entry");
  }
  return files;
}

export async function writeArtifactManifest(directory) {
  const files = await artifactFiles(directory);
  if (!files.some((file) => file.path === "index.html"))
    throw new Error("Test artifact has no index.html");
  const manifest = JSON.stringify({ version: 1, files }) + "\n";
  await writeFile(join(directory, FILE_MANIFEST), manifest);
  return createHash("sha256").update(manifest).digest("hex");
}

export async function verifyArtifactFiles(directory, marker) {
  try {
    if (!(await lstat(directory)).isDirectory()) return false;
    const bytes = await readFile(join(directory, FILE_MANIFEST));
    if (createHash("sha256").update(bytes).digest("hex") !== marker.filesDigest)
      return false;
    const manifest = JSON.parse(bytes);
    if (manifest.version !== 1 || !Array.isArray(manifest.files)) return false;
    const actual = await artifactFiles(directory);
    return (
      actual.some((file) => file.path === "index.html") &&
      JSON.stringify(actual) === JSON.stringify(manifest.files)
    );
  } catch {
    return false;
  }
}

export async function findLocalArtifact(root, identity, validate) {
  const canonical = join(root, identity.key);
  if (await validate(canonical, identity)) return canonical;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      !entry.name.startsWith(`${identity.key}.artifact-`)
    )
      continue;
    const directory = join(root, entry.name);
    if (await validate(directory, identity)) return directory;
  }
  return null;
}

export async function findSharedArtifact(cache, identity, validate) {
  if (!cache) return null;
  const root = join(cache, "test-build", identity.key);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("artifact-")) continue;
    const directory = join(root, entry.name);
    if (await validate(directory, identity)) return directory;
  }
  return null;
}

async function removeOwnedStaging(directory, parent) {
  if (
    dirname(resolve(directory)) !== resolve(parent) ||
    !basename(directory).startsWith(".pending-")
  )
    throw new Error("Refusing to remove an unowned build directory");
  await rm(directory, { recursive: true, force: true });
}

/** Never overwrite a published directory: a browser may still be serving it. */
export async function publishLocalArtifact(
  source,
  root,
  identity,
  validate,
  unchanged,
) {
  await mkdir(root, { recursive: true });
  const pending = join(root, `.pending-${randomUUID()}`);
  try {
    await cp(source, pending, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    const filesDigest = await writeArtifactManifest(pending);
    await unchanged();
    await writeFile(
      join(pending, BUILD_MARKER),
      JSON.stringify({ ...identity, filesDigest }, null, 2) + "\n",
    );
    const existing = await findLocalArtifact(root, identity, validate);
    if (existing) return existing;
    const canonical = join(root, identity.key);
    const occupied = await lstat(canonical).then(
      () => true,
      (error) => {
        if (error.code !== "ENOENT") throw error;
        return false;
      },
    );
    let target = occupied
      ? join(root, `${identity.key}.artifact-${randomUUID()}`)
      : canonical;
    try {
      await rename(pending, target);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(error.code)) throw error;
      target = join(root, `${identity.key}.artifact-${randomUUID()}`);
      await rename(pending, target);
    }
    return target;
  } finally {
    await removeOwnedStaging(pending, root);
  }
}

export async function publishSharedArtifact(cache, source, identity, validate) {
  if (!cache) return null;
  const existing = await findSharedArtifact(cache, identity, validate);
  if (existing) return existing;
  if (!(await validate(source, identity))) return null;
  const root = join(cache, "test-build", identity.key);
  await mkdir(root, { recursive: true });
  const pending = join(root, `.pending-${randomUUID()}`);
  try {
    await cp(source, pending, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    if (!(await validate(pending, identity)))
      throw new Error("Shared test artifact failed integrity validation");
    const publishedMeanwhile = await findSharedArtifact(
      cache,
      identity,
      validate,
    );
    if (publishedMeanwhile) return publishedMeanwhile;
    const target = join(root, `artifact-${randomUUID()}`);
    await rename(pending, target);
    return target;
  } finally {
    await removeOwnedStaging(pending, root);
  }
}
