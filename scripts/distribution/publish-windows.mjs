import { readFile, readdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { githubClient } from "./github.mjs";
import { publishWindows } from "./publish.mjs";

try {
  const expected = JSON.parse(process.env.WINDOWS_IDENTITY);
  const directory = process.argv[2];
  const files = new Map();
  for (const name of await readdir(directory)) files.set(name, await readFile(join(directory, name)));
  const release = await publishWindows({ manifest: expected, files, appleState: process.env.APPLE_STATE }, githubClient());
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `\nPublished ${expected.title}: ${release.html_url}\n\nUnsigned installer, checksums and build manifest verified.\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Windows publication failed; inspect draft state");
  process.exitCode = 1;
}
