# ADR-0002：开发 Agent 与审查工具的外层闭环

- 状态：Accepted（设计），不进入 M0–M4 核心验收
- 日期：2026-10-31
- 决策：支持“编码 Agent → 确定性测试 → 审查工具 → fix-request → 编码 Agent”的外层闭环；只通过结构化工件通信，不允许 Agent 自由对话。
- 关联：[ADR-0001 编排框架选型](./ADR-0001-编排框架选型.md) · [设计文档](./设计文档.md) · [技术可行性](./技术可行性-多Agent协同.md) · [功能规格](./功能.md)

---

## 1. 背景

Anthropic 的“How the Claude Code team does code review”（2026-10-15，用户提供摘要）描述了一个闭环：编码 Agent 写代码并自测，审查 Agent 通过 PR 评论给出发现，编码 Agent 读取评论后修复，再触发下一轮。文章同时记录了一个失控案例：Agent 作者 + Agent 审查者在一夜之间跑了 50+ 轮。

本 ADR 把该模式压缩为个人开发可用的“外层开发环”：

```
编码 Agent（作者/修复者）
   │ commit + 自测证据
   ▼
确定性检查/测试（判定）
   ▼
审查工具（Finder/Verifier，建议）
   ▼
fix-request（结构化反馈）
   │
   └──► 编码 Agent（下一轮）
```

它与现有设计的边界：

| 层 | 谁在协作 | 通信方式 | 是否允许直接对话 |
|---|---|---|---|
| 作者环 | 编码 Agent + 测试/lint/build | Agent 调用工具，读取退出码/日志 | 允许（Agent 使用工具） |
| 审查环 | Finder / Verifier / Aggregator | 编排器结构化 JSON | **不允许**（ADR-0001） |
| 外层开发环 | 编码 Agent + 测试 + 审查工具 | Git commit、测试结果、fix-request JSON | **不直接对话**，由工件传递 |

因此，现有文档中“Agent 不直接对话”只约束审查内部；外层修复环是明确增加的能力，但仍不使用自由聊天。

## 2. 范围与非目标

### 2.1 范围

- `fix-request` / `fix-result` 工件协议。
- Author-driven 的修复闭环（推荐）与可选的 Orchestrator-driven 模式。
- 测试文件保护、停止条件、轮次上限、人工接管点。
- 循环账本事件、审计字段、指标。
- 与编码 Agent（DeepSeek Harness、Qoder、OpenCode 等）的接入边界。

### 2.2 非目标

- 不让本工具自动修改代码、自动合并或自动部署。
- 不允许编码 Agent 修改测试/CI 后自动继续。
- 不让审查 Agent 修改代码或执行命令。
- 不做三个以上编码 Agent 的自由协作。
- 不替代标准审批门禁；循环通过不等于可合并。
- 不在 M0–M4 核心交付中强制实现；先以 opt-in 实验验证。

## 3. 角色与权限

| 角色 | 权限 | 禁止 | 备注 |
|---|---|---|---|
| 编码 Agent（作者/修复者） | 在隔离 worktree 写源码、运行测试、产出 commit | 改测试/CI、读取审查者上下文、自动合并 | 可以保持自己的实现会话 |
| 测试运行器 | 执行配置中的检查命令，输出退出码/JUnit/日志 | 由模型生成命令、访问网络、修改仓库 | 确定性，判定唯一来源 |
| 审查工具 | 只读取上下文，产出 findings | 修改代码、执行命令、看作者对话 | Finder/Verifier 全新上下文 |
| 循环控制器 | 计算继续/停止、生成 fix-request、写账本 | 修改代码、替代审批 | 确定性代码 |
| 人 | 决定方向、测试变更、高风险审批、reset | 无（最终负责） | 高风险路径必须在环外 |
| 可选第二审查方 | 只读、独立上下文、结构化 findings | 与作者共享上下文/会话 | 仅在 eval 证明收益后启用 |

## 4. 两种接入模式

### 4.1 Author-driven（推荐，先做）

编码 Agent 自己驱动循环，本工具只提供检查、审查和 fix-request：

```
# 编码 Agent 每写完一轮执行（review 内部会跑配置中的 checks）
npx review run --base main --head HEAD --json --fix-request .review/fix-request.json
```

- 编码 Agent 读取 `.review/fix-request.json`，修复后产生新 commit，再执行同一命令。
- 本工具不调用编码 Agent，不需要它的 API key；安全边界清晰。
- 代价：本工具无法强制编码 Agent 的成本/行为，只能记录观察到的 commit 与声明信息。
- 适合 DeepSeek Harness、OpenCode 等可运行 shell 的终端 Agent；Cursor/Qoder 若只能人工交互，则由人把 fix-request 喂给它们。

