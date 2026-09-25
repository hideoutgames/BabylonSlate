const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function validatePatchNotes(notes, version) {
  const text = value => typeof value === "string" && value.trim().length > 0;
  if (!notes || !versionPattern.test(notes.version) || notes.version !== version ||
      !text(notes.title) || !Array.isArray(notes.changes) ||
      notes.changes.length === 0 || !notes.changes.every(text)) {
    throw new Error(`Patch notes with a title and nonempty changes are required for version ${version}`);
  }
  return { version: notes.version, title: notes.title.trim(), changes: notes.changes.map(value => value.trim()) };
}

export function validateChangelog(value, version) {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.releases)) throw new Error("Invalid release/changelog.json");
  const releases = value.releases.map(notes => validatePatchNotes(notes, notes?.version));
  if (new Set(releases.map(notes => notes.version)).size !== releases.length) throw new Error("Duplicate changelog version");
  validatePatchNotes(releases.find(notes => notes.version === version), version);
  const compare = (a, b) => {
    const right = b.split(".").map(Number);
    return a.split(".").map(Number).map((part, index) => part - right[index]).find(delta => delta !== 0) ?? 0;
  };
  return releases.filter(notes => compare(notes.version, version) <= 0).sort((a, b) => compare(b.version, a.version));
}

export function patchNotesMarkdown(notes) {
  const validated = validatePatchNotes(notes, notes?.version);
  return `## ${validated.title}\n\n${validated.changes.map(change => `- ${change}`).join("\n")}`;
}
