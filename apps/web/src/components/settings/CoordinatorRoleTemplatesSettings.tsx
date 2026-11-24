import {
  DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
  type CoordinatorRoleTemplate,
  type CoordinatorRoleTemplateConfig,
  type CoordinatorRoleTemplateId,
  type CoordinatorSceneMode,
  type CoordinatorTier,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInstanceId,
  type ServerProvider,
  type UnifiedSettings,
} from "@t3tools/contracts";
import {
  resolveCoordinatorModels,
  resolveCoordinatorRoleTemplates,
} from "@t3tools/shared/coordinator";
import { pickModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import { EyeIcon, LayersIcon, PencilIcon, PlusIcon, RotateCcwIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { useUiLanguage } from "../../i18n/useUiLanguage";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { useEnvironmentProviders } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { cn } from "~/lib/utils";
import { CoordinatorTierPreviewList } from "../chat/CoordinatorModeControl";
import {
  COORDINATOR_TIERS,
  coordinatorSceneModeLabel,
  coordinatorTierRoleLabel,
} from "../chat/coordinatorModeControl.logic";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import {
  buildDraftCoordinatorPreviewSettings,
  canCreateCoordinatorRoleTemplate,
  createEditCoordinatorTemplateDraft,
  createEmptyCoordinatorTemplateDraft,
  isBuiltInTemplateCustomized,
  pickInitialExplicitTierModel,
  slugifyCoordinatorTemplateId,
  summarizeTierOverrides,
  validateCoordinatorTemplateDraft,
  type CoordinatorRoleTemplateDraft,
} from "./coordinatorRoleTemplatesSettings.logic";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { useSearchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useScopedSettingsWriteAllowed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

function templateDisplayName(
  template: Pick<CoordinatorRoleTemplate, "name" | "builtIn">,
  uiText: (source: string) => string,
): string {
  return template.builtIn ? uiText(template.name) : template.name;
}

function CoordinatorRoleTemplateEditorDialog({
  draft: initialDraft,
  existingIds,
  environmentId,
  settings,
  providers,
  onClose,
  onSave,
}: {
  readonly draft: CoordinatorRoleTemplateDraft;
  readonly existingIds: ReadonlySet<string>;
  readonly environmentId: EnvironmentId | null;
  readonly settings: UnifiedSettings;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly onClose: () => void;
  readonly onSave: (id: CoordinatorRoleTemplateId, config: CoordinatorRoleTemplateConfig) => void;
}) {
  const { text: uiText } = useUiLanguage();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<CoordinatorRoleTemplateDraft>(initialDraft);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const previewContext = buildDraftCoordinatorPreviewSettings(settings, draft);
  const draftPreview = resolveCoordinatorModels({
    settings: previewContext.settings,
    providers,
    projectId: null,
    templateId: previewContext.templateId,
    rootModelSelection: settings.defaultModelSelection,
  });

  const instanceEntries = providerInstanceEntriesFor(providers, settings, null);
  const hasAvailableProviderModels = providers.some((provider) => provider.models.length > 0);

  const handleNameChange = (nextName: string) => {
    setErrorMessage(null);
    setDraft((current) => ({
      ...current,
      name: nextName,
      ...(current.mode === "create" && !current.idManuallyEdited
        ? { id: slugifyCoordinatorTemplateId(nextName, existingIds) }
        : {}),
    }));
  };

  const handleTierModelChange = (tier: CoordinatorTier, nextSelection: ModelSelection | null) => {
    setErrorMessage(null);
    setDraft((current) => ({
      ...current,
      tierModels: {
        ...current.tierModels,
        [tier]: nextSelection,
      },
    }));
  };

  const handleSubmit = () => {
    const validated = validateCoordinatorTemplateDraft(draft, existingIds);
    if (!validated.ok) {
      setErrorMessage(validated.error);
      return;
    }
    onSave(validated.id, validated.config);
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-xl" data-testid="coordinator-template-editor-dialog">
        <DialogHeader>
          <DialogTitle>
            {draft.mode === "create"
              ? uiText("New coordinator role template")
              : uiText("Edit coordinator role template")}
          </DialogTitle>
          <DialogDescription>
            {uiText(
              "Configure scene mode, delegation behavior, and optional per-tier pinned models. Unpinned tiers follow the current coordinating thread.",
            )}
          </DialogDescription>
        </DialogHeader>

        <DialogPanel>
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="coordinator-template-name">{uiText("Name")}</Label>
                <Input
                  id="coordinator-template-name"
                  size="sm"
                  maxLength={80}
                  value={draft.name}
                  placeholder={uiText("e.g. Strict Architect")}
                  onChange={(event) => handleNameChange(event.target.value)}
                  data-testid="coordinator-template-name-input"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="coordinator-template-id">{uiText("Template ID")}</Label>
                <Input
                  id="coordinator-template-id"
                  size="sm"
                  maxLength={64}
                  value={draft.id}
                  disabled={draft.mode === "edit"}
                  spellCheck={false}
                  onChange={(event) => {
                    setErrorMessage(null);
                    setDraft((current) => ({
                      ...current,
                      id: event.target.value,
                      idManuallyEdited: true,
                    }));
                  }}
                  data-testid="coordinator-template-id-input"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="coordinator-template-description">{uiText("Description")}</Label>
              <Input
                id="coordinator-template-description"
                size="sm"
                maxLength={240}
                value={draft.description}
                placeholder={uiText("Describe when this coordinator role template should be used.")}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, description: event.target.value }))
                }
                data-testid="coordinator-template-description-input"
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex items-center justify-between gap-3 rounded-lg border border-border/80 bg-muted/20 px-3 py-2">
                <div className="min-w-0">
                  <div className="text-xs font-medium text-foreground">
                    {uiText("Prefer delegation")}
                  </div>
                  <div className="text-2xs text-muted-foreground">
                    {uiText("Keep the coordinator focused on planning, delegation, and synthesis.")}
                  </div>
                </div>
                <Switch
                  checked={draft.preferDelegation}
                  onCheckedChange={(checked) =>
                    setDraft((current) => ({ ...current, preferDelegation: Boolean(checked) }))
                  }
                  aria-label={uiText("Prefer delegation")}
                  data-testid="coordinator-template-prefer-delegation-switch"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="coordinator-template-scene-mode">{uiText("Scene mode")}</Label>
                <Select
                  value={draft.sceneMode}
                  onValueChange={(value) => {
                    if (value === "code" || value === "general") {
                      setDraft((current) => ({ ...current, sceneMode: value }));
                    }
                  }}
                >
                  <SelectTrigger
                    id="coordinator-template-scene-mode"
                    size="sm"
                    className="w-full"
                    aria-label={uiText("Scene mode")}
                    data-testid="coordinator-template-scene-mode-select"
                  >
                    <SelectValue>
                      {(value: CoordinatorSceneMode | null) =>
                        value ? uiText(coordinatorSceneModeLabel(value)) : ""
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="start" alignItemWithTrigger={false}>
                    <SelectItem value="code">
                      {uiText(coordinatorSceneModeLabel("code"))}
                    </SelectItem>
                    <SelectItem value="general">
                      {uiText(coordinatorSceneModeLabel("general"))}
                    </SelectItem>
                  </SelectPopup>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-foreground">
                  {uiText("Tier model overrides (optional)")}
                </span>
                <span className="text-2xs text-muted-foreground">
                  {uiText("Unpinned tiers follow the current thread model")}
                </span>
              </div>
              <div className="space-y-2 rounded-lg border border-border/80 bg-muted/20 p-2.5">
                {COORDINATOR_TIERS.map((tier) => {
                  const configured = draft.tierModels[tier];
                  const modelOptions = getCustomModelOptionsByInstance(
                    settings,
                    providers,
                    configured?.instanceId,
                    configured?.model,
                  );
                  return (
                    <div
                      key={tier}
                      data-testid={`coordinator-template-tier-row-${tier}`}
                      className="flex flex-wrap items-center justify-between gap-2"
                    >
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="inline-flex items-center rounded border border-border bg-background px-1.5 py-0.5 font-mono text-3xs font-semibold">
                          {tier}
                        </span>
                        <span className="text-xs font-medium text-foreground">
                          {uiText(coordinatorTierRoleLabel(tier))}
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center justify-end gap-1.5">
                        {configured !== null ? (
                          <>
                            <ProviderModelPicker
                              environmentId={environmentId}
                              activeInstanceId={configured.instanceId}
                              model={configured.model}
                              lockedProvider={null}
                              instanceEntries={instanceEntries}
                              modelOptionsByInstance={modelOptions}
                              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                              {...(environmentId
                                ? {
                                    onOpenProviderSetup: (instanceId: ProviderInstanceId) => {
                                      void navigate({
                                        to: "/settings/providers",
                                        search: { environmentId, instanceId },
                                      });
                                    },
                                  }
                                : {})}
                              onInstanceModelChange={(instanceId, model) =>
                                handleTierModelChange(
                                  tier,
                                  pickModelSelection(configured, instanceId, model),
                                )
                              }
                            />
                            <Button
                              type="button"
                              size="xs"
                              variant="ghost"
                              data-testid={`coordinator-template-tier-auto-${tier}`}
                              onClick={() => handleTierModelChange(tier, null)}
                            >
                              {uiText("Follow current")}
                            </Button>
                          </>
                        ) : (
                          <div className="flex items-center gap-2">
                            <span
                              data-testid={`coordinator-template-tier-auto-badge-${tier}`}
                              className="text-xs text-muted-foreground"
                            >
                              {uiText("Follows current")}
                            </span>
                            <Button
                              type="button"
                              size="xs"
                              variant="outline"
                              disabled={!hasAvailableProviderModels}
                              data-testid={`coordinator-template-tier-override-${tier}`}
                              onClick={() => {
                                const initial = pickInitialExplicitTierModel(
                                  providers,
                                  draftPreview.tiers[tier].modelSelection,
                                );
                                if (initial !== null) {
                                  handleTierModelChange(tier, initial);
                                }
                              }}
                            >
                              {uiText("Pin model")}
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="coordinator-template-instructions">
                  {uiText("Extra coordinator instructions")}
                </Label>
                <span className="text-2xs text-muted-foreground">
                  {draft.instructions.trim().length}/2000
                </span>
              </div>
              <Textarea
                id="coordinator-template-instructions"
                size="sm"
                rows={3}
                maxLength={2000}
                value={draft.instructions}
                placeholder={uiText(
                  "Optional guidance appended to the coordinator prompt (e.g. require a checklist before delegating).",
                )}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, instructions: event.target.value }))
                }
                data-testid="coordinator-template-instructions-input"
              />
            </div>

            <div className="space-y-1.5 border-t border-border/70 pt-3">
              <div className="text-xs font-medium text-foreground">
                {uiText("Live tier preview")}
              </div>
              <CoordinatorTierPreviewList
                resolved={draftPreview}
                providers={providers}
                compact
                testIdPrefix="editor-coordinator-preview"
              />
            </div>

            {errorMessage ? (
              <p
                role="alert"
                data-testid="coordinator-template-editor-error"
                className="text-xs font-medium text-destructive"
              >
                {uiText(errorMessage)}
              </p>
            ) : null}
          </div>
        </DialogPanel>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {uiText("Cancel")}
          </Button>
          <Button
            type="button"
            data-testid="coordinator-template-save-button"
            onClick={handleSubmit}
          >
            {draft.mode === "create" ? uiText("Create template") : uiText("Save changes")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function CoordinatorRoleTemplatesSettings() {
  const { text: uiText } = useUiLanguage();
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { environment, connectedEnvironments } = useSettingsScope();
  const providersByEnvironment = useEnvironmentProviders();
  const writeAllowed = useScopedSettingsWriteAllowed();
  const mixedDefaultTemplate = useScopedSettingsMixed(["defaultCoordinatorRoleTemplateId"]);

  const hasServerTargets = connectedEnvironments.length > 0;
  const readOnly = !hasServerTargets || !writeAllowed;
  const environmentId = environment?.environmentId ?? null;
  const providers =
    (environment?.serverConfig
      ? providersByEnvironment.get(environment.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS;

  const templates = resolveCoordinatorRoleTemplates(settings);
  const existingIds = new Set(templates.map((template) => template.id));
  const canCreate = !readOnly && canCreateCoordinatorRoleTemplate(settings);

  const [previewTemplateId, setPreviewTemplateId] = useState<CoordinatorRoleTemplateId | null>(
    null,
  );
  const [editingDraft, setEditingDraft] = useState<CoordinatorRoleTemplateDraft | null>(null);
  const [deletingTemplate, setDeletingTemplate] = useState<CoordinatorRoleTemplate | null>(null);

  const effectivePreviewTemplateId =
    previewTemplateId !== null && existingIds.has(previewTemplateId)
      ? previewTemplateId
      : settings.defaultCoordinatorRoleTemplateId;

  const previewResolved = resolveCoordinatorModels({
    settings,
    providers,
    projectId: null,
    templateId: effectivePreviewTemplateId,
    rootModelSelection: settings.defaultModelSelection,
  });

  const handleSaveTemplate = (
    id: CoordinatorRoleTemplateId,
    config: CoordinatorRoleTemplateConfig,
  ) => {
    updateSettings({
      coordinatorRoleTemplates: {
        [id]: config,
      },
    });
    setPreviewTemplateId(id);
  };

  const handleResetBuiltIn = (templateId: CoordinatorRoleTemplateId) => {
    updateSettings({
      coordinatorRoleTemplates: {
        [templateId]: null,
      },
    });
  };

  const handleDeleteTemplate = (template: CoordinatorRoleTemplate) => {
    updateSettings({
      coordinatorRoleTemplates: {
        [template.id]: null,
      },
    });
    if (previewTemplateId === template.id) {
      setPreviewTemplateId(null);
    }
    setDeletingTemplate(null);
  };

  return (
    <>
      <SettingsSection
        {...searchableSetting("coordinator-role-templates")}
        headerAction={
          hasServerTargets ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={!canCreate}
              data-testid="coordinator-new-template-button"
              onClick={() => setEditingDraft(createEmptyCoordinatorTemplateDraft(existingIds))}
            >
              <PlusIcon className="size-3" aria-hidden />
              {uiText("New template")}
            </Button>
          ) : null
        }
      >
        <SettingsRow
          serverScoped
          settingKeys={["defaultCoordinatorRoleTemplateId"]}
          mixed={mixedDefaultTemplate}
          {...searchableSetting("default-coordinator-role-template")}
          description={uiText(
            "Role template pre-selected when enabling Coordinator Mode on a thread.",
          )}
          resetAction={
            hasServerTargets &&
            settings.defaultCoordinatorRoleTemplateId !== DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID ? (
              <SettingResetButton
                ariaLabel={uiText("Reset default coordinator template")}
                onClick={() =>
                  updateSettings({
                    defaultCoordinatorRoleTemplateId: DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
                  })
                }
              />
            ) : null
          }
          control={
            !hasServerTargets ? (
              <span className="text-sm text-muted-foreground">
                {uiText("Connect an environment to configure coordinator role templates.")}
              </span>
            ) : (
              <Select
                value={mixedDefaultTemplate ? null : settings.defaultCoordinatorRoleTemplateId}
                disabled={readOnly}
                onValueChange={(value) => {
                  if (value !== null) {
                    updateSettings({
                      defaultCoordinatorRoleTemplateId: value as CoordinatorRoleTemplateId,
                    });
                  }
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full sm:w-56"
                  aria-label={uiText("Default coordinator template")}
                  data-testid="settings-default-coordinator-template-select"
                >
                  <SelectValue>
                    {(value: string | null) => {
                      if (value === null) return uiText("Mixed");
                      const matched = templates.find((item) => item.id === value);
                      return matched ? templateDisplayName(matched, uiText) : value;
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {templates.map((template) => (
                    <SelectItem key={template.id} value={template.id}>
                      {templateDisplayName(template, uiText)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            )
          }
        />

        {templates.map((template) => {
          const isDefaultSelection = settings.defaultCoordinatorRoleTemplateId === template.id;
          const isPreviewed = previewResolved.template.id === template.id;
          const isCustomizedBuiltIn =
            template.builtIn && isBuiltInTemplateCustomized(settings, template.id);
          const displayName = templateDisplayName(template, uiText);
          return (
            <SettingsRow
              key={template.id}
              title={
                <span className="inline-flex flex-wrap items-center gap-1.5">
                  <LayersIcon className="size-3.5 shrink-0 text-primary" aria-hidden />
                  <span>{displayName}</span>
                  {template.builtIn ? (
                    <span className="rounded border border-border bg-muted px-1.5 py-0.25 text-3xs font-medium text-muted-foreground">
                      {uiText("Built-in")}
                    </span>
                  ) : null}
                  {isCustomizedBuiltIn ? (
                    <span className="rounded border border-primary/30 bg-primary/10 px-1.5 py-0.25 text-3xs font-medium text-primary">
                      {uiText("Customized")}
                    </span>
                  ) : null}
                  {isDefaultSelection ? (
                    <span className="rounded border border-info/30 bg-info/10 px-1.5 py-0.25 text-3xs font-medium text-info">
                      {uiText("Default")}
                    </span>
                  ) : null}
                </span>
              }
              description={
                <span className="block space-y-1">
                  {template.description ? (
                    <span className="block">{template.description}</span>
                  ) : null}
                  <span className="block text-2xs text-muted-foreground">
                    {uiText("Scene: {value0}", {
                      value0: uiText(coordinatorSceneModeLabel(template.mode)),
                    })}{" "}
                    ·{" "}
                    {template.preferDelegation
                      ? uiText("Prefer delegation")
                      : uiText("Flexible execution")}{" "}
                    · {uiText(summarizeTierOverrides(template.tierModels))}
                  </span>
                </span>
              }
              control={
                <div
                  className="flex flex-wrap items-center justify-end gap-1"
                  data-testid={`coordinator-template-row-${template.id}`}
                >
                  <Button
                    type="button"
                    size="xs"
                    variant={isPreviewed ? "secondary" : "ghost"}
                    data-testid={`coordinator-template-preview-${template.id}`}
                    onClick={() => setPreviewTemplateId(template.id)}
                  >
                    <EyeIcon className="size-3" aria-hidden />
                    {uiText("Preview")}
                  </Button>
                  {!readOnly ? (
                    <>
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        data-testid={`coordinator-template-edit-${template.id}`}
                        onClick={() =>
                          setEditingDraft(createEditCoordinatorTemplateDraft(template))
                        }
                      >
                        <PencilIcon className="size-3" aria-hidden />
                        {uiText("Edit")}
                      </Button>
                      {isCustomizedBuiltIn ? (
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          data-testid={`coordinator-template-reset-${template.id}`}
                          onClick={() => handleResetBuiltIn(template.id)}
                        >
                          <RotateCcwIcon className="size-3" aria-hidden />
                          {uiText("Reset")}
                        </Button>
                      ) : null}
                      {!template.builtIn ? (
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          aria-label={uiText("Delete {value0}", { value0: displayName })}
                          data-testid={`coordinator-template-delete-${template.id}`}
                          onClick={() => setDeletingTemplate(template)}
                        >
                          <Trash2Icon className="size-3 text-destructive" aria-hidden />
                        </Button>
                      ) : null}
                    </>
                  ) : null}
                </div>
              }
            />
          );
        })}

        <div
          data-testid="settings-coordinator-tier-preview"
          className={cn("border-t border-border/70 bg-muted/15 px-4 py-3")}
        >
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-xs font-semibold text-foreground">
                {uiText("Tier preview")} · {templateDisplayName(previewResolved.template, uiText)}
              </div>
              <div className="text-2xs text-muted-foreground">
                {uiText(
                  "Live L0 / L1 / L2 resolution against currently enabled providers and available models.",
                )}
              </div>
            </div>
            <span className="font-mono text-3xs text-muted-foreground">
              {previewResolved.template.id}
            </span>
          </div>
          <CoordinatorTierPreviewList
            resolved={previewResolved}
            providers={providers}
            testIdPrefix="settings-coordinator-preview"
          />
        </div>
      </SettingsSection>

      {editingDraft !== null ? (
        <CoordinatorRoleTemplateEditorDialog
          draft={editingDraft}
          existingIds={existingIds}
          environmentId={environmentId}
          settings={settings}
          providers={providers}
          onClose={() => setEditingDraft(null)}
          onSave={handleSaveTemplate}
        />
      ) : null}

      <AlertDialog
        open={deletingTemplate !== null}
        onOpenChange={(open) => {
          if (!open) setDeletingTemplate(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {uiText("Delete role template “{value0}”?", {
                value0: deletingTemplate?.name ?? "",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {uiText(
                "Threads referencing this template will automatically fall back to the default coordinator role template.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              {uiText("Cancel")}
            </AlertDialogClose>
            <Button
              variant="destructive"
              data-testid="coordinator-template-confirm-delete"
              onClick={() => {
                if (deletingTemplate !== null) {
                  handleDeleteTemplate(deletingTemplate);
                }
              }}
            >
              {uiText("Delete")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
