import { createHash } from "node:crypto";
import { parse } from "yaml";

/** Reject a broken feed before the package becomes a distribution artifact. */
export function validateWindowsUpdate(version, files) {
  const installer = `BabylonSlate-${version}-x64.exe`;
  const metadata = parse(files.get("latest.yml").toString("utf8"));
  const bytes = files.get(installer);
  const sha512 = createHash("sha512").update(bytes).digest("base64");
  if (metadata?.version !== version || metadata.files?.length !== 1 ||
      metadata.files[0].url !== installer || metadata.files[0].sha512 !== sha512 || metadata.files[0].size !== bytes.length ||
      (metadata.path !== undefined && metadata.path !== installer) || (metadata.sha512 !== undefined && metadata.sha512 !== sha512)) {
    throw new Error("Windows update metadata does not match the installer");
  }
}
