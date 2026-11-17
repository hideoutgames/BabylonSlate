import { useId, useRef, useState } from "react";
import { CircleCheckIcon, CircleXIcon, TriangleAlertIcon } from "lucide-react";
import type { SourceControlProjectSettings } from "@haptic/core";
import { GITHUB_ORIGIN, GITLAB_ORIGIN, isSyncError, parseRepositoryUrl } from "@haptic/source-control";
import type { GitBenchmarkStep } from "@haptic/source-control/git-benchmark";
import { NumberField, SelectableText } from "@haptic/editor-kit";
import { Alert, AlertDescription, AlertTitle } from "@haptic/ui/components/alert";
import { Button } from "@haptic/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@haptic/ui/components/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@haptic/ui/components/field";
import { Input } from "@haptic/ui/components/input";
import { Progress, ProgressLabel } from "@haptic/ui/components/progress";
import { Textarea } from "@haptic/ui/components/textarea";
import { isTestModeEnabled } from "@haptic/vfs";
import { useGitBenchmarkRun } from "../context/app-settings-context";
import { useProjectState } from "../context/document-context";
import { copyText } from "../lib/diagnostic-info";
import {
  GIT_BENCHMARK_DEFAULT_BLOB_MIB,
  GIT_BENCHMARK_DEFAULT_BLOBS,
  GIT_BENCHMARK_STAGE_LABELS,
  gitBenchmarkStageLabel,
  runGitBenchmarkLazily,
  type GitBenchmarkRunStage,
} from "../lib/git-benchmark-hook";
import type { EditorGitBenchmarkResult } from "../lib/git-benchmark-runner";
import { deviceClientId } from "../lib/source-control-client-ids";
import { useHostLink } from "./use-host-link";

type Form = { repositoryUrl: string; branch: string; blobs: number; blobMiB: number };
type Run =
  | { kind: "idle" }
  | { kind: "running"; repositoryUrl: string; branch: string }
  | { kind: "done"; result: EditorGitBenchmarkResult; json: string }
  | { kind: "failed"; message: string; signIn: SignInOffer | null };

/** The device sign-in a failed run offers: its host refused the saved sign-in, or there was none. */
type SignInOffer = { host: "github" | "gitlab"; again: boolean };

function signInOffer(error: unknown, repositoryUrl: string): SignInOffer | null {
  const cause = error instanceof Error ? error.cause : null;
  const code = isSyncError(cause) ? cause.code : null;
  if (code !== "credential-refused" && code !== "no-credential") return null;
  const origin = parseRepositoryUrl(repositoryUrl)?.origin;
  const host = origin === GITHUB_ORIGIN ? "github" : origin === GITLAB_ORIGIN ? "gitlab" : null;
  return host && deviceClientId(host, isTestModeEnabled()) ? { host, again: code === "credential-refused" } : null;
}

/**
 * The open project's repository and default branch when its settings name one, in any mode (Project Settings shows
 * both even while Off); else an empty URL and `main`.
 */
function prefilledForm(sourceControl: SourceControlProjectSettings | undefined): Form {
  const repository = sourceControl?.repositoryUrl ? sourceControl : null;
  return {
    repositoryUrl: repository?.repositoryUrl ?? "",
    branch: repository?.branch || "main",
    blobs: GIT_BENCHMARK_DEFAULT_BLOBS,
    blobMiB: GIT_BENCHMARK_DEFAULT_BLOB_MIB,
  };
}

const formatMs = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const formatMiB = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const transfer = (step: GitBenchmarkStep) => `${formatMiB(step.sent)} sent, ${formatMiB(step.received)} received`;

/** The gate: a status of the unchanged tree reads no file and finds no change. */
function StatusGate({ result }: { result: EditorGitBenchmarkResult }) {
  const reads = result.status.workingReads;
  const changes = result.unchangedStatusChanges;
  const passed = reads === 0 && changes === 0;
  const findings = [
    `It read ${plural(reads, "file", "files")}${reads === 0 ? "" : "; it must read none"}.`,
    ...(changes === 0 ? [] : [`It found ${plural(changes, "change", "changes")} in the unchanged tree; it must find none.`]),
  ];
  return (
    <Alert variant={passed ? "default" : "destructive"} data-testid="git-benchmark-gate" data-passed={passed}>
      {passed ? <CircleCheckIcon className="text-(--success)" /> : <CircleXIcon />}
      <AlertTitle>{passed ? "Unchanged Status Passed" : "Unchanged Status Failed"}</AlertTitle>
      <AlertDescription>{findings.join(" ")}</AlertDescription>
    </Alert>
  );
}

