import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  CoordinatorRoleTemplateId,
  DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as FamilyCollaborationOverviewService from "./FamilyCollaborationOverviewService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as SharedWorktreeCoordinationService from "./SharedWorktreeCoordinationService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

function makeCoordinatorTestLayer(name: string) {
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
        return {
          instanceId,
          driver,
          providerSessionId,
          providerSession: {
            id: providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd: `/tmp/${name}`,
            model: modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.never,
          ensureThread: ({ threadId, existingProviderThread }) =>
            Effect.succeed({
              ...existingProviderThread!,
              appThreadId: threadId,
              nativeThreadRef: {
                driver,
                nativeId: `native:${threadId}`,
                strength: "strong",
              },
              status: "idle",
              updatedAt: now,
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          forkThread: ({ targetThreadId }) =>
            Effect.succeed({
              id: ProviderThreadId.make(`pt:${targetThreadId}`),
              driver,
              providerInstanceId: instanceId,
              providerSessionId,
              appThreadId: targetThreadId,
              ownerNodeId: null,
              nativeThreadRef: {
                driver,
                nativeId: `native:${targetThreadId}`,
                strength: "strong",
              },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            }),
          startTurn: () => Effect.void,
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          rollbackThread: () => Effect.die("unused"),
          readThreadSnapshot: () => Effect.die("unused"),
        } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
      }),
  };

  const layerDb = SqlitePersistence.layerMemory;
  const layerServerSettings = ServerSettings.layerTest({ responseStreamingMode: "turn" }).pipe(
    Layer.orDie,
  );
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    {
      databaseLayer: layerDb,
      serverSettingsLayer: layerServerSettings,
      runEffectWorker: false,
    },
  );
  const layerProjection = ProjectionStore.layer.pipe(Layer.provide(layerDb));
  const layerSharedWorktreeMock = Layer.mock(
    SharedWorktreeCoordinationService.SharedWorktreeCoordinationService,
  )({
    getSnapshot: (rootThreadId) =>
      Effect.succeed({
        rootThreadId,
        checkoutPath: `/tmp/${name}`,
        checkoutKey: `/tmp/${name}`,
        policy: {
          checkoutKey: `/tmp/${name}`,
          checkoutPath: `/tmp/${name}`,
          serializationMode: "parallel" as const,
          shellConstraintCoverage: {
            serverEnforcedWorktreeGate: true,
            serverEnforcedWriteReservation: true,
            checkoutWriteSerializationEnabled: false,
            shellGitWorktreeConstraint: "provider_tool_permission" as const,
            summary: "test",
          },
          updatedAt: "2026-11-21T00:00:00.000Z",
          updatedBy: null,
        },
        sharedThreadCount: 1,
        threads: [],
        overlaps: [],
        observedUnverifiedPaths: [],
        activeReservations: [],
        waitingReservations: [],
        activeSerializedRun: null,
        waitingSerializedRuns: [],
        restoreSafetyProtected: true,
        generatedAt: "2026-11-21T00:00:00.000Z",
      }),
  });
  const layerOverview = FamilyCollaborationOverviewService.layer.pipe(
    Layer.provide(Layer.mergeAll(layerProjection, layerSharedWorktreeMock)),
  );

  return {
    driver,
    instanceId,
    modelSelection,
    layerDb,
    layer: Layer.mergeAll(layerOrchestrator, layerProjection, layerServerSettings, layerOverview),
  };
}

