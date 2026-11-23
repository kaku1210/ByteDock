import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointScopeId,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as SharedWorktreeCoordinationService from "./SharedWorktreeCoordinationService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

interface FakeDirtyFile {
  readonly path: string;
  readonly insertions: number;
  readonly deletions: number;
}

function makeHarness(
  dirtyFilesRef: { files: ReadonlyArray<FakeDirtyFile> },
  hooks?: {
    readonly onLocalStatus?: () => Effect.Effect<void>;
  },
) {
  const driver = ProviderDriverKind.make("codex");
  const instanceId = ProviderInstanceId.make(driver);
  const modelSelection = { instanceId, model: "model-alpha" };

  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: ({ providerSessionId }) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const queue = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        return {
          instanceId,
          driver,
          providerSessionId,
          providerSession: {
            id: providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd: process.cwd(),
            model: modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(queue),
          ensureThread: ({ threadId, existingProviderThread }) =>
            Effect.succeed({
              ...existingProviderThread!,
              appThreadId: threadId,
              nativeThreadRef: {
                driver,
                nativeId: existingProviderThread?.nativeThreadRef?.nativeId ?? `native:${threadId}`,
                strength: "weak",
              },
              status: "idle",
              updatedAt: now,
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          forkThread: () => Effect.die(new Error("forkThread not expected")),
          startTurn: () => Effect.void,
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          rollbackThread: () => Effect.die("unused"),
          readThreadSnapshot: () => Effect.die("unused"),
        } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
      }),
  };

  const gitWorkflowStub = Layer.succeed(GitWorkflowService.GitWorkflowService, {
    localStatus: ({ cwd }: { readonly cwd: string }) =>
      Effect.gen(function* () {
        if (hooks?.onLocalStatus !== undefined) {
          yield* hooks.onLocalStatus();
        }
        return {
          isRepo: true,
          hasOriginRemote: false,
          isDefaultBranch: true,
          refName: "develop",
          hasWorkingTreeChanges: dirtyFilesRef.files.length > 0,
          workingTree: {
            rootPath: cwd,
            files: dirtyFilesRef.files.map((file) => ({ ...file })),
            insertions: dirtyFilesRef.files.reduce((sum, f) => sum + f.insertions, 0),
            deletions: dirtyFilesRef.files.reduce((sum, f) => sum + f.deletions, 0),
          },
        };
      }),
  } as unknown as GitWorkflowService.GitWorkflowService["Service"]);

  const layerDatabase = SqlitePersistence.layerMemory;
  const base = ProviderReplayHarness.layerWithRegistry(
    { name: "shared-worktree-coordination" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );

  const sharedWorktreeLayer = SharedWorktreeCoordinationService.layer.pipe(
    Layer.provide(Layer.merge(ProjectionStore.layer, ProjectStore.layer)),
    Layer.provide(layerDatabase),
    Layer.provide(gitWorkflowStub),
    Layer.provide(NodeServices.layer),
  );

  return {
    modelSelection,
    layer: Layer.mergeAll(
      ThreadManagementService.layer.pipe(
        Layer.provideMerge(base),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
      ),
      sharedWorktreeLayer,
      NodeServices.layer,
    ),
  };
}

const seedSharedFamily = Effect.fn("seedSharedFamily")(function* (input: {
  readonly modelSelection: { readonly instanceId: ProviderInstanceId; readonly model: string };
  readonly workspaceRoot: string;
}) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projectId = ProjectId.make("project:shared-wt");
  const rootId = ThreadId.make("thread:l0-root");
  const childAId = ThreadId.make("thread:l1-a");
  const childBId = ThreadId.make("thread:l1-b");

  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("cmd:create-root"),
    projectId,
    threadId: rootId,
    title: "L0 Coordinator",
    modelSelection: input.modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: input.workspaceRoot,
    branch: "develop",
    createdBy: "user",
    creationSource: "web",
  });

  yield* orchestrator.dispatch({
    type: "thread.fork",
    commandId: CommandId.make("cmd:create-a"),
    sourceThreadId: rootId,
    targetThreadId: childAId,
    subtask: true,
    title: "L1 Worker A",
    sourcePoint: { type: "latest_stable" },
    createdBy: "agent",
    creationSource: "mcp",
  });

  yield* orchestrator.dispatch({
    type: "thread.fork",
    commandId: CommandId.make("cmd:create-b"),
    sourceThreadId: rootId,
    targetThreadId: childBId,
    subtask: true,
    title: "L1 Worker B",
    sourcePoint: { type: "latest_stable" },
    createdBy: "agent",
    creationSource: "mcp",
  });

  return { projectId, rootId, childAId, childBId } as const;
});

