import {
  FamilyCollaborationOverviewError,
  IsoDateTime,
  isOrchestrationV2WorkActive,
  isTaskChildLineage,
  type FamilyCollaborationBlockingKind,
  type FamilyCollaborationDeliveryStatus,
  type FamilyCollaborationDigest,
  type FamilyCollaborationGetOverviewInput,
  type FamilyCollaborationNode,
  type FamilyCollaborationNodeKind,
  type FamilyCollaborationOverview,
  type FamilyCollaborationRemoteChild,
  type FamilyCollaborationSessionStatus,
  type FamilyCollaborationSideChatSummary,
  type FamilyCollaborationTaskStatus,
  type OrchestrationV2ContextTransfer,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadShell,
  type SharedWorktreeCoordinationSnapshot,
  type SubtaskEscalationRequest,
  type ThreadId,
  type WorktreeApprovalRequest,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectionStore from "./ProjectionStore.ts";
import * as SharedWorktreeCoordinationService from "./SharedWorktreeCoordinationService.ts";
import * as SubtaskEscalationService from "./SubtaskEscalationService.ts";
import * as WorktreeApprovalService from "./WorktreeApprovalService.ts";

const MAX_ARTIFACT_SUMMARY_CHARS = 220;

const ACTIVE_RUN_STATUSES = new Set<OrchestrationV2Run["status"]>([
  "preparing",
  "starting",
  "running",
  "waiting",
]);

interface ThreadDetailRecords {
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly subagents: ReadonlyArray<OrchestrationV2Subagent>;
  readonly runtimeRequests: ReadonlyArray<OrchestrationV2RuntimeRequest>;
  readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
  readonly contextTransfers: ReadonlyArray<OrchestrationV2ContextTransfer>;
}

const EMPTY_RECORDS: ThreadDetailRecords = {
  runs: [],
  subagents: [],
  runtimeRequests: [],
  messages: [],
  contextTransfers: [],
};

function toNonNegativeInt(value: number): number {
  return Math.max(0, Math.floor(value));
}

function toIsoDateTime(value: DateTime.Utc): IsoDateTime {
  return IsoDateTime.make(DateTime.formatIso(value));
}

function summarizeText(
  raw: string | null | undefined,
  maxLength = MAX_ARTIFACT_SUMMARY_CHARS,
): string | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  const normalized = raw.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return null;
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function effectiveCheckoutKey(worktreePath: string | null): string {
  return worktreePath ?? "__project_root__";
}

function sortShellsStable(
  shells: ReadonlyArray<OrchestrationV2ThreadShell>,
): ReadonlyArray<OrchestrationV2ThreadShell> {
  return [...shells].sort((left, right) => {
    const leftEpoch = DateTime.toEpochMillis(left.createdAt);
    const rightEpoch = DateTime.toEpochMillis(right.createdAt);
    if (leftEpoch !== rightEpoch) {
      return leftEpoch - rightEpoch;
    }
    return left.id.localeCompare(right.id);
  });
}

function latestRunOf(runs: ReadonlyArray<OrchestrationV2Run>): OrchestrationV2Run | null {
  if (runs.length === 0) {
    return null;
  }
  let latest: OrchestrationV2Run = runs[0]!;
  for (let index = 1; index < runs.length; index += 1) {
    const candidate = runs[index]!;
    const latestEpoch = DateTime.toEpochMillis(latest.requestedAt);
    const candidateEpoch = DateTime.toEpochMillis(candidate.requestedAt);
    if (
      candidateEpoch > latestEpoch ||
      (candidateEpoch === latestEpoch && candidate.id.localeCompare(latest.id) > 0)
    ) {
      latest = candidate;
    }
  }
  return latest;
}

function latestActiveRunOf(
  shell: OrchestrationV2ThreadShell,
  runs: ReadonlyArray<OrchestrationV2Run>,
): OrchestrationV2Run | null {
  if (shell.activeRunId !== null) {
    const byActiveId = runs.find((run) => run.id === shell.activeRunId);
    if (byActiveId !== undefined && ACTIVE_RUN_STATUSES.has(byActiveId.status)) {
      return byActiveId;
    }
  }
  const activeRuns = runs.filter((run) => ACTIVE_RUN_STATUSES.has(run.status));
  return latestRunOf(activeRuns);
}

function latestPendingRuntimeRequestOf(
  shell: OrchestrationV2ThreadShell,
  requests: ReadonlyArray<OrchestrationV2RuntimeRequest>,
): {
  readonly kind: OrchestrationV2RuntimeRequest["kind"];
  readonly blocking: boolean;
} | null {
  const pendingFromRecords = requests
    .filter((req) => req.status === "pending")
    .sort(
      (left, right) =>
        DateTime.toEpochMillis(right.createdAt) - DateTime.toEpochMillis(left.createdAt),
    );
  const firstRecord = pendingFromRecords[0];
  if (firstRecord !== undefined) {
    const shellPending =
      shell.pendingRuntimeRequest?.id === firstRecord.id ? shell.pendingRuntimeRequest : null;
    return {
      kind: firstRecord.kind,
      blocking: shellPending?.blocking ?? true,
    };
  }
  if (shell.pendingRuntimeRequest !== null) {
    return {
      kind: shell.pendingRuntimeRequest.kind,
      blocking: shell.pendingRuntimeRequest.blocking ?? true,
    };
  }
  return null;
}

function resolveSessionStatus(input: {
  readonly shell: OrchestrationV2ThreadShell;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly activeRun: OrchestrationV2Run | null;
  readonly queuedRuns: ReadonlyArray<OrchestrationV2Run>;
  readonly latestRun: OrchestrationV2Run | null;
  readonly pendingRequest: {
    readonly kind: OrchestrationV2RuntimeRequest["kind"];
    readonly blocking: boolean;
  } | null;
}): FamilyCollaborationSessionStatus {
  const { shell, runs, activeRun, queuedRuns, latestRun, pendingRequest } = input;
  if (shell.archivedAt !== null) {
    return "archived";
  }
  if (pendingRequest !== null) {
    return pendingRequest.kind === "user_input" ? "waiting_input" : "waiting_approval";
  }
  const hasHeldQueue = queuedRuns.some((run) => run.queueHeld === true);
  if (activeRun === null && queuedRuns.length > 0 && hasHeldQueue) {
    return "queue_paused";
  }
  if (
    activeRun !== null ||
    shell.activityRunStatus !== null ||
    shell.status === "preparing" ||
    shell.status === "starting" ||
    shell.status === "running" ||
    shell.status === "waiting"
  ) {
    return "running";
  }
  if (shell.status === "failed" || latestRun?.status === "failed") {
    return "error";
  }
  if (
    runs.length === 0 &&
    shell.latestRunId === null &&
    (isTaskChildLineage(shell.lineage) || shell.lineage.relationshipToParent === "fork")
  ) {
    return "awaiting_initial_send";
  }
  return "idle";
}

function resolveBlockingState(input: {
  readonly shell: OrchestrationV2ThreadShell;
  readonly activeRun: OrchestrationV2Run | null;
  readonly queuedRuns: ReadonlyArray<OrchestrationV2Run>;
  readonly pendingRequest: {
    readonly kind: OrchestrationV2RuntimeRequest["kind"];
    readonly blocking: boolean;
  } | null;
  readonly pendingWorktreeApprovals: ReadonlyArray<WorktreeApprovalRequest>;
  readonly sharedWorktree: SharedWorktreeCoordinationSnapshot | null;
}): {
  readonly blockingKind: FamilyCollaborationBlockingKind | null;
  readonly blockingReason: string | null;
} {
  const { shell, activeRun, queuedRuns, pendingRequest, pendingWorktreeApprovals, sharedWorktree } =
    input;

  const pendingWorktreeForChild = pendingWorktreeApprovals.find(
    (approval) => approval.status === "pending" && approval.childThreadId === shell.id,
  );
  if (pendingWorktreeForChild !== undefined) {
    const branchLabel =
      pendingWorktreeForChild.branch !== null ? ` (${pendingWorktreeForChild.branch})` : "";
    return {
      blockingKind: "worktree_approval",
      blockingReason: `Waiting for human approval to create isolated worktree${branchLabel}.`,
    };
  }

  if (pendingRequest !== null && pendingRequest.blocking) {
    if (pendingRequest.kind === "user_input") {
      return {
        blockingKind: "user_input",
        blockingReason: "Waiting for user input before continuing.",
      };
    }
    return {
      blockingKind: "approval",
      blockingReason: `Waiting for runtime approval (${pendingRequest.kind}).`,
    };
  }

  const waitingReservation = sharedWorktree?.waitingReservations.find(
    (reservation) => reservation.threadId === shell.id,
  );
  if (waitingReservation !== undefined) {
    const pathPreview = waitingReservation.paths.slice(0, 2).join(", ");
    const extraCount = waitingReservation.paths.length - 2;
    const suffix = extraCount > 0 ? ` (+${extraCount} more)` : "";
    return {
      blockingKind: "write_lock",
      blockingReason: `Waiting for shared worktree write lock on ${pathPreview}${suffix}.`,
    };
  }

  const waitingSerialized = sharedWorktree?.waitingSerializedRuns.some(
    (entry) => entry.threadId === shell.id,
  );
  if (waitingSerialized === true) {
    return {
      blockingKind: "checkout_serialization",
      blockingReason: "Waiting in serialized checkout write queue.",
    };
  }

  if (shell.blockedOnThreadWait === true) {
    return {
      blockingKind: "thread_wait",
      blockingReason: "Waiting for delegated child task(s) to finish.",
    };
  }

  if (activeRun === null && queuedRuns.some((run) => run.queueHeld === true)) {
    return {
      blockingKind: "queue_paused",
      blockingReason: "Queue is paused; review and resume in thread.",
    };
  }

  return {
    blockingKind: null,
    blockingReason: null,
  };
}

function resolveTaskStatus(input: {
  readonly shell: OrchestrationV2ThreadShell;
  readonly activeRun: OrchestrationV2Run | null;
  readonly queuedRuns: ReadonlyArray<OrchestrationV2Run>;
  readonly latestRun: OrchestrationV2Run | null;
  readonly parentSubagent: OrchestrationV2Subagent | null;
  readonly blockingKind: FamilyCollaborationBlockingKind | null;
}): FamilyCollaborationTaskStatus {
  const { shell, activeRun, queuedRuns, latestRun, parentSubagent, blockingKind } = input;
  if (blockingKind !== null) {
    return "blocked";
  }
  if (activeRun !== null || shell.activityRunStatus !== null) {
    return "running";
  }
  if (queuedRuns.length > 0) {
    return "queued";
  }
  if (latestRun !== null) {
    switch (latestRun.status) {
      case "completed":
        return "completed";
      case "failed":
        return "failed";
      case "cancelled":
        return "cancelled";
      case "interrupted":
      case "rolled_back":
        return "interrupted";
      case "queued":
        return "queued";
      default:
        return "running";
    }
  }
  if (parentSubagent !== null) {
    switch (parentSubagent.status) {
      case "completed":
        return "completed";
      case "failed":
        return "failed";
      case "cancelled":
        return "cancelled";
      case "interrupted":
        return "interrupted";
      case "running":
      case "waiting":
        return "running";
      case "pending":
        return "queued";
      case "idle":
        return "draft";
    }
  }
  if (isTaskChildLineage(shell.lineage) || shell.lineage.relationshipToParent === "fork") {
    return "draft";
  }
  return "none";
}

function resolveDeliveryMetrics(input: {
  readonly shell: OrchestrationV2ThreadShell;
  readonly rootThreadId: ThreadId;
  readonly taskStatus: FamilyCollaborationTaskStatus;
  readonly parentSubagent: OrchestrationV2Subagent | null;
  readonly parentTransfers: ReadonlyArray<OrchestrationV2ContextTransfer>;
}): {
  readonly deliveryStatus: FamilyCollaborationDeliveryStatus;
  readonly delegatedDeliveryState: FamilyCollaborationNode["delegatedDeliveryState"];
  readonly pendingMergeBackCount: number;
  readonly boundMergeBackCount: number;
  readonly deliveredMergeBackCount: number;
  readonly interimReportCount: number;
  readonly finalReportCount: number;
} {
  const { shell, rootThreadId, taskStatus, parentSubagent, parentTransfers } = input;

  let pendingMergeBack = 0;
  let boundMergeBack = 0;
  let deliveredMergeBack = 0;
  let hasSupersededMergeBack = false;
  let interimReports = 0;
  let finalReports = 0;

  for (const transfer of parentTransfers) {
    if (transfer.sourceThreadId !== shell.id) {
      continue;
    }
    if (transfer.type === "merge_back") {
      if (transfer.status === "pending") {
        pendingMergeBack += 1;
      } else if (transfer.status === "bound") {
        boundMergeBack += 1;
      } else if (
        transfer.status === "consumed" ||
        transfer.status === "resolved_native" ||
        transfer.status === "resolved_portable"
      ) {
        deliveredMergeBack += 1;
      } else if (transfer.status === "superseded") {
        hasSupersededMergeBack = true;
      }
    } else if (transfer.type === "subagent_result") {
      if (transfer.status === "failed" || transfer.status === "superseded") {
        continue;
      }
      if (transfer.reportKind === "interim") {
        interimReports += 1;
      } else {
        finalReports += 1;
      }
    }
  }

  const delegatedDeliveryState = parentSubagent?.completionDelivery?.state ?? null;

  let deliveryStatus: FamilyCollaborationDeliveryStatus;
  if (shell.id === rootThreadId) {
    deliveryStatus = "none";
  } else if (boundMergeBack > 0) {
    deliveryStatus = "bound_merge_back";
  } else if (pendingMergeBack > 0) {
    deliveryStatus = "pending_merge_back";
  } else if (delegatedDeliveryState === "acknowledged") {
    deliveryStatus = "acknowledged";
  } else if (delegatedDeliveryState === "delivered") {
    deliveryStatus = "delivered";
  } else if (delegatedDeliveryState === "pending" || delegatedDeliveryState === "claimed") {
    deliveryStatus =
      interimReports > 0 &&
      taskStatus !== "completed" &&
      taskStatus !== "failed" &&
      taskStatus !== "cancelled"
        ? "interim_reported"
        : "awaiting_delivery";
  } else if (delegatedDeliveryState === "disposed") {
    deliveryStatus = "superseded";
  } else if (finalReports > 0 || deliveredMergeBack > 0) {
    deliveryStatus = "delivered";
  } else if (interimReports > 0) {
    deliveryStatus = "interim_reported";
  } else if (taskStatus === "completed") {
    deliveryStatus = "awaiting_delivery";
  } else if (hasSupersededMergeBack) {
    deliveryStatus = "superseded";
  } else {
    deliveryStatus = "none";
  }

  return {
    deliveryStatus,
    delegatedDeliveryState,
    pendingMergeBackCount: toNonNegativeInt(pendingMergeBack),
    boundMergeBackCount: toNonNegativeInt(boundMergeBack),
    deliveredMergeBackCount: toNonNegativeInt(deliveredMergeBack),
    interimReportCount: toNonNegativeInt(interimReports),
    finalReportCount: toNonNegativeInt(finalReports),
  };
}

function resolveLatestArtifactSummary(input: {
  readonly shell: OrchestrationV2ThreadShell;
  readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
  readonly parentSubagent: OrchestrationV2Subagent | null;
}): string | null {
  const { shell, messages, parentSubagent } = input;
  const assistantMessages = messages
    .filter((message) => message.role === "assistant" && message.text.trim().length > 0)
    .sort(
      (left, right) =>
        DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
    );
  const latestAssistant = assistantMessages[0];
  if (latestAssistant !== undefined) {
    return summarizeText(latestAssistant.text);
  }
  if (
    shell.latestVisibleMessage !== null &&
    shell.latestVisibleMessage.role === "assistant" &&
    shell.latestVisibleMessage.text.trim().length > 0
  ) {
    return summarizeText(shell.latestVisibleMessage.text);
  }
  const subagentResult = summarizeText(parentSubagent?.result);
  if (subagentResult !== null) {
    return subagentResult;
  }
  if (
    shell.lastError !== null &&
    shell.lastError !== undefined &&
    shell.lastError.trim().length > 0
  ) {
    return summarizeText(`Error: ${shell.lastError}`);
  }
  return null;
}

function resolveNodeKind(
  shell: OrchestrationV2ThreadShell,
  rootThreadId: ThreadId,
): FamilyCollaborationNodeKind {
  if (shell.id === rootThreadId) {
    return "root";
  }
  if (shell.lineage.sideChat === true) {
    return "side_chat";
  }
  if (shell.lineage.relationshipToParent === "fork") {
    return "fork";
  }
  return "subtask";
}

function findParentSubagent(
  parentRecords: ThreadDetailRecords | undefined,
  childThreadId: ThreadId,
): OrchestrationV2Subagent | null {
  if (parentRecords === undefined) {
    return null;
  }
  const matches = parentRecords.subagents.filter(
    (subagent) => subagent.childThreadId === childThreadId,
  );
  if (matches.length === 0) {
    return null;
  }
  return matches[matches.length - 1] ?? null;
}

function buildRemoteChildren(
  subagents: ReadonlyArray<OrchestrationV2Subagent>,
): ReadonlyArray<FamilyCollaborationRemoteChild> {
  const results: Array<FamilyCollaborationRemoteChild> = [];
  for (const subagent of subagents) {
    if (subagent.remoteChild === undefined) {
      continue;
    }
    results.push({
      subagentId: subagent.id,
      title: subagent.title ?? subagent.remoteChild.title ?? subagent.remoteChild.label,
      status: subagent.status,
      targetEnvironmentId: subagent.remoteChild.environmentId,
      remoteThreadId: subagent.remoteChild.threadId,
      deliveryState: subagent.completionDelivery?.state ?? null,
    });
  }
  return results;
}

function buildDigest(input: {
  readonly rootThreadId: ThreadId;
  readonly nodes: ReadonlyArray<FamilyCollaborationNode>;
  readonly sideChats: ReadonlyArray<FamilyCollaborationSideChatSummary>;
  readonly pendingEscalations: FamilyCollaborationOverview["pendingEscalations"];
  readonly pendingWorktreeApprovals: FamilyCollaborationOverview["pendingWorktreeApprovals"];
  readonly sharedWorktree: SharedWorktreeCoordinationSnapshot | null;
}): FamilyCollaborationDigest {
  const {
    rootThreadId,
    nodes,
    sideChats,
    pendingEscalations,
    pendingWorktreeApprovals,
    sharedWorktree,
  } = input;

  let l0Count = 0;
  let l1Count = 0;
  let l2Count = 0;
  let remoteCount = 0;
  let runningCount = 0;
  let blockedCount = 0;
  let awaitingInitialSendCount = 0;
  let completedCount = 0;
  let failedCount = 0;
  let pendingDeliveryCount = 0;
  let pendingMergeBackCount = 0;

  for (const node of nodes) {
    if (node.depth === 0) {
      l0Count += 1;
    } else if (node.depth === 1) {
      l1Count += 1;
    } else {
      l2Count += 1;
    }
    remoteCount += node.remoteChildren.length;
    if (node.taskStatus === "running" || node.taskStatus === "queued") {
      runningCount += 1;
    } else if (node.taskStatus === "blocked") {
      blockedCount += 1;
    } else if (node.taskStatus === "completed") {
      completedCount += 1;
    } else if (node.taskStatus === "failed") {
      failedCount += 1;
    }
    if (node.sessionStatus === "awaiting_initial_send") {
      awaitingInitialSendCount += 1;
    }
    if (
      node.deliveryStatus === "awaiting_delivery" ||
      node.deliveryStatus === "pending_merge_back" ||
      node.deliveryStatus === "bound_merge_back"
    ) {
      pendingDeliveryCount += 1;
    }
    pendingMergeBackCount += node.pendingMergeBackCount + node.boundMergeBackCount;
  }

  for (const sideChat of sideChats) {
    pendingMergeBackCount += sideChat.pendingMergeBackCount + sideChat.boundMergeBackCount;
  }

  const overlapCount = sharedWorktree?.overlaps.length ?? 0;
  const observedUnverifiedCount = sharedWorktree?.observedUnverifiedPaths.length ?? 0;

  const highlights: Array<string> = [];
  for (const node of nodes) {
    if (node.taskStatus === "blocked") {
      highlights.push(
        `[L${node.depth}] ${node.title} is blocked: ${node.blockingReason ?? node.blockingKind ?? "pending action"}`,
      );
    } else if (node.deliveryStatus === "awaiting_delivery") {
      highlights.push(
        `[L${node.depth}] ${node.title} finished work and has undelivered results awaiting parent handoff.`,
      );
    } else if (node.sessionStatus === "awaiting_initial_send") {
      highlights.push(`[L${node.depth}] ${node.title} is a draft awaiting initial human send.`);
    }
  }
  if (overlapCount > 0) {
    highlights.push(
      `Shared worktree has ${overlapCount} overlapping file path conflict(s) across concurrent threads.`,
    );
  }
  if (observedUnverifiedCount > 0) {
    highlights.push(
      `Shared worktree detected ${observedUnverifiedCount} unverified/external modified file(s).`,
    );
  }
  if (pendingEscalations.length > 0) {
    highlights.push(
      `${pendingEscalations.length} L1 horizontal escalation request(s) pending resolution at root.`,
    );
  }
  if (pendingWorktreeApprovals.length > 0) {
    highlights.push(
      `${pendingWorktreeApprovals.length} AI isolated worktree request(s) awaiting human approval.`,
    );
  }

  const rootTitle = nodes.find((node) => node.threadId === rootThreadId)?.title ?? rootThreadId;
  const lines: Array<string> = [
    `# Collaboration Overview: ${rootTitle}`,
    "",
    `- Read-only snapshot (does not acknowledge delegated deliveries or mutate queues).`,
    `- Topology: L0=${l0Count}, L1=${l1Count}, L2=${l2Count}, Side Chats=${sideChats.length}, Remote=${remoteCount}`,
    `- Execution: Running/Queued=${runningCount}, Blocked=${blockedCount}, Draft=${awaitingInitialSendCount}, Completed=${completedCount}, Failed=${failedCount}`,
    `- Handoff & Governance: Pending Delivery=${pendingDeliveryCount}, Pending/Bound Merge-Back=${pendingMergeBackCount}, Pending Escalations=${pendingEscalations.length}, Pending Worktree Approvals=${pendingWorktreeApprovals.length}`,
  ];
  if (overlapCount > 0 || observedUnverifiedCount > 0) {
    lines.push(
      `- Shared Worktree: Overlaps=${overlapCount}, Observed Unverified=${observedUnverifiedCount}`,
    );
  }
  if (highlights.length > 0) {
    lines.push("", "## Highlights");
    for (const highlight of highlights) {
      lines.push(`- ${highlight}`);
    }
  }
  lines.push("", "## Task Tree");
  for (const node of nodes) {
    const indent = "  ".repeat(node.depth);
    const modelLabel = `${node.modelSelection.instanceId}/${node.modelSelection.model}`;
    const statusTuple = `session=${node.sessionStatus} | task=${node.taskStatus} | delivery=${node.deliveryStatus}`;
    const extra = node.blockingReason !== null ? ` (${node.blockingReason})` : "";
    lines.push(
      `${indent}- [L${node.depth}] **${node.title}** (${modelLabel}): ${statusTuple}${extra}`,
    );
    if (node.latestArtifactSummary !== null) {
      lines.push(`${indent}  - Latest: ${node.latestArtifactSummary}`);
    }
  }

  return {
    l0Count: toNonNegativeInt(l0Count),
    l1Count: toNonNegativeInt(l1Count),
    l2Count: toNonNegativeInt(l2Count),
    sideChatCount: toNonNegativeInt(sideChats.length),
    remoteCount: toNonNegativeInt(remoteCount),
    runningCount: toNonNegativeInt(runningCount),
    blockedCount: toNonNegativeInt(blockedCount),
    awaitingInitialSendCount: toNonNegativeInt(awaitingInitialSendCount),
    completedCount: toNonNegativeInt(completedCount),
    failedCount: toNonNegativeInt(failedCount),
    pendingDeliveryCount: toNonNegativeInt(pendingDeliveryCount),
    pendingMergeBackCount: toNonNegativeInt(pendingMergeBackCount),
    pendingEscalationCount: toNonNegativeInt(pendingEscalations.length),
    pendingWorktreeApprovalCount: toNonNegativeInt(pendingWorktreeApprovals.length),
    overlapCount: toNonNegativeInt(overlapCount),
    observedUnverifiedCount: toNonNegativeInt(observedUnverifiedCount),
    highlights,
    markdownDigest: lines.join("\n"),
  };
}

export interface FamilyCollaborationOverviewServiceShape {
  readonly getOverview: (
    input: FamilyCollaborationGetOverviewInput,
  ) => Effect.Effect<FamilyCollaborationOverview, FamilyCollaborationOverviewError>;
}

export class FamilyCollaborationOverviewService extends Context.Service<
  FamilyCollaborationOverviewService,
  FamilyCollaborationOverviewServiceShape
>()("t3/orchestration-v2/FamilyCollaborationOverviewService") {}

export const layer: Layer.Layer<
  FamilyCollaborationOverviewService,
  never,
  ProjectionStore.ProjectionStoreV2
> = Layer.effect(
  FamilyCollaborationOverviewService,
  Effect.gen(function* () {
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const escalationServiceOption = yield* Effect.serviceOption(
      SubtaskEscalationService.SubtaskEscalationService,
    );
    const worktreeApprovalServiceOption = yield* Effect.serviceOption(
      WorktreeApprovalService.WorktreeApprovalService,
    );
    const sharedWorktreeServiceOption = yield* Effect.serviceOption(
      SharedWorktreeCoordinationService.SharedWorktreeCoordinationService,
    );

    const getOverview: FamilyCollaborationOverviewServiceShape["getOverview"] = Effect.fn(
      "FamilyCollaborationOverviewService.getOverview",
    )(function* (input) {
      // Strictly read-only: only query projection readers and read-only coordination snapshots.
      // Never dispatch commands or acknowledge delegated task completion deliveries.
      const shellSnapshot = yield* projectionStore
        .getShellSnapshot({ familyOf: input.threadId })
        .pipe(
          Effect.mapError(
            (cause) =>
              new FamilyCollaborationOverviewError({
                reason: "load_failed",
                detail: cause.message,
                cause,
              }),
          ),
        );

      const requestedShell = shellSnapshot.threads.find((thread) => thread.id === input.threadId);
      if (requestedShell === undefined) {
        return yield* new FamilyCollaborationOverviewError({
          reason: "thread_not_found",
          detail: `Thread ${input.threadId} was not found or has been deleted.`,
        });
      }

      const rootThreadId = requestedShell.lineage.rootThreadId;
      const projectId = requestedShell.projectId;
      const shells = shellSnapshot.threads;
      const shellById = new Map<ThreadId, OrchestrationV2ThreadShell>(
        shells.map((shell) => [shell.id, shell] as const),
      );

      const recordEntries = yield* Effect.forEach(
        shells,
        (shell) =>
          projectionStore
            .getThreadRecords(shell.id, [
              "runs",
              "subagents",
              "runtimeRequests",
              "messages",
              "contextTransfers",
            ])
            .pipe(
              Effect.map((records): readonly [ThreadId, ThreadDetailRecords] => [
                shell.id,
                {
                  runs: records.runs,
                  subagents: records.subagents,
                  runtimeRequests: records.runtimeRequests,
                  messages: records.messages,
                  contextTransfers: records.contextTransfers,
                },
              ]),
              Effect.catchTags({
                ProjectionStoreThreadNotFoundError: () =>
                  Effect.succeed([shell.id, EMPTY_RECORDS] as const),
              }),
            ),
        { concurrency: 8 },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new FamilyCollaborationOverviewError({
              reason: "load_failed",
              detail: cause.message,
              cause,
            }),
        ),
      );

      const recordsByThreadId = new Map<ThreadId, ThreadDetailRecords>(recordEntries);

      const pendingEscalationsRaw: ReadonlyArray<SubtaskEscalationRequest> = Option.isSome(
        escalationServiceOption,
      )
        ? yield* escalationServiceOption.value
            .listForThread(rootThreadId)
            .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<SubtaskEscalationRequest>))
        : [];

      const pendingWorktreeApprovalsRaw: ReadonlyArray<WorktreeApprovalRequest> = Option.isSome(
        worktreeApprovalServiceOption,
      )
        ? yield* Effect.forEach(
            shells,
            (shell) => worktreeApprovalServiceOption.value.listForThread(shell.id),
            { concurrency: 8 },
          ).pipe(
            Effect.map((lists) => {
              const deduped = new Map<string, WorktreeApprovalRequest>();
              for (const list of lists) {
                for (const request of list) {
                  if (request.status === "pending") {
                    deduped.set(request.requestId, request);
                  }
                }
              }
              return [...deduped.values()].sort((left, right) =>
                left.createdAt.localeCompare(right.createdAt),
              );
            }),
          )
        : [];

      const sharedWorktreeSnapshot: SharedWorktreeCoordinationSnapshot | null = Option.isSome(
        sharedWorktreeServiceOption,
      )
        ? yield* sharedWorktreeServiceOption.value
            .getSnapshot(shellById.has(rootThreadId) ? rootThreadId : input.threadId)
            .pipe(Effect.orElseSucceed(() => null))
        : null;

      const sideChatShells = shells
        .filter((shell) => shell.lineage.sideChat === true)
        .sort(
          (left, right) =>
            DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
        );

      const treeShells = shells.filter((shell) => shell.lineage.sideChat !== true);
      const treeShellById = new Map<ThreadId, OrchestrationV2ThreadShell>(
        treeShells.map((shell) => [shell.id, shell] as const),
      );

      const checkoutCounts = new Map<string, number>();
      for (const shell of treeShells) {
        const key = effectiveCheckoutKey(shell.worktreePath);
        checkoutCounts.set(key, (checkoutCounts.get(key) ?? 0) + 1);
      }

      const childrenByParent = new Map<ThreadId, Array<OrchestrationV2ThreadShell>>();
      const topLevelShells: Array<OrchestrationV2ThreadShell> = [];

      for (const shell of sortShellsStable(treeShells)) {
        if (shell.id === rootThreadId) {
          topLevelShells.unshift(shell);
          continue;
        }
        const rawParent = shell.lineage.parentThreadId;
        const resolvedParent =
          rawParent !== null && treeShellById.has(rawParent)
            ? rawParent
            : treeShellById.has(rootThreadId)
              ? rootThreadId
              : null;
        if (resolvedParent === null || resolvedParent === shell.id) {
          topLevelShells.push(shell);
          continue;
        }
        const bucket = childrenByParent.get(resolvedParent);
        if (bucket === undefined) {
          childrenByParent.set(resolvedParent, [shell]);
        } else {
          bucket.push(shell);
        }
      }

      const orderedTreeEntries: Array<{
        readonly shell: OrchestrationV2ThreadShell;
        readonly depth: number;
      }> = [];
      const visited = new Set<ThreadId>();

      const visitTree = (shell: OrchestrationV2ThreadShell, depth: number): void => {
        if (visited.has(shell.id)) {
          return;
        }
        visited.add(shell.id);
        orderedTreeEntries.push({ shell, depth });
        const children = childrenByParent.get(shell.id);
        if (children === undefined) {
          return;
        }
        for (const child of children) {
          visitTree(child, depth + 1);
        }
      };

      for (const top of topLevelShells) {
        visitTree(top, top.id === rootThreadId ? 0 : 1);
      }
      for (const shell of sortShellsStable(treeShells)) {
        if (!visited.has(shell.id)) {
          visitTree(shell, 1);
        }
      }

      const rootShell = shellById.get(rootThreadId);
      const rootRecords = recordsByThreadId.get(rootThreadId) ?? EMPTY_RECORDS;

      const nodes: Array<FamilyCollaborationNode> = orderedTreeEntries.map(({ shell, depth }) => {
        const records = recordsByThreadId.get(shell.id) ?? EMPTY_RECORDS;
        const parentThreadId = shell.id === rootThreadId ? null : shell.lineage.parentThreadId;
        const parentShell =
          parentThreadId !== null ? (shellById.get(parentThreadId) ?? rootShell) : undefined;
        const parentRecords =
          parentThreadId !== null ? recordsByThreadId.get(parentThreadId) : undefined;

        const parentSubagent = findParentSubagent(parentRecords, shell.id);
        const activeRun = latestActiveRunOf(shell, records.runs);
        const queuedRuns = records.runs.filter((run) => run.status === "queued");
        const latestRun = latestRunOf(records.runs);
        const pendingRequest = latestPendingRuntimeRequestOf(shell, records.runtimeRequests);

        const sessionStatus = resolveSessionStatus({
          shell,
          runs: records.runs,
          activeRun,
          queuedRuns,
          latestRun,
          pendingRequest,
        });

        const { blockingKind, blockingReason } = resolveBlockingState({
          shell,
          activeRun,
          queuedRuns,
          pendingRequest,
          pendingWorktreeApprovals: pendingWorktreeApprovalsRaw,
          sharedWorktree: sharedWorktreeSnapshot,
        });

        const taskStatus = resolveTaskStatus({
          shell,
          activeRun,
          queuedRuns,
          latestRun,
          parentSubagent,
          blockingKind,
        });

        const parentTransfers =
          parentThreadId === null
            ? []
            : parentRecords !== undefined && parentThreadId !== rootThreadId
              ? [...parentRecords.contextTransfers, ...rootRecords.contextTransfers]
              : (parentRecords?.contextTransfers ?? rootRecords.contextTransfers);

        const delivery = resolveDeliveryMetrics({
          shell,
          rootThreadId,
          taskStatus,
          parentSubagent,
          parentTransfers,
        });

        const attribution = sharedWorktreeSnapshot?.threads.find(
          (entry) => entry.threadId === shell.id,
        );
        const plannedPaths = attribution?.plannedPaths.map((entry) => entry.normalizedPath) ?? [];
        const confirmedWritePaths =
          attribution?.confirmedWritePaths.map((entry) => entry.normalizedPath) ?? [];
        const activeReservationPaths = [
          ...new Set(
            (sharedWorktreeSnapshot?.activeReservations ?? [])
              .filter((reservation) => reservation.threadId === shell.id)
              .flatMap((reservation) => reservation.paths),
          ),
        ];
        const hasPathOverlap =
          sharedWorktreeSnapshot?.overlaps.some((overlap) =>
            overlap.participants.some((participant) => participant.threadId === shell.id),
          ) ?? false;

        const checkoutKey = effectiveCheckoutKey(shell.worktreePath);
        const usesSharedWorktree =
          shell.id === rootThreadId
            ? (checkoutCounts.get(checkoutKey) ?? 0) > 1
            : parentShell !== undefined
              ? checkoutKey === effectiveCheckoutKey(parentShell.worktreePath)
              : false;

        const hasActiveDelegation =
          parentSubagent !== null && isOrchestrationV2WorkActive(parentSubagent.status);
        const hasUnheldQueuedRun = queuedRuns.some((run) => run.queueHeld !== true);
        const canStop =
          shell.archivedAt === null &&
          (activeRun !== null ||
            hasUnheldQueuedRun ||
            shell.activityRunStatus !== null ||
            hasActiveDelegation);

        const settled = shell.settledOverride === "settled" || shell.settledAt !== null;

        return {
          threadId: shell.id,
          parentThreadId,
          rootThreadId,
          depth: toNonNegativeInt(depth),
          nodeKind: resolveNodeKind(shell, rootThreadId),
          createdBy: shell.createdBy,
          title: shell.title,
          modelSelection: shell.modelSelection,
          runtimeMode: shell.runtimeMode,
          interactionMode: shell.interactionMode,
          ...(shell.coordinatorMode === undefined
            ? {}
            : { coordinatorMode: shell.coordinatorMode }),
          worktreePath: shell.worktreePath,
          branch: shell.branch,
          usesSharedWorktree,
          isCurrentThread: shell.id === input.threadId,
          isArchived: shell.archivedAt !== null,
          settled,
          sessionStatus,
          queuedMessageCount: toNonNegativeInt(queuedRuns.length),
          taskStatus,
          activeRunId: activeRun?.id ?? shell.activeRunId,
          delegatedTaskId: parentSubagent?.id ?? activeRun?.delegatedTaskId ?? null,
          blockingKind,
          blockingReason,
          canStop,
          deliveryStatus: delivery.deliveryStatus,
          delegatedDeliveryState: delivery.delegatedDeliveryState,
          pendingMergeBackCount: delivery.pendingMergeBackCount,
          boundMergeBackCount: delivery.boundMergeBackCount,
          deliveredMergeBackCount: delivery.deliveredMergeBackCount,
          interimReportCount: delivery.interimReportCount,
          finalReportCount: delivery.finalReportCount,
          latestArtifactSummary: resolveLatestArtifactSummary({
            shell,
            messages: records.messages,
            parentSubagent,
          }),
          plannedPaths,
          confirmedWritePaths,
          activeReservationPaths,
          hasPathOverlap,
          remoteChildren: buildRemoteChildren(records.subagents),
          updatedAt: toIsoDateTime(shell.updatedAt),
        };
      });

      const sideChats: Array<FamilyCollaborationSideChatSummary> = sideChatShells.map((shell) => {
        const records = recordsByThreadId.get(shell.id) ?? EMPTY_RECORDS;
        const activeRun = latestActiveRunOf(shell, records.runs);
        const queuedRuns = records.runs.filter((run) => run.status === "queued");
        const latestRun = latestRunOf(records.runs);
        const pendingRequest = latestPendingRuntimeRequestOf(shell, records.runtimeRequests);

        let pendingMergeBack = 0;
        let boundMergeBack = 0;
        for (const transfer of rootRecords.contextTransfers) {
          if (transfer.type !== "merge_back" || transfer.sourceThreadId !== shell.id) {
            continue;
          }
          if (transfer.status === "pending") {
            pendingMergeBack += 1;
          } else if (transfer.status === "bound") {
            boundMergeBack += 1;
          }
        }

        return {
          threadId: shell.id,
          title: shell.title,
          sessionStatus: resolveSessionStatus({
            shell,
            runs: records.runs,
            activeRun,
            queuedRuns,
            latestRun,
            pendingRequest,
          }),
          temporary: shell.lineage.temporary === true,
          pendingMergeBackCount: toNonNegativeInt(pendingMergeBack),
          boundMergeBackCount: toNonNegativeInt(boundMergeBack),
          updatedAt: toIsoDateTime(shell.updatedAt),
        };
      });

      const pendingEscalations = pendingEscalationsRaw
        .filter((escalation) => escalation.status === "pending")
        .map((escalation) => ({
          requestId: escalation.requestId,
          sourceThreadId: escalation.sourceThreadId,
          sourceTitle: shellById.get(escalation.sourceThreadId)?.title ?? escalation.sourceThreadId,
          title: escalation.title,
          status: escalation.status,
          createdChildThreadId: escalation.childThreadId,
          createdAt: escalation.createdAt,
        }));

      const pendingWorktreeApprovals = pendingWorktreeApprovalsRaw.map((approval) => ({
        requestId: approval.requestId,
        parentThreadId: approval.parentThreadId,
        childThreadId: approval.childThreadId,
        branch: approval.branch,
        status: approval.status,
        createdAt: approval.createdAt,
      }));

      const summary =
        input.includeSummary === true
          ? buildDigest({
              rootThreadId,
              nodes,
              sideChats,
              pendingEscalations,
              pendingWorktreeApprovals,
              sharedWorktree: sharedWorktreeSnapshot,
            })
          : null;

      const now = yield* DateTime.now;
      return {
        rootThreadId,
        requestedThreadId: input.threadId,
        projectId,
        generatedAt: toIsoDateTime(now),
        readOnlyGuaranteed: true,
        nodes,
        sideChats,
        pendingEscalations,
        pendingWorktreeApprovals,
        sharedWorktree: sharedWorktreeSnapshot,
        summary,
      };
    });

    return {
      getOverview,
    };
  }),
);
