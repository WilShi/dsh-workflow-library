/**
 * dsh-workflow-library — reusable workflows for DeepSeek Harness.
 *
 * The harness ships a `workflow` tool that runs a model-authored orchestration
 * script, but the script is written fresh on every call and never persists.
 * This plugin adds the missing layer: scripts saved as files, discovered from
 * the project (so they can live in git and be shared), and runnable by name
 * with arguments.
 *
 * The workflow engine stays the harness's own — this plugin never implements
 * orchestration, it only stores, discovers, and starts runs.
 */

import type { Context } from "@deepseek-ai/cordis";
import { createWorkflowTools } from "./tools.ts";

/** Plugin name used by the Cordis loader and `cordis.patch.yml`. */
export const name = "dsh-workflow-library";

/**
 * Only the tool registry is required. The workflow engine is looked up at call
 * time, so the plugin still installs on deployments without it (and reports a
 * clear error from `workflow_run` instead of failing to load).
 */
export const inject = ["tools"];

/**
 * Register the workflow-library tools on the harness tool registry.
 *
 * Registration is an effect: disposing this plugin's fiber unregisters them.
 * @param ctx - the Cordis context supplied by the loader.
 */
export function apply(ctx: Context): void {
  for (const tool of createWorkflowTools(ctx)) {
    ctx.tools.register(tool);
  }
}
