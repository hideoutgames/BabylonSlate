import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";

const workflow = parse(
  await readFile(
    new URL("../.github/workflows/security.yml", import.meta.url),
    "utf8",
  ),
);

/** The part of the Actions expression language the workflow uses: context paths, strings, `==`, `!=`, `!`, `&&`, `||`. */
function evaluate(expression, github) {
  const script = expression
    .replace(/\bgithub((?:\.[\w-]+)+)/g, (_, path) => `github${path.replaceAll(".", "?.")}`)
    .replace(/([=!])=/g, "$1==");
  return new Function("github", `return (${script});`)(github);
}

const interpolate = (text, github) =>
  text.replace(/\$\{\{(.*?)\}\}/g, (_, expression) => evaluate(expression, github) ?? "");

const pullRequest = (event) => ({
  event_name: "pull_request",
  workflow: "Security",
  ref: "refs/pull/7/merge",
  event: { pull_request: { number: 7 }, ...event },
});
const codeEvents = {
  push: { event_name: "push", workflow: "Security", ref: "refs/heads/main", event: {} },
  opened: pullRequest({ action: "opened" }),
  synchronize: pullRequest({ action: "synchronize" }),
  reopened: pullRequest({ action: "reopened" }),
  ready: pullRequest({ action: "ready_for_review" }),
  // A new base changes the pull request's commit range.
  base: pullRequest({ action: "edited", changes: { base: { ref: { from: "old" } } } }),
};
const textEvents = {
  title: pullRequest({ action: "edited", changes: { title: { from: "Old title" } } }),
  body: pullRequest({ action: "edited", changes: { body: { from: "Old body" } } }),
  review: pullRequest({ action: "submitted", review: { id: 11 } }),
  reviewComment: pullRequest({ action: "created", comment: { id: 12 } }),
  issueComment: {
    event_name: "issue_comment",
    workflow: "Security",
    ref: "refs/heads/main",
    event: { action: "created", comment: { id: 13 }, issue: { number: 7 } },
  },
};
textEvents.review.event_name = "pull_request_review";
textEvents.reviewComment.event_name = "pull_request_review_comment";

// A job runs when its condition is truthy.
const runs = (job, github) => Boolean(evaluate(workflow.jobs[job].if, github));
const group = (github) => interpolate(workflow.concurrency.group, github);

test("code events run the full scan and text events only the event text check", () => {
  assert.deepEqual(Object.keys(workflow.jobs).sort(), ["event-text", "public-hygiene"]);
  for (const [name, github] of Object.entries(codeEvents)) {
    assert.equal(runs("public-hygiene", github), true, name);
    assert.equal(runs("event-text", github), false, name);
  }
  for (const [name, github] of Object.entries(textEvents)) {
    assert.equal(runs("public-hygiene", github), false, name);
    assert.equal(runs("event-text", github), true, name);
  }
});

test("the full scan covers the tree, the commits and the text; the text check reads only the event", () => {
  const commands = (job) => workflow.jobs[job].steps.map((step) => step.run ?? "").join("\n");
  const full = commands("public-hygiene");
  for (const scan of [
    "./gitleaks dir .",
    "./gitleaks git . --log-opts=",
    'node scripts/check-public-hygiene.mjs --event "$GITHUB_EVENT_PATH"',
    "node scripts/check-public-hygiene.mjs --range ",
    'node scripts/check-public-hygiene.mjs --commits "$RANGE"',
  ])
    assert.ok(full.includes(scan), scan);
  const [checkout] = workflow.jobs["public-hygiene"].steps;
  assert.equal(checkout.with["fetch-depth"], 0);

  const text = workflow.jobs["event-text"];
  assert.deepEqual(
    text.steps.filter((step) => step.run).map((step) => step.run.trim()),
    ['node scripts/check-public-hygiene.mjs --event-only "$GITHUB_EVENT_PATH"'],
  );
  // One file at the event's commit, no history.
  assert.equal(text.steps[0].with["fetch-depth"], undefined);
  assert.equal(text.steps[0].with["sparse-checkout"], "scripts/check-public-hygiene.mjs");
});

test("a title or body edit cannot cancel the commit scan, and each comment or review keeps its own run", () => {
  const scan = group(codeEvents.synchronize);
  assert.equal(group(codeEvents.opened), scan);
  // A base change replaces the commit range, so it supersedes the earlier scan with a full one.
  assert.equal(group(codeEvents.base), scan);
  assert.notEqual(group(textEvents.title), scan);
  assert.equal(group(textEvents.body), group(textEvents.title));
  const edited = (github) => ({ ...github, event: { ...github.event, action: "edited" } });
  for (const name of ["review", "reviewComment", "issueComment"]) {
    const github = textEvents[name];
    assert.equal(group(edited(github)), group(github), name);
    assert.ok(
      [scan, group(textEvents.title)].every((other) => other !== group(github)),
      name,
    );
  }
  assert.notEqual(
    group({ ...textEvents.issueComment, event: { ...textEvents.issueComment.event, comment: { id: 14 } } }),
    group(textEvents.issueComment),
  );
  assert.equal(workflow.concurrency["cancel-in-progress"], true);
});
