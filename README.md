# dsh-prompt-router

DeepSeek Harness 的提示词路由插件：按「已绑定自定义模式 > 规则命中 > 默认模板」动态拼装每个会话的系统提示词与工具白名单。

- **规则来源复用渐进式披露体系**：直接读 `AGENTS.md` / `SKILL.md` 的 YAML 头部，不引入独立配置文件。
- **模式优先级最高**：会话绑定的自定义模式（来自 [dsh-mode-builder](https://github.com/dsh-plugins/dsh-mode-builder) 的本机模式目录）一旦绑定即接管拼装基线。
- **预算可控**：`pinned` 规则固顶绝不截断，`scoped` 规则按需加载、超预算按字节安全裁剪。
- **工具白名单真实收窄**：同时用作用域 `tools.restrict` 与调用守卫，模型看不到、也调不动白名单外的工具。
- **零外部服务**：不引入分类模型、不访问网络，规则与模式都读本机文件。

## 安装

```bash
dsh plugin add @dsh-plugin/dsh-prompt-router
```

插件是组合包（`dsh.bundle.patch`），安装后自动加入 profile 并挂载，无需手改 `cordis.patch.yml`。

## 功能

| 能力 | 说明 |
| --- | --- |
| 规则路由 | 从项目根到工作目录整条链上的 `AGENTS.md` / `SKILL.md`，外加 `skills/`、`.dsh/skills/`、`.agents/skills/` 子目录技能，按 YAML 头部判定是否命中 |
| 模式接管 | 会话绑定的模式快照完全接管基线；模式文件内容变化时热更新，删除后继续使用快照 |
| 工具白名单 | 模式与规则的 `tools` 取交集后与宿主当前工具求交；能交给 `tools.restrict` 的名称同时收窄工具 Schema，其余由作用域守卫拒绝 |
| 任务上下文 | 注入绑定任务的标题、描述、标签与最近 5 条状态历史（运行时上下文快照） |
| 运行时探测 | 每次拼装读取当前模型名、可用工具清单、绑定任务与激活模式名 |
| 诊断接口 | `/_dsh/prompt-router/*` 提供状态核对、规则查看、模式绑定与任务写入 |
| 设置页 | 由 dsh-loader config-api 渲染，保存后立即生效并重建拼装 |

## 路由规则

在任意 `AGENTS.md` / `SKILL.md` 顶部加 YAML 头部：

```markdown
---
tier: scoped                 # pinned 固顶不截断 / scoped 超预算可裁剪
modes: ["code", "review"]    # 只在绑定这些模式时生效
paths: ["src/main/java/**"]  # 任务涉及或提到这些路径时生效
task_tags: ["bugfix"]        # 绑定任务带这些标签时生效
tools: ["read", "grep"]      # 本会话收窄工具白名单
override: false              # true 时清空此前拼装结果，本条成为新基线
---

这里写正文，命中后作为提示词分段注入。
```

判定细节：

- `pinned` 恒命中且不参与预算；`scoped` 依次按 `modes`、`paths`、`task_tags` 判定，全部缺省时恒命中。
- `paths` 的候选包含会话工作目录、用户消息里提到的路径、最近工具调用操作过的路径。
- 工具白名单多来源取交集；交集为空时保留前者并记录诊断，不会把会话锁死。
- 单文件读取上限、文件数上限、scoped 总预算都在设置页可调。

## 自定义模式

模式目录默认 `<DSH_HOME>/profiles/<profile>/data/dsh-mode-builder/modes`，可在设置页覆盖。一个模式一份 JSON：

```json
{
  "formatVersion": 1,
  "id": "planner",
  "name": "规划模式",
  "description": "先产出计划再改代码",
  "prompt": "你是规划者：先输出任务拆解与验收标准，得到确认后再动手。",
  "tools": ["read", "grep", "glob"],
  "icon": "map"
}
```

## 设置页字段

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `defaultMode` | 空 | 未绑定会话时使用的模式 id |
| `defaultTemplate` | 内置模板 | 未命中模式与规则时注入，支持 `{{cwd}}`、`{{model}}`、`{{mode}}`、`{{route}}`、`{{tools}}`、`{{rules}}` |
| `modesDir` | 见上文 | 自定义模式目录 |
| `dataDir` | `<profile>/data/dsh-prompt-router` | 会话绑定存储目录 |
| `extraRulePaths` | 空 | 额外规则文件、目录或通配符 |
| `maxScopedBytes` | `24000` | scoped 规则正文总预算（字节） |
| `maxRules` | `100` | 最多规则文件数 |
| `maxRuleBytes` | `131072` | 单文件读取上限（字节） |
| `cacheMs` | `5000` | 规则与模式目录缓存有效期 |
| `injectTaskContext` | `true` | 是否注入任务摘要 |
| `diagnostics` | `true` | 是否注册诊断接口 |

## 诊断接口

所有请求走宿主浏览器鉴权（`?token=`）并拒绝跨站请求：

```bash
# 概况
curl "http://127.0.0.1:PORT/_dsh/prompt-router/health?token=..."
# 某会话的绑定与实时拼装结果
curl "http://127.0.0.1:PORT/_dsh/prompt-router/sessions/<sessionId>?token=..."
# 走宿主真实的 systemPrompt.assemble 生成一次提示词（不发模型请求）
curl "http://127.0.0.1:PORT/_dsh/prompt-router/sessions/<sessionId>/assemble?token=..."
# 绑定/解绑模式
curl -X POST "http://127.0.0.1:PORT/_dsh/prompt-router/sessions/<sessionId>/mode?token=..." \
  -H 'Content-Type: application/json' -d '{"mode":"planner"}'
# 写入/清除任务摘要
curl -X POST "http://127.0.0.1:PORT/_dsh/prompt-router/sessions/<sessionId>/task?token=..." \
  -H 'Content-Type: application/json' -d '{"task":{"title":"修复登录","tags":["bugfix"]}}'
```

## 与其他插件的关系

| 关联方 | 关系 |
| --- | --- |
| dsh-mode-builder | 模式定义的来源；本插件只读其模式目录 |
| dsh-task-board | 任务摘要与任务 ID 的来源，经诊断接口写入后参与 `task_tags` 路由 |

## 开发

```bash
pnpm install
pnpm run typecheck
pnpm test
```

## 许可

LGPL-3.0-only。