function TimingSummary({ result }: { result: EditorGitBenchmarkResult }) {
  const rows: Array<[string, string]> = [
    ["Files", String(result.files)],
    ["Clone", `${formatMs(result.clone.ms)} · ${transfer(result.clone)}`],
    ["Status", formatMs(result.status.ms)],
    ["Commit", formatMs(result.commit.ms)],
    ["Push", `${formatMs(result.push.ms)} · ${transfer(result.push)}`],
    ["LFS Transfer", result.transfer === "native" ? "Native, between file and network" : "Whole body, through JavaScript"],
    ["Create LFS Objects", `${formatMs(result.createObjects.ms)} · ${plural(result.createObjects.objects, "object", "objects")}, ${formatMiB(result.createObjects.bytes)}`],
    ["LFS Commit", formatMs(result.lfsCommit.ms)],
    ["LFS Upload", `${formatMs(result.lfsUpload.ms)} · ${plural(result.lfsUpload.objects, "object", "objects")}, ${formatMiB(result.lfsUpload.bytes)}`],
    ["LFS Download", `${formatMs(result.lfsDownload.ms)} · ${plural(result.lfsDownload.objects, "object", "objects")}, ${formatMiB(result.lfsDownload.bytes)}`],
  ];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs" data-testid="git-benchmark-summary">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Each measured stage's peak: the app process's footprint and the least memory left on iOS and Android (the
 * WebView's content process, where JavaScript runs on iOS, is not in it), or the JavaScript heap.
 */
function MemorySummary({ result }: { result: EditorGitBenchmarkResult }) {
  const rows = (Object.keys(GIT_BENCHMARK_STAGE_LABELS) as GitBenchmarkRunStage[]).flatMap((stage) => {
    const peak = result.memory[stage];
    if (!peak) return [];
    const parts = [
      peak.appFootprintBytes !== undefined ? `${formatMiB(peak.appFootprintBytes)} app` : null,
      peak.appAvailableBytes !== undefined ? `${formatMiB(peak.appAvailableBytes)} left` : null,
      peak.jsHeapBytes !== undefined ? `${formatMiB(peak.jsHeapBytes)} JS heap` : null,
    ].filter((part): part is string => part !== null);
    return parts.length > 0 ? [[GIT_BENCHMARK_STAGE_LABELS[stage], parts.join(" · ")] as const] : [];
  });
  if (rows.length === 0) return null;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs" data-testid="git-benchmark-memory">
      <dt className="col-span-2 font-medium">Peak Memory</dt>
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface GitBenchmarkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Debug menu → Run Git Benchmark…: runs the Integrated mode Git benchmark (the iPad gate) against a
 * repository the signed-in account can push to and shows its timings to copy. A run cannot be
 * cancelled; closing the dialog leaves it running, and reopening shows it.
 */
export function GitBenchmarkDialog({ open, onOpenChange }: GitBenchmarkDialogProps) {
  const id = useId();
  const { projectDocument } = useProjectState();
  const sourceControl = projectDocument?.settings.sourceControl;
  // Recorded before each stage and cleared when a run ends: while no run is going here, a run the app did not survive.
  const recorded = useGitBenchmarkRun();
  const [form, setForm] = useState<Form>(() => prefilledForm(sourceControl));
  const [urlError, setUrlError] = useState<string | null>(null);
  const [run, setRun] = useState<Run>({ kind: "idle" });
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const { link, dialogs } = useHostLink();
  const finishBlobs = useRef<() => number | undefined>(null);
  const finishBlobMiB = useRef<() => number | undefined>(null);
  // Each opening of the form starts from the open project's repository again.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open && run.kind === "idle") {
      setForm(prefilledForm(sourceControl));
      setUrlError(null);
    }
  }

  const repositoryUrl = form.repositoryUrl.trim();
  const branch = form.branch.trim();
  const start = async () => {
    const blobs = finishBlobs.current?.();
    const blobMiB = finishBlobMiB.current?.();
    if (blobs === undefined || blobMiB === undefined) return;
    if (!parseRepositoryUrl(repositoryUrl)) {
      setUrlError("Not a repository URL.");
      return;
    }
    setCopied("idle");
    setRun({ kind: "running", repositoryUrl, branch });
    try {
      const result = await runGitBenchmarkLazily({ repositoryUrl, branch, blobs, blobMiB });
      setRun({ kind: "done", result, json: JSON.stringify(result, null, 2) });
    } catch (error) {
      setRun({ kind: "failed", message: error instanceof Error ? error.message : String(error), signIn: signInOffer(error, repositoryUrl) });
    }
  };
  const copy = async (text: string) => setCopied((await copyText(text)) ? "copied" : "failed");
  const copyLabel = (idle: string) => (copied === "copied" ? "Copied" : copied === "failed" ? "Copy Failed: Select The Text" : idle);
  const runAgain = () => {
    setCopied("idle");
    setRun({ kind: "idle" });
  };

  const signIn = async (offer: SignInOffer) => {
    // Signed in: back to the form, to run again.
    if (await link({ kind: "sign-in", host: offer.host })) runAgain();
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[min(40rem,85vh)] w-full sm:max-w-lg" bodyClassName="flex flex-col gap-3" data-testid="git-benchmark-dialog">
          <DialogHeader>
            <DialogTitle>Git Benchmark</DialogTitle>
            <DialogDescription>
              {run.kind === "running"
                ? `${run.repositoryUrl} · ${run.branch}`
                : "Times a shallow clone, a status of the unchanged tree, a commit, a push and Git LFS uploads and downloads on this device."}
            </DialogDescription>
          </DialogHeader>
          {run.kind === "idle" ? (
            <>
              <FieldGroup className="gap-3">
                <Field data-invalid={urlError ? true : undefined}>
                  <FieldLabel htmlFor={`${id}-url`}>Repository URL</FieldLabel>
                  <Input
                    id={`${id}-url`}
                    inputMode="url"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    aria-invalid={urlError ? true : undefined}
                    value={form.repositoryUrl}
                    data-testid="git-benchmark-repository"
                    onChange={(event) => {
                      setForm({ ...form, repositoryUrl: event.target.value });
                      setUrlError(null);
                    }}
                  />
                  {urlError ? <FieldError>{urlError}</FieldError> : null}
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${id}-branch`}>Branch</FieldLabel>
                  <Input
                    id={`${id}-branch`}
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    value={form.branch}
                    data-testid="git-benchmark-branch"
                    onChange={(event) => setForm({ ...form, branch: event.target.value })}
                  />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field>
                    <FieldLabel htmlFor={`${id}-blobs`}>LFS Objects</FieldLabel>
                    <NumberField
                      id={`${id}-blobs`}
                      integer
                      min={1}
                      value={form.blobs}
                      data-testid="git-benchmark-blobs"
                      onChange={(blobs) => setForm({ ...form, blobs })}
                      finishRef={finishBlobs}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={`${id}-blob-mib`}>Object Size</FieldLabel>
                    <NumberField
                      id={`${id}-blob-mib`}
                      min={1}
                      unit="MiB"
                      value={form.blobMiB}
                      data-testid="git-benchmark-blob-mib"
                      onChange={(blobMiB) => setForm({ ...form, blobMiB })}
                      finishRef={finishBlobMiB}
                    />
                  </Field>
                </div>
              </FieldGroup>
              {recorded ? (
                <Alert variant="destructive" data-testid="git-benchmark-interrupted">
                  <CircleXIcon />
                  <AlertTitle>Last Run Stopped During {gitBenchmarkStageLabel(recorded.stage)}</AlertTitle>
                  <AlertDescription>
                    The run started {new Date(recorded.startedAt).toLocaleString()} never finished: the app closed during
                    this stage, most likely out of memory.
                  </AlertDescription>
                </Alert>
              ) : null}
              <Alert data-testid="git-benchmark-warning">
                <TriangleAlertIcon className="text-(--warning)" />
                <AlertTitle>Pushes A New Branch</AlertTitle>
                <AlertDescription>
                  Run pushes a new haptic-benchmark-… branch with the LFS objects to this repository as the account
                  signed in for its host. Delete the branch there afterwards.
                </AlertDescription>
              </Alert>
            </>
          ) : run.kind === "running" ? (
            <Progress value={null} data-testid="git-benchmark-progress">
              <ProgressLabel className="text-xs font-normal text-muted-foreground">
                {recorded ? `${gitBenchmarkStageLabel(recorded.stage)}…` : "Running…"}
              </ProgressLabel>
            </Progress>
          ) : run.kind === "done" ? (
            <>
              <StatusGate result={run.result} />
              <TimingSummary result={run.result} />
              <MemorySummary result={run.result} />
              <Textarea
                readOnly
                value={run.json}
                aria-label="Results"
                data-testid="git-benchmark-results"
                className="min-h-40 flex-1 font-mono text-xs"
              />
            </>
          ) : (
            <Alert variant="destructive" data-testid="git-benchmark-error">
              <CircleXIcon />
              <AlertTitle>Git Benchmark Failed</AlertTitle>
              <AlertDescription><SelectableText>{run.message}</SelectableText></AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            {run.kind === "idle" ? (
              <>
                <Button type="button" size="touch" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
                <Button
                  type="button"
                  size="touch"
                  data-testid="git-benchmark-run"
                  disabled={!repositoryUrl || !branch}
                  onClick={() => void start()}
                >
                  Run
                </Button>
              </>
            ) : run.kind === "running" ? (
              <Button type="button" size="touch" variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
            ) : (
              <>
                {run.kind === "failed" && run.signIn ? (
                  <Button type="button" size="touch" data-testid="git-benchmark-sign-in" onClick={() => void signIn(run.signIn!)}>
                    {run.signIn.again ? "Sign In Again" : "Sign In"}
                  </Button>
                ) : null}
                <Button type="button" size="touch" variant="outline" data-testid="git-benchmark-again" onClick={runAgain}>Run Again</Button>
                <Button
                  type="button"
                  size="touch"
                  variant="secondary"
                  data-testid="git-benchmark-copy"
                  onClick={() => void copy(run.kind === "done" ? run.json : run.message)}
                >
                  {copyLabel(run.kind === "done" ? "Copy Results" : "Copy Error")}
                </Button>
                <Button type="button" size="touch" variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {dialogs}
    </>
  );
}
