// @effect-diagnostics nodeBuiltinImport:off -- Exercises real filesystem directory and junction entries.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import { checkInputCandidates } from "./check-changed-inputs.ts";

it("collects check inputs without traversing dependencies, junctions or git metadata", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-check-inputs-"));
  try {
    for (const directory of ["node_modules/nested", ".git", "app/.generated", "app/.astro"]) {
      await NodeFSP.mkdir(NodePath.join(root, directory), { recursive: true });
    }
    for (const file of [
      "node_modules/nested/ignored.d.ts",
      ".git/ignored.d.ts",
      "app/types.d.ts",
      "app/.env.local",
      "app/.generated/client.ts",
      "app/.astro/content.ts",
      "app/source.ts",
    ]) {
      await NodeFSP.writeFile(NodePath.join(root, file), "fixture");
    }
    await NodeFSP.symlink(root, NodePath.join(root, "loop"), "junction");
    expect(await checkInputCandidates(root)).toEqual([
      "app/.astro/content.ts",
      "app/.env.local",
      "app/.generated/client.ts",
      "app/types.d.ts",
    ]);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
