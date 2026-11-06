---
name: review-files
description: 并发审查多个文件，返回每个文件的结论汇总
whenToUse: 需要一次性审查一批文件、又不希望逐个人工提问时
---
// args.files 是一个字符串数组，由 workflow_run 的 args 传入。
const files = (args && args.files) || []
if (!files.length) {
  return { reviewed: 0, note: "没有传入 args.files" }
}

const results = await Promise.all(
  files.map(async (file) => {
    const answer = await agent({
      prompt: `审查文件 ${file}：指出最严重的 1 个问题和 1 条改进建议，控制在 80 字以内。`,
    })
    return { file, review: String(answer).slice(0, 400) }
  }),
)

return { reviewed: results.length, results }
