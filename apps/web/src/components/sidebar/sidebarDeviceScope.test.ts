import { describe, expect, it } from "vite-plus/test";
import { sidebarDeviceProjectScope } from "./sidebarDeviceScope";

describe("sidebar device scope", () => {
  const projects = [
    { environmentId: "local", id: "same" },
    { environmentId: "remote", id: "same" },
    { environmentId: "new", id: "other" },
  ];
  it("defaults to all devices and intersects device and project selections", () => {
    expect(sidebarDeviceProjectScope(projects, null, [])).toBeNull();
    expect([...sidebarDeviceProjectScope(projects, null, ["remote"])!]).toEqual([
      "local:same",
      "new:other",
    ]);
    expect([...sidebarDeviceProjectScope(projects, new Set(["remote:same"]), ["remote"])!]).toEqual(
      [],
    );
    expect([...sidebarDeviceProjectScope(projects, null, ["local", "remote", "new"])!]).toEqual([]);
  });
});
