import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  androidGameFileName, androidProjectFiles, type AndroidPackageFormat,
} from "../../../packages/exporter/src/native-android";
import { runCommand, within, type RunCommand } from "./mac-game-package";

/**
 * Packages an Android game in the desktop app: copies the Android project
 * template, adds the game, and builds it with Gradle using the user's JDK and
 * Android SDK, the way Android Studio would. The unsigned APK is aligned and
 * signed with the SDK's apksigner, the unsigned App Bundle with the JDK's
 * jarsigner (apksigner cannot sign bundles). Keystore passwords reach the
 * signers only through their environment, never their arguments.
 */

/** Engine Settings: an empty path finds the tool. */
export interface AndroidToolchainSettings {
  sdk: string;
  java: string;
}

/** Engine Settings: a null keystore signs with Android's debug key. */
export interface AndroidSigningSettings {
  keystore: string | null;
  alias: string;
}

export interface AndroidGamePackageRequest {
  game: [string, Uint8Array][];
  name: string;
  appId: string;
  version: string;
  buildNumber: number;
  format: AndroidPackageFormat;
  /** App Icon PNGs at `ANDROID_ICON_SIZES`, or null for the system's default icon. */
  icon: [number, Uint8Array][] | null;
  toolchain: AndroidToolchainSettings;
  signing: AndroidSigningSettings;
}

export interface AndroidToolchain {
  javaHome: string;
  javaVersion: number;
  sdk: string;
  /** The newest build-tools folder with apksigner and zipalign. */
  buildTools: string;
}

/** What finding the toolchain reads: this computer, or a test's stand-in. */
export interface ToolchainHost {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  exists(path: string): Promise<boolean>;
  list(directory: string): Promise<string[]>;
  run: RunCommand;
}

export const localToolchainHost: ToolchainHost = {
  platform: process.platform,
  env: process.env,
  home: homedir(),
  exists: (path) => access(path).then(() => true, () => false),
  list: (directory) => readdir(directory).catch(() => []),
  run: runCommand,
};

/** Android Gradle Plugin 8 runs on Java 17 and later. */
const MIN_JAVA = 17;
const STORE_PASSWORD = "HAPTIC_ANDROID_STORE_PASSWORD";
const KEY_PASSWORD = "HAPTIC_ANDROID_KEY_PASSWORD";
/** The key every Android SDK build signs debug apps with; its passwords are public. */
const DEBUG_KEY = { alias: "androiddebugkey", password: "android" };

function program(platform: NodeJS.Platform, name: string): string {
  return platform === "win32" ? `${name}.exe` : name;
}

/** JDKs to try: the configured one alone, else JAVA_HOME and Android Studio's bundled runtime. */
export function javaHomeCandidates(settings: AndroidToolchainSettings, host: ToolchainHost): string[] {
  if (settings.java.trim()) return [settings.java.trim()];
  const studio: Partial<Record<NodeJS.Platform, string[]>> = {
    darwin: ["/Applications/Android Studio.app/Contents/jbr/Contents/Home", join(host.home, "Applications/Android Studio.app/Contents/jbr/Contents/Home")],
    win32: [join(host.env.ProgramFiles ?? "C:\\Program Files", "Android", "Android Studio", "jbr")],
    linux: ["/opt/android-studio/jbr", join(host.home, "android-studio", "jbr"), "/snap/android-studio/current/jbr"],
  };
  return [...(host.env.JAVA_HOME ? [host.env.JAVA_HOME] : []), ...(studio[host.platform] ?? [])];
}

/** SDKs to try: the configured one alone, else ANDROID_HOME, ANDROID_SDK_ROOT and Android Studio's default folder. */
export function sdkCandidates(settings: AndroidToolchainSettings, host: ToolchainHost): string[] {
  if (settings.sdk.trim()) return [settings.sdk.trim()];
  const defaults: Partial<Record<NodeJS.Platform, string>> = {
    darwin: join(host.home, "Library", "Android", "sdk"),
    win32: join(host.env.LOCALAPPDATA ?? join(host.home, "AppData", "Local"), "Android", "Sdk"),
    linux: join(host.home, "Android", "Sdk"),
  };
  return [host.env.ANDROID_HOME, host.env.ANDROID_SDK_ROOT, defaults[host.platform]].filter((path): path is string => Boolean(path));
}

