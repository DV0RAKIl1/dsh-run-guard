# 🛡️ dsh-run-guard

> DeepSeek Harness 插件 · **Agent 运行节奏守护** — 一体两面,让 LLM 在长任务中既不会「推理死循环停不下来」,也不会「想完就停不干活」。

> **要求 dsh `0.2.1-rc.2`**（peerDependencies 由 dsh 在安装与启动时校验；不匹配会被拒绝加载或要求 exact-version 豁免）。

[![GitHub stars](https://img.shields.io/github/stars/Dis2017/dsh-run-guard?style=flat-square)](https://github.com/Dis2017/dsh-run-guard)
[![dsh-plugin](https://img.shields.io/badge/ecosystem-dsh--plugin-blue?style=flat-square)](https://github.com/topics/dsh-plugin)
[![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)

---

## ✨ 功能特性

| 能力 | 方向 | 说明 |
|------|------|------|
| **guard(刹车)** | 拦截推理死循环 | 监听 `llm/stream` 流,滑动窗口重复率检测 + 硬性上限双保险,死循环在 **1~2 秒内被中断**(而非空转数分钟);中断后**自动重试**(默认每 turn 2 次,可配),仍失败才停止并给出中文原因提示 |
| **recovery(恢复)** | 上游请求失败自动重试 | `PI_AI_ERROR` 等瞬时上游失败(不在 llm-retry 默认集合的)也自动重试(白名单可扩展),与 guard 共用每 turn 上限 |
| **continue(油门)** | 防止提前停摆 | turn 正常结束后自动续跑:有未完成 todo 时注入状态续跑;无 todo 但模型「想完就停」(最后只有推理、无正文无工具调用)时注入简洁提示续跑 |
| **pause_work 暂停** | 人工控制 | 模型可随时调用 `pause_work` 工具主动暂停,两路都不会再自动继续 |

**核心设计**:刹车与油门共用一套状态感知,互不干扰——guard 中断的 turn 以 error 结束,continue 天然不会误推;continue 推进的新 turn 若再次死循环,guard 立刻拦截。闭环自洽。

---

## 🎯 为什么需要它

DeepSeek V4 Flash 配合 `reasoningEffort: max` 在长任务中会出现两种典型异常:

1. **想完就停**:模型输出完整思考后直接正常结束 turn,没有正文、没有工具调用,留下未完成的任务——表现为「不干活」。
2. **推理死循环**:模型推理进入重复空转(实测单步可输出 10.9 万块、132 万字符垃圾推理),持续数分钟不停——表现为「停不下来」。

DeepSeek Harness 的 agent loop 本身对这两种异常都没有调控机制。本插件在两端补齐:**guard 保证它不会无限干活,continue 保证它不会不干活**。

---

## 🧠 工作原理

```
模型推理流 ──► llm/stream (waterfall) ──► [guard] 滑动窗口重复率 + 硬闸
                                            │ 触发:注入 REASONING_GUARD 错误中断
                                            ▼
                                   agent/request-error 恢复扩展点
                                            │ 错误码 ∈ {REASONING_GUARD} ∪ autoRetryErrors 且
                                            │ 该 turn 重试 < maxGuardRetries → 写一条 llm/retry
                                            │ (序号按 (turn,step,provider,policyKey) 链计算)并自动重跑 step
                                            └─ 超限或非可重试错误 → turn 以 error 结束(用户可见)
                                            ▲
                                            │ 天然抑制:continue 只在 completed 触发
                                            │
turn/end (completed) ──► [continue] 有 todo → 注入状态续跑(计数上限)
                              └─────── 无 todo + 想完就停 → 注入简洁提示续跑(无上限)
                              └─────── pause_work 已标记 → 不续跑
```

| 扩展点 | 用途 |
|--------|------|
| `llm/stream`(waterfall) | guard:包装每次模型调用,拦截 reasoning 死循环 |
| `agent/request-error`(waterfall) | recovery:中断/白名单错误自动重试 |
| `session/event` | continue:跟踪 turn 生命周期、todo 状态、产出判定 |
| `systemPrompt.context` | continue:预防层——有未完成 todo 时注入状态与引导 |
| `tools.register` | continue:注册 `pause_work` 暂停工具 |
| `plugins.row.config`(client slot) | 配置入口:Plugins 页面上的 run-guard 配置卡片 |

---

## 🚀 快速开始

### 安装(GitHub 发布版,推荐)

```bash
dsh plugin --profile web add "github:Dis2017/dsh-run-guard#v0.2.2"
```

`dsh plugin add` 检测到包内 `dsh.bundle` 声明后自动挂载:追加进 profile 的 bundles 列表,插件行由 bundle patch 提供。

### 验证

1. 重启 GUI（或让 dsh-hmr 完成一次配置重载）
2. 打开 **设置 → 插件**,确认 `dsh-run-guard` 为 **Mounted / Enabled**
3. 展开该 bundle 的 **run-guard** 行 → 打开它的配置页，编辑总开关 / Guard 死循环拦截 / Continue 自动继续；保存后 dsh 写回 profile patch 并重载插件，**无需重启进程**
4. 正常使用:死循环会被 1~2 秒内中断并自动重试(页面可见);「想完就停」后会自动收到续跑提示

> **0.2.1-rc.2 起配置入口变化**：插件不再自注册 settings 命名空间（`ctx.settings.register` 已删除），宿主也**不会**按 `Config` schema 自动生成配置页（官方 `dsh-settings` 文档：`autoGenerate` 目前没有已发布的客户端消费）。配置入口必须由插件自己提供 client 组件，注册到 Plugins 页面的 `plugins.row.config` slot，key 为 `<包名>#<patch 行 id>`（本插件：`dsh-run-guard#run-guard`）；没有注册者的行不显示任何配置控件。表单能力由宿主下发（`ctx.configForms.get('run-guard')`），不再需要插件自建 HTTP 路由。
>
> 另外，**只有标记 `.volatile()` 的字段可写**（宿主按此判定哪些路径能 live 编辑），新增配置项时别忘了加这个标记；`test/settings.test.js` 有回归保护。

### 开发模式(绝对路径挂载,改代码即时生效)

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: run-guard
      name: /绝对/路径/dsh-run-guard/lib/index.js?v=1
```

---

## ⚙️ 配置

配置由 dsh 的 Cordis Loader 按插件导出的 `Config` schema 解析 profile patch 里的插件条目；编辑入口在 Plugins 页面（见上文「验证」）。下表是全部字段：

| 配置项 | 默认 | 说明 |
|--------|------|------|
| `enabled` | `true` | 总开关 |
| `guard.enabled` | `true` | 死循环拦截开关 |
| `guard.windowChars` | `2000` | 滑动窗口大小(字符) |
| `guard.substrLen` | `32` | 重复检测子串长度 |
| `guard.repeatRatio` | `0.7` | 窗口重复率阈值(≥ 触发) |
| `guard.checkEvery` | `50` | 每 N 块检测一次(降频) |
| `guard.maxBlocks` | `10000` | 硬闸:单次调用推理块数上限 |
| `guard.maxChars` | `500000` | 硬闸:单次调用推理字符数上限 |
| `guard.maxGuardRetries` | `2` | 中断后每 turn 自动重试次数上限(0 禁用) |
| `guard.autoRetryErrors` | `["PI_AI_ERROR"]` | 额外自动重试的错误码白名单(REASONING_GUARD 恒重试);瞬时上游错误可加入 |
| `continue.enabled` | `true` | 自动继续开关 |
| `continue.maxAutoFollowups` | `3` | 有 todo 场景连续无产出续跑上限 |

---

## 🧪 测试

```bash
pnpm install
pnpm test
```

95 个单元/集成测试,覆盖:

- **guard 检测器**:死循环触发、正常流不误报、硬闸、滑动窗口精确性、极端配置
- **中断恢复**:guard/上游错误自动重试、超限停止、turn 隔离、白名单外与持久错误不干预
- **llm/retry 链语义**:同一 `(turn,step,provider,policyKey)` 链内序号连续且 `retryId` 固定、换 step 或 provider 即新链从 1 开始、超限不写事件、`turn/end` 清理、跨会话隔离
- **流拦截**:透传、中断、顺序保持、退化降级
- **continue**:todo 续跑、想完就停续跑、暂停抑制、计数上限、UI 投影恢复、持久化恢复走 `sessionPersistence.open(id,'read')`
- **配置**:`Volatile` 句柄解包、volatile/普通配置等价、每个叶子字段都标记 `.volatile()`
- **client half**:bundle 注册形状、`plugins.row.config` key、字段表与 Config schema 一致性、summary/page 两分支渲染
- **两 half 集成**:guard 中断不误推、continue 推进的新 turn 死循环被拦截

---

## 🔧 故障排查

### `Cannot read properties of undefined (reading 'prepare')`

**根因**:profile 顶层 node_modules 出现了第二份 `@deepseek-ai/dsh-tools` 副本(通常由插件把 `@deepseek-ai/*` 放进 `dependencies` 引起,pnpm hoisted 会提升)。DSH 的 `TOOL_RUNTIME_SCHEDULER` 是 Symbol,双实例下跨实例读取为 undefined。

**修复**:把 `@deepseek-ai/*` 移回 `peerDependencies`(宿主单例),清理 profile 顶层副本后重启。

```bash
cd ~/.dsh/profiles/web
pnpm remove <出问题的插件>
# 确认 node_modules/@deepseek-ai/ 已清空
ls node_modules/@deepseek-ai/
# 重启 dsh web
```

### 历史会话打开卡死

**根因**:死循环推理被全量落盘(单 step 可达 132 万字符),GUI 打开时前端处理巨型事件。

**修复**:本插件的 guard 保证**之后**不会再产生;存量会话需清理数据(结构保留、清空死循环文本)或归档。

### `stored log is corrupt: SessionFormatError: llm/retry skips its policy attempt sequence`

**根因**:0.1.x 时代本插件把 per-turn 的重试次数直接写进伪造的 `llm/retry.retry`。dsh 的会话格式校验(`dsh-session-format-v3-to-v4`,**0.2.0-rc.1 才引入**)要求该字段是 `(turn, step, provider, policyKey)` 链上的尝试序号、必须从 1 开始连续 —— 于是"同一 turn 的第二次中断发生在新的 step"时写出了 `retry=2` 的新链,整份日志被判损坏,会话再也打不开。

**修复**:本插件已改为 per-`(turn,step,provider,policyKey)` 链计数,并为每条链固定 `retryId=run-guard:[turn,step,provider,policyKey]`。升级后新产生的中断不再损坏会话。**已损坏的存量会话不会被自动修复**——它们需要人工订正日志里那条违规的 `llm/retry`(`retry` 改为该链应有的序号、`retryId` 改为对应的 `run-guard:[...]`)后重新压缩,或直接归档放弃。

诊断哪条会话损坏、坏在哪条链:

```bash
zstd -dc ~/.dsh/sessions/<workspace>/<session-id>/session.v4.jsonl.zstd \
  | grep -n '"retryId":"run-guard:' 
```

---

## 🤝 开发

### 仓库结构

```
dsh-run-guard/
├── lib/
│   ├── index.js      # 合并入口:Config schema(volatile) + 按子开关挂载
│   ├── config.js     # 配置读取:解包 Volatile 句柄
│   ├── guard.js      # 刹车 half:检测器 + llm/stream 拦截 + 中断文案
│   ├── continue.js   # 油门 half:自动继续 + pause_work
│   ├── client.js     # client half:Plugins 页面的 run-guard 配置卡片
│   └── debug.js      # /tmp/dsh-run-guard.log 诊断日志
├── test/             # 95 个测试(guard / stream / continue / index / recovery / settings / client / integration)
└── cordis.patch.yml  # bundle patch(dsh plugin add 自动挂载)
```

### 迭代流程

```bash
git commit -m "fix: ..."
git push origin main
git tag v0.2.2 && git push origin v0.2.2
dsh plugin --profile web add "github:Dis2017/dsh-run-guard#v0.2.2"   # 或 remove + add 升级
```

### 依赖约定(重要)

- `@deepseek-ai/*` → **peerDependencies**(宿主提供单例),绝不能放 `dependencies`
- schema 必须用 `@deepseek-ai/schemastery`(宿主单例,`~3.18.5`),不要用裸 `schemastery`:后者 3.18.0 没有 `.volatile()`,字段不会进设置表单
- 测试用的 dsh 依赖 → `devDependencies`(镜像 peer 版本,不随安装)
- client half 通过 `dsh.client.inject` 声明它依赖的 client 包(`@deepseek-ai/dsh-client-ui-settings` 提供 `configForms`，`@deepseek-ai/dsh-client-ui-plugin-manager` 声明 `plugins.row.config` slot)；client 侧不需要、也不应声明 `@deepseek-ai/dsh-*` 的 Host 包

违反此约定会导致上述 `prepare` 错误。

---

## 📄 许可证

[MIT](LICENSE) © 2026 Dis2017