### 4.2 Orchestrator-driven（可选，后做）

```bash
review loop --author-cmd "<headless coding agent command>" --max-rounds 3
```

- 本工具在沙箱/worktree 中调用 headless 编码 Agent，自动完成多轮。
- 需要：编码 Agent 的 API/CLI、预算上限、容器隔离、权限最小化、失败恢复。
- 审计更完整（可记录每轮 stdout/stderr 和用量），但攻击面、成本与集成复杂度更高。
- 不作为 M1–M3 范围；先完成 Author-driven 与 eval。

### 4.3 自由对话（拒绝）

不实现“编码 Agent 与审查 Agent 自由聊天互相说服”的模式：

- 容易无限循环（文章案例 50+ 轮）；
- 无法稳定预算与审计；
- 容易互相强化错误或泄露实现意图；
- 与“审查者独立判断”的目标冲突。

## 5. 外层流程

```
┌────────────────────────────┐
│ 编码 Agent（作者）          │
│ 写源码 / 自测 / 产出 commit  │
└─────────────┬──────────────┘
              │ head_sha
              ▼
┌────────────────────────────┐
│ 循环控制器（我们的 CLI）     │
│ 1. 跑确定性检查/测试         │
│ 2. 测试绿 → 跑审查           │
│ 3. 评估进度/预算/轮次        │
└──────┬─────────────┬───────┘
       │ continue    │ pass / stop-human
       ▼             ▼
┌──────────────┐   ┌────────────────────┐
│ fix-request  │   │ 正常审批门禁 / 人工  │
│ (JSON)       │   │ （不自动合并）       │
└──────┬───────┘   └────────────────────┘
       │
       └──► 编码 Agent 下一轮
```

规则：

- 每轮先跑确定性检查；测试失败时**跳过 AI 审查**，只返回测试失败与日志，避免在红测试上浪费审查预算。
- 测试全绿后才运行审查；findings 只包含 confirmed 项，不包含 candidate。
- 轮次按作者修复轮计，测试修复轮也计数，最多 3 轮；每轮测试全绿后最多运行一次审查。
- 首次运行审查时全量；其后的审查只审新 hunks 与未解决 finding 的相关文件。
- 通过循环后仍需标准审批：low 自审 + 冷静期，high 外部 reviewer；不自动合并。
- 高风险路径（`.github/workflows/**`、auth、billing、migrations、infra、release 等）在无人值守模式下直接停止，转人工；不允许 Agent 自动循环。

## 6. fix-request 协议

### 6.1 示例

```json
{
  "schema": "review.fix-request.v1",
  "loop_id": "dl_20261031_01",
  "run_id": "r_20261031_02",
  "round": 2,
  "max_rounds": 3,
  "base_sha": "abc123",
  "head_sha": "def456",
  "generated_at": "2026-10-31T13:30:00Z",
  "checks": {
    "all_passed": false,
    "failed": [
      {
        "name": "unit",
        "command": "npm test -- --run",
        "exit_code": 1,
        "log_path": ".review/artifacts/r_20261031_02/test.log",
        "failing_cases": ["tests/auth/session.test.ts::rejects expired token"]
      }
    ]
  },
  "findings": [
    {
      "id": "f_01",
      "fingerprint": "sha256:...",
      "file": "src/auth/session.ts",
      "line": 42,
      "severity": "important",
      "category": "security",
      "claim": "token 未校验过期时间",
      "evidence": "第 42 行直接读取 payload.exp，未与当前时间比较。",
      "suggestion": "验签后检查 exp/nbf，并补充回归测试。"
    }
  ],
  "constraints": {
    "protected_paths": ["tests/**", "**/*.test.*", "**/*.spec.*", ".github/workflows/**"],
    "may_change_source": true,
    "may_change_tests": false,
    "must_not": [
      "disable checks or lint rules",
      "delete or weaken tests",
      "change CI workflows",
      "add skip/ignore annotations"
    ]
  },
  "progress": {
    "previous_findings": ["f_00"],
    "diff_added": 45,
    "diff_deleted": 12,
    "diff_growth_ratio": 0.18,
    "failing_tests_before": 5
  },
  "budget": {
    "review_tokens_used": 120000,
    "review_tokens_limit": 200000,
    "author_round_limit": 3
  },
  "artifacts": {
    "report": ".review/artifacts/r_20261031_02/report.md",
    "tests": ".review/artifacts/r_20261031_02/test.log"
  }
}
```

