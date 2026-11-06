/**
 * Run the end-to-end test against a real DeepSeek Harness checkout.
 *
 * The harness packages must resolve from a single node_modules, so the driver
 * and the built plugin are staged inside the harness workflow package and run
 * there — the same technique the harness uses for its own built-worker e2e.
 *
 * Usage:
 *   npm run build && DSH_REPO=~/Documents/Code/deepseek-harness node scripts/e2e.mjs
 */

import { copyFileSync, existsSync, rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const pluginEntry = join(here, "..", "lib", "index.js");
const driverSource = join(here, "e2e-driver.mjs");

const repo = process.env.DSH_REPO ?? join(homedir(), "Documents", "Code", "deepseek-harness");
const host = join(repo, "packages", "workflow", "workflow-worker-thread");

if (!existsSync(host)) {
  console.log(`跳过端到端测试：${repo} 下没有 DSH 源码。`);
  console.log("设置 DSH_REPO 指向 deepseek-harness 仓库即可运行。");
  process.exit(0);
}
if (!existsSync(pluginEntry)) {
  console.error("先运行 npm run build 生成 lib/index.js");
  process.exit(1);
}

const stagedPlugin = join(host, ".wf-e2e-plugin.mjs");
const stagedDriver = join(host, ".wf-e2e-driver.mjs");

try {
  copyFileSync(pluginEntry, stagedPlugin);
  copyFileSync(driverSource, stagedDriver);
  const { stdout } = await run(process.execPath, [stagedDriver], { cwd: host, timeout: 180_000 });
  process.stdout.write(stdout);
  if (!stdout.includes("E2E_PASS")) process.exit(1);
} catch (error) {
  if (error.stdout) process.stdout.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  if (!error.stdout && !error.stderr) console.error(error.message);
  process.exit(1);
} finally {
  rmSync(stagedPlugin, { force: true });
  rmSync(stagedDriver, { force: true });
}

console.log("\n端到端通过");