/** Java's feature version from `java -version` (`"21.0.4"`, `"17"`, or `"1.8.0_402"` for Java 8). */
export function javaVersion(output: string): number | null {
  const match = /version "(\d+)(?:\.(\d+))?/.exec(output);
  if (!match) return null;
  const major = Number(match[1]);
  return major === 1 ? Number(match[2]) : major;
}

function compareVersions(a: string, b: string): number {
  const parts = (version: string) => version.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const [left, right] = [parts(a), parts(b)];
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The JDK and Android SDK packaging uses, or why it cannot. */
export async function findAndroidToolchain(
  settings: AndroidToolchainSettings,
  host: ToolchainHost = localToolchainHost,
): Promise<{ toolchain: AndroidToolchain | null; problems: string[] }> {
  const problems: string[] = [];
  let java: { home: string; version: number } | null = null;
  for (const home of javaHomeCandidates(settings, host)) {
    const binary = join(home, "bin", program(host.platform, "java"));
    if (!(await host.exists(binary))) continue;
    let version: number | null = null;
    try {
      const { stdout, stderr } = await host.run(binary, ["-version"]);
      version = javaVersion(`${stderr}\n${stdout}`);
    } catch {
      // Not a working Java: try the next.
    }
    if (version !== null && version >= MIN_JAVA) {
      java = { home, version };
      break;
    }
    problems.push(`The JDK at ${home} is ${version === null ? "not working" : `Java ${version}`}; Android builds need Java ${MIN_JAVA} or later.`);
  }
  if (!java && problems.length === 0) {
    problems.push(settings.java.trim()
      ? `No JDK at ${settings.java.trim()}.`
      : "No JDK found. Install Android Studio, or set the JDK in Engine Settings > Packaging.");
  }

  let sdk: { home: string; buildTools: string } | null = null;
  for (const home of sdkCandidates(settings, host)) {
    const versions = (await host.list(join(home, "build-tools"))).sort(compareVersions).reverse();
    for (const version of versions) {
      const folder = join(home, "build-tools", version);
      if (await host.exists(join(folder, "lib", "apksigner.jar")) && await host.exists(join(folder, program(host.platform, "zipalign")))) {
        sdk = { home, buildTools: folder };
        break;
      }
    }
    if (sdk) break;
  }
  if (!sdk) {
    problems.push(settings.sdk.trim()
      ? `No Android SDK build tools at ${settings.sdk.trim()}. Install them with Android Studio's SDK Manager.`
      : "No Android SDK found. Install Android Studio, or set the Android SDK in Engine Settings > Packaging.");
  }
  return {
    toolchain: java && sdk ? { javaHome: java.home, javaVersion: java.version, sdk: sdk.home, buildTools: sdk.buildTools } : null,
    problems: java && sdk ? [] : problems,
  };
}

/** The part of a failed Gradle run's output that says what went wrong. */
export function gradleFailure(output: string): string {
  const reason = /\* What went wrong:\s*([\s\S]*?)(?:\n\* Try:|\n\* Get more help|$)/.exec(output)?.[1];
  const text = (reason ?? output.trim().split("\n").slice(-15).join("\n")).replace(/\s+/g, " ").trim();
  return text.length > 1500 ? `${text.slice(0, 1500)}…` : text;
}

/** Every file under `from` copied to `to`; reads through Electron's archive support when the template is packed. */
async function copyTree(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.isDirectory()) await copyTree(join(from, entry.name), join(to, entry.name));
    else if (entry.isFile()) await writeFile(join(to, entry.name), await readFile(join(from, entry.name)));
  }
}

/** Android's debug keystore in the user's home, created as the SDK would when it is missing. */
async function debugKeystore(toolchain: AndroidToolchain, host: ToolchainHost, run: RunCommand): Promise<string> {
  const path = join(host.home, ".android", "debug.keystore");
  if (await host.exists(path)) return path;
  await mkdir(dirname(path), { recursive: true });
  await run(join(toolchain.javaHome, "bin", program(host.platform, "keytool")), [
    "-genkeypair", "-keystore", path, "-storepass", DEBUG_KEY.password, "-alias", DEBUG_KEY.alias, "-keypass", DEBUG_KEY.password,
    "-keyalg", "RSA", "-keysize", "2048", "-validity", "10000", "-dname", "CN=Android Debug,O=Android,C=US",
  ]);
  return path;
}

