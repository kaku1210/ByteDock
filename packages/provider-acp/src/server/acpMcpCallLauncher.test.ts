// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { ACP_MCP_CALL_LAUNCHER, ACP_MCP_CALL_STANDALONE_SCRIPT } from "./acpMcpCallLauncher.ts";

function runScript(input: {
  readonly scriptPath: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly stdin?: string;
}): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(process.execPath, [input.scriptPath, ...input.args], {
      env: input.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (input.stdin !== undefined) child.stdin.write(input.stdin);
    child.stdin.end();
  });
}

describe("acpMcpCallLauncher", () => {
  it("prefers standalone node.exe and falls back to T3_ACP_MCP_NODE in the Windows batch launcher", () => {
    expect(ACP_MCP_CALL_LAUNCHER).toContain('node.exe "%T3_CALL_SCRIPT%" %*');
    expect(ACP_MCP_CALL_LAUNCHER).toContain('if not "%errorlevel%"=="125" exit /b %errorlevel%');
    expect(ACP_MCP_CALL_LAUNCHER).toContain('set "ELECTRON_RUN_AS_NODE=1"');
    expect(ACP_MCP_CALL_LAUNCHER).toContain(
      '"%T3_ACP_MCP_NODE%" "%T3_ACP_MCP_ENTRYPOINT%" acp-mcp-call %*',
    );
  });

  it("calls an MCP HTTP endpoint via SSE, strips BOM on stdin, deduplicates structuredContent, and terminates the session", async () => {
    const methods: Array<string> = [];
    const seenToolCalls: Array<unknown> = [];
    let deleteCount = 0;

    const server = NodeHttp.createServer(async (req, res) => {
      if (req.method === "DELETE") {
        deleteCount += 1;
        res.writeHead(204).end();
        return;
      }
      const chunks: Array<Buffer> = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        id?: string;
        method?: string;
        params?: unknown;
      };
      if (message.method) methods.push(message.method);
      if (message.method === "notifications/initialized") {
        res.writeHead(202).end();
        return;
      }
      if (message.method === "initialize") {
        res.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": "session-standalone-1",
        });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { protocolVersion: "2025-06-18" },
          }),
        );
        return;
      }
      if (message.method === "tools/call") {
        seenToolCalls.push(message.params);
        const structuredContent = { scheduledTaskId: "task-1", enabled: false };
        const payload = {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            structuredContent,
            content: [
              { type: "text", text: JSON.stringify(structuredContent) },
              { type: "text", text: "Paused." },
            ],
            isError: false,
          },
        };
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: ${JSON.stringify(payload)}\n\n`);
        return;
      }
      res.writeHead(202).end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP address");
    const tmpDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-acp-mcp-call-"));
    const scriptPath = NodePath.join(tmpDir, "acp-mcp-call.mjs");
    try {
      await NodeFSP.writeFile(scriptPath, ACP_MCP_CALL_STANDALONE_SCRIPT, "utf8");
      const env = {
        ...process.env,
        T3_ACP_MCP_ENDPOINT: `http://127.0.0.1:${address.port}/mcp`,
        T3_ACP_MCP_AUTHORIZATION: "Bearer standalone-test",
      };

      const ok = await runScript({
        scriptPath,
        args: ["schedule_task", "-"],
        env,
        stdin: '\uFEFF{"scheduledTaskId":"task-1","enabled":false}\r\n',
      });
      expect(ok.stderr).toBe("");
      expect(ok.code).toBe(0);
      expect(JSON.parse(ok.stdout)).toEqual({
        structuredContent: { scheduledTaskId: "task-1", enabled: false },
        content: [{ type: "text", text: "Paused." }],
        isError: false,
      });
      expect(methods).toEqual(["initialize", "notifications/initialized", "tools/call"]);
      expect(seenToolCalls).toEqual([
        { name: "schedule_task", arguments: { scheduledTaskId: "task-1", enabled: false } },
      ]);
      expect(deleteCount).toBe(1);

      const badJson = await runScript({
        scriptPath,
        args: ["schedule_task", "{not-json"],
        env,
      });
      expect(badJson.code).toBe(2);
      expect(badJson.stderr).toContain("valid JSON");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await NodeFSP.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
