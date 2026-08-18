import type { DebugInspectSnapshot } from "@babylonslate/object-model";

export function formatDumpActors(snapshot: DebugInspectSnapshot): string {
  const actors = snapshot.nodes.filter((node) => node.kind === "actor");
  if (actors.length === 0) return "(no actors)";
  return actors
    .map((actor) => {
      const position = actor.transform?.position ?? [0, 0, 0];
      return `${actor.label} ${actor.classId} ${actor.id} ${position.join(",")}`;
    })
    .join("\n");
}

export function formatInspectActor(
  snapshot: DebugInspectSnapshot,
  query: string,
  selection?: string | null,
): string {
  const target = query.trim() || selection?.trim() || "";
  if (!target) return "inspect <name|guid>";
  const lower = target.toLowerCase();
  const node = snapshot.nodes.find(
    (candidate) =>
      candidate.id.toLowerCase() === lower ||
      candidate.label.toLowerCase() === lower,
  );
  if (!node) return `inspect: no actor matching '${target}'`;
  const position = node.transform?.position;
  const lines = [`${node.label} ${node.classId} ${node.id}`];
  if (position) lines.push(`  position ${position.join(", ")}`);
  const keys = Object.keys(node.variables).sort();
  for (const key of keys) {
    lines.push(`  ${key}=${JSON.stringify(node.variables[key])}`);
  }
  return lines.join("\n");
}

export function applyInspectSelectionToConsoleLine(
  line: string,
  selection: string | null | undefined,
): string {
  if (!selection?.trim()) return line;
  if (line.trim().toLowerCase() !== "inspect") return line;
  return `inspect ${selection.trim()}`;
}
