# dsh-workflow-library 发布文案

## 定位一句话

把工作流存成文件，按名字重复跑。可进 git、可 code review、可团队共享。

---

## 版本 A：技术社区（V2EX / 掘金 / 即刻）

**标题**：DSH 的 workflow 工具很好用，但脚本跑完就没了——我补上了缺的那一层

DSH 自带的 `workflow` 工具让模型写一段 JS 编排脚本，扇出到几十个子 agent。这个设计很聪明。

但有个问题：**那段脚本是每次现写的，跑完就没了。**

如果你有一套固定流程——比如每次发版前「跑测试 → 查依赖变更 → 生成 changelog → 提 PR」——现在每次都得重新跟模型描述一遍。说完就没了，下次还得再说。

我翻了 workflow 子系统的源码，`WorkflowMeta.name` 的注释写着 "persistence key"，一开始以为有持久化。看完才发现：那个 persistence 只是**运行记录**，不是可复用库。

所以写了个插件 `dsh-workflow-library`。

**工作流就是一个文件**，放在项目的 `.dsh/workflows/` 下：

```js
---
name: review-files
description: 并发审查多个文件
---
const files = (args && args.files) || []
const results = await Promise.all(files.map(async (file) => ({
  file,
  review: String(await agent(`审查 ${file}`)),
})))
return { reviewed: results.length, results }
```

上半是元信息，下半是**原生 workflow 工具里写的那个脚本体，一字不改**。

之后就是「跑一下 review-files，审这几个文件」，模型调用 `workflow_run` 按名字执行。

**四个工具**：`workflow_list` / `workflow_show` / `workflow_run` / `workflow_save`。

最后这个是关键：模型成功跑完一段编排后，一条命令把它存成模板。**模板是用出来的，不是事先设计的。**

---

**验证**：端到端测试跑的是真实引擎——真实 Cordis + ToolRuntime + SubagentRuntime + WorkerThreadWorkflowEngine，脚本在真实 worker 线程执行，`agent()` 真实扇出。只有子 agent provider 换成桩，所以不需要模型 key：

```
  ok  workflow_run 真实执行：3 个子 agent，耗时 50ms
  ok  workflow_save 写入并立即出现在列表
E2E_PASS
```

装：`dsh plugin add dsh-workflow-library`
仓库：github.com/WilShi/dsh-workflow-library

---

## 版本 B：短版（交友/闲聊场景）

给 DSH 写了个小插件。

DSH 的 workflow 工具能让模型写脚本扇出到几十个子 agent——但脚本每次现写、跑完就没了。

我把工作流做成了文件：放 `.dsh/workflows/` 下，能进 git、能同事共享，按名字带参数跑。

顺手做了个 `workflow_save`：模型跑通一段流程后，一条命令存成模板。**模板是用出来的，不是事先设计的。**

端到端测试用的是真引擎，3 个子 agent 真的扇出去了。有人感兴趣可以试试。

---

## 发布时配的三张图（建议截图）

1. `.dsh/workflows/*.js` 的文件树 + 一个工作流文件内容
2. `npm run e2e` 的终端输出（那一串 ok 很有说服力）
3. 工具列表截图

---

## 提醒

- 提到「DSH」时最好带一句它是什么（不是所有人都知道）
- 不要写「第一个」「最好的」这类词，awesome 列表的评审明确说描述带营销词会被打回
- 如果发 V2EX 的「分享创造」，标题别用「震惊」「绝了」这类，那边反感
