import { McpAttachmentInput } from "../attachment/input.ts";
import {
  clampedPositiveInt,
  NonNegativeInt,
  ModelSelection,
  TrimmedNonEmptyString,
  ThreadId,
  RunId,
  OrchestrationV2DelegatedFrom,
  OrchestrationV2WorkflowOrigin,
  OrchestrationV2RunStatus,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  RuntimeMode,
  ProviderInteractionMode,
  Project,
  ProjectCreatePayload,
  ProjectMoveThreadToScratchInput,
  ProjectMoveThreadToScratchResult,
  ProjectMoveThreadToProjectInput,
  ProjectMoveThreadToProjectResult,
  ProjectUpdatePayload,
  ProjectId,
  OrchestratorMcpClientRequestId,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  SourceControlCloneRepositoryInput,
  SourceControlCloneRepositoryResult,
} from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as DocumentText from "../../../provider/DocumentText.ts";
import * as ServerConfig from "../../../config.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ProjectCloneTracker from "../../../project/ProjectCloneTracker.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as ThreadProjectMove from "../../../project/ThreadProjectMove.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SourceControlRepositoryService from "../../../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  success: Project,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
    ServerSettings.ServerSettingsService,
    SecureRandom.SecureRandom,
  ],
};
const ProjectListTool = Tool.make("t3_project_list", {
  ...shared,
  description: "List projects. Pages can shift.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    cursor: Schema.optional(NonNegativeInt),
    limit: Schema.optional(clampedPositiveInt(100)),
  }),
  success: Schema.Struct({
    projects: Schema.Array(Project),
    nextCursor: Schema.NullOr(NonNegativeInt),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const ProjectReadTool = Tool.make("t3_project_read", {
  ...shared,
  description: "Read one project: workspace and saved scripts.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    projectId: ProjectId,
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const ProjectCreateTool = Tool.make("t3_project_create", {
  ...shared,
  description:
    "Register a project folder. `createWorkspaceRootIfMissing` creates it; a registered folder is rejected. No `workspaceRoot`: makes a git repo from `title` with README, icon, first commit (`commitError` on failure; project still exists). Clone first with `t3_project_clone` if needed.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...ProjectCreatePayload.fields,
    workspaceRoot: Schema.optional(ProjectCreatePayload.fields.workspaceRoot),
  }),
  success: Schema.Struct({ ...Project.fields, commitError: Schema.optional(Schema.String) }),
  dependencies: [...shared.dependencies, ManagedProjectFolders.ManagedProjectFolders],
}).annotate(Tool.Destructive, true);
const ThreadMoveToNoProjectTool = Tool.make("t3_thread_move_to_no_project", {
  ...shared,
  description:
    "Move one stopped thread into No project, keeping its history, files, working directory and lifecycle state. Read it first and pass expectedProjectId. Active or queued work and open requests must finish first. Repeating a completed move does nothing.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...ProjectMoveThreadToScratchInput.fields,
  }),
  success: Schema.Struct({
    ...ProjectMoveThreadToScratchResult.fields,
    link: Schema.String,
  }),
  dependencies: [...shared.dependencies, ThreadProjectMove.ThreadProjectMove],
}).annotate(Tool.Destructive, true);
const ThreadMoveToProjectTool = Tool.make("t3_thread_move_to_project", {
  ...shared,
  description:
    "Move one stopped No project thread and its dedicated scratch folder into an existing project. Read it first and pass expectedProjectId and targetProjectId. Active, queued, or background work must finish first.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...ProjectMoveThreadToProjectInput.fields,
  }),
  success: Schema.Struct({
    ...ProjectMoveThreadToProjectResult.fields,
    link: Schema.String,
  }),
  dependencies: [...shared.dependencies, ThreadProjectMove.ThreadProjectMove],
}).annotate(Tool.Destructive, true);
const ProjectUpdateTool = Tool.make("t3_project_update", {
  ...shared,
  description: "Update one project's settings. Omitted fields are unchanged.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    projectId: ProjectId,
    ...ProjectUpdatePayload.fields,
  }),
}).annotate(Tool.Destructive, true);
const ProjectDeleteTool = Tool.make("t3_project_delete", {
  ...shared,
  description: "Delete one project. Nonempty needs `force: true`. Folder on disk stays.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    projectId: ProjectId,
    force: Schema.optionalKey(Schema.Boolean),
  }),
  dependencies: [
    ...shared.dependencies,
    ProjectCloneTracker.ProjectCloneTracker,
    ManagedProjectFolders.ManagedProjectFolders,
  ],
}).annotate(Tool.Destructive, true);
const ProjectCloneTool = Tool.make("t3_project_clone", {
  ...shared,
  description:
    "Clone a repository (`destinationPath` new or empty). Register after with `t3_project_create`, with the same `environmentId`.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...SourceControlCloneRepositoryInput.fields,
  }),
  success: SourceControlCloneRepositoryResult,
  dependencies: [
    ...shared.dependencies,
    SourceControlRepositoryService.SourceControlRepositoryService,
  ],
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);
const ThreadLaunchTool = Tool.make("t3_thread_launch", {
  ...shared,
  description:
    "Create a top-level thread in its workspace. Task in `message` (omit with `attachments` for idle). Omit `projectId`, model, modes to inherit (outside a thread, pass `projectId` or `scratch`). Reuse `clientRequestId` on retry. Mention its `link`.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    projectId: Schema.optional(ProjectId),
    scratch: Schema.optional(
      Schema.Boolean.annotate({
        description: "No project: new Scratch folder. Not with `projectId` or `workspaceStrategy`.",
      }),
    ),
    title: TrimmedNonEmptyString,
    generateTitle: Schema.optional(Schema.Boolean),
    modelSelection: Schema.optional(ModelSelection),
    runtimeMode: Schema.optional(RuntimeMode),
    interactionMode: Schema.optional(ProviderInteractionMode),
    workspaceStrategy: Schema.optional(
      OrchestrationV2ThreadLaunchWorkspaceStrategy.annotate({
        description:
          "'worktree' (new checkout from `baseRef`, `startFromOrigin`), 'existing_worktree' (`worktreePath`), or 'root' (default, project root). Uncommitted edits are not copied.",
      }),
    ),
    message: Schema.optional(
      Schema.String.check(Schema.isMaxLength(120000)).annotate({
        description: "First prompt. Omit with `attachments` for idle.",
      }),
    ),
    attachments: Schema.optional(Schema.Array(McpAttachmentInput).check(Schema.isMaxLength(8))),
    outputSchema: Schema.optional(
      Schema.Record(Schema.String, Schema.Json).annotate({
        description: "As in `t3_thread_send`. Needs `message`.",
      }),
    ),
    clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
    /** Set by a linked environment launching its agent's delegated task here; ignored otherwise. */
    delegatedFrom: Schema.optional(OrchestrationV2DelegatedFrom),
    /** Set by a linked environment whose workflow run this thread is a step of; ignored otherwise. */
    workflowRun: Schema.optional(OrchestrationV2WorkflowOrigin),
  }),
  success: Schema.Struct({
    threadId: ThreadId,
    link: Schema.optional(Schema.String),
    projectId: ProjectId,
    modelSelection: ModelSelection,
    runId: Schema.NullOr(RunId),
    status: Schema.NullOr(OrchestrationV2RunStatus),
  }),
  dependencies: [
    ...shared.dependencies,
    ThreadLaunchService.ThreadLaunchService,
    ManagedProjectFolders.ManagedProjectFolders,
    GitVcsDriver.GitVcsDriver,
    FileSystem.FileSystem,
    ServerConfig.ServerConfig,
    ServerSettings.ServerSettingsService,
    ProviderRegistry.ProviderRegistry,
    DocumentText.DocumentText,
    Digest.Digest,
  ],
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const ProjectToolkit = Toolkit.make(
  ThreadLaunchTool,
  ThreadMoveToNoProjectTool,
  ThreadMoveToProjectTool,
  ProjectListTool,
  ProjectReadTool,
  ProjectCreateTool,
  ProjectUpdateTool,
  ProjectDeleteTool,
  ProjectCloneTool,
);
