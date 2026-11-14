/**
 * 路由拼装的纯函数核心。
 *
 * 输入是「已绑定的模式 / 已发现的规则 / 运行时探测结果」，输出是一份可直接
 * 落地的 {@link RoutePlan}：提示词分段、工具白名单、命中与跳过记录。这里不
 * 接触 Cordis、文件系统或网络，宿主接线（apply.ts）只负责把计划应用出去。
 *
 * 判定顺序遵循已确认决策：会话绑定的自定义模式 > 意图规则命中 > 默认模板。
 * 模式一旦绑定即完全接管基线；规则只在 baseline 之后追加，`override: true`
 * 的规则会清空此前拼装结果并成为新的基线。
 *
 * @module dsh-prompt-router/route
 */

import { renderTemplate, type ResolvedRouterConfig } from './config.js';
import { matchAnyGlob } from './glob.js';
import { truncateUtf8 } from './text.js';
import type { ModeDefinition, ModeSnapshot, RuleFile, RuleTier, TaskBinding } from './schema.js';

/** 运行时探测结果与任务上下文。 */
export interface RouteContext {
  /** 会话工作目录。 */
  cwd: string;
  /** 当前模型名，用于模板占位符与诊断。 */
  model?: string;
  /** 当前绑定（或默认）的模式 id。 */
  boundMode?: string;
  /** 任务涉及或最近操作过的文件路径。 */
  paths: string[];
  /** 绑定任务的标签。 */
  taskTags: string[];
  /** 本步骤可见的工具名（含代理作用域注册）；空数组表示宿主未提供清单。 */
  availableTools: string[];
  /**
   * 判断单个工具在当前步骤是否可见。宿主把工具注册在 Agent 作用域时，
   * 只能逐名查询，拿不到完整清单，因此优先用这个探针。
   */
  isToolVisible?: (name: string) => boolean;
  /**
   * 可见性是否可知。拼装步骤之外没有作用域与工具集，`isToolVisible` 的结果
   * 不可信；此时不做求交，白名单交由调用守卫兜底。
   */
  toolVisibilityKnown?: boolean;
  /** 其中可交给 `tools.restrict` 的全局工具名；省略时不做宿主级限制。 */
  restrictableTools?: string[];
}

/** 一次拼装的完整输入。 */
export interface RouteInputs {
  config: ResolvedRouterConfig;
  rules: readonly RuleFile[];
  /** 已绑定的模式快照（优先）或目录中的模式定义。 */
  mode?: ModeDefinition | ModeSnapshot;
  context: RouteContext;
  task?: TaskBinding;
}

/** 提示词分段。 */
export interface RouteSection {
  /** 分段标识：`default`、`mode`、规则展示路径或 `tools`。 */
  id: string;
  kind: 'mode' | 'rule' | 'default' | 'tools';
  /** 已渲染文本。 */
  text: string;
  /** 文本 UTF-8 字节数。 */
  bytes: number;
  /** 规则分段所属层级。 */
  tier?: RuleTier;
}

/** 工具白名单计划。 */
export interface RouteToolPlan {
  /** 声明来源中合并后的白名单。 */
  declared: string[];
  /**
   * 本步骤可见的工具名（含代理作用域注册的工具）。宿主未提供工具清单时为空
   * 数组，表示「无法与宿主求交」而不是「一个都不存在」。
   */
  known: string[];
  /**
   * 可交给宿主 `tools.restrict` 的全局工具名。该 API 只接受全局注册的工具，
   * 作用域注册的工具传进去会直接抛错。
   */
  restrictable: string[];
  /** 真正用于调用守卫与提示词的白名单：有交集用交集，否则用声明值。 */
  allow: string[];
  /** 声明了但本步骤不可见的工具名。 */
  ignored: string[];
  /** 白名单来源。 */
  source: 'mode' | 'rule';
}

/** 一条命中记录。 */
export interface RouteMatch {
  path: string;
  tier: RuleTier;
  bytes: number;
  /** 命中的分层原因：pinned、always、mode、path、tag。 */
  by: string;
}

/** 一份可直接应用的拼装计划。 */
export interface RoutePlan {
  route: 'mode' | 'rules' | 'default' | 'disabled';
  mode?: { id: string; name: string };
  sections: RouteSection[];
  /** 分段合并后的最终提示词。 */
  prompt: string;
  tools?: RouteToolPlan;
  matched: RouteMatch[];
  skipped: { path: string; reason: string }[];
  truncated: string[];
  /** 被 `override` 规则清空的规则路径。 */
  overridden: string[];
  diagnostics: string[];
  generatedAt: number;
}

/** 规则命中的判定结果。 */
type RuleVerdict = { ok: true; by: string } | { ok: false; reason: string };

/**
 * 判定一条 scoped 规则是否命中当前上下文。
 * @param rule - 规则。
 * @param context - 运行时上下文。
 * @returns 命中原因或未命中的首个原因。
 */
