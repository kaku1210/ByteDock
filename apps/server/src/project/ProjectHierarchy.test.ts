import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";
import * as ProjectService from "./ProjectService.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const layerWorkspacePaths = Layer.succeed(WorkspacePaths.WorkspacePaths, {
  normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot.replace(/\/$/, "")),
  resolveRelativePathWithinRoot: ({ workspaceRoot, relativePath }) =>
    Effect.succeed({ absolutePath: `${workspaceRoot}/${relativePath}`, relativePath }),
});

const layerProjectMetadata = Layer.merge(
  Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
    resolve: () => Effect.succeed(null),
  }),
  Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
    invalidate: () => Effect.void,
    resolvePath: () => Effect.succeed(null),
  }),
);

const layerProjectServiceTest = RuntimeLayer.layerProjectService.pipe(
  Layer.provideMerge(ProjectEnrichmentService.layer),
  Layer.provideMerge(layerWorkspacePaths),
  Layer.provideMerge(layerProjectMetadata),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "project-hierarchy-test-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const createProject = (
  service: ProjectService.ProjectService["Service"],
  input: {
    readonly id: string;
    readonly title: string;
    readonly workspaceRoot: string;
    readonly parentProjectId?: ProjectId | null;
  },
) =>
  service.create({
    commandId: CommandId.make(`cmd:create:${input.id}`),
    projectId: ProjectId.make(input.id),
    title: input.title,
    workspaceRoot: input.workspaceRoot,
    ...(input.parentProjectId !== undefined ? { parentProjectId: input.parentProjectId } : {}),
  });

it.effect(
  "enforces 2-level parent-child project rules and detaches children when deleting a parent",
  () =>
    Effect.gen(function* () {
      const service = yield* ProjectService.ProjectService;
      const config = yield* ServerConfig.ServerConfig;
      const path = yield* Path.Path;

      const parent = yield* createProject(service, {
        id: "game",
        title: "Game",
        workspaceRoot: "/work/game",
      });
      assert.strictEqual(parent.parentProjectId, null);

      const server = yield* createProject(service, {
        id: "game-server",
        title: "Server",
        workspaceRoot: "/work/game/server",
        parentProjectId: parent.id,
      });
      assert.strictEqual(server.parentProjectId, parent.id);

      const client = yield* createProject(service, {
        id: "game-client",
        title: "Client",
        workspaceRoot: "/work/game/client",
        parentProjectId: parent.id,
      });
      assert.strictEqual(client.parentProjectId, parent.id);

      const other = yield* createProject(service, {
        id: "website",
        title: "Website",
        workspaceRoot: "/work/website",
      });

      const scratch = yield* createProject(service, {
        id: "scratch",
        title: "Scratch",
        workspaceRoot: path.join(config.baseDir, "scratch"),
      });

      // Reject grandchild creation (max 2 levels).
      const grandchildExit = yield* Effect.exit(
        createProject(service, {
          id: "game-server-sub",
          title: "Sub",
          workspaceRoot: "/work/game/server/sub",
          parentProjectId: server.id,
        }),
      );
      assert.isTrue(Exit.isFailure(grandchildExit));

      // Reject missing parent.
      const missingParentExit = yield* Effect.exit(
        createProject(service, {
          id: "orphan",
          title: "Orphan",
          workspaceRoot: "/work/orphan",
          parentProjectId: ProjectId.make("does-not-exist"),
        }),
      );
      assert.isTrue(Exit.isFailure(missingParentExit));

      // Reject scratch project as parent.
      const scratchParentExit = yield* Effect.exit(
        createProject(service, {
          id: "under-scratch",
          title: "Under Scratch",
          workspaceRoot: "/work/under-scratch",
          parentProjectId: scratch.id,
        }),
      );
      assert.isTrue(Exit.isFailure(scratchParentExit));

      // Reject self-parenting on update.
      const selfParentExit = yield* Effect.exit(
        service.update({
          commandId: CommandId.make("cmd:self-parent"),
          projectId: other.id,
          parentProjectId: other.id,
        }),
      );
      assert.isTrue(Exit.isFailure(selfParentExit));

      // Reject moving a parent that still has children under another project.
      const parentAsChildExit = yield* Effect.exit(
        service.update({
          commandId: CommandId.make("cmd:parent-as-child"),
          projectId: parent.id,
          parentProjectId: other.id,
        }),
      );
      assert.isTrue(Exit.isFailure(parentAsChildExit));

      // Detach a single child back to top level.
      const promoted = yield* service.update({
        commandId: CommandId.make("cmd:promote-client"),
        projectId: client.id,
        parentProjectId: null,
      });
      assert.strictEqual(promoted.parentProjectId, null);

      // Re-attach client back under parent before deleting parent.
      const reattached = yield* service.update({
        commandId: CommandId.make("cmd:reattach-client"),
        projectId: client.id,
        parentProjectId: parent.id,
      });
      assert.strictEqual(reattached.parentProjectId, parent.id);

      // Deleting the parent detaches children instead of deleting them.
      yield* service.delete({
        commandId: CommandId.make("cmd:delete-parent"),
        projectId: parent.id,
        force: true,
      });

      const serverAfterDelete = Option.getOrThrow(yield* service.getById(server.id));
      const clientAfterDelete = Option.getOrThrow(yield* service.getById(client.id));
      assert.strictEqual(serverAfterDelete.parentProjectId, null);
      assert.strictEqual(clientAfterDelete.parentProjectId, null);
    }).pipe(Effect.provide(layerProjectServiceTest)),
);

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for sidebar metadata routing"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const makeOrchestratorTestLayer = () => {
  const layerDatabase = SqlitePersistence.layerMemory;
  return Layer.mergeAll(
    layerDatabase,
    ProjectStore.layer.pipe(Layer.provide(layerDatabase)),
    ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
    ProviderReplayHarness.layerWithRegistry(
      { name: "sidebar-project-routing" },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      { databaseLayer: layerDatabase, runEffectWorker: false },
    ),
  );
};

