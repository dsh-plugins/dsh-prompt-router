# 配置与路径推导

本页说明 dsh-prompt-router 的配置文件位置、路径推导规则与每个字段的含义。设置页由 dsh-loader 的 config-api 渲染，保存即写入 `<profile>/config/dsh-prompt-router/config.json`，无需重启宿主。

## 配置文件位置

```text
<DSH_HOME>/profiles/<profile>/config/dsh-prompt-router/config.json
```

```json
{
  "formatVersion": 1,
  "revision": 3,
  "value": {
    "enabled": true,
    "defaultMode": "",
    "defaultTemplate": "...",
    "modesDir": "",
    "dataDir": "",
    "extraRulePaths": [],
    "maxScopedBytes": 24000,
    "maxRules": 100,
    "maxRuleBytes": 131072,
    "cacheMs": 5000,
    "injectTaskContext": true,
    "diagnostics": true
  }
}
```

空串表示「使用默认推导值」。手动编辑后需要重新加载插件或重启宿主。

## 路径推导

插件与宿主同进程，因此按以下顺序确定 `DSH_HOME` 与 `<profile>`：

1. `DSH_HOME` 环境变量；未设置时用 `~/.dsh`。
2. 启动参数 `--profile <name>` 或 `--profile=<name>`；没有时用 `DSH_PROFILE` 环境变量，再回退 `web`。

推导结果：

| 用途 | 默认值 |
| --- | --- |
| 自定义模式目录 `modesDir` | `<DSH_HOME>/profiles/<profile>/data/dsh-mode-builder/modes` |
| 会话绑定目录 `dataDir` | `<DSH_HOME>/profiles/<profile>/data/dsh-prompt-router` |

设置页填写的相对路径按插件启动目录（宿主进程 cwd）解析，`~` 前缀展开为用户主目录。

## 字段

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 总开关。关闭后不产生任何提示词分段，也不注册守卫 |
| `defaultMode` | text | 空 | 未绑定会话使用的模式 id；模式不存在时按规则/默认模板处理 |
| `defaultTemplate` | textarea | 内置模板 | 未命中模式与规则时的兜底提示词，支持 `{{cwd}}`、`{{model}}`、`{{mode}}`、`{{route}}`、`{{tools}}`、`{{rules}}`；未知占位原样保留 |
| `modesDir` | text | 见上表 | 自定义模式目录 |
| `dataDir` | text | 见上表 | 会话绑定存储目录，变更后重新加载，不迁移旧数据 |
| `extraRulePaths` | array | `[]` | 额外规则文件、目录或通配符（`*`、`**`、`?`） |
| `maxScopedBytes` | number | `24000` | scoped 规则正文总预算（字节），钳制范围 `512`–`4000000` |
| `maxRules` | number | `100` | 单次发现最多读取的规则文件数，钳制范围 `1`–`2000` |
| `maxRuleBytes` | number | `131072` | 单文件读取上限（字节），钳制范围 `1024`–`8000000` |
| `cacheMs` | number | `5000` | 规则与模式目录缓存有效期，`0` 表示下一轮拼装即刷新 |
| `injectTaskContext` | boolean | `true` | 是否把绑定任务摘要注入运行时上下文 |
| `diagnostics` | boolean | `true` | 是否注册 `/_dsh/prompt-router` 路由 |

非法数值（负数、`NaN`、超界）会被钳制到最近边界，非法布尔回落到默认值，缺失字段补默认值；配置解析永不抛错。

## 会话绑定存储

```text
<dataDir>/sessions.json
```

```json
{
  "formatVersion": 1,
  "sessions": {
    "<sessionId>": {
      "mode": { "id": "planner", "name": "规划模式", "prompt": "...", "tools": ["read"], "capturedAt": 1763000000000, "hash": "..." },
      "task": { "title": "修复登录", "tags": ["bugfix"], "history": [{ "status": "进行中" }], "updatedAt": 1763000000000 },
      "updatedAt": 1763000000000
    }
  }
}
```

- 写入采用「同目录临时文件 + rename」的原子替换，串行执行。
- 文件损坏时只记录错误并保持空状态，插件照常加载。
- 最多保留 500 个会话，超出时按 `updatedAt` 淘汰最旧的条目。
- 模式与任务都被清除时删除该会话条目。

## 诊断接口

| 方法与路径 | 说明 |
| --- | --- |
| `GET /health` | 插件版本、目录、绑定数量与模式概况 |
| `GET /state` | 完整运行时状态 |
| `GET /rules?cwd=<path>` | 指定工作目录已解析的规则与其诊断 |
| `GET /sessions/<id>` | 会话绑定与实时拼装摘要（含 `matched`/`skipped`/`tools`/`enforcement`/`promptPreview`） |
| `GET /sessions/<id>/assemble` | 走宿主真实的 `systemPrompt.assemble` 生成一次提示词，返回 sections/contexts/tools |
| `POST /sessions/<id>/mode` | `{ "mode": "planner" | null }` 绑定或解绑模式 |
| `POST /sessions/<id>/task` | `{ "task": { ... } | null }` 写入或清除任务摘要 |

所有请求复用宿主 `connection.authorizeIndex` 的浏览器鉴权，并拒绝 `Sec-Fetch-Site: cross-site` 与跨站 `Origin`；请求体上限 1 MiB。

## 工具白名单的实际执行方式

宿主把 `read`、`grep` 这类工具注册在 Agent 作用域，而 `tools.restrict` 只接受全局注册的工具名。因此插件按下面的顺序选择执行机制，`/sessions/<id>` 的 `enforcement` 字段会写明当前用的是哪一种：

| 取值 | 含义 |
| --- | --- |
| `tools.guard` | 宿主提供作用域守卫，白名单外调用被单调拒绝（首选） |
| `tools/pre-execute` | 宿主没有 `tools.guard`，改用执行前瀑布拒绝 |
| `none` | 宿主既无守卫也无事件通道，白名单仅体现在提示词里 |

能交给 `tools.restrict` 的名称（`tools.restrictable`）非空时，插件同时注册该限制，让受限工具从模型可见的工具 Schema 中消失；不含全局名称时只留调用守卫，两者合起来才是完整约束。