export function ruleVerdict(rule: RuleFile, context: RouteContext): RuleVerdict {
  if (rule.tier === 'pinned') return { ok: true, by: 'pinned' };
  if (rule.modes.length > 0) {
    const bound = context.boundMode?.toLowerCase();
    const modes = rule.modes.map(mode => mode.toLowerCase());
    if (bound === undefined) return { ok: false, reason: '未绑定模式（modes 限制不生效）' };
    if (!modes.includes(bound)) return { ok: false, reason: `模式不匹配：需要 ${rule.modes.join('/')}，当前 ${context.boundMode}` };
    return { ok: true, by: 'mode' };
  }
  if (rule.paths.length > 0) {
    const candidates = [context.cwd, ...context.paths];
    const hit = matchAnyGlob(rule.paths, candidates);
    if (hit === undefined) return { ok: false, reason: `路径不匹配：${rule.paths.join(', ')}` };
    return { ok: true, by: `path:${hit}` };
  }
  if (rule.taskTags.length > 0) {
    const tags = new Set(context.taskTags.map(tag => tag.toLowerCase()));
    const hit = rule.taskTags.find(tag => tags.has(tag.toLowerCase()));
    if (hit === undefined) return { ok: false, reason: `任务标签不匹配：需要 ${rule.taskTags.join('/')}` };
    return { ok: true, by: `tag:${hit}` };
  }
  return { ok: true, by: 'always' };
}

/**
 * 收窄工具白名单：多份声明取交集，交集为空时保留前者并记录冲突。
 * @param current - 已生效白名单。
 * @param next - 新声明白名单。
 * @param source - 新声明来源标签。
 * @param diagnostics - 诊断收集器。
 * @returns 收窄后的白名单。
 */
function narrowTools(current: string[] | undefined, next: readonly string[], source: string, diagnostics: string[]): string[] {
  if (current === undefined) return [...next];
  const allowed = new Set(current);
  const intersection = next.filter(name => allowed.has(name));
  if (intersection.length === 0) {
    diagnostics.push(`工具白名单冲突：${source} 与已生效白名单无交集，保留已生效白名单`);
    return current;
  }
  return intersection;
}

/** 规则分段头部（HTML 注释：模型可见但不干扰排版）。 */
function ruleHeader(rule: RuleFile): string {
  return `<!-- prompt-router: ${rule.displayPath} (${rule.tier}) -->`;
}

/**
 * 生成拼装计划。
 * @param inputs - 拼装输入。
 * @returns 可应用的拼装计划。
 */