### 6.2 字段约束

- `schema`：版本化；不兼容变更升级版本号。
- `checks`：只列失败项；日志路径必须可访问，且不含密钥。
- `findings`：只列 confirmed 的 blocker/important/minor；不含审查者身份、置信度、其他票。
- `constraints`：默认测试与 CI 为保护路径；作者只改源码。
- `progress`：用于判断是否还在收敛；由控制器计算，不由模型填写。
- `budget`：审查预算与轮次上限；作者成本在 Author-driven 模式下由外部 harness 负责。
- `artifacts`：本地路径，不上传敏感内容。

> 若本轮确定性检查失败，审查不会运行，`findings` 通常为空或只包含上一轮未解决项；示例将 checks 与 findings 放在一起仅为展示完整结构。

### 6.3 作者返回契约

最小要求：新 commit（`base_sha` 必须是上一轮 `head_sha`），且不修改保护路径。可选返回：

```json
{
  "schema": "review.fix-result.v1",
  "loop_id": "dl_20261031_01",
  "round": 2,
  "base_sha": "def456",
  "head_sha": "ghi789",
  "summary": "补齐 exp/nbf 校验。",
  "changed_files": ["src/auth/session.ts"],
  "protected_paths_changed": false,
  "needs_human": false,
  "notes": "测试文件未修改；回归测试由人工单独提交。"
}
```

- 作者应报告它执行过的测试与结果；控制器会重新执行，不信任自报。
- 无法修复时输出 `needs_human: true` 与原因，不继续无效循环。
- 作者不得在 fix-request 之外读取审查者的隐藏推理；只读取 findings 与证据。

## 7. 测试保护与判定完整性

- 测试文件、测试配置、CI workflow 默认受保护；每轮前后计算 hash，发生变更立即停止并转人工。
- 作者可以新增回归测试吗？v1 **不允许**；需要新增测试时走单独的、人工审查的测试变更。这是为了防止“改测试通过”。
- 测试命令只能来自仓库配置，不能由模型生成或修改。
- 测试在干净 worktree/容器中执行；固定依赖、固定 seed、无网络、超时；flaky 测试先隔离并标记，不进入判定。
- 以退出码、JUnit/XML、日志为准；不要让 LLM 判断“测试是否通过”。
- 覆盖率不是门禁；它容易诱发“为覆盖率写测试”而不是验证行为。
- 测试全绿是必要条件，不是审批充分条件；AI 审查与人工审批仍然独立。

## 8. 停止与继续策略

| 结果 | 条件 | 动作 |
|---|---|---|
| 通过循环 | 确定性检查全绿 + 无 confirmed blocker/important + 保护路径未改 | 进入标准审批门禁；不自动合并 |
| 继续 | 测试失败或存在 blocker/important，round < 3，且有进展 | 输出 fix-request |
| 停人工 | 达到 3 轮；连续 2 轮无进展；同一 fingerprint 反复出现；测试失败数不降；diff 增长 >30%；预算/时限耗尽；测试或 CI 变更；高风险路径；作者请求人工；测试 flaky | 停止循环，输出报告与原因 |

“有进展”至少满足一项：

- 失败测试数量减少；
- confirmed blocker/important 数量减少；
- 新增 finding 不重复旧 fingerprint；
- diff 增长受控（≤30%）；
- 测试保持绿且 findings 在收敛。

补充规则：

- 测试红时只返回测试失败，不调用 AI 审查；测试绿后才审查。
- 首次 review 后只审新 diff；不重复发布已有 finding；按 bug 类别要求修全部实例。
- 3 轮后要求“退一步改方案”，人工 reset 需 reason 并写账本。
- 高风险路径或测试变更直接停人工，不尝试自动修复。

## 9. 审计、预算与指标

### 9.1 账本事件

`devloop.started`、`devloop.round.started`、`devloop.checks.completed`、`devloop.review.completed`、`devloop.fix_request.issued`、`devloop.author_commit`、`devloop.protected_changed`、`devloop.round.completed`、`devloop.human_required`、`devloop.stopped`、`devloop.reset`。

每条记录：`loop_id`、`round`、base/head sha、diff hash、测试文件 hash、fix-request hash、stop_reason、时间。审批事件仍由 ADR-0001 的审批账本负责。

### 9.2 作者元数据与局限

- 记录可观察的事实：commit、测试结果、diff、声明的 Agent/模型名（如有）。
- Author-driven 模式下，本工具无法证明作者是谁、模型版本、是否人工参与；不要把它写成强审计。
- Orchestrator-driven 模式可记录 stdout/stderr、用量和命令，但会引入 API key 与更多权限，必须沙箱化。

