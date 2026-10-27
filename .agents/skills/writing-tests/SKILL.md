---
name: writing-tests
description: Use when implementing a feature, bug fix or behaviour change, or when writing or changing tests, mocks or test helpers, to choose tests that protect production behaviour and catch plausible regressions.
---

# Writing tests

Use tests to protect the behaviour people rely on in the editor and game runtime. Which tests a change needs is set by the [testing rules](../../rules/agent-workflow.md#testing); this skill covers choosing and writing them. Tests may be written before or after the implementation: do not discard working code, add redundant tests or stall implementation because no test has failed yet.

A test exists to catch a specific break, so every test names the break it catches and exercises the real thing.

## Choose what to test

Read the implementation and its existing coverage, then name the behaviour that could regress.

- **Runtime or integration change**: exercise the real resolver, compiler, serialisation or host boundary. When Play and the exported player take different paths, cover each affected path.
- **UI behaviour**: test interaction through the real component. Use a targeted browser check when layout, pixels, touch sizing or focus cannot be established in a DOM test.
- **Cosmetic changes and documentation** usually need inspection, not new tests.

Vitest projects, the shared mocks and the jsdom traps that produce false passes are in [testing.md](../../reference/testing.md).

## Principle 1: Name the break

Before writing the test body, name the production change that should make it fail, and check that the change is a bug rather than a decision.

**Derive expectations independently.** Use literals and hand-checked fixtures; table-driven tests with literal expected values are the preferred shape. An expectation computed by the code under test passes whatever that code does:

```typescript
// ❌ The same builder computes both sides
expect(buildSearchQuery({ tag: "urgent" })).toBe(buildSearchQuery({ tag: "urgent" }));

// ✅ Hand-derived literal
expect(buildSearchQuery({ tag: "urgent" })).toBe('tag:"urgent"');
```

**No change detectors.** A test that only an intentional decision can fail (a constant's value, exact wording, private structure) fires on redesign and sleeps through bugs. Test the behaviour that depends on the decision: not `expect(MAX_RETRIES).toBe(5)`, but that a failing call is retried five times and never a sixth.

**Behaviour, not text, unless the text is the contract.** Run scripts against controlled inputs and assert outputs, side effects or exit codes. Source-text assertions are fine when the source text is the contract; the repository has source-read audit tests ([testing.md](../../reference/testing.md)). Say so in the test.

**Your code, not the framework.** Test the contract at your boundary: the command you emit, the payload you write, the state you publish. Constructors, getters, constants and forwarding earn tests only when they validate, normalise, default, derive or cause side effects.

## Principle 2: Exercise the real thing

**The mock earns no assertions.** An assertion that passes when a mock is present says nothing about the component. Assert the real component's behaviour, or unmock it.

**Mock at the right level.** Learn the real dependency's side effects, mock only the slow or external level below them, and keep what the test depends on real. In editor tests:

```typescript
// ❌ A hand-written factory: hooks it omits return undefined, and the test runs against a context the app never builds
vi.mock("../context/document-context", () => ({ useDocuments: () => ({ openDocuments: docs }) }));

// ✅ The shared mock: typed, inert defaults; supply only the fields the test controls
vi.mock("../context/document-context", async () =>
  (await import("../testing/document-context-mock")).documentContextMock(() => ({ openDocuments: docs })),
);
```

When the behaviour belongs to the provider itself, mount the real `DocumentProvider` with the stand-ins in `apps/editor/src/testing/real-document-provider.ts`, which replace only storage (an in-memory OPFS root), engine library fetches and GPU-dependent waits ([testing.md](../../reference/testing.md#document-context-mocks)).

**Make doubles specific.** When arguments, counts or order are part of the contract, assert them, and give each branch (success, error, malformed) its own fixture.

**Mirror real data completely.** A partial fixture fails silently when downstream code reads an omitted field.

**Production classes carry production methods only.** Cleanup that only tests need lives in test utilities.

## The mutation check

Before finishing, mutate the production code in your head. At least one test should fail for each realistic mutation:

- A wrong constant or argument
- A wrong branch
- A missing state change or side effect
- An empty or default return
- Missing validation for zero, empty, null, unauthorised or malformed input

A mutation that nothing catches marks the behaviour as unprotected, or the test as tautological.

## Verification

Select, run and record checks as [agent-workflow.md](../../rules/agent-workflow.md#verification) requires.
