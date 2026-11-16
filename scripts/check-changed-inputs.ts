// @effect-diagnostics nodeBuiltinImport:off -- Dirent distinguishes junctions without following them.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export async function checkInputCandidates(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string, generated: boolean) => {
    for (const entry of await NodeFSP.readdir(NodePath.join(root, directory), {
      withFileTypes: true,
    })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const relative = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        if (entry.name.endsWith(".d.ts") || entry.name.startsWith(".env")) {
          const info = await NodeFSP.stat(NodePath.join(root, relative)).catch(() => undefined);
          if (info?.isFile()) files.push(relative);
        }
        continue;
      }
      if (entry.isDirectory()) {
        await visit(relative, generated || entry.name === ".generated" || entry.name === ".astro");
      } else if (
        entry.isFile() &&
        (generated || entry.name.endsWith(".d.ts") || entry.name.startsWith(".env"))
      ) {
        files.push(relative);
      }
    }
  };
  await visit("", false);
  return files.sort();
}
