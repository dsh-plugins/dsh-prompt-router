/**
 * 把拼装计划接到单个 Agent 上。
 *
 * 每个 Agent 在自己的作用域内注册两处贡献：
 * - `systemPrompt.section`：路由拼装出的提示词（顺序在 persona 之后、内置工具说明之前）；
 * - `systemPrompt.context`：绑定任务的摘要（运行时上下文快照）。
 *
 * 工具白名单有两道闸：`tools.restrict({ allow })` 收窄模型可见的工具 Schema，
 * `tools/pre-execute` 守卫在调用时拒绝白名单外的工具。restrict 只在下一个
 * 步骤生效（宿主的 tools.resolve 先于 systemPrompt.assemble），守卫则对当前
 * 步骤立即生效，两者合起来才是完整约束。
 *
 * @module dsh-prompt-router/apply
 */

import { planRoute, renderTaskContext, type RouteContext, type RoutePlan } from './route.js';
import type { RouterState } from './state.js';
import { extractArgumentPaths, extractPaths } from './text.js';
import type { ModeDefinition, ModeSnapshot, RuleFile } from './schema.js';

/** 路由提示词分段的固定名称。 */
export const ROUTING_SECTION = 'dsh-prompt-router:routing';

/** 任务摘要上下文的固定名称。 */
export const TASK_CONTEXT = 'dsh-prompt-router:task';

/** 提示词分段顺序：紧接 persona（0）之后，早于 PLAN_POLICY（500）。 */
const SECTION_ORDER = 100;

/** 任务上下文顺序：早于工作目录（由宿主按 100 起排序）之外的位置，保持稳定。 */
const CONTEXT_ORDER = 500;

/** 单个 Agent 记录的路径上限。 */
const MAX_TOUCHED_PATHS = 100;

/** 会话对象的最小结构。 */
export interface RoutedSession {
  readonly id: string;
  readonly header?: { readonly cwd?: string } | undefined;
  snapshotEvents?(offset?: unknown): readonly unknown[];
}

/** Agent 作用域内需要的 Cordis 能力。 */
export interface RoutedAgentContext {
  on(event: string, listener: (...args: never[]) => unknown): () => void;
  get(name: string): unknown;
  systemPrompt?: {
    section(section: {
      name: string;
      order: number;
      text: string | ((context: unknown) => string);
      interpolate?: boolean;
    }): () => void;
    context?(entry: {
      name: string;
      order: number;
      text: string | ((context: unknown) => string);
      interpolate?: boolean;
      required?: boolean;
    }): () => void;
    getSectionOrder?(name: string): number;
    getContextOrder?(name: string): number;
    assemble?(context: { scope?: unknown }): Promise<{
      sections: readonly { name: string; text: string }[];
      contexts?: readonly { name: string; text: string }[];
      tools?: readonly { name: string }[];
    }>;
  };
  tools?: {
    restrict(filter: { allow?: string[]; deny?: string[] }): () => void;
    guard?(guard: (exec: { name?: unknown }) => string | undefined): () => void;
    definitions?(scope?: unknown, toolSet?: unknown): readonly { name: string }[];
    get?(name: string, scope?: unknown, toolSet?: unknown): { name: string } | undefined;
  };
  logger?: { warn(...args: unknown[]): void; error(...args: unknown[]): void };
}

/** 宿主 Agent 的最小结构。 */
export interface RoutedAgent {
  readonly id: string;
  readonly session: RoutedSession;
  readonly ctx: RoutedAgentContext;
}

/** 已安装的路由句柄。 */
export interface AgentRouterHandle {
  /** 工作目录（规则发现基准）。 */
  readonly cwd: string;
  /** 最近一次拼装计划（尚未拼装时为 `undefined`）。 */
  plan(): RoutePlan | undefined;
  /** 重新拼装并立即应用工具白名单。 */
  refresh(): RoutePlan;
  /** 诊断用的计划摘要。 */
  describe(): Record<string, unknown>;
  /**
   * 按宿主真实的拼装流程生成一次提示词（不发起模型请求）。
   *
   * 与模型步骤用的是同一个 `systemPrompt.assemble`，因此作用域、工具可见性
   * 与规则命中都与真实请求一致，可用来核对最终提示词。
   */
  assemble(): Promise<{
    prompt: string;
    sections: { name: string; text: string }[];
    contexts: { name: string; text: string }[];
    tools: string[];
  }>;
  /** 卸载全部贡献。 */
  dispose(): void;
}

/** 从消息对象里收集全部字符串（用于路径提取）。 */
function flattenText(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 4 || out.length > 200) return out;
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) flattenText(item, out, depth + 1);
    return out;
  }
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) flattenText(child, out, depth + 1);
  }
  return out;
}

/**
 * 在 Agent 作用域安装路由贡献。
 * @param agent - 宿主 Agent。
 * @param state - 路由运行时状态。
 * @returns 可刷新/卸载的路由句柄。
 */