describe("Orchestrator L0 coordinator mode (P3-B1)", () => {
  it.effect(
    "persists coordinatorMode across thread.create, thread.coordinator-mode.set, shells, family overview, and SQLite reload",
    () => {
      const { modelSelection, layer } = makeCoordinatorTestLayer("coordinator-persistence");

      return Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const serverSettings = yield* ServerSettings.ServerSettingsService;
        const overviewService =
          yield* FamilyCollaborationOverviewService.FamilyCollaborationOverviewService;

        const projectId = ProjectId.make("proj:coord-persist");
        const threadId = ThreadId.make("thread:coord-l0");
        const customTemplateId = CoordinatorRoleTemplateId.make("arch-lead");

        // Creating an L0 thread with default coordinator mode enabled succeeds and persists.
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd:create-l0"),
          threadId,
          projectId,
          title: "L0 Coordinator Root",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          coordinatorMode: {
            enabled: true,
            templateId: DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
          },
          branch: "main",
          worktreePath: "/tmp/coordinator-persistence",
          createdBy: "user",
          creationSource: "web",
        });

        const initialThread = yield* projectionStore.getThread(threadId);
        assert.deepStrictEqual(initialThread.coordinatorMode, {
          enabled: true,
          templateId: DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
        });

        const initialShell = yield* projectionStore.getThreadShell(threadId);
        assert.deepStrictEqual(initialShell?.coordinatorMode, {
          enabled: true,
          templateId: DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
        });

        const overview = yield* overviewService.getOverview({ threadId });
        assert.deepStrictEqual(overview.nodes[0]?.coordinatorMode, {
          enabled: true,
          templateId: DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
        });

        // Register a custom coordinator role template, then switch thread to it.
        yield* serverSettings.updateSettings({
          coordinatorRoleTemplates: {
            [customTemplateId]: {
              name: "Architecture Lead",
              description: "Delegation-first coordinator",
              tierModels: { L0: null, L1: null, L2: null },
              preferDelegation: true,
              delegationStrategy: "tiered",
              instructions: "Keep L0 focused on coordination.",
            },
          },
        });

        yield* orchestrator.dispatch({
          type: "thread.coordinator-mode.set",
          commandId: CommandId.make("cmd:switch-template"),
          threadId,
          coordinatorMode: { enabled: true, templateId: customTemplateId },
        });

        const switchedThread = yield* projectionStore.getThread(threadId);
        assert.deepStrictEqual(switchedThread.coordinatorMode, {
          enabled: true,
          templateId: customTemplateId,
        });

        // Deleting the custom template still allows disabling coordinator mode while keeping the templateId.
        yield* serverSettings.updateSettings({
          coordinatorRoleTemplates: { [customTemplateId]: null },
        });

        yield* orchestrator.dispatch({
          type: "thread.coordinator-mode.set",
          commandId: CommandId.make("cmd:disable-after-delete"),
          threadId,
          coordinatorMode: { enabled: false, templateId: customTemplateId },
        });

        const disabledShell = yield* projectionStore.getThreadShell(threadId);
        assert.deepStrictEqual(disabledShell?.coordinatorMode, {
          enabled: false,
          templateId: customTemplateId,
        });

        // Re-enabling the deleted custom template is rejected.
        const reenableError = yield* orchestrator
          .dispatch({
            type: "thread.coordinator-mode.set",
            commandId: CommandId.make("cmd:reenable-deleted"),
            threadId,
            coordinatorMode: { enabled: true, templateId: customTemplateId },
          })
          .pipe(Effect.flip);
        assert.strictEqual(reenableError._tag, "OrchestratorDispatchError");
        assert.include(String(reenableError.cause), customTemplateId);

        // Clearing coordinatorMode to null persists cleanly.
        yield* orchestrator.dispatch({
          type: "thread.coordinator-mode.set",
          commandId: CommandId.make("cmd:clear-coord"),
          threadId,
          coordinatorMode: null,
        });

        const clearedThread = yield* projectionStore.getThread(threadId);
        assert.strictEqual(clearedThread.coordinatorMode, null);
        const clearedShell = yield* projectionStore.getThreadShell(threadId);
        assert.strictEqual(clearedShell?.coordinatorMode, null);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "enforces strict L0-only coordinator mode across subtasks, subagents, side chats, temporary threads, remote delegations, and forks",
    () => {
      const { driver, instanceId, modelSelection, layer } =
        makeCoordinatorTestLayer("coordinator-l0-only");

      return Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const sink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;

        const projectId = ProjectId.make("proj:coord-l0-only");
        const l0Id = ThreadId.make("thread:l0-root");
        const l1SubtaskId = ThreadId.make("thread:l1-subtask");
        const l2SubtaskId = ThreadId.make("thread:l2-subtask");
        const sideChatId = ThreadId.make("thread:side-chat");
        const plainForkId = ThreadId.make("thread:plain-fork");
        const appSubagentId = ThreadId.make("thread:app-subagent");
        const nativeSubagentId = ThreadId.make("thread:native-subagent");
        const tempThreadId = ThreadId.make("thread:temporary");
        const remoteDelegatedId = ThreadId.make("thread:remote-delegated");

        // 1. Unknown template on thread.create is rejected.
        const missingTemplateErr = yield* orchestrator
          .dispatch({
            type: "thread.create",
            commandId: CommandId.make("cmd:create-missing-tpl"),
            threadId: ThreadId.make("thread:bad-tpl"),
            projectId,
            title: "Bad Template",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            coordinatorMode: {
              enabled: true,
              templateId: CoordinatorRoleTemplateId.make("does-not-exist"),
            },
            branch: "main",
            worktreePath: "/tmp/coordinator-l0-only",
            createdBy: "user",
            creationSource: "web",
          })
          .pipe(Effect.flip);
        assert.strictEqual(missingTemplateErr._tag, "OrchestratorDispatchError");

        // 2. Remotely delegated thread cannot enable coordinatorMode at thread.create.
        const remoteCreateErr = yield* orchestrator
          .dispatch({
            type: "thread.create",
            commandId: CommandId.make("cmd:create-remote-coord"),
            threadId: remoteDelegatedId,
            projectId,
            title: "Remote Delegated",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            coordinatorMode: {
              enabled: true,
              templateId: DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
            },
            linkOrigin: {
              sessionId: "link-session-origin",
              label: "Origin",
            },
            delegatedFrom: {
              environmentId: EnvironmentId.make("env:origin"),
              threadId: ThreadId.make("thread:origin-parent"),
              title: "Origin Parent",
            },
            branch: "main",
            worktreePath: "/tmp/coordinator-l0-only",
            createdBy: "agent",
            creationSource: "mcp",
          })
          .pipe(Effect.flip);
        assert.strictEqual(remoteCreateErr._tag, "OrchestratorDispatchError");
        assert.include(String(remoteCreateErr.cause), "remotely delegated");

        // Creating the remotely delegated thread without coordinatorMode works, then setting it fails.
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd:create-remote-ok"),
          threadId: remoteDelegatedId,
          projectId,
          title: "Remote Delegated",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          linkOrigin: {
            sessionId: "link-session-origin",
            label: "Origin",
          },
          delegatedFrom: {
            environmentId: EnvironmentId.make("env:origin"),
            threadId: ThreadId.make("thread:origin-parent"),
            title: "Origin Parent",
          },
          branch: "main",
          worktreePath: "/tmp/coordinator-l0-only",
          createdBy: "agent",
          creationSource: "mcp",
        });

        const remoteMutateErr = yield* orchestrator
          .dispatch({
            type: "thread.coordinator-mode.set",
            commandId: CommandId.make("cmd:set-remote-coord"),
            threadId: remoteDelegatedId,
            coordinatorMode: {
              enabled: true,
              templateId: DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
            },
          })
          .pipe(Effect.flip);
        assert.strictEqual(remoteMutateErr._tag, "OrchestratorDispatchError");
        assert.include(String(remoteMutateErr.cause), "remotely delegated");

        // 3. Create an L0 coordinator root with a completed run so we can fork real subtasks/sideChats/forks.
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd:create-l0-root"),
          threadId: l0Id,
          projectId,
          title: "L0 Coordinator",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          coordinatorMode: {
            enabled: true,
            templateId: DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
          },
          branch: "main",
          worktreePath: "/tmp/coordinator-l0-only",
          createdBy: "user",
          creationSource: "web",
        });

        const l0RunId = RunId.make("run:l0:1");
        const l0PtId = ProviderThreadId.make("pt:l0");
        yield* sink.write({
          events: [
            {
              id: EventId.make("ev:l0-pt"),
              type: "provider-thread.updated",
              threadId: l0Id,
              providerInstanceId: instanceId,
              occurredAt: now,
              payload: {
                id: l0PtId,
                driver,
                providerInstanceId: instanceId,
                providerSessionId: null,
                appThreadId: l0Id,
                ownerNodeId: null,
                nativeThreadRef: { driver, nativeId: "native:l0", strength: "strong" },
                nativeConversationHeadRef: null,
                status: "active",
                firstRunOrdinal: 1,
                lastRunOrdinal: 1,
                handoffIds: [],
                forkedFrom: null,
                createdAt: now,
                updatedAt: now,
              },
            },
            {
              id: EventId.make("ev:l0-msg"),
              type: "message.updated",
              threadId: l0Id,
              runId: l0RunId,
              occurredAt: now,
              payload: {
                id: MessageId.make("msg:l0-1"),
                threadId: l0Id,
                runId: l0RunId,
                nodeId: null,
                role: "user",
                text: "Coordinate this feature",
                attachments: [],
                streaming: false,
                createdAt: now,
                updatedAt: now,
                createdBy: "user",
                creationSource: "web",
              },
            },
            {
              id: EventId.make("ev:l0-run"),
              type: "run.created",
              threadId: l0Id,
              runId: l0RunId,
              occurredAt: now,
              payload: {
                id: l0RunId,
                threadId: l0Id,
                ordinal: 1,
                providerInstanceId: instanceId,
                modelSelection,
                providerThreadId: l0PtId,
                userMessageId: MessageId.make("msg:l0-1"),
                rootNodeId: null,
                activeAttemptId: null,
                status: "completed",
                queuePosition: null,
                requestedAt: now,
                startedAt: now,
                completedAt: now,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
          ],
        });

        // Fork a real L1 subtask, side chat, temporary thread, and plain user fork from the L0 coordinator.
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("cmd:fork-l1-subtask"),
          sourceThreadId: l0Id,
          targetThreadId: l1SubtaskId,
          sourcePoint: { type: "run", runId: l0RunId },
          subtask: true,
          title: "L1 Subtask",
          createdBy: "user",
          creationSource: "web",
        });

        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("cmd:fork-sidechat"),
          sourceThreadId: l0Id,
          targetThreadId: sideChatId,
          sourcePoint: { type: "run", runId: l0RunId },
          sideChat: true,
          title: "Side Chat",
          createdBy: "user",
          creationSource: "web",
        });

        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("cmd:fork-plain"),
          sourceThreadId: l0Id,
          targetThreadId: plainForkId,
          sourcePoint: { type: "run", runId: l0RunId },
          title: "Plain User Fork",
          createdBy: "user",
          creationSource: "web",
        });

        // Children and forks MUST NOT inherit coordinatorMode from their L0 source.
        assert.isUndefined((yield* projectionStore.getThread(l1SubtaskId)).coordinatorMode);
        assert.isUndefined((yield* projectionStore.getThread(sideChatId)).coordinatorMode);
        assert.isUndefined((yield* projectionStore.getThread(plainForkId)).coordinatorMode);

        // Seed L2 subtask, temporary thread, app-owned subagent, and provider-native subagent threads.
        const seedThread = (thread: OrchestrationV2AppThread, eventId: string) =>
          sink.write({
            events: [
              {
                id: EventId.make(eventId),
                type: "thread.created",
                threadId: thread.id,
                providerInstanceId: instanceId,
                occurredAt: now,
                payload: thread,
              },
            ],
          });

        const baseThread: Omit<OrchestrationV2AppThread, "id" | "title" | "lineage"> = {
          createdBy: "agent",
          creationSource: "mcp",
          projectId,
          providerInstanceId: instanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "main",
          worktreePath: "/tmp/coordinator-l0-only",
          activeProviderThreadId: null,
          pullRequests: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          snoozedUntil: null,
          snoozedAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        };

        yield* seedThread(
          {
            ...baseThread,
            id: tempThreadId,
            title: "Temporary Root",
            lineage: {
              parentThreadId: null,
              relationshipToParent: null,
              rootThreadId: tempThreadId,
              temporary: true,
            },
          },
          "ev:seed-temp",
        );

        yield* seedThread(
          {
            ...baseThread,
            id: l2SubtaskId,
            title: "L2 Subtask",
            lineage: {
              parentThreadId: l1SubtaskId,
              relationshipToParent: "subtask",
              rootThreadId: l0Id,
            },
          },
          "ev:seed-l2",
        );
        yield* seedThread(
          {
            ...baseThread,
            id: appSubagentId,
            title: "App Subagent",
            lineage: {
              parentThreadId: l0Id,
              relationshipToParent: "subagent",
              rootThreadId: l0Id,
            },
          },
          "ev:seed-app-subagent",
        );
        yield* seedThread(
          {
            ...baseThread,
            id: nativeSubagentId,
            title: "Native Subagent",
            creationSource: "provider",
            lineage: {
              parentThreadId: l0Id,
              relationshipToParent: "subagent",
              rootThreadId: l0Id,
            },
          },
          "ev:seed-native-subagent",
        );

        // Non-L0 threads are strictly rejected.
        for (const [label, targetId, expectedSubstring] of [
          ["L1 subtask", l1SubtaskId, "subtask"],
          ["L2 subtask", l2SubtaskId, "subtask"],
          ["side chat", sideChatId, "side chat"],
          ["temporary thread", tempThreadId, "temporary"],
          ["app subagent", appSubagentId, "subagent"],
        ] as const) {
          const err = yield* orchestrator
            .dispatch({
              type: "thread.coordinator-mode.set",
              commandId: CommandId.make(`cmd:reject-${label}`),
              threadId: targetId,
              coordinatorMode: {
                enabled: true,
                templateId: DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
              },
            })
            .pipe(Effect.flip);
          assert.strictEqual(err._tag, "OrchestratorDispatchError");
          assert.include(String(err.cause), expectedSubstring);
        }

        // Provider-native subagent returns read-only subagent error.
        const nativeErr = yield* orchestrator
          .dispatch({
            type: "thread.coordinator-mode.set",
            commandId: CommandId.make("cmd:reject-native-subagent"),
            threadId: nativeSubagentId,
            coordinatorMode: {
              enabled: true,
              templateId: DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
            },
          })
          .pipe(Effect.flip);
        assert.strictEqual(nativeErr._tag, "OrchestratorSubagentThreadReadOnlyError");

        // Plain user fork is an independent L0 root and CAN opt into coordinator mode.
        yield* orchestrator.dispatch({
          type: "thread.coordinator-mode.set",
          commandId: CommandId.make("cmd:enable-plain-fork"),
          threadId: plainForkId,
          coordinatorMode: {
            enabled: true,
            templateId: DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
          },
        });
        assert.deepStrictEqual((yield* projectionStore.getThread(plainForkId)).coordinatorMode, {
          enabled: true,
          templateId: DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
        });
      }).pipe(Effect.provide(layer));
    },
  );
});
