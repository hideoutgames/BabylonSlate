import { afterEach, describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ANDROID_ICON_SIZES } from "../../../packages/exporter/src/native-android";
import { pngHeader } from "../../../packages/exporter/src/test-support/app-icon-images";
import {
  DEFAULT_ANDROID_PACKAGING, findAndroidToolchain, gradleFailure, javaVersion, normalizeAndroidPackaging, packageAndroidGame,
  type AndroidGamePackageRequest, type AndroidPackagingSettings, type ToolchainHost,
} from "./android-game-package";
import type { RunCommand } from "./mac-game-package";

const SDK = "/sdk";
const BUILD_TOOLS = "/sdk/build-tools/35.0.1";
const cleanup: string[] = [];
afterEach(async () => { for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true }); });

async function temp(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(path);
  return path;
}

/** The template trimmed to what packaging touches. */
async function template(): Promise<string> {
  const root = await temp("haptic-android-template-");
  await mkdir(join(root, "gradle", "wrapper"), { recursive: true });
  await mkdir(join(root, "app"), { recursive: true });
  await writeFile(join(root, "gradle", "wrapper", "gradle-wrapper.jar"), "wrapper");
  await writeFile(join(root, "app", "build.gradle"), "android {}");
  return root;
}

function request(overrides: Partial<AndroidGamePackageRequest> = {}): AndroidGamePackageRequest {
  return {
    game: [["index.html", new TextEncoder().encode("<html>")]],
    name: "Space Game", appId: "com.studio.space", version: "1.2.0", buildNumber: 7, format: "apk",
    icon: ANDROID_ICON_SIZES.map((size) => [size, pngHeader(size)]),
    ...overrides,
  };
}

const RELEASE_KEY: AndroidPackagingSettings = { java: null, sdk: null, keystore: "/keys/release.jks", alias: "upload" };

interface Call { command: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }

/**
 * A computer with a JDK at JAVA_HOME and an SDK at ANDROID_HOME whose tools
 * are recorded: Gradle writes its unsigned output, the signers write signed
 * copies, keytool writes a keystore. `files` holds what Gradle saw.
 */
async function computer(options: { gradle?: () => never; javaOutput?: Record<string, string> } = {}) {
  const home = await temp("haptic-android-home-");
  const calls: Call[] = [];
  const files: Record<string, string> = {};
  const virtual = new Set([
    "/jdk/bin/java", `${BUILD_TOOLS}/lib/apksigner.jar`, `${BUILD_TOOLS}/zipalign`,
  ]);
  const exists = (path: string) => virtual.has(path) ? Promise.resolve(true) : access(path).then(() => true, () => false);
  const run: RunCommand = async (command, args, runOptions = {}) => {
    calls.push({ command, args: [...args], ...runOptions });
    const at = (flag: string) => args[args.indexOf(flag) + 1]!;
    if (args[0] === "-version") return { stdout: "", stderr: options.javaOutput?.[command] ?? 'openjdk version "21.0.4" 2024-07-16' };
    if (args.includes("org.gradle.wrapper.GradleWrapperMain")) {
      if (options.gradle) options.gradle();
      const project = runOptions.cwd!;
      for (const path of ["app/haptic-game.properties", "app/src/main/assets/game/index.html", "app/build.gradle", "gradle/wrapper/gradle-wrapper.jar"]) {
        files[path] = await readFile(join(project, path), "utf8");
      }
      const output = args.at(-1) === "assembleRelease" ? "app/build/outputs/apk/release/app-release-unsigned.apk" : "app/build/outputs/bundle/release/app-release.aab";
      await mkdir(dirname(join(project, output)), { recursive: true });
      await writeFile(join(project, output), "unsigned");
    } else if (command.endsWith("zipalign")) {
      await writeFile(args.at(-1)!, `aligned ${await readFile(args.at(-2)!, "utf8")}`);
    } else if (args[1]?.endsWith("apksigner.jar") && args[2] === "sign") {
      await writeFile(at("--out"), `signed ${await readFile(args.at(-1)!, "utf8")}`);
    } else if (command.endsWith("jarsigner") && args[0] !== "-verify") {
      await writeFile(at("-signedjar"), `jar-signed ${await readFile(args.at(-2)!, "utf8")}`);
    } else if (command.endsWith("jarsigner")) {
      return { stdout: "jar verified.\n", stderr: "" };
    } else if (command.endsWith("keytool")) {
      await writeFile(at("-keystore"), "debug keystore");
    }
    return { stdout: "", stderr: "" };
  };
  const host: ToolchainHost = {
    platform: "linux", env: { JAVA_HOME: "/jdk", ANDROID_HOME: SDK, PATH: "/usr/bin" }, home, exists,
    list: async (directory) => directory === `${SDK}/build-tools` ? ["34.0.0", "35.0.1"] : [],
    run,
  };
  return { host, run, calls, files, home };
}