export function installAgentRouter(agent: RoutedAgent, state: RouterState): AgentRouterHandle {
  const sessionId = agent.session.id;
  const cwd = agent.session.header?.cwd ?? process.cwd();
  const touched = new Set<string>();
  const disposers: (() => void)[] = [];
  let latest: RoutePlan | undefined;
  let appliedKey = '';
  let restriction: (() => void) | undefined;
  let messageCache: { key: number; paths: string[] } | undefined;
  let disposed = false;

  const logger = agent.ctx.logger;
  const agentCtx = agent.ctx;

  /**
   * 读取本步骤的工具可见性。
   *
   * 宿主把绝大多数工具注册在 Agent 作用域，全局 `definitions()` 往往为空，
   * 因此可见性按名字用 `get(name, scope, toolSet)` 逐个探测；只有全局注册的
   * 名称才能交给 `tools.restrict`。
   * @param assemble - 宿主拼装上下文，含 scope 与 toolSet。
   */
  const toolProbe = (assemble?: { scope?: unknown; toolSet?: unknown }): {
    isVisible: (name: string) => boolean;
    restrictable: string[];
    globalNames: string[];
  } => {
    const tools = agentCtx.tools;
    const scope = assemble?.scope;
    const toolSet = assemble?.toolSet;
    let globalNames: string[] = [];
    try {
      globalNames = (tools?.definitions?.call(tools) ?? []).map(definition => definition.name);
    } catch (error) {
      logger?.warn(`dsh-prompt-router: 读取全局工具清单失败：${error instanceof Error ? error.message : String(error)}`);
    }
    const get = tools?.get;
    const isVisible = (name: string): boolean => {
      if (get === undefined) return globalNames.includes(name);
      try {
        return get.call(tools, name, scope, toolSet) !== undefined;
      } catch (error) {
        logger?.warn(`dsh-prompt-router: 查询工具 ${name} 失败：${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    };
    return { isVisible, restrictable: globalNames, globalNames };
  };

  /** 从最近用户消息里提取路径（按事件数量缓存）。 */
  const messagePaths = (): string[] => {
    const events = agent.session.snapshotEvents?.() ?? [];
    const key = events.length;
    if (messageCache?.key === key) return messageCache.paths;
    const result: string[] = [];
    let scanned = 0;
    for (let index = events.length - 1; index >= 0 && scanned < 40 && result.length < 16; index -= 1) {
      const event = events[index] as { type?: unknown; data?: unknown } | undefined;
      if (event?.type !== 'user/message') continue;
      scanned += 1;
      result.push(...extractPaths(flattenText(event.data).join('\n')));
    }
    messageCache = { key, paths: result.slice(0, 16) };
    return messageCache.paths;
  };

  /**
   * 应用宿主级工具限制。
   *
   * 只把全局注册的工具交给 `tools.restrict`：该 API 拒绝作用域注册的名称，
   * 而作用域工具本来也不归它管。白名单的完整约束始终由调用守卫兜底，因此
   * 这里跳过不会让约束失效。
   */
  const applyTools = (plan: RoutePlan): void => {
    const restrictable = plan.tools?.restrictable ?? [];
    const key = restrictable.length === 0 ? '' : [...restrictable].sort().join('\u0000');
    if (key === appliedKey) return;
    restriction?.();
    restriction = undefined;
    appliedKey = key;
    if (restrictable.length === 0) return;
    try {
      restriction = agentCtx.tools?.restrict({ allow: restrictable });
    } catch (error) {
      logger?.warn(`dsh-prompt-router: tools.restrict 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** 重新拼装。 */
  const compute = (assemble?: { scope?: unknown; toolSet?: unknown }): RoutePlan => {
    const config = state.current;
    const resolved = state.resolveMode(sessionId);
    const binding = state.bindings.get(sessionId);
    const rules: RuleFile[] = state.rulesFor(cwd).files;
    const { isVisible, restrictable } = toolProbe(assemble);
    const context: RouteContext = {
      cwd,
      ...resolved.mode === undefined ? {} : { boundMode: resolved.mode.id },
      paths: [cwd, ...touched, ...messagePaths()],
      taskTags: binding?.task?.tags ?? [],
      availableTools: [],
      isToolVisible: isVisible,
      // 拼装步骤之外没有作用域与工具集，可见性不可判定。
      toolVisibilityKnown: assemble !== undefined,
      ...restrictable.length === 0 ? {} : { restrictableTools: restrictable },
    };
    const plan = planRoute({
      config,
      rules,
      ...resolved.mode === undefined ? {} : { mode: resolved.mode as ModeDefinition | ModeSnapshot },
      context,
      ...binding?.task === undefined ? {} : { task: binding.task },
    });
    latest = plan;
    applyTools(plan);
    return plan;
  };

  const sectionOrder = agentCtx.systemPrompt?.getSectionOrder?.('DEPLOYMENT_PERSONA_PREFIX') ?? 0;
  if (agentCtx.systemPrompt === undefined) {
    logger?.warn('dsh-prompt-router: 当前宿主缺少 systemPrompt 服务，路由未启用');
  } else {
    disposers.push(agentCtx.systemPrompt.section({
      name: ROUTING_SECTION,
      order: sectionOrder + SECTION_ORDER,
      // 规则正文与模板占位符都不参与宿主变量插值，交由本插件渲染。
      interpolate: false,
      text: (assemble: unknown) => compute(assemble as { scope?: unknown; toolSet?: unknown }).prompt,
    }));
    if (agentCtx.systemPrompt.context !== undefined) {
      disposers.push(agentCtx.systemPrompt.context({
        name: TASK_CONTEXT,
        order: (agentCtx.systemPrompt.getContextOrder?.('WORKING_DIRECTORY') ?? 100) + CONTEXT_ORDER,
        interpolate: false,
        required: false,
        text: () => {
          const config = state.current;
          if (!config.enabled || !config.injectTaskContext) return '';
          const task = state.bindings.get(sessionId)?.task;
          return task === undefined ? '' : renderTaskContext(task);
        },
      }));
    }
  }

  // 路径采集：观察器只记录，不做判定。
  disposers.push(agentCtx.on('tools/pre-execute', (async (
    exec: { arguments?: unknown },
    next: () => Promise<unknown>,
  ) => {
    for (const path of extractArgumentPaths(exec?.arguments)) {
      if (touched.size < MAX_TOUCHED_PATHS) touched.add(path);
    }
    return next();
  }) as unknown as (...args: never[]) => unknown));

  /** 白名单判定：返回拒绝原因，未命中白名单外的工具返回 `undefined`。 */
  const denial = (name: unknown): string | undefined => {
    const allow = latest?.tools?.allow;
    if (allow === undefined || allow.length === 0 || typeof name !== 'string') return undefined;
    if (allow.includes(name)) return undefined;
    return `工具 ${name} 不在当前路由白名单内；本会话可用：${allow.join(', ')}`;
  };

  // 首选宿主的作用域守卫（单调、无法被后续策略放行）；不可用时退回 pre-execute 瀑布。
  const guard = agentCtx.tools?.guard;
  const enforcement: 'tools.guard' | 'tools/pre-execute' | 'none' = guard !== undefined
    ? 'tools.guard'
    : agentCtx.on === undefined ? 'none' : 'tools/pre-execute';
  if (guard !== undefined) {
    disposers.push(guard.call(agentCtx.tools, ((exec: { name?: unknown }) => denial(exec?.name)) as never));
  } else if (enforcement === 'tools/pre-execute') {
    disposers.push(agentCtx.on('tools/pre-execute', (async (
      exec: { name?: unknown },
      next: () => Promise<unknown>,
    ) => {
      const reason = denial(exec?.name);
      return reason === undefined ? next() : { kind: 'deny', reason };
    }) as unknown as (...args: never[]) => unknown));
  }

  // 首次拼装失败不应影响 Agent 创建：记录后继续。
  try {
    latest = compute();
  } catch (error) {
    logger?.error(`dsh-prompt-router: 首次拼装失败：${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    cwd,
    plan: () => latest,
    refresh: () => {
      if (disposed) return latest!;
      return compute();
    },
    describe: () => {
      const plan = latest ?? compute();
      const prompt = plan.prompt;
      return {
        sessionId,
        cwd,
        route: plan.route,
        mode: plan.mode ?? null,
        tools: plan.tools ?? null,
        /** 当前生效的白名单执行机制。 */
        enforcement,
        /** 宿主全局注册表里的工具名（只有这些能交给 tools.restrict）。 */
        globalTools: toolProbe().globalNames,
        matched: plan.matched,
        skipped: plan.skipped,
        truncated: plan.truncated,
        overridden: plan.overridden,
        diagnostics: plan.diagnostics,
        promptBytes: Buffer.byteLength(prompt, 'utf8'),
        promptPreview: prompt.length > 800 ? `${prompt.slice(0, 800)}…` : prompt,
        generatedAt: plan.generatedAt,
      };
    },
    assemble: async () => {
      const service = agentCtx.systemPrompt;
      if (service?.assemble === undefined) throw new Error('当前宿主不支持按作用域拼装提示词');
      const assembly = await service.assemble({ scope: agent as unknown as never });
      const sections = [...assembly.sections].map(section => ({ name: section.name, text: section.text }));
      const contextEntries = assembly.contexts ?? [];
      return {
        prompt: sections.map(section => section.text).join('\n\n'),
        sections,
        contexts: [...contextEntries].map(entry => ({ name: entry.name, text: entry.text })),
        tools: (assembly.tools ?? []).map(tool => tool.name),
      };
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      restriction?.();
      restriction = undefined;
      for (const disposer of disposers.splice(0)) {
        try {
          disposer();
        } catch {
          /* 宿主卸载期间的清理失败无需中断 */
        }
      }
    },
  };
}
