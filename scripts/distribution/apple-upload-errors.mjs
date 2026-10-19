// Apple's reason for refusing an upload is the only part of the uploader's private output
// that may reach the public log: lines naming an ITMS code or an error, with identifiers,
// paths and token-like strings removed, capped in count and length.
const MAX_LINES = 6;
const MAX_LINE_LENGTH = 300;

export function appleUploadErrors(output, privateValues = []) {
  const lines = [];
  for (const raw of output.split(/\r?\n/)) {
    let line = raw.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "").replace(/^\[[0-9:]+\]:\s*/, "").trim();
    if (!/ITMS-\d{4,5}|\b(?:error|failed|failure)\b/i.test(line)) continue;
    for (const value of privateValues) if (value) line = line.split(value).join("[redacted]");
    line = line
      .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]")
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[id]")
      .replace(/(?:~|\.{1,2})?\/(?:[^\s/'"]+\/)+[^\s'"]*/g, "[path]")
      // Long runs mixing letters and digits; plain words such as Info.plist key names stay readable.
      .replace(/\b(?=[A-Za-z0-9+/=_-]*\d)(?=[A-Za-z0-9+/=_-]*[A-Za-z])[A-Za-z0-9+/=_-]{32,}\b/g, "[token]")
      .slice(0, MAX_LINE_LENGTH);
    if (line && !lines.includes(line)) lines.push(line);
    if (lines.length === MAX_LINES) break;
  }
  return lines;
}
