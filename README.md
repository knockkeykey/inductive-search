# 感应式搜索

浏览器扩展名称：**感应式搜索**。

这是基于 [tymscar/hunch](https://github.com/tymscar/hunch) 的公开派生项目，由 [knockkeykey](https://github.com/knockkeykey) 维护。本项目保留原作者 **Oscar Molnar（tymscar）** 的代码历史与 MIT 许可证。

原项目提供由 Jev 驱动的网页段落查找。本分支增加条件筛选、原文结果侧边栏、搜索范围和带来源的本地摘录，并接入 OpenRouter 与 OpenLux。

## 本分支新增的功能

| 功能 | 使用方式 |
| --- | --- |
| 按条件找原文 | 每行一个条件，最多 5 个；选择全部满足或任一满足 |
| 搜索结果侧边栏 | 查看原文、所在标题和各条件分数；点击定位网页段落 |
| 搜索范围 | 整页、仅正文、当前选区 |
| 原文摘录与来源保存 | 保存原文、网页标题、网址、所在标题、搜索条件与时间；复制或导出 Markdown |
| API 服务商切换 | TypeSafe、OpenRouter、OpenLux 的 Key 和模型分别保存 |
| 中文输入与搜索状态 | 支持两字问题和输入法；手动提交搜索；区分无高相关结果与部分请求失败 |

摘录侧边栏标注上游来源。新功能属于本分支，不表示上游已经合并或支持它们。

## 安装

需要 Node.js 20.19+、22.13+ 或 24+（开发依赖的要求）。

```sh
git clone https://github.com/knockkeykey/inductive-search.git
cd inductive-search
npm ci
npm run build
```

- **Chrome / Edge**：打开 `chrome://extensions` 或 `edge://extensions`，启用开发者模式，选择“加载未打包的扩展程序”，加载 `dist/chrome`。
- **Firefox**：在 `about:debugging#/runtime/this-firefox` 加载 `dist/firefox/manifest.json`，这是临时附加组件。
- 构建也输出 `dist/safari`；Safari 需要另行转换并打包，当前没有验证 Safari 的运行效果。

更新代码后重新构建并在扩展管理页重新加载；已经打开的网页建议刷新。

## 配置 API

打开扩展设置，选择服务商，粘贴该服务商的密钥，点击“保存”。

| 服务商 | 获取密钥 | 默认模型 | 搜索接口 |
| --- | --- | --- | --- |
| TypeSafe 官方 | [TypeSafe 控制台](https://console.typesafe.ai/keys) | `jev-latest` | `https://api.typesafe.ai/v1/systemone` |
| OpenRouter | [OpenRouter 密钥](https://openrouter.ai/settings/keys) | `~typesafe/jev-latest` | `https://openrouter.ai/api/v1/systemone` |
| OpenLux | [OpenLux 控制台](https://www.openlux.ai/login) | `jev-1.13.0` | `https://api.openlux.ai/v1/systemone` |

OpenRouter 可固定选择 `typesafe/jev-1.13`，接入依据为 [官方 TypeSafe SDK 指南](https://openrouter.ai/docs/guides/community/typesafe-sdk)。

OpenLux 使用 [Jev 专用 System One 文档](https://doc.openlux.ai/en/reference/typesafe/v1/systemone?leaf=c%3A1790771919883) 中的 `state` 和 `questions` 请求格式。模型菜单还提供站点通用示例中的 `jev-1.13.0:stable` 路由名，但该别名是否可用取决于账号权限，尚未用真实 Key 验证。该模型的专用接口为 `/v1/systemone`，不使用通用的 Chat Completions 示例。

这里调用的是 Jev 决策模型。GPT、Claude 等自由文本聊天模型不能直接替代它。

## 使用

macOS 按 **Option + F**，其他平台默认 **Ctrl + Shift + F**，也可以点击工具栏「感应式搜索」图标。正常的 Cmd/Ctrl + F 保持不变。

Chrome 的快捷键在 `chrome://extensions/shortcuts` 修改；Firefox 可在扩展设置页修改。

### 按意思找

选择“按意思找”，输入问题，按 Enter 或点击“搜索”。支持中文两字输入；拼音确认不会提交请求。仅输入文字不会调用 API。

例如：

- 哪一段写了小蝌蚪认错妈妈？
- 哪些内容提到了退款限制？
- 作者实际测试发现了什么？

### 按条件找

选择“按条件找”，每行写一个可由原文判断的条件，例如：

```text
描述作者实际进行的测试
包含具体数字或测量结果
```

- **全部满足**：同一文字块的每个条件分数都必须达到阈值。
- **任一满足**：至少一个条件达到阈值。
- 点击“搜索”提交；条件框中 Enter 换行，Cmd/Ctrl + Enter 提交。

Jev 为每个条件分别返回判断分数。全部满足取最低分、任一满足取最高分用于筛选和排序；这不是复合事件的校准概率。侧边栏显示每个条件的分数，方便检查判断。

条件应用于每个文字块。分散在不同段落的证据不会自动合并为“同一段满足全部条件”。

### 搜索范围

- **整页**：页面可提取的可见文字，包括导航和推荐区域。
- **仅正文**：优先提取 `article`，其次 `main` / 主内容区域；没有明确正文结构时使用整页并排除语义导航区域。自动识别可能不准确。
- **当前选区**：在网页上划选文字后，可从悬浮栏直接提问；也可打开感应式搜索，再选择这个范围。只提交选中的文字，保留其原文位置用于跳转。

每次提交都会重新提取范围内文字。尚未加载的内容、iframe 内部和封闭 Shadow DOM 内容不在提取范围中。

### 结果与摘录

- 侧边栏展示符合阈值的原文，点击结果跳转；底部 ▲ / ▼ 切换结果。
- “复制原文与来源”复制段落、标题、网址和所在标题。
- “保存摘录”存到浏览器扩展的本地存储，相同网址和原文不会重复保存。
- “已存摘录”展示各网页保存的内容，支持复制、单条删除和导出 Markdown。
- 摘录最多 500 条，达到上限后请先导出并清理。删除扩展也会删除其本地数据，请提前导出。
- “结果 / 摘录”可收起或展开侧边栏；再次按快捷键或按 Esc 关闭整个查找界面。

## 实现原理与边界

感应式搜索提取页面文字并分块，给每个块生成 Jev `noul` 问题。后台把网页标题、网址、文字块和问题发给选定服务商，验证返回值后把评分发回网页。界面按阈值 0.4 筛选、排序并高亮原文。

评分反映模型对条件是否满足的判断，不是事实正确率，也不代表关键词出现次数。当前没有精确关键词匹配兜底，因此页面出现某个词也可能没有高相关结果。这个插件定位原文，不生成答案或推理解释。

长页按文字量和问题数量分批，最多 4 个请求并行。OpenLux 使用更小批次给条件问题留出空间；字符预算是估算，不是精确 token 计数。已完成批次会逐步显示；部分失败会明确提示结果不完整。

浏览器限制访问的页面（`chrome://`、`about:`、扩展商店和内置 PDF 阅读器等）无法使用。

## 开发与验证

```sh
npm test
npm run check
npm run watch
```

`npm run check` 依次执行类型检查、Biome 检查、构建和 Firefox 扩展校验。自动测试覆盖服务商路由、快捷键触发、条件组合与请求预算、范围边界、并发摘录保存、Markdown 来源保留和侧边栏交互。

自动测试使用模拟 API，不代表真实 Jev 的命中质量或账号额度已经验证。实际效果需使用自己的 Key，在目标网页上确认。

## 隐私与许可证

只有提交搜索时才向所选服务商发送当前范围的文字、页面标题、网址和问题。关闭搜索会取消客户端请求；已经被服务商接收的请求仍可能计费。已存摘录不会随其他搜索发给服务商，默认不云同步。

详见 [PRIVACY.md](PRIVACY.md)。保留原作者的 [MIT License](LICENSE)。上游项目：[tymscar/hunch](https://github.com/tymscar/hunch)。