export async function packageAndroidGame(options: {
  request: AndroidGamePackageRequest;
  /** The Android project template (`apps/desktop/android-game`). */
  templateRoot: string;
  /** The keystore's passwords from this computer's secret store; asked for only with a keystore. */
  passwords: () => Promise<{ store: string; key: string }>;
  host?: ToolchainHost;
  run?: RunCommand;
}): Promise<{ fileName: string; bytes: Uint8Array; debugSigned: boolean }> {
  const { request } = options;
  const host = options.host ?? localToolchainHost;
  const run = options.run ?? host.run;
  // Identity and paths are checked before any tool runs.
  const files = androidProjectFiles({
    game: request.game, name: request.name, appId: request.appId, version: request.version,
    buildNumber: request.buildNumber, icon: request.icon ? new Map(request.icon) : null,
  });
  const debugSigned = request.signing.keystore === null;
  if (!debugSigned && !request.signing.alias.trim()) throw new Error("Enter the Key Alias in Engine Settings > Packaging.");
  const { toolchain, problems } = await findAndroidToolchain(request.toolchain, host);
  if (!toolchain) throw new Error(problems.join(" "));

  const work = await mkdtemp(join(tmpdir(), "haptic-android-"));
  try {
    const project = join(work, "project");
    await copyTree(options.templateRoot, project);
    for (const [path, data] of files) {
      const target = within(project, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data);
    }

    const java = join(toolchain.javaHome, "bin", program(host.platform, "java"));
    const env = { ...host.env, JAVA_HOME: toolchain.javaHome, ANDROID_HOME: toolchain.sdk, ANDROID_SDK_ROOT: toolchain.sdk };
    // The wrapper's own entry point, so no shell script runs; Gradle downloads itself on first use.
    try {
      await run(java, [
        "-Xmx64m", "-Xms64m", "-Dorg.gradle.appname=gradlew",
        "-classpath", join(project, "gradle", "wrapper", "gradle-wrapper.jar"), "org.gradle.wrapper.GradleWrapperMain",
        "--console=plain", request.format === "apk" ? "assembleRelease" : "bundleRelease",
      ], { cwd: project, env });
    } catch (error) {
      throw new Error(`The Android build failed: ${gradleFailure(error instanceof Error ? error.message : String(error))}`, { cause: error });
    }

    const keystore = debugSigned ? await debugKeystore(toolchain, host, run) : request.signing.keystore!;
    const alias = debugSigned ? DEBUG_KEY.alias : request.signing.alias.trim();
    const passwords = debugSigned ? { store: DEBUG_KEY.password, key: DEBUG_KEY.password } : await options.passwords();
    if (!passwords.store) throw new Error("Enter the Keystore Password in Engine Settings > Packaging.");
    // An empty key password means the key shares the keystore's, as PKCS #12 keystores require.
    const signingEnv = { ...env, [STORE_PASSWORD]: passwords.store, [KEY_PASSWORD]: passwords.key || passwords.store };

    let signed: string;
    if (request.format === "apk") {
      const aligned = join(work, "aligned.apk");
      signed = join(work, "signed.apk");
      const apksigner = join(toolchain.buildTools, "lib", "apksigner.jar");
      await run(join(toolchain.buildTools, program(host.platform, "zipalign")), ["-f", "4", join(project, "app", "build", "outputs", "apk", "release", "app-release-unsigned.apk"), aligned]);
      await run(java, ["-jar", apksigner, "sign", "--ks", keystore, "--ks-key-alias", alias,
        "--ks-pass", `env:${STORE_PASSWORD}`, "--key-pass", `env:${KEY_PASSWORD}`, "--out", signed, aligned], { env: signingEnv });
      await run(java, ["-jar", apksigner, "verify", signed]);
    } else {
      signed = join(work, "signed.aab");
      const jarsigner = join(toolchain.javaHome, "bin", program(host.platform, "jarsigner"));
      await run(jarsigner, ["-keystore", keystore, "-storepass:env", STORE_PASSWORD, "-keypass:env", KEY_PASSWORD,
        "-signedjar", signed, join(project, "app", "build", "outputs", "bundle", "release", "app-release.aab"), alias], { env: signingEnv });
      const { stdout } = await run(jarsigner, ["-verify", signed]);
      if (!stdout.includes("jar verified")) throw new Error("The App Bundle's signature did not verify.");
    }
    return { fileName: androidGameFileName(request.name, request.format), bytes: new Uint8Array(await readFile(signed)), debugSigned };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
