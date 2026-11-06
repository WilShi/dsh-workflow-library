/**
 * Model-facing tools for the workflow library.
 *
 * `workflow_list` / `workflow_show` let the model discover what exists before
 * authoring something new; `workflow_run` executes a saved workflow by name;
 * `workflow_save` turns a working inline workflow into a reusable file.
 */

import { defineTool } from "@deepseek-ai/dsh-tools";
import type { Context } from "@deepseek-ai/cordis";
import { discoverWorkflows, loadWorkflow, saveWorkflow } from "./library.ts";

const text = (s: string) => [{ type: "text" as const, text: s }];

/** The engine surface this plugin drives; structural so the plugin loads without it. */
interface WorkflowEngineLike {
  start(request: {
    script: string;
    meta: { name: string; description: string; whenToUse?: string };
    args?: unknown;
    parent: unknown;
    signal?: AbortSignal;
  }): {
    result: Promise<{ value: unknown; stopReason: string; agentsStarted: number; error?: string }>;
    dispose(): Promise<void>;
  };
}

/** Resolve the directory the agent is operating on. */
function resolveCwd(agent: unknown): string {
  const candidate = (agent as { cwd?: unknown } | undefined)?.cwd;
  return typeof candidate === "string" && candidate ? candidate : process.cwd();
}

/**
 * Wrap a non-object script result so the declared output schema stays honest.
 *
 * A workflow script may return any JSON value, so the object is JSON round-tripped
 * to guarantee it is serializable before it reaches the tool result.
 */
function asObjectValue(value: unknown): Record<string, unknown> {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : { result: value ?? null };
  return JSON.parse(JSON.stringify(source)) as Record<string, unknown>;
}

export function createWorkflowTools(ctx: Context) {
  const getEngine = () => (ctx as unknown as { workflowEngine?: WorkflowEngineLike }).workflowEngine;

  const listTool = defineTool({
    name: "workflow_list",
    description: "列出当前项目可用的工作流模板（来自 .dsh/workflows、.agents/workflows 和用户目录）。运行工作流前先用它确认名字。",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          workflows: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string" },
                description: { type: "string" },
                whenToUse: { type: "string" },
                source: { type: "string" },
              },
            },
          },
        },
      },
      render: (_a, value) => {
        const v = value as { workflows: { name: string; description: string; source: string }[] };
        if (!v.workflows.length) return text("没有找到工作流模板。可以在 .dsh/workflows/ 下新建，或用 workflow_save 保存一个。");
        return text(`可用工作流 ${v.workflows.length} 个：\n` + v.workflows.map((w) => `- ${w.name}（${w.source}）：${w.description || "无描述"}`).join("\n"));
      },
    },
    async execute(_args, exec) {
      const list = discoverWorkflows(resolveCwd(exec?.agent));
      return { workflows: list.map((w) => ({ name: w.name, description: w.description, ...(w.whenToUse ? { whenToUse: w.whenToUse } : {}), source: w.source })) };
    },
  });

  const showTool = defineTool({
    name: "workflow_show",
    description: "查看某个工作流模板的元信息和完整脚本，便于在运行前确认它做什么、需要什么参数。",
    parameters: {
      name: { type: "string", required: true, description: "工作流名字，如 release-check" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          source: { type: "string" },
          path: { type: "string" },
          script: { type: "string" },
        },
      },
      render: (_a, value) => {
        const v = value as { name: string; description: string; path: string; script: string };
        return text(`工作流 ${v.name}\n描述：${v.description || "无"}\n文件：${v.path}\n\n脚本：\n${v.script}`);
      },
    },
    async execute(args, exec) {
      const def = loadWorkflow(resolveCwd(exec?.agent), args.name);
      if (!def) throw new Error(`找不到工作流「${args.name}」。先用 workflow_list 看看有哪些。`);
      return { name: def.name, description: def.description, source: def.source, path: def.path, script: def.script };
    },
  });

  const runTool = defineTool({
    name: "workflow_run",
    description: "按名字运行一个已保存的工作流模板，可传入 args 参数对象。脚本里通过 args 全局变量读取。这是复用工作流的主要入口。",
    parameters: {
      name: { type: "string", required: true, description: "工作流名字" },
      args: { type: "object", additionalProperties: true, description: "传给脚本的参数对象，脚本中作为 args 全局变量" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          stopReason: { type: "string" },
          agentsStarted: { type: "number" },
          value: { type: "object", additionalProperties: true },
        },
      },
      render: (_a, value) => {
        const v = value as { name: string; stopReason: string; agentsStarted: number; value: Record<string, unknown> };
        return text(`工作流「${v.name}」${v.stopReason === "completed" ? "完成" : "未完成（" + v.stopReason + "）"}，启动 ${v.agentsStarted} 个子 agent。\n\n返回值：\n${JSON.stringify(v.value, null, 2)}`);
      },
    },
    async execute(args, exec) {
      const engine = getEngine();
      if (!engine) throw new Error("当前 DSH 没有启用 workflow 引擎（@deepseek-ai/dsh-workflow 未安装）。");
      const parent = exec?.agent;
      if (!parent) throw new Error("workflow_run 需要一个运行中的 agent 作为父级，当前调用没有。");
      const def = loadWorkflow(resolveCwd(parent), args.name);
      if (!def) throw new Error(`找不到工作流「${args.name}」。先用 workflow_list 看看有哪些。`);
      const run = engine.start({
        script: def.script,
        meta: { name: def.name, description: def.description, ...(def.whenToUse ? { whenToUse: def.whenToUse } : {}) },
        args: args.args,
        parent,
        ...(exec?.signal ? { signal: exec.signal } : {}),
      });
      try {
        const result = await run.result;
        if (result.stopReason !== "completed") {
          throw new Error(`工作流「${def.name}」未完成：${result.stopReason}${result.error ? " - " + result.error : ""}`);
        }
        return {
          name: def.name,
          stopReason: result.stopReason,
          agentsStarted: result.agentsStarted,
          // The script's return value is arbitrary JSON; the schema types it as an
          // open object, so widen to the schema's JsonValue element type here.
          value: asObjectValue(result.value) as Record<string, never>,
        };
      } finally {
        await run.dispose();
      }
    },
  });

  const saveTool = defineTool({
    name: "workflow_save",
    description: "把一个可以复用的编排脚本保存成工作流模板文件（.dsh/workflows/<name>.js），之后可以用 workflow_run 按名字重复运行。适合把刚刚跑通的多 agent 流程沉淀下来。",
    parameters: {
      name: { type: "string", required: true, description: "工作流名字，kebab-case，如 release-check" },
      description: { type: "string", required: true, description: "一句话说明这个工作流做什么" },
      script: { type: "string", required: true, description: "编排脚本正文（纯 JS，支持 top-level await，以 return 结束）" },
      whenToUse: { type: "string", description: "什么时候该用它" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          path: { type: "string" },
        },
      },
      render: (_a, value) => {
        const v = value as { name: string; path: string };
        return text(`已保存工作流「${v.name}」到 ${v.path}\n下次直接 workflow_run ${v.name} 即可。`);
      },
    },
    async execute(args, exec) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(args.name)) {
        throw new Error("工作流名字必须是 kebab-case（小写字母、数字、连字符），如 release-check。");
      }
      const path = saveWorkflow(resolveCwd(exec?.agent), {
        name: args.name,
        description: args.description,
        ...(args.whenToUse ? { whenToUse: args.whenToUse } : {}),
      }, args.script);
      return { name: args.name, path };
    },
  });

  return [listTool, showTool, runTool, saveTool];
}
