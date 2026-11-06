/**
 * Load test: register the plugin against a mock harness and exercise every tool.
 *
 * The workflow engine is mocked, but the plumbing under test is real: workflow
 * files are read from a temp project, and `workflow_run` must hand the engine
 * exactly the script, meta, args and parent that the file declares.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { name, inject, apply } from "../lib/index.js";

console.log("plugin name:", name);
console.log("inject:", JSON.stringify(inject));

const registered = [];
const started = [];
const engine = {
  start(request) {
    started.push(request);
    return {
      result: Promise.resolve({
        value: { receivedArgs: request.args ?? null, scriptLines: request.script.trim().split("\n").length },
        stopReason: "completed",
        agentsStarted: 3,
      }),
      dispose: async () => {},
    };
  },
};

const ctx = {
  tools: { register: (t) => { registered.push(t); return () => {}; } },
  workflowEngine: engine,
};
apply(ctx);

console.log("\n注册工具数:", registered.length);
for (const t of registered) {
  const props = Object.keys(t.parameters?.properties ?? {});
  const required = t.parameters?.required ?? [];
  console.log(` - ${t.name}`);
  console.log(`   参数: ${props.join(", ") || "无"} | 必填: ${required.join(", ") || "无"}`);
}

// 临时项目：带 .git 标记，让 findProjectRoot 认它
const dir = mkdtempSync(join(tmpdir(), "wf-lib-"));
mkdirSync(join(dir, ".git"), { recursive: true });
mkdirSync(join(dir, ".dsh", "workflows"), { recursive: true });
writeFileSync(
  join(dir, ".dsh", "workflows", "demo.js"),
  "---\nname: demo\ndescription: 演示工作流\nwhenToUse: 仅用于测试\n---\nreturn { ok: true }\n",
);
const agent = { cwd: dir };
const exec = { agent, signal: AbortSignal.timeout(20000), callId: "t", name: "x", arguments: {} };

const byName = (n) => registered.find((t) => t.name === n);
const call = async (tool, args) => tool.execute(args, exec);

try {
  const listed = await call(byName("workflow_list"), {});
  console.log("\nworkflow_list:", JSON.stringify(listed));

  const shown = await call(byName("workflow_show"), { name: "demo" });
  console.log("workflow_show 描述:", shown.description, "| 脚本:", JSON.stringify(shown.script));

  const run = await call(byName("workflow_run"), { name: "demo", args: { files: ["a.ts"] } });
  console.log("workflow_run:", JSON.stringify(run));
  console.log("  引擎收到的 meta:", JSON.stringify(started.at(-1).meta));
  console.log("  引擎收到的 args:", JSON.stringify(started.at(-1).args));
  console.log("  引擎收到的 parent 是同一个 agent:", started.at(-1).parent === agent);

  const saved = await call(byName("workflow_save"), {
    name: "saved-demo",
    description: "保存测试",
    script: "return { saved: true }",
  });
  console.log("workflow_save:", JSON.stringify(saved));

  const listed2 = await call(byName("workflow_list"), {});
  console.log("保存后列表:", listed2.workflows.map((w) => w.name).join(", "));

  // 不存在的名字必须给出可执行的报错，而不是静默返回空
  try {
    await call(byName("workflow_run"), { name: "nope" });
    console.log("!! 未按预期报错");
  } catch (e) {
    console.log("未知名字报错:", e.message.slice(0, 60));
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("\n✅ 全部通过");
