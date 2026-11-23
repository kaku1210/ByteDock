import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { findLatestTodoListPlan } from "./planStepDurations.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for MCP todo-list updates"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "todo-list-mcp" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

it.effect(
  "thread.todo-list.update persists todo_list plan and turn item, tracks step durations, and reuses idle MCP ids",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const projectId = ProjectId.make("project:todo-list-mcp");
      const threadId = ThreadId.make("thread:todo-list-mcp");

      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd:create"),
        threadId,
        projectId,
        title: "Task list test",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });

      // Idle thread update creates a single runless todo_list plan + turn item.
      yield* orchestrator.dispatch({
        type: "thread.todo-list.update",
        commandId: CommandId.make("cmd:todo:1"),
        threadId,
        explanation: "Idle tasks",
        steps: [
          { id: "task-1", text: "Draft spec", status: "running" },
          { id: "task-2", text: "Verify behavior", status: "pending" },
        ],
      });

      yield* TestClock.adjust("5 seconds");

      // Second idle update reuses the same runless MCP plan/item IDs and records step duration.
      yield* orchestrator.dispatch({
        type: "thread.todo-list.update",
        commandId: CommandId.make("cmd:todo:2"),
        threadId,
        explanation: "Idle tasks",
        steps: [
          { id: "task-1", text: "Draft spec", status: "completed" },
          { id: "task-2", text: "Verify behavior", status: "running" },
        ],
      });

      const afterIdle = yield* projectionStore.getThreadRecords(threadId, ["plans", "turnItems"]);
      const idleTodoPlans = afterIdle.plans.filter((plan) => plan.kind === "todo_list");
      const idleTodoItems = afterIdle.turnItems.filter((item) => item.type === "todo_list");
      assert.strictEqual(idleTodoPlans.length, 1);
      assert.strictEqual(idleTodoItems.length, 1);
      const latestIdlePlan = findLatestTodoListPlan(afterIdle);
      assert.isDefined(latestIdlePlan);
      assert.isNull(latestIdlePlan.runId);
      assert.strictEqual(latestIdlePlan.status, "active");
      assert.strictEqual(latestIdlePlan.steps[0]?.status, "completed");
      assert.strictEqual(latestIdlePlan.steps[0]?.durationMs, 5_000);
      assert.strictEqual(latestIdlePlan.steps[1]?.status, "running");

      // Starting an active run binds subsequent MCP task-list updates to that run and supersedes the idle plan.
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("cmd:dispatch"),
        threadId,
        messageId: MessageId.make("msg:todo-list-mcp:1"),
        text: "Work on the tasks",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const afterDispatch = yield* projectionStore.getThreadRecords(threadId, ["runs"]);
      const runId = afterDispatch.runs[0]?.id;
      assert.isDefined(runId);

      yield* orchestrator.dispatch({
        type: "thread.todo-list.update",
        commandId: CommandId.make("cmd:todo:3"),
        threadId,
        explanation: "Active run checklist",
        steps: [
          { id: "task-1", text: "Draft spec", status: "completed" },
          { id: "task-2", text: "Verify behavior", status: "completed" },
        ],
      });

      const afterRunUpdate = yield* projectionStore.getThreadRecords(threadId, [
        "plans",
        "turnItems",
      ]);
      const supersededPlans = afterRunUpdate.plans.filter(
        (plan) => plan.kind === "todo_list" && plan.status === "superseded",
      );
      assert.strictEqual(supersededPlans.length, 1);
      assert.strictEqual(supersededPlans[0]?.id, latestIdlePlan.id);

      const activePlan = findLatestTodoListPlan(afterRunUpdate);
      assert.isDefined(activePlan);
      assert.strictEqual(activePlan.runId, runId);
      assert.strictEqual(activePlan.status, "completed");
      assert.strictEqual(activePlan.explanation, "Active run checklist");
      assert.deepStrictEqual(
        activePlan.steps.map(({ id, text, status }) => ({ id, text, status })),
        [
          { id: "task-1", text: "Draft spec", status: "completed" },
          { id: "task-2", text: "Verify behavior", status: "completed" },
        ],
      );

      // Clearing supersedes the previous active-run plan with an empty-step snapshot for the same run.
      yield* orchestrator.dispatch({
        type: "thread.todo-list.update",
        commandId: CommandId.make("cmd:todo:4"),
        threadId,
        steps: [],
      });

      const afterClear = yield* projectionStore.getThreadRecords(threadId, ["plans", "turnItems"]);
      assert.isUndefined(findLatestTodoListPlan(afterClear));
      const clearedPlan = afterClear.plans.find(
        (plan) => plan.kind === "todo_list" && String(plan.id) === "plan:mcp:cmd:todo:4",
      );
      assert.isDefined(clearedPlan);
      assert.strictEqual(clearedPlan.kind, "todo_list");
      assert.strictEqual(clearedPlan.runId, runId);
      assert.strictEqual(clearedPlan.status, "superseded");
      if (clearedPlan.kind === "todo_list") {
        assert.deepStrictEqual(clearedPlan.steps, []);
      }
      const clearedItem = afterClear.turnItems.find(
        (item) => item.type === "todo_list" && item.planId === clearedPlan.id,
      );
      assert.isDefined(clearedItem);
      assert.strictEqual(clearedItem.type, "todo_list");
      assert.strictEqual(clearedItem.runId, runId);
      if (clearedItem.type === "todo_list") {
        assert.deepStrictEqual(clearedItem.steps, []);
      }
    }).pipe(Effect.provide(layerTest)),
);
