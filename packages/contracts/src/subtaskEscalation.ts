import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  MessageId,
  NodeId,
  ProjectId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { OrchestrationV2Actor } from "./orchestrationV2.ts";

export const SubtaskEscalationRequestId = TrimmedNonEmptyString.pipe(
  Schema.brand("SubtaskEscalationRequestId"),
);
export type SubtaskEscalationRequestId = typeof SubtaskEscalationRequestId.Type;

export const SubtaskEscalationStatus = Schema.Literals([
  "pending",
  "fulfilled",
  "rejected",
  "cancelled",
]);
export type SubtaskEscalationStatus = typeof SubtaskEscalationStatus.Type;

export const SubtaskEscalationTrigger = Schema.Literals(["user", "agent"]);
export type SubtaskEscalationTrigger = typeof SubtaskEscalationTrigger.Type;

export const SubtaskEscalationRequest = Schema.Struct({
  requestId: SubtaskEscalationRequestId,
  projectId: ProjectId,
  rootThreadId: ThreadId,
  sourceThreadId: ThreadId,
  sourceRunId: Schema.NullOr(RunId),
  sourceMessageId: Schema.NullOr(MessageId),
  excerpt: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  task: Schema.String,
  trigger: SubtaskEscalationTrigger,
  status: SubtaskEscalationStatus,
  childThreadId: Schema.NullOr(ThreadId),
  delegatedTaskId: Schema.NullOr(NodeId),
  inboxMessageId: Schema.NullOr(MessageId),
  inboxRunId: Schema.NullOr(RunId),
  parentQueueHeld: Schema.Boolean,
  causationChain: Schema.Array(ThreadId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
  resolvedBy: Schema.NullOr(OrchestrationV2Actor),
  resolutionReason: Schema.NullOr(Schema.String),
});
export type SubtaskEscalationRequest = typeof SubtaskEscalationRequest.Type;

export const SubtaskEscalationCreateDraftInput = Schema.Struct({
  requestId: Schema.optionalKey(SubtaskEscalationRequestId),
  sourceThreadId: ThreadId,
  targetThreadId: Schema.optionalKey(ThreadId),
  title: Schema.optionalKey(TrimmedNonEmptyString),
  task: Schema.optionalKey(Schema.String),
  sourceRunId: Schema.optionalKey(RunId),
  sourceMessageId: Schema.optionalKey(MessageId),
  excerpt: Schema.optionalKey(Schema.String),
});
export type SubtaskEscalationCreateDraftInput = typeof SubtaskEscalationCreateDraftInput.Type;

export const SubtaskEscalationCreateDraftResult = Schema.Struct({
  request: SubtaskEscalationRequest,
  childThreadId: ThreadId,
  replayed: Schema.Boolean,
});
export type SubtaskEscalationCreateDraftResult = typeof SubtaskEscalationCreateDraftResult.Type;

export const SubtaskEscalationListInput = Schema.Struct({
  threadId: ThreadId,
});
export type SubtaskEscalationListInput = typeof SubtaskEscalationListInput.Type;

export const SubtaskEscalationListResult = Schema.Struct({
  requests: Schema.Array(SubtaskEscalationRequest),
});
export type SubtaskEscalationListResult = typeof SubtaskEscalationListResult.Type;

export const SubtaskEscalationResolveDecision = Schema.Literals(["create_draft", "reject"]);
export type SubtaskEscalationResolveDecision = typeof SubtaskEscalationResolveDecision.Type;

export const SubtaskEscalationResolveInput = Schema.Struct({
  requestId: SubtaskEscalationRequestId,
  decision: SubtaskEscalationResolveDecision,
  reason: Schema.optionalKey(Schema.String),
});
export type SubtaskEscalationResolveInput = typeof SubtaskEscalationResolveInput.Type;

export const SubtaskEscalationResolveResult = Schema.Struct({
  request: SubtaskEscalationRequest,
  childThreadId: Schema.NullOr(ThreadId),
});
export type SubtaskEscalationResolveResult = typeof SubtaskEscalationResolveResult.Type;

const SUBTASK_ESCALATION_FAILURE_MESSAGES = {
  not_found: "This subtask escalation request no longer exists.",
  invalid_source: "Only an active L1 subtask may initiate horizontal escalation to L0.",
  root_archived: "Root thread is archived and cannot accept new sibling L1 escalations.",
  root_deleted: "Root thread was deleted and cannot accept new sibling L1 escalations.",
  root_unreachable: "Root thread could not be reached.",
  root_worktree_pending: "Root thread worktree is still being prepared.",
  binding_mismatch: "Escalation request parameters do not match the original request.",
  already_resolved: "This subtask escalation request was already resolved.",
  causation_loop: "Circular escalation or auto-wake loop detected in causationChain.",
  privilege_denied: "Only the escalation's root thread may fulfill this request.",
  persistence_failed: "Failed to persist subtask escalation request state.",
  orchestration_failed: "Failed to dispatch escalation command.",
} as const;

export const SubtaskEscalationFailureReason = Schema.Literals(
  Object.keys(SUBTASK_ESCALATION_FAILURE_MESSAGES) as Array<
    keyof typeof SUBTASK_ESCALATION_FAILURE_MESSAGES
  >,
);
export type SubtaskEscalationFailureReason = typeof SubtaskEscalationFailureReason.Type;

export class SubtaskEscalationError extends Schema.TaggedError<SubtaskEscalationError>()(
  "SubtaskEscalationError",
  {
    reason: SubtaskEscalationFailureReason,
    detail: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail ?? SUBTASK_ESCALATION_FAILURE_MESSAGES[this.reason];
  }
}