const waitUntilSnapshot = Effect.fn("waitUntilSnapshot")(function* (
  coord: SharedWorktreeCoordinationService.SharedWorktreeCoordinationServiceShape,
  threadId: ThreadId,
  predicate: (snapshot: Awaited<Effect.Success<ReturnType<typeof coord.getSnapshot>>>) => boolean,
) {
  while (true) {
    const waitNext = yield* coord.watchCoordinationChange;
    const snapshot = yield* coord.getSnapshot(threadId);
    if (predicate(snapshot)) {
      return snapshot;
    }
    yield* waitNext;
  }
});

describe("SharedWorktreeCoordinationService", () => {
  it.live(
    "allows parallel non-overlapping reservations and serializes overlapping file edits with fresh revision handoff",
    () => {
      const dirtyFiles = { files: [] as ReadonlyArray<FakeDirtyFile> };
      const harness = makeHarness(dirtyFiles);
      return Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tmpDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-shared-wt-" });
          yield* fs.makeDirectory(path.join(tmpDir, "src"), { recursive: true });
          yield* fs.writeFileString(path.join(tmpDir, "src", "a.ts"), "export const a = 1;\n");
          yield* fs.writeFileString(path.join(tmpDir, "src", "b.ts"), "export const b = 1;\n");
          yield* fs.writeFileString(path.join(tmpDir, "src", "shared.ts"), "v0\n");

          const { childAId, childBId } = yield* seedSharedFamily({
            modelSelection: harness.modelSelection,
            workspaceRoot: tmpDir,
          });
          const coord = yield* SharedWorktreeCoordinationService.SharedWorktreeCoordinationService;

          // 1. Parallel non-overlapping reservations proceed without waiting.
          const resAOnly = yield* coord.acquireWriteReservation({
            threadId: childAId,
            paths: ["src/a.ts"],
          });
          const resBOnly = yield* coord.acquireWriteReservation({
            threadId: childBId,
            paths: ["src/b.ts"],
          });
          assert.isFalse(resAOnly.waited);
          assert.isFalse(resBOnly.waited);
          const quietSnap = yield* coord.getSnapshot(childAId);
          assert.equal(quietSnap.overlaps.length, 0);
          assert.isTrue(quietSnap.restoreSafetyProtected);
          yield* coord.releaseWriteReservation({
            threadId: childAId,
            reservationId: resAOnly.reservation.reservationId,
          });
          yield* coord.releaseWriteReservation({
            threadId: childBId,
            reservationId: resBOnly.reservation.reservationId,
          });

          // 2. Planned path overlap emits warning before any write happens.
          yield* coord.setPlannedPaths({ threadId: childAId, paths: ["src/shared.ts"] });
          const planB = yield* coord.setPlannedPaths({
            threadId: childBId,
            paths: ["./src/shared.ts"],
          });
          assert.equal(planB.overlaps.length, 1);
          assert.equal(planB.overlaps[0]?.kind, "exact");
          assert.equal(planB.overlaps[0]?.severity, "warning");

          // 3. A reserves shared.ts; B queues behind A until A writes and releases.
          const resA = yield* coord.acquireWriteReservation({
            threadId: childAId,
            runId: RunId.make("run:a1"),
            paths: ["src/shared.ts"],
          });
          assert.isFalse(resA.waited);
          assert.equal(resA.latestFiles[0]?.contents, "v0\n");

          const bAcquiredGate = yield* Deferred.make<void>();
          const fiberB = yield* Effect.forkChild(
            coord
              .acquireWriteReservation({
                threadId: childBId,
                runId: RunId.make("run:b1"),
                paths: ["src/shared.ts"],
              })
              .pipe(Effect.tap(() => Deferred.succeed(bAcquiredGate, undefined))),
          );

          // Let fiberB enqueue on the waiting queue.
          const duringWait = yield* waitUntilSnapshot(
            coord,
            childAId,
            (snapshot) => snapshot.waitingReservations.length === 1,
          );
          assert.equal(duringWait.activeReservations.length, 1);
          assert.equal(duringWait.waitingReservations.length, 1);
          assert.equal(duringWait.overlaps[0]?.severity, "blocking");

          // A writes v1 while holding reservation, then releases.
          yield* fs.writeFileString(path.join(tmpDir, "src", "shared.ts"), "v1-from-A\n");
          yield* coord.releaseWriteReservation({
            threadId: childAId,
            reservationId: resA.reservation.reservationId,
          });

          const resB = yield* Fiber.join(fiberB);
          assert.isTrue(resB.waited);
          assert.equal(resB.priorWriters.length, 1);
          assert.equal(resB.priorWriters[0]?.threadId, childAId);
          assert.equal(resB.latestFiles[0]?.contents, "v1-from-A\n");
          const latestSha = resB.latestFiles[0]?.sha256;
          assert.isNotNull(latestSha);

          // Release B's explicit reservation so controlledWriteFile acquires cleanly.
          yield* coord.releaseWriteReservation({
            threadId: childBId,
            reservationId: resB.reservation.reservationId,
          });

          // Stale sha256 is rejected without overwriting A's changes.
          const staleExit = yield* Effect.exit(
            coord.controlledWriteFile({
              threadId: childBId,
              runId: RunId.make("run:b1"),
              path: "src/shared.ts",
              contents: "stale-overwrite\n",
              expectedSha256: "0000000000000000000000000000000000000000000000000000000000000000",
            }),
          );
          assert.isTrue(Exit.isFailure(staleExit));
          assert.equal(
            yield* fs.readFileString(path.join(tmpDir, "src", "shared.ts")),
            "v1-from-A\n",
          );

          // Fresh sha256 succeeds and records confirmed_write attribution for B.
          const written = yield* coord.controlledWriteFile({
            threadId: childBId,
            runId: RunId.make("run:b1"),
            path: "src/shared.ts",
            contents: "v1-from-A\nv2-from-B\n",
            expectedSha256: latestSha!,
          });
          assert.equal(written.writtenFile.contents, "v1-from-A\nv2-from-B\n");
          const afterWrite = yield* coord.getSnapshot(childBId);
          const threadBAttr = afterWrite.threads.find((t) => t.threadId === childBId);
          assert.isDefined(threadBAttr);
          assert.isTrue(
            threadBAttr!.confirmedWritePaths.some(
              (entry) =>
                entry.normalizedPath === "src/shared.ts" && entry.source === "controlled_write",
            ),
          );
        }),
      ).pipe(Effect.provide(harness.layer));
    },
  );

  it.live(
    "handles directory containment boundaries, rename pairs, and rejects invalid/git paths",
    () => {
      const dirtyFiles = { files: [] as ReadonlyArray<FakeDirtyFile> };
      const harness = makeHarness(dirtyFiles);
      return Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tmpDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-shared-wt-dir-" });
          yield* fs.makeDirectory(path.join(tmpDir, "src", "dir"), { recursive: true });
          yield* fs.makeDirectory(path.join(tmpDir, "src", "dir2"), { recursive: true });
          yield* fs.writeFileString(path.join(tmpDir, "src", "dir", "inside.ts"), "in\n");
          yield* fs.writeFileString(path.join(tmpDir, "src", "dir2", "sibling.ts"), "sib\n");
          yield* fs.writeFileString(path.join(tmpDir, "src", "old.ts"), "old\n");

          const { childAId, childBId } = yield* seedSharedFamily({
            modelSelection: harness.modelSelection,
            workspaceRoot: tmpDir,
          });
          const coord = yield* SharedWorktreeCoordinationService.SharedWorktreeCoordinationService;

          // Escape and .git metadata paths are rejected.
          const escapeExit = yield* Effect.exit(
            coord.setPlannedPaths({ threadId: childAId, paths: ["../outside.ts"] }),
          );
          assert.isTrue(Exit.isFailure(escapeExit));
          const gitExit = yield* Effect.exit(
            coord.setPlannedPaths({ threadId: childAId, paths: [".git/config"] }),
          );
          assert.isTrue(Exit.isFailure(gitExit));

          // Directory reservation on src/dir does NOT block src/dir2/sibling.ts,
          // but DOES block src/dir/inside.ts.
          const dirRes = yield* coord.acquireWriteReservation({
            threadId: childAId,
            paths: ["src/dir"],
          });
          const siblingRes = yield* coord.acquireWriteReservation({
            threadId: childBId,
            paths: ["src/dir2/sibling.ts"],
          });
          assert.isFalse(siblingRes.waited);
          yield* coord.releaseWriteReservation({
            threadId: childBId,
            reservationId: siblingRes.reservation.reservationId,
          });

          const insideFiber = yield* Effect.forkChild(
            coord.acquireWriteReservation({
              threadId: childBId,
              paths: ["src/dir/inside.ts"],
            }),
          );
          const snap = yield* waitUntilSnapshot(
            coord,
            childAId,
            (snapshot) => snapshot.waitingReservations.length === 1,
          );
          assert.equal(snap.waitingReservations.length, 1);
          assert.isTrue(snap.overlaps.some((o) => o.kind === "directory_containment"));

          yield* coord.releaseWriteReservation({
            threadId: childAId,
            reservationId: dirRes.reservation.reservationId,
          });
          const insideRes = yield* Fiber.join(insideFiber);
          assert.isTrue(insideRes.waited);
          yield* coord.releaseWriteReservation({
            threadId: childBId,
            reservationId: insideRes.reservation.reservationId,
          });

          // Rename pair writes new path, removes old path, and attributes both paths.
          const renamed = yield* coord.controlledWriteFile({
            threadId: childAId,
            path: "src/new.ts",
            renameFrom: "src/old.ts",
            contents: "renamed\n",
          });
          assert.equal(renamed.writtenFile.normalizedPath, "src/new.ts");
          assert.isFalse(yield* fs.exists(path.join(tmpDir, "src", "old.ts")));
          const afterRename = yield* coord.getSnapshot(childAId);
          const attrA = afterRename.threads.find((t) => t.threadId === childAId);
          assert.isTrue(
            attrA?.confirmedWritePaths.some(
              (e) => e.normalizedPath === "src/new.ts" && e.oldNormalizedPath === "src/old.ts",
            ) ?? false,
          );
        }),
      ).pipe(Effect.provide(harness.layer));
    },
  );

  it.live(
    "separates confirmed_write from observed_unverified external edits and ignores checkpoint diffs",
    () => {
      const dirtyFiles = {
        files: [
          { path: "src/from-controlled.ts", insertions: 3, deletions: 0 },
          { path: "src/from-turn-item.ts", insertions: 5, deletions: 1 },
          { path: "manual-external.txt", insertions: 2, deletions: 0 },
        ] as ReadonlyArray<FakeDirtyFile>,
      };
      const harness = makeHarness(dirtyFiles);
      return Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tmpDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-shared-wt-layers-" });
          yield* fs.makeDirectory(path.join(tmpDir, "src"), { recursive: true });

          const { childAId, childBId } = yield* seedSharedFamily({
            modelSelection: harness.modelSelection,
            workspaceRoot: tmpDir,
          });
          const coord = yield* SharedWorktreeCoordinationService.SharedWorktreeCoordinationService;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const sink = yield* EventSink.EventSinkV2;

          // Thread A performs a controlled write.
          yield* coord.controlledWriteFile({
            threadId: childAId,
            runId: RunId.make("run:a-ctrl"),
            path: "src/from-controlled.ts",
            contents: "export const a = true;\n",
          });

          // Start a run on Thread B so we have a valid runId + nodeId for turn items.
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("cmd:b-turn-msg"),
            threadId: childBId,
            messageId: MessageId.make("msg:b-turn"),
            text: "Edit from-turn-item.ts",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          const projB = yield* orchestrator.getThreadProjection(childBId);
          const runB = projB.runs[0]!;
          assert.isDefined(runB);
          const nodeId = runB.rootNodeId!;
          const now = yield* DateTime.now;
          yield* sink.write({
            events: [
              {
                id: EventId.make("evt:fc-b"),
                threadId: childBId,
                runId: runB.id,
                nodeId,
                driver: ProviderDriverKind.make("codex"),
                occurredAt: now,
                payload: {
                  id: TurnItemId.make("item:fc-b"),
                  threadId: childBId,
                  runId: runB.id,
                  nodeId,
                  providerThreadId: null,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 1,
                  status: "completed",
                  title: null,
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                  type: "file_change",
                  fileName: "src/from-turn-item.ts",
                  additions: 5,
                  deletions: 1,
                },
                type: "turn-item.updated",
              },
              {
                id: EventId.make("evt:cp-b"),
                threadId: childBId,
                runId: runB.id,
                nodeId,
                driver: ProviderDriverKind.make("codex"),
                occurredAt: now,
                payload: {
                  id: TurnItemId.make("item:cp-b"),
                  threadId: childBId,
                  runId: runB.id,
                  nodeId,
                  providerThreadId: null,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 2,
                  status: "completed",
                  title: null,
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                  type: "checkpoint",
                  checkpointId: CheckpointId.make("cp:b-1"),
                  scopeId: CheckpointScopeId.make("scope:b-1"),
                  files: [
                    {
                      path: "manual-external.txt",
                      kind: "modified",
                      additions: 2,
                      deletions: 0,
                    },
                  ],
                },
                type: "turn-item.updated",
              },
            ],
          });

          const snapshot = yield* coord.getSnapshot(childAId);
          const attrA = snapshot.threads.find((t) => t.threadId === childAId);
          const attrB = snapshot.threads.find((t) => t.threadId === childBId);
          assert.deepStrictEqual(
            attrA?.confirmedWritePaths.map((e) => e.normalizedPath),
            ["src/from-controlled.ts"],
          );
          assert.deepStrictEqual(
            attrB?.confirmedWritePaths.map((e) => e.normalizedPath),
            ["src/from-turn-item.ts"],
          );
          // manual-external.txt MUST remain observed_unverified, NEVER falsely attributed to B from checkpoint.files.
          assert.deepStrictEqual(
            snapshot.observedUnverifiedPaths.map((e) => e.normalizedPath),
            ["manual-external.txt"],
          );
          assert.equal(snapshot.observedUnverifiedPaths[0]?.attribution, "observed_unverified");
        }),
      ).pipe(Effect.provide(harness.layer));
    },
  );

  it.live(
    "serializes checkout turns when serialize_checkout_writes is enabled and avoids deadlock via suspendCheckoutTurnLease",
    () => {
      const dirtyFiles = { files: [] as ReadonlyArray<FakeDirtyFile> };
      const harness = makeHarness(dirtyFiles);
      return Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const tmpDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-shared-wt-ser-" });

          const { rootId, childAId } = yield* seedSharedFamily({
            modelSelection: harness.modelSelection,
            workspaceRoot: tmpDir,
          });
          const coord = yield* SharedWorktreeCoordinationService.SharedWorktreeCoordinationService;

          // Default parallel mode does not serialize turns.
          const parallelLease = yield* coord.acquireCheckoutTurnLease({
            cwd: tmpDir,
            threadId: rootId,
            runId: RunId.make("run:par-1"),
          });
          assert.isFalse(parallelLease.serialized);

          // Switch checkout to serialize_checkout_writes.
          const policy = yield* coord.setPolicy({
            threadId: rootId,
            serializationMode: "serialize_checkout_writes",
            updatedBy: "user",
          });
          assert.equal(policy.serializationMode, "serialize_checkout_writes");
          assert.isTrue(policy.shellConstraintCoverage.checkoutWriteSerializationEnabled);

          const rootRunId = RunId.make("run:root-ser");
          const childRunId = RunId.make("run:child-ser");
          const rootLease = yield* coord.acquireCheckoutTurnLease({
            cwd: tmpDir,
            threadId: rootId,
            runId: rootRunId,
          });
          assert.isTrue(rootLease.serialized);

          // Child waits while root holds the lease.
          const childStarted = yield* Deferred.make<void>();
          const childFiber = yield* Effect.forkChild(
            Effect.gen(function* () {
              const childLease = yield* coord.acquireCheckoutTurnLease({
                cwd: tmpDir,
                threadId: childAId,
                runId: childRunId,
              });
              yield* Deferred.succeed(childStarted, undefined);
              yield* childLease.release;
              return "child-done";
            }),
          );

          const queuedSnap = yield* waitUntilSnapshot(
            coord,
            rootId,
            (snapshot) => snapshot.waitingSerializedRuns.length === 1,
          );
          assert.equal(queuedSnap.activeSerializedRun?.threadId, rootId);
          assert.equal(queuedSnap.waitingSerializedRuns.length, 1);
          assert.equal(queuedSnap.waitingSerializedRuns[0]?.threadId, childAId);

          // Root suspends its checkout lease while synchronously waiting for child -> zero deadlock.
          const childResult = yield* coord.suspendCheckoutTurnLease(
            rootId,
            rootRunId,
            Fiber.join(childFiber),
          );
          assert.equal(childResult, "child-done");
          assert.isTrue(yield* Deferred.isDone(childStarted));

          // Root re-acquired its lease after suspend; releasing clears activeSerializedRun.
          const resumedSnap = yield* coord.getSnapshot(rootId);
          assert.equal(resumedSnap.activeSerializedRun?.threadId, rootId);
          yield* rootLease.release;

          const finalSnap = yield* coord.getSnapshot(rootId);
          assert.isNull(finalSnap.activeSerializedRun);
          assert.equal(finalSnap.waitingSerializedRuns.length, 0);
        }),
      ).pipe(Effect.provide(harness.layer));
    },
  );

  it.live(
    "cleans up reservations and planned paths on clearThreadState and unblocks waiting siblings",
    () => {
      const dirtyFiles = { files: [] as ReadonlyArray<FakeDirtyFile> };
      const harness = makeHarness(dirtyFiles);
      return Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tmpDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-shared-wt-clean-" });
          yield* fs.makeDirectory(path.join(tmpDir, "src"), { recursive: true });
          yield* fs.writeFileString(path.join(tmpDir, "src", "lock.ts"), "init\n");

          const { childAId, childBId } = yield* seedSharedFamily({
            modelSelection: harness.modelSelection,
            workspaceRoot: tmpDir,
          });
          const coord = yield* SharedWorktreeCoordinationService.SharedWorktreeCoordinationService;

          yield* coord.setPlannedPaths({ threadId: childAId, paths: ["src/lock.ts"] });
          yield* coord.acquireWriteReservation({
            threadId: childAId,
            runId: RunId.make("run:a-die"),
            paths: ["src/lock.ts"],
          });

          const fiberB = yield* Effect.forkChild(
            coord.acquireWriteReservation({
              threadId: childBId,
              paths: ["src/lock.ts"],
            }),
          );
          yield* waitUntilSnapshot(
            coord,
            childAId,
            (snapshot) => snapshot.waitingReservations.length === 1,
          );

          // Clearing thread A (simulating archive/delete/cancel) unblocks B immediately.
          yield* coord.clearThreadState([childAId]);
          const resB = yield* Fiber.join(fiberB);
          assert.isTrue(resB.waited);
          yield* coord.releaseWriteReservation({
            threadId: childBId,
            reservationId: resB.reservation.reservationId,
          });

          const snap = yield* coord.getSnapshot(childBId);
          const attrA = snap.threads.find((t) => t.threadId === childAId);
          assert.equal(attrA?.plannedPaths.length ?? 0, 0);
          assert.equal(snap.activeReservations.length, 0);
        }),
      ).pipe(Effect.provide(harness.layer));
    },
  );

  it.live(
    "coalesces concurrent checkout snapshots with per-caller family projection and invalidates on mutations",
    () => {
      const dirtyFiles = { files: [] as ReadonlyArray<FakeDirtyFile> };
      let localStatusCalls = 0;
      let gate: Deferred.Deferred<void> | null = null;
      let startedGate: Deferred.Deferred<void> | null = null;
      const harness = makeHarness(dirtyFiles, {
        onLocalStatus: () =>
          Effect.gen(function* () {
            localStatusCalls += 1;
            if (startedGate !== null) {
              yield* Deferred.succeed(startedGate, undefined);
            }
            if (gate !== null) {
              yield* Deferred.await(gate);
            }
          }),
      });

      return Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tmpDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-shared-wt-cache-" });
          yield* fs.makeDirectory(path.join(tmpDir, "src"), { recursive: true });
          yield* fs.writeFileString(path.join(tmpDir, "src", "file.ts"), "v0\n");

          const { projectId, rootId, childAId } = yield* seedSharedFamily({
            modelSelection: harness.modelSelection,
            workspaceRoot: tmpDir,
          });
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const otherRootId = ThreadId.make("thread:other-root");
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("cmd:create-other-root"),
            projectId,
            threadId: otherRootId,
            title: "Other Root",
            modelSelection: harness.modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            worktreePath: tmpDir,
            branch: "develop",
            createdBy: "user",
            creationSource: "web",
          });

          const coord = yield* SharedWorktreeCoordinationService.SharedWorktreeCoordinationService;

          // 1. Concurrent getSnapshot calls from two different families sharing the same checkout
          //    coalesce onto a single localStatus + base computation, while projecting caller-specific fields.
          gate = yield* Deferred.make<void>();
          startedGate = yield* Deferred.make<void>();
          const fiber1 = yield* Effect.forkChild(coord.getSnapshot(childAId));
          yield* Deferred.await(startedGate);
          const fiber2 = yield* Effect.forkChild(coord.getSnapshot(otherRootId));
          yield* Deferred.succeed(gate, undefined);
          gate = null;
          startedGate = null;

          const [snapA, snapOther] = yield* Effect.all([Fiber.join(fiber1), Fiber.join(fiber2)]);
          assert.equal(localStatusCalls, 1);
          assert.equal(snapA.rootThreadId, rootId);
          assert.equal(snapOther.rootThreadId, otherRootId);
          assert.isTrue(snapA.threads.find((t) => t.threadId === rootId)?.inFamily);
          assert.isFalse(snapA.threads.find((t) => t.threadId === otherRootId)?.inFamily);
          assert.isFalse(snapOther.threads.find((t) => t.threadId === rootId)?.inFamily);
          assert.isTrue(snapOther.threads.find((t) => t.threadId === otherRootId)?.inFamily);

          // 2. Immediate follow-up read hits the checkout snapshot cache without calling localStatus again.
          const cachedSnap = yield* coord.getSnapshot(rootId);
          assert.equal(localStatusCalls, 1);
          assert.equal(cachedSnap.generatedAt, snapA.generatedAt);

          // 3. Policy and planned path mutations invalidate the checkout snapshot cache immediately.
          yield* coord.setPolicy({
            threadId: rootId,
            serializationMode: "serialize_checkout_writes",
            updatedBy: "user",
          });
          const afterPolicy = yield* coord.getSnapshot(rootId);
          assert.equal(afterPolicy.policy.serializationMode, "serialize_checkout_writes");
          // Git localStatus cache is still valid across policy-only change.
          assert.equal(localStatusCalls, 1);

          yield* coord.setPlannedPaths({ threadId: childAId, paths: ["src/file.ts"] });
          const afterPlan = yield* coord.getSnapshot(rootId);
          assert.equal(
            afterPlan.threads.find((t) => t.threadId === childAId)?.plannedPaths[0]?.normalizedPath,
            "src/file.ts",
          );

          // 4. Controlled write invalidates both snapshot and git localStatus caches.
          dirtyFiles.files = [{ path: "src/file.ts", insertions: 1, deletions: 1 }];
          yield* coord.controlledWriteFile({
            threadId: childAId,
            path: "src/file.ts",
            contents: "v1\n",
          });
          const afterWrite = yield* coord.getSnapshot(rootId);
          assert.equal(localStatusCalls, 2);
          assert.isTrue(
            afterWrite.threads
              .find((t) => t.threadId === childAId)
              ?.confirmedWritePaths.some((entry) => entry.normalizedPath === "src/file.ts") ??
              false,
          );
          assert.equal(afterWrite.observedUnverifiedPaths.length, 0);
        }),
      ).pipe(Effect.provide(harness.layer));
    },
  );
});
