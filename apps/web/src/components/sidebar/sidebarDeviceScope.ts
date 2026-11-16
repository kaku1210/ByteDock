export function sidebarDeviceProjectScope(
  projects: readonly { environmentId: string; id: string }[],
  projectScope: ReadonlySet<string> | null,
  hiddenEnvironmentIds: readonly string[],
): ReadonlySet<string> | null {
  if (hiddenEnvironmentIds.length === 0) return projectScope;
  const hidden = new Set(hiddenEnvironmentIds);
  return new Set(
    projects.flatMap((project) => {
      const key = `${project.environmentId}:${project.id}`;
      return !hidden.has(project.environmentId) && (projectScope === null || projectScope.has(key))
        ? [key]
        : [];
    }),
  );
}
