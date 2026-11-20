import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  NodeId,
  NonNegativeInt,
  ProjectId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import {
  OrchestrationV2Actor,
  OrchestrationV2DelegatedCompletionTaskDeliveryState,
} from "./orchestrationV2.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";
import { SharedWorktreeCoordinationSnapshot } from "./sharedWorktreeCoordination.ts";
import { SubtaskEscalationRequestId, SubtaskEscalationStatus } from "./subtaskEscalation.ts";
import { WorktreeApprovalRequestId, WorktreeApprovalStatus } from "./worktreeApproval.ts";

export const FamilyCollaborationNodeKind = Schema.Literals([
  "root",
  "subtask",
  "fork",
  "side_chat",
]);
export type FamilyCollaborationNodeKind = typeof FamilyCollaborationNodeKind.Type;

/** Session-level lifecycle status of a thread, kept separate from task and delivery status. */
export const FamilyCollaborationSessionStatus = Schema.Literals([
  "awaiting_initial_send",
  "running",
  "waiting_approval",
  "waiting_input",
  "queue_paused",
  "idle",
  "archived",
  "error",
]);
export type FamilyCollaborationSessionStatus = typeof FamilyCollaborationSessionStatus.Type;

/** Task/run execution status of a thread, kept separate from session and delivery status. */
export const FamilyCollaborationTaskStatus = Schema.Literals([
  "none",
  "draft",
  "queued",
  "running",
  "blocked",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export type FamilyCollaborationTaskStatus = typeof FamilyCollaborationTaskStatus.Type;

/** Handoff/delivery status toward the parent thread, never auto-acknowledged by overview reads. */
export const FamilyCollaborationDeliveryStatus = Schema.Literals([
  "none",
  "awaiting_delivery",
  "interim_reported",
  "delivered",
  "acknowledged",
  "superseded",
  "pending_merge_back",
  "bound_merge_back",
]);
export type FamilyCollaborationDeliveryStatus = typeof FamilyCollaborationDeliveryStatus.Type;

export const FamilyCollaborationBlockingKind = Schema.Literals([
  "approval",
  "user_input",
  "thread_wait",
  "write_lock",
  "checkout_serialization",
  "queue_paused",
  "worktree_approval",
]);
export type FamilyCollaborationBlockingKind = typeof FamilyCollaborationBlockingKind.Type;

export const FamilyCollaborationRemoteChild = Schema.Struct({
  subagentId: NodeId,
  title: Schema.String,
  status: Schema.String,
  targetEnvironmentId: EnvironmentId,
  remoteThreadId: Schema.NullOr(ThreadId),
  deliveryState: Schema.NullOr(OrchestrationV2DelegatedCompletionTaskDeliveryState),
});
export type FamilyCollaborationRemoteChild = typeof FamilyCollaborationRemoteChild.Type;

export const FamilyCollaborationNode = Schema.Struct({
  threadId: ThreadId,
  parentThreadId: Schema.NullOr(ThreadId),
  rootThreadId: ThreadId,
  depth: NonNegativeInt,
  nodeKind: FamilyCollaborationNodeKind,
  createdBy: OrchestrationV2Actor,
  title: Schema.String,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  usesSharedWorktree: Schema.Boolean,
  isCurrentThread: Schema.Boolean,
  isArchived: Schema.Boolean,
  settled: Schema.Boolean,
  // Dimension 1: Session status
  sessionStatus: FamilyCollaborationSessionStatus,
  queuedMessageCount: NonNegativeInt,
  // Dimension 2: Task status
  taskStatus: FamilyCollaborationTaskStatus,
  activeRunId: Schema.NullOr(RunId),
  delegatedTaskId: Schema.NullOr(NodeId),
  blockingKind: Schema.NullOr(FamilyCollaborationBlockingKind),
  blockingReason: Schema.NullOr(Schema.String),
  canStop: Schema.Boolean,
  // Dimension 3: Delivery status
  deliveryStatus: FamilyCollaborationDeliveryStatus,
  delegatedDeliveryState: Schema.NullOr(OrchestrationV2DelegatedCompletionTaskDeliveryState),
  pendingMergeBackCount: NonNegativeInt,
  boundMergeBackCount: NonNegativeInt,
  deliveredMergeBackCount: NonNegativeInt,
  interimReportCount: NonNegativeInt,
  finalReportCount: NonNegativeInt,
  // Artifacts & three-layer shared worktree path attribution
  latestArtifactSummary: Schema.NullOr(Schema.String),
  plannedPaths: Schema.Array(TrimmedNonEmptyString),
  confirmedWritePaths: Schema.Array(TrimmedNonEmptyString),
  activeReservationPaths: Schema.Array(TrimmedNonEmptyString),
  hasPathOverlap: Schema.Boolean,
  remoteChildren: Schema.Array(FamilyCollaborationRemoteChild),
  updatedAt: IsoDateTime,
});
export type FamilyCollaborationNode = typeof FamilyCollaborationNode.Type;

export const FamilyCollaborationSideChatSummary = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  sessionStatus: FamilyCollaborationSessionStatus,
  temporary: Schema.Boolean,
  pendingMergeBackCount: NonNegativeInt,
  boundMergeBackCount: NonNegativeInt,
  updatedAt: IsoDateTime,
});
export type FamilyCollaborationSideChatSummary = typeof FamilyCollaborationSideChatSummary.Type;