/** Packages on `host` with the release keystore unless `settings` says otherwise. */
async function pack(host: ToolchainHost, options: {
  request?: Partial<AndroidGamePackageRequest>; settings?: AndroidPackagingSettings; passwords?: () => Promise<{ store: string; key: string }>;
} = {}) {
  return packageAndroidGame({ request: request(options.request), settings: options.settings ?? RELEASE_KEY, templateRoot: await template(), host,
    passwords: options.passwords ?? (async () => ({ store: "store-secret", key: "key-secret" })) });
}

describe("Android game packages", () => {
  it("build the APK with Gradle through the wrapper, then align it and sign it with the keystore", async () => {
    const pc = await computer();
    const result = await pack(pc.host);

    expect(result).toEqual({ fileName: "Space_Game-Android.apk", bytes: new TextEncoder().encode("signed aligned unsigned"), debugSigned: false });
    const gradle = pc.calls.find((call) => call.args.includes("org.gradle.wrapper.GradleWrapperMain"))!;
    expect(gradle.command).toBe("/jdk/bin/java");
    expect(gradle.args.slice(-2)).toEqual(["--console=plain", "assembleRelease"]);
    expect(gradle.args[gradle.args.indexOf("-classpath") + 1]).toBe(join(gradle.cwd!, "gradle", "wrapper", "gradle-wrapper.jar"));
    expect(gradle.env).toMatchObject({ JAVA_HOME: "/jdk", ANDROID_HOME: SDK, ANDROID_SDK_ROOT: SDK, PATH: "/usr/bin" });
    // Gradle builds the template with the game's identity and files in it.
    expect(pc.files).toEqual({
      "app/haptic-game.properties": "applicationId=com.studio.space\nversionCode=7\nversionName=1.2.0\nhasIcon=true\n",
      "app/src/main/assets/game/index.html": "<html>",
      "app/build.gradle": "android {}",
      "gradle/wrapper/gradle-wrapper.jar": "wrapper",
    });
    const zipalign = pc.calls.find((call) => call.command.endsWith("zipalign"))!;
    expect(zipalign.command).toBe(`${BUILD_TOOLS}/zipalign`);
    expect(zipalign.args.slice(0, 2)).toEqual(["-f", "4"]);
    const sign = pc.calls.find((call) => call.args[2] === "sign")!;
    expect(sign.args.slice(0, 9)).toEqual(["-jar", `${BUILD_TOOLS}/lib/apksigner.jar`, "sign", "--ks", "/keys/release.jks", "--ks-key-alias", "upload",
      "--ks-pass", "env:HAPTIC_ANDROID_STORE_PASSWORD"]);
    expect(sign.env).toMatchObject({ HAPTIC_ANDROID_STORE_PASSWORD: "store-secret", HAPTIC_ANDROID_KEY_PASSWORD: "key-secret" });
    // Passwords never appear in any program's arguments.
    expect(pc.calls.flatMap((call) => call.args).filter((arg) => arg.includes("secret"))).toEqual([]);
    expect(pc.calls.at(-1)!.args).toEqual(["-jar", `${BUILD_TOOLS}/lib/apksigner.jar`, "verify", expect.stringMatching(/signed\.apk$/)]);
    // The project is built in a temporary folder that is removed afterwards.
    expect(await access(gradle.cwd!).then(() => true, () => false)).toBe(false);
  });

  it("bundle with Gradle and sign the App Bundle with jarsigner, making Android's debug key when no keystore is set", async () => {
    const pc = await computer();
    let asked = false;
    const result = await pack(pc.host, { request: { format: "aab" }, settings: DEFAULT_ANDROID_PACKAGING,
      passwords: async () => { asked = true; return { store: "", key: "" }; } });

    expect(result).toEqual({ fileName: "Space_Game-Android.aab", bytes: new TextEncoder().encode("jar-signed unsigned"), debugSigned: true });
    expect(asked).toBe(false);
    const debugKeystore = join(pc.home, ".android", "debug.keystore");
    expect(await readFile(debugKeystore, "utf8")).toBe("debug keystore");
    expect(pc.calls.find((call) => call.command.endsWith("keytool"))!.args.slice(0, 8))
      .toEqual(["-genkeypair", "-keystore", debugKeystore, "-storepass", "android", "-alias", "androiddebugkey", "-keypass"]);
    const signing = pc.calls.filter((call) => call.command === "/jdk/bin/jarsigner");
    expect(signing[0]!.args).toEqual(["-keystore", debugKeystore, "-storepass:env", "HAPTIC_ANDROID_STORE_PASSWORD", "-keypass:env", "HAPTIC_ANDROID_KEY_PASSWORD",
      "-signedjar", expect.stringMatching(/signed\.aab$/), expect.stringMatching(/app-release\.aab$/), "androiddebugkey"]);
    expect(signing[0]!.env).toMatchObject({ HAPTIC_ANDROID_STORE_PASSWORD: "android", HAPTIC_ANDROID_KEY_PASSWORD: "android" });
    expect(signing[1]!.args).toEqual(["-verify", expect.stringMatching(/signed\.aab$/)]);
    expect(pc.calls.find((call) => call.args.includes("org.gradle.wrapper.GradleWrapperMain"))!.args.at(-1)).toBe("bundleRelease");
    expect(pc.calls.some((call) => call.command.endsWith("zipalign"))).toBe(false);

    // The existing debug key is reused.
    const again = await computer();
    await mkdir(join(again.home, ".android"));
    await writeFile(join(again.home, ".android", "debug.keystore"), "kept");
    await pack(again.host, { settings: DEFAULT_ANDROID_PACKAGING });
    expect(again.calls.some((call) => call.command.endsWith("keytool"))).toBe(false);
  });

  it("sign with the keystore password when the key has none, and ask for a missing keystore password or alias", async () => {
    const pc = await computer();
    await pack(pc.host, { passwords: async () => ({ store: "only-store", key: "" }) });
    expect(pc.calls.find((call) => call.args[2] === "sign")!.env).toMatchObject({ HAPTIC_ANDROID_STORE_PASSWORD: "only-store", HAPTIC_ANDROID_KEY_PASSWORD: "only-store" });

    await expect(pack((await computer()).host, { passwords: async () => ({ store: "", key: "" }) }))
      .rejects.toThrow("Enter the Keystore Password in Engine Settings > Packaging.");
    const unaliased = await computer();
    await expect(pack(unaliased.host, { settings: { ...RELEASE_KEY, alias: "" } })).rejects.toThrow("Enter the Key Alias in Engine Settings > Packaging.");
    expect(unaliased.calls).toEqual([]);
  });

  it("report what went wrong in a failed build, and refuse before building without a JDK or with an invalid identity", async () => {
    const failing = await computer({ gradle: () => { throw new Error("FAILURE: Build failed with an exception.\n\n* What went wrong:\nCould not resolve all files for configuration ':app:releaseRuntimeClasspath'.\n\n* Try:\n> Run with --stacktrace."); } });
    await expect(pack(failing.host)).rejects.toThrow("The Android build failed: Could not resolve all files for configuration ':app:releaseRuntimeClasspath'.");

    const noJava = await computer();
    noJava.host.env = { ANDROID_HOME: SDK };
    await expect(pack(noJava.host)).rejects.toThrow("No JDK found. Install Android Studio, or choose the JDK in Engine Settings > Packaging.");
    expect(noJava.calls.some((call) => call.args.includes("org.gradle.wrapper.GradleWrapperMain"))).toBe(false);

    const invalid = await computer();
    await expect(pack(invalid.host, { request: { appId: "com.my-studio.game" } })).rejects.toThrow("App ID com.my-studio.game is not valid.");
    expect(invalid.calls).toEqual([]);
  });
});

