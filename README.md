# dsh-workflow-library

> 把工作流存成文件，按名字重复运行。可进 git、可 code review、可团队共享。

DSH 自带 `workflow` 工具，让模型写编排脚本扇出到多个子 agent。但那段脚本是**每次现写的**，跑完就没了。

这个插件补上缺的那一层：**工作流以文件形式存在项目中，按名字运行，可以带参数。**

## 安装

```bash
dsh plugin add dsh-workflow-library
```

## 工作流长什么样

在项目里建 `.dsh/workflows/review-files.js`：

```js
---
name: review-files
description: 并发审查多个文件
whenToUse: 需要一次性审查一批文件时
---
const files = (args && args.files) || []

const results = await Promise.all(
  files.map(async (file) => {
    const answer = await agent({ prompt: `审查 ${file}，指出最严重的问题` })
    return { file, review: String(answer) }
  }),
)

return { reviewed: results.length, results }
```

上半部分是元信息，下半部分是脚本正文——就是原生 `workflow` 工具里写的那个脚本体，一字不改。

## 用起来

```
> 跑一下 review-files，审查 src/index.ts 和 src/cli.ts
```

模型会调用 `workflow_run`，把 `args` 传进去。之后每次都只需要说「跑一下 review-files」。

## 四个工具

| 工具 | 作用 |
| --- | --- |
| `workflow_list` | 列出当前项目可用的工作流 |
| `workflow_show` | 看某个工作流的元信息和完整脚本 |
| `workflow_run` | 按名字运行，可传 `args` 参数 |
| `workflow_save` | 把刚跑通的流程存成模板文件 |

## 目录约定

和 DSH 的 skill 约定保持一致，按优先级查找：

| 优先级 | 路径 |
| --- | --- |
| 1 | `<项目根>/.dsh/workflows/` |
| 2 | `<项目根>/.agents/workflows/` |
| 3 | `<DSH_HOME>/workflows/` |

项目根 = 最近的包含 `.git` 的祖先目录。多个目录里有同名工作流时，**优先级高的生效**（项目内的会覆盖用户目录的）。

## 为什么不直接用原生 workflow 工具

| | 原生 `workflow` 工具 | 本插件 |
| --- | --- | --- |
| 脚本来源 | 模型每次现写 | 从磁盘读取 |
| 能否复用 | ❌ | ✅ 按名字 |
| 能否进 git | ❌ | ✅ |
| 能否团队共享 | ❌ | ✅ |
| 能否传参 | ✅ | ✅ |

原生工具适合一次性的编排。这个插件适合**反复用的流程**——比如每次发版前的检查清单、每周的依赖审计、固定格式的报告生成。

## 实现说明

- 编排引擎用的是 DSH 自带的（`ctx.workflowEngine.start()`），本插件不实现任何编排逻辑
- 只在 `tools` 上注册，引擎在调用时才查找，所以没装引擎的部署也能正常加载插件（`workflow_run` 会给出明确报错）
- 前置元信息解析是极简 YAML 子集，只支持 `key: value`

## 开发

```bash
npm install --ignore-scripts
npm run verify   # tsc --noEmit && tsdown && node scripts/load-test.mjs
```

## License

MIT