export function planRoute(inputs: RouteInputs): RoutePlan {
  const { config, context } = inputs;
  const now = Date.now();
  const diagnostics: string[] = [];
  if (!config.enabled) {
    return {
      route: 'disabled',
      sections: [],
      prompt: '',
      matched: [],
      skipped: [],
      truncated: [],
      overridden: [],
      diagnostics: ['插件已禁用'],
      generatedAt: now,
    };
  }

  const mode = inputs.mode;
  const matched: RouteMatch[] = [];
  const skipped: { path: string; reason: string }[] = [];
  const sections: RouteSection[] = [];
  const truncated: string[] = [];
  const overridden: string[] = [];
  let declaredTools: string[] | undefined = mode?.tools === undefined ? undefined : [...mode.tools];
  let toolSource: 'mode' | 'rule' = 'mode';

  if (mode !== undefined) {
    sections.push({ id: 'mode', kind: 'mode', text: mode.prompt, bytes: Buffer.byteLength(mode.prompt, 'utf8') });
  }

  let used = 0;
  // pinned 固顶：稳定分区，保持两组内各自的发现顺序。
  const ordered = [
    ...inputs.rules.filter(rule => rule.tier === 'pinned'),
    ...inputs.rules.filter(rule => rule.tier !== 'pinned'),
  ];
  for (const rule of ordered) {
    const verdict = ruleVerdict(rule, context);
    if (!verdict.ok) {
      skipped.push({ path: rule.displayPath, reason: verdict.reason });
      continue;
    }
    if (rule.tier === 'scoped' && rule.bytes > config.maxScopedBytes - used) {
      const remaining = config.maxScopedBytes - used;
      if (remaining < 512) {
        skipped.push({ path: rule.displayPath, reason: `scoped 预算不足（剩余 ${remaining} 字节）` });
        continue;
      }
      const body = truncateUtf8(rule.body, remaining);
      if (body.length === 0) {
        skipped.push({ path: rule.displayPath, reason: 'scoped 预算不足' });
        continue;
      }
      truncated.push(rule.displayPath);
      used += Buffer.byteLength(body, 'utf8');
      applyRule(sections, rule, `${ruleHeader(rule)}\n${body}\n…[truncated by dsh-prompt-router]`, overridden);
    } else {
      if (rule.tier === 'scoped') used += rule.bytes;
      applyRule(sections, rule, `${ruleHeader(rule)}\n${rule.body}`, overridden);
    }
    matched.push({ path: rule.displayPath, tier: rule.tier, bytes: rule.bytes, by: verdict.by });
    if (rule.tools !== undefined && rule.tools.length > 0) {
      declaredTools = narrowTools(declaredTools, rule.tools, `规则 ${rule.displayPath}`, diagnostics);
      if (toolSource === 'mode' && mode?.tools === undefined) toolSource = 'rule';
    }
  }

  let route: RoutePlan['route'] = mode !== undefined ? 'mode' : matched.length > 0 ? 'rules' : 'default';
  if (sections.length === 0) {
    // 没有模式且所有命中规则都被预算裁掉：回落默认模板，路由标记也回到 default。
    route = 'default';
    sections.push({
      id: 'default',
      kind: 'default',
      text: renderTemplate(config.defaultTemplate, {
        cwd: context.cwd,
        model: context.model ?? '(unknown model)',
        mode: mode?.id ?? '',
        route,
        tools: declaredTools?.join(', ') ?? '',
        rules: matched.map(entry => entry.path).join(', '),
      }),
      bytes: 0,
    });
  }
  for (const section of sections) {
    section.bytes = Buffer.byteLength(section.text, 'utf8');
  }

  let tools: RouteToolPlan | undefined;
  if (declaredTools !== undefined && declaredTools.length > 0) {
    const available = new Set(context.availableTools);
    const probe = context.isToolVisible;
    // 能逐名探测就按名判断；否则退回到批量清单；两者都没有时不做求交。
    const unsure = context.toolVisibilityKnown === false || (probe === undefined && available.size === 0);
    const visible = (name: string): boolean => (probe === undefined ? available.has(name) : probe(name));
    const known = unsure ? [] : declaredTools.filter(visible);
    const ignored = unsure ? [] : declaredTools.filter(name => !visible(name));
    const allow = known.length > 0 ? known : [...declaredTools];
    const restrictableNames = new Set(context.restrictableTools ?? []);
    const restrictable = restrictableNames.size === 0
      ? []
      : allow.filter(name => restrictableNames.has(name));
    if (!unsure && known.length === 0) {
      diagnostics.push('声明的工具本步骤均不可见，白名单只由调用守卫执行，未注册宿主级工具限制');
    } else if (known.length > 0 && restrictable.length === 0) {
      diagnostics.push('白名单工具都注册在 Agent 作用域，宿主 tools.restrict 不适用，改由调用守卫执行');
    }
    tools = { declared: [...declaredTools], known, restrictable, allow, ignored, source: toolSource };
  }

  if (tools !== undefined) {
    const text = `Only the following tools are available in this session: ${tools.allow.join(', ')}. Do not attempt to call any other tool; when a required capability is missing, explain the limitation instead.`;
    sections.push({ id: 'tools', kind: 'tools', text, bytes: Buffer.byteLength(text, 'utf8') });
  }

  const prompt = sections
    .map(section => section.text.trim())
    .filter(text => text.length > 0)
    .join('\n\n');

  return {
    route,
    ...mode === undefined ? {} : { mode: { id: mode.id, name: mode.name } },
    sections,
    prompt,
    ...tools === undefined ? {} : { tools },
    matched,
    skipped,
    truncated,
    overridden,
    diagnostics,
    generatedAt: now,
  };
}

/**
 * 追加一条规则分段；`override` 规则先清空已有分段。
 * @param sections - 分段收集器。
 * @param rule - 规则。
 * @param text - 已渲染文本。
 * @param overridden - 被覆盖的规则路径收集器。
 */
function applyRule(sections: RouteSection[], rule: RuleFile, text: string, overridden: string[]): void {
  if (rule.override) {
    for (const section of sections) overridden.push(section.id);
    sections.length = 0;
  }
  sections.push({ id: rule.displayPath, kind: 'rule', text, bytes: Buffer.byteLength(text, 'utf8'), tier: rule.tier });
}

/**
 * 渲染任务上下文摘要（与 dsh-task-board 约定的绑定注入内容）。
 * @param task - 任务绑定。
 * @returns 供 `systemPrompt.context` 使用的文本。
 */
export function renderTaskContext(task: TaskBinding): string {
  const lines = ['Current task context (bound task snapshot):', `- Title: ${task.title}`];
  if (task.description !== undefined && task.description.length > 0) lines.push(`- Description: ${task.description}`);
  if (task.tags.length > 0) lines.push(`- Tags: ${task.tags.join(', ')}`);
  const history = task.history.slice(-5);
  if (history.length > 0) {
    lines.push('- Recent status history:');
    for (const entry of history) {
      lines.push(`  - ${[entry.at, entry.status, entry.note].filter(part => part !== undefined && part.length > 0).join(' | ')}`);
    }
  }
  return lines.join('\n');
}