describe("Android toolchain", () => {
  it("skip a JDK older than 17 for Android Studio's bundled one, and pick the newest build tools that sign and align", async () => {
    const pc = await computer({ javaOutput: { "/jdk/bin/java": 'java version "11.0.2" 2019-01-15 LTS' } });
    const studio = "/opt/android-studio/jbr";
    pc.host.exists = async (path) => [`/jdk/bin/java`, `${studio}/bin/java`, `${SDK}/build-tools/35.0.1/lib/apksigner.jar`, `${SDK}/build-tools/35.0.1/zipalign`,
      `${SDK}/build-tools/36.0.0/zipalign`].includes(path);
    pc.host.list = async () => ["34.0.0", "36.0.0", "35.0.1"];
    expect(await findAndroidToolchain({ sdk: null, java: null }, pc.host)).toEqual({
      toolchain: { javaHome: studio, javaVersion: 21, sdk: SDK, buildTools: `${SDK}/build-tools/35.0.1` },
      problems: [],
    });
  });

  it("use only a chosen folder, and say what is missing", async () => {
    const pc = await computer();
    const found = await findAndroidToolchain({ sdk: "/elsewhere/sdk", java: "/elsewhere/jdk" }, pc.host);
    expect(found).toEqual({ toolchain: null, problems: [
      "No JDK at /elsewhere/jdk.",
      "No Android SDK build tools at /elsewhere/sdk. Install them with Android Studio's SDK Manager.",
    ] });
    const old = await computer({ javaOutput: { "/jdk/bin/java": 'java version "1.8.0_402"' } });
    expect((await findAndroidToolchain({ sdk: null, java: "/jdk" }, old.host)).problems)
      .toEqual(["The JDK at /jdk is Java 8; Android builds need Java 17 or later."]);
  });

  it("keep stored settings only when well formed", () => {
    expect(normalizeAndroidPackaging({ java: "/jdk", sdk: "", keystore: 7, alias: " upload " })).toEqual({ java: "/jdk", sdk: null, keystore: null, alias: "upload" });
    expect(normalizeAndroidPackaging("broken")).toEqual(DEFAULT_ANDROID_PACKAGING);
  });

  it("read Java's version and Gradle's reason for failing", () => {
    expect(javaVersion('openjdk version "17" 2021-09-14')).toBe(17);
    expect(javaVersion('java version "1.8.0_402"')).toBe(8);
    expect(javaVersion("not java")).toBeNull();
    expect(gradleFailure("> Task :app:x\nline one\nline two")).toBe("> Task :app:x line one line two");
  });
});