const seedProjectRow = (
  projects: ProjectStore.ProjectStoreV2["Service"],
  input: {
    readonly sequence: number;
    readonly projectId: ProjectId;
    readonly title: string;
    readonly workspaceRoot: string;
    readonly parentProjectId?: ProjectId | null;
  },
) =>
  projects.apply({
    sequence: input.sequence,
    eventId: EventId.make(`event:project:${input.projectId}`),
    aggregateKind: "project",
    aggregateId: input.projectId,
    occurredAt: "2026-04-01T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId: input.projectId,
      title: input.title,
      workspaceRoot: input.workspaceRoot,
      defaultModelSelection: null,
      scripts: [],
      ...(input.parentProjectId !== undefined ? { parentProjectId: input.parentProjectId } : {}),
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
    },
  });

it.effect(
  "updates sidebarProjectId within the same parent-child family without mutating projectId, worktree, or updatedAt",
  () =>
    Effect.gen(function* () {
      const projects = yield* ProjectStore.ProjectStoreV2;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;

      const parentId = ProjectId.make("family-game");
      const serverId = ProjectId.make("family-server");
      const clientId = ProjectId.make("family-client");
      const unrelatedId = ProjectId.make("unrelated-web");

      yield* seedProjectRow(projects, {
        sequence: 1,
        projectId: parentId,
        title: "Game",
        workspaceRoot: "/work/game",
      });
      yield* seedProjectRow(projects, {
        sequence: 2,
        projectId: serverId,
        title: "Server",
        workspaceRoot: "/work/game/server",
        parentProjectId: parentId,
      });
      yield* seedProjectRow(projects, {
        sequence: 3,
        projectId: clientId,
        title: "Client",
        workspaceRoot: "/work/game/client",
        parentProjectId: parentId,
      });
      yield* seedProjectRow(projects, {
        sequence: 4,
        projectId: unrelatedId,
        title: "Web",
        workspaceRoot: "/work/web",
      });

      const threadId = ThreadId.make("thread:game-full");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd:create-game-thread"),
        threadId,
        projectId: parentId,
        title: "Full-stack feature",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "feat/sync",
        worktreePath: "/work/game/.worktrees/sync",
        createdBy: "user",
        creationSource: "web",
      });

      const before = yield* projections.getThreadProjection(threadId);
      yield* TestClock.adjust("5 minutes");

      // Move parent thread under child `serverId` in the sidebar only.
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("cmd:sidebar-move-to-server"),
        threadId,
        sidebarProjectId: serverId,
      });

      const afterMoveToServer = yield* projections.getThreadProjection(threadId);
      const shellSnapshot = yield* Effect.flatten(projections.readShellSnapshot());
      const shellAfterMoveToServer = shellSnapshot.threads.find(
        (candidate) => candidate.id === threadId,
      );
      assert.strictEqual(afterMoveToServer.thread.projectId, parentId);
      assert.strictEqual(afterMoveToServer.thread.sidebarProjectId, serverId);
      assert.strictEqual(afterMoveToServer.thread.branch, "feat/sync");
      assert.strictEqual(afterMoveToServer.thread.worktreePath, "/work/game/.worktrees/sync");
      assert.deepStrictEqual(afterMoveToServer.thread.updatedAt, before.thread.updatedAt);
      assert.strictEqual(shellAfterMoveToServer?.projectId, parentId);
      assert.strictEqual(shellAfterMoveToServer?.sidebarProjectId, serverId);

      // Move across siblings (`serverId` -> `clientId`) still stays in family.
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("cmd:sidebar-move-to-client"),
        threadId,
        sidebarProjectId: clientId,
      });
      const afterMoveToClient = yield* projections.getThreadProjection(threadId);
      assert.strictEqual(afterMoveToClient.thread.projectId, parentId);
      assert.strictEqual(afterMoveToClient.thread.sidebarProjectId, clientId);

      // Moving back to its own `projectId` normalizes `sidebarProjectId` to `null`.
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("cmd:sidebar-move-back-to-parent"),
        threadId,
        sidebarProjectId: parentId,
      });
      const afterMoveBack = yield* projections.getThreadProjection(threadId);
      assert.strictEqual(afterMoveBack.thread.sidebarProjectId, null);

      // Reject moving to an unrelated project outside the parent-child family.
      const crossFamilyExit = yield* Effect.exit(
        orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("cmd:sidebar-move-cross-family"),
          threadId,
          sidebarProjectId: unrelatedId,
        }),
      );
      assert.isTrue(Exit.isFailure(crossFamilyExit));

      // Reject setting `sidebarProjectId` on a subagent thread.
      const subagentThreadId = ThreadId.make("thread:game-subagent");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd:create-subagent-thread"),
        threadId: subagentThreadId,
        projectId: parentId,
        title: "Subagent worker",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "agent",
        creationSource: "web",
      });
      const seededSubagent = yield* projections.getThreadProjection(subagentThreadId);
      yield* projections.apply({
        id: EventId.make("event:seed-subagent-lineage"),
        type: "thread.metadata-updated",
        threadId: subagentThreadId,
        providerInstanceId: seededSubagent.thread.providerInstanceId,
        occurredAt: seededSubagent.thread.updatedAt,
        payload: {
          ...seededSubagent.thread,
          lineage: {
            parentThreadId: threadId,
            rootThreadId: threadId,
            relationshipToParent: "subagent",
          },
        },
      });
      const subagentMoveExit = yield* Effect.exit(
        orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("cmd:sidebar-move-subagent"),
          threadId: subagentThreadId,
          sidebarProjectId: serverId,
        }),
      );
      assert.isTrue(Exit.isFailure(subagentMoveExit));

      // Full project move (`thread.project.move`) clears `sidebarProjectId`.
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("cmd:sidebar-move-before-full-move"),
        threadId,
        sidebarProjectId: serverId,
      });
      yield* orchestrator.dispatch({
        type: "thread.project.move",
        commandId: CommandId.make("cmd:full-project-move"),
        threadId,
        expectedProjectId: parentId,
        targetProjectId: unrelatedId,
        sourceFolderPath: "/workspaces/game",
        movedFolderPath: "/workspaces/other",
      });
      const afterFullMove = yield* projections.getThreadProjection(threadId);
      assert.strictEqual(afterFullMove.thread.projectId, unrelatedId);
      assert.strictEqual(afterFullMove.thread.sidebarProjectId, null);
    }).pipe(Effect.provide(makeOrchestratorTestLayer())),
);