### 9.3 预算与限制

- 每轮 review 预算沿用 Quick/Standard/Deep 上限；整个 loop 设总预算 = `max_rounds × 单轮上限` 的上限，可配置更小。
- 轮次上限 3；墙钟上限可配（例如 30 分钟）；单轮 diff 增长上限 30%。
- Author-driven 的作者成本不在本工具预算内；要求 harness 自设配额，并在 fix-result 中报告（可选）。
- 超预算/超时停止，转人工；不得以“快好了”为由超限。

### 9.4 指标

- 外层环一轮通过率、平均轮次、停止原因分布；
- 测试失败到修复的轮数、同一 finding 复发率；
- 人工接管率、测试文件变更尝试次数（应接近 0）；
- 每次循环的作者成本（如可得）、审查成本；
- 护栏：回滚率、事故率不上升。

## 10. 与现有 Agent 的接入

| 工具 | 建议角色 | 前提 |
|---|---|---|
| DeepSeek Harness | 作者/修复者 | 可非交互执行命令、产出 commit；可读 fix-request |
| Qoder | 可选修复/独立审查 | 若支持 headless/CLI、沙箱与结构化输出；否则作为人工工作台 |
| Cursor | 人工辅助工作台 | 交互式为主；不作为无人值守环的默认执行器 |
| OpenCode | 可选终端修复/审查 | 确认非交互执行、权限与沙箱 |
| 本审查工具 | 审查与循环控制器 | M1 起提供 CLI（Markdown 报告）；M2 起提供 JSON 与 fix-request |

原则：

- **测试不是 Agent**；Qoder/Cursor/OpenCode 不是测试 oracle，最多是能运行测试的编码/审查 Agent。
- 一个作者 + 一个独立审查方足够；不要默认接入三家。需要模型多样性时，用不同供应商/模型做独立审查，而不是堆 IDE。
- 所有接入通过 Git commit、CLI、JSON 工件；不通过自由聊天。
- 若使用 MCP/A2A，也必须包在确定性控制器内，且不改变“测试判定、审批与账本”的所有权。

## 11. 安全边界

- 编码 Agent 在隔离 worktree/容器内写；审查 Agent 只读；测试网络默认关闭。
- 编码 Agent 不接触审查/生产凭证与 `.env`；其自身模型凭证由沙箱注入并限额；敏感仓库支持本地模型。
- 测试、日志、代码均视为不可信输入；防止提示词注入影响作者或控制器。
- 保护路径与高风险路径双重限制；违反即停。
- 不自动合并、不自动部署；循环通过后仍需审批。
- 只有人能做：修改测试、重置轮次、处理高风险、接受剩余风险。

## 12. 落地路径（不影响 M0–M4）

| 阶段 | 内容 | 前提 |
|---|---|---|
| Phase 0（M1 后） | 人工闭环：编码 Agent 跑测试；人读 `review run` 的 Markdown/终端报告并粘回编码 Agent；JSON 输出在 M2 后自动化 | M1 CLI |
| Phase 1（M2 后，可选） | Author-driven：`--fix-request` 输出、测试保护、3 轮停止、loop 账本 | M2 的 JSON/缓存/评论 |
| Phase 2（可选） | Orchestrator-driven：沙箱内调用 headless Agent、自动多轮、预算硬停 | M3 审批/账本 + 专项 spike |
| Phase 3（数据决定） | 第二独立审查方、夜间自动修复实验；只对低/中风险仓库 | eval 与回滚率数据 |

本 ADR 不进入 M0–M4 DoD；是否实现 Phase 1 由真实使用频率与手工闭环的效果决定。

## 13. 开放问题

1. DeepSeek Harness、Qoder、OpenCode 的非交互/headless 能力、退出码与沙箱支持需要逐一验证。
2. 是否允许作者新增回归测试（当前禁止）；若允许，需要单独的测试变更审查流程。
3. flaky 测试的判定与隔离策略（重跑次数、窗口、人工确认）。
4. loop 状态存储位置（`.review/loops/<loop_id>.json`）与账本的事件粒度。
5. Orchestrator-driven 的 API key 管理、作者成本计量与进程隔离。
6. 高风险路径的“人工接管”具体形式：在 CI 里阻断，还是只允许本地监督执行。
7. 是否需要 A2A/MCP 等标准协议；在没有第二个真实 Agent 需求前不引入。

## 14. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-10-31 | 初版：定义外层开发环、fix-request 协议、测试保护、3 轮停止与 Author-driven 优先 |