export const FamilyCollaborationEscalationSummary = Schema.Struct({
  requestId: SubtaskEscalationRequestId,
  sourceThreadId: ThreadId,
  sourceTitle: Schema.String,
  title: Schema.NullOr(Schema.String),
  status: SubtaskEscalationStatus,
  createdChildThreadId: Schema.NullOr(ThreadId),
  createdAt: IsoDateTime,
});
export type FamilyCollaborationEscalationSummary = typeof FamilyCollaborationEscalationSummary.Type;

export const FamilyCollaborationWorktreeApprovalSummary = Schema.Struct({
  requestId: WorktreeApprovalRequestId,
  parentThreadId: Schema.NullOr(ThreadId),
  childThreadId: ThreadId,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  status: WorktreeApprovalStatus,
  createdAt: IsoDateTime,
});
export type FamilyCollaborationWorktreeApprovalSummary =
  typeof FamilyCollaborationWorktreeApprovalSummary.Type;

export const FamilyCollaborationDigest = Schema.Struct({
  l0Count: NonNegativeInt,
  l1Count: NonNegativeInt,
  l2Count: NonNegativeInt,
  sideChatCount: NonNegativeInt,
  remoteCount: NonNegativeInt,
  runningCount: NonNegativeInt,
  blockedCount: NonNegativeInt,
  awaitingInitialSendCount: NonNegativeInt,
  completedCount: NonNegativeInt,
  failedCount: NonNegativeInt,
  pendingDeliveryCount: NonNegativeInt,
  pendingMergeBackCount: NonNegativeInt,
  pendingEscalationCount: NonNegativeInt,
  pendingWorktreeApprovalCount: NonNegativeInt,
  overlapCount: NonNegativeInt,
  observedUnverifiedCount: NonNegativeInt,
  highlights: Schema.Array(Schema.String),
  markdownDigest: Schema.String,
});
export type FamilyCollaborationDigest = typeof FamilyCollaborationDigest.Type;

export const FamilyCollaborationOverview = Schema.Struct({
  rootThreadId: ThreadId,
  requestedThreadId: ThreadId,
  projectId: ProjectId,
  generatedAt: IsoDateTime,
  /** Explicit contract guarantee that reading this overview never acknowledges deliveries or mutates state. */
  readOnlyGuaranteed: Schema.Literal(true),
  nodes: Schema.Array(FamilyCollaborationNode),
  sideChats: Schema.Array(FamilyCollaborationSideChatSummary),
  pendingEscalations: Schema.Array(FamilyCollaborationEscalationSummary),
  pendingWorktreeApprovals: Schema.Array(FamilyCollaborationWorktreeApprovalSummary),
  sharedWorktree: Schema.NullOr(SharedWorktreeCoordinationSnapshot),
  summary: Schema.NullOr(FamilyCollaborationDigest),
});
export type FamilyCollaborationOverview = typeof FamilyCollaborationOverview.Type;

export const FamilyCollaborationGetOverviewInput = Schema.Struct({
  threadId: ThreadId,
  includeSummary: Schema.optionalKey(Schema.Boolean),
});
export type FamilyCollaborationGetOverviewInput = typeof FamilyCollaborationGetOverviewInput.Type;

const FAMILY_COLLABORATION_FAILURE_MESSAGES = {
  thread_not_found: "Thread was not found or has been deleted.",
  load_failed: "Failed to load the multi-agent collaboration tree overview.",
} as const;

export const FamilyCollaborationOverviewFailureReason = Schema.Literals(
  Object.keys(FAMILY_COLLABORATION_FAILURE_MESSAGES) as Array<
    keyof typeof FAMILY_COLLABORATION_FAILURE_MESSAGES
  >,
);
export type FamilyCollaborationOverviewFailureReason =
  typeof FamilyCollaborationOverviewFailureReason.Type;

export class FamilyCollaborationOverviewError extends Schema.TaggedError<FamilyCollaborationOverviewError>()(
  "FamilyCollaborationOverviewError",
  {
    reason: FamilyCollaborationOverviewFailureReason,
    detail: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail ?? FAMILY_COLLABORATION_FAILURE_MESSAGES[this.reason];
  }
}
