/**
 * dsh-prompt-router — DeepSeek Harness 提示词路由插件。
 *
 * 按「已绑定自定义模式 > 规则命中 > 默认模板」动态拼装会话的系统提示词与
 * 工具白名单：规则来自 AGENTS.md / SKILL.md 的 YAML 头部，模式来自
 * dsh-mode-builder 的本机模式目录，运行时探测当前模型、可用工具与绑定任务。
 *
 * @module dsh-prompt-router
 */

import type { CordisContext, HostAPI } from '@dsh-plugin/dsh-loader';
import { defineConfig } from '@dsh-plugin/dsh-loader/config';
import { installAgentRouter, type AgentRouterHandle, type RoutedAgent } from './apply.js';
import {
  CONFIG_ID,
  DEFAULT_TEMPLATE,
  defaultDataDir,
  defaultModesDir,
  deriveHostPaths,
  resolveConfig,
  type RouterSettings,
} from './config.js';
import { registerDiagnostics } from './diag.js';
import { RouterState } from './state.js';

export { planRoute, renderTaskContext, ruleVerdict } from './route.js';
export type { RouteContext, RouteInputs, RoutePlan, RouteSection, RouteToolPlan } from './route.js';
export { modeSnapshot, parseMode, parseRule } from './schema.js';
export type { Issue, ModeDefinition, ModeSnapshot, RuleFile, RuleTier, SessionBinding, TaskBinding } from './schema.js';
export { parseYamlLite, splitFrontmatter, FrontmatterError } from './frontmatter.js';
export { discoverRuleFiles, findProjectRoot } from './discovery.js';
export { readModeCatalog } from './modes.js';
export { BindingStore, normalizeTask } from './store.js';
export {
  DEFAULT_SETTINGS,
  deriveHostPaths,
  defaultDataDir,
  defaultModesDir,
  renderTemplate,
  resolveConfig,
} from './config.js';
export { installAgentRouter, ROUTING_SECTION, TASK_CONTEXT } from './apply.js';
export type { AgentRouterHandle, RoutedAgent } from './apply.js';
export { RouterState } from './state.js';
export { compileGlob, matchAnyGlob, matchGlob } from './glob.js';
export { extractArgumentPaths, extractPaths, truncateUtf8 } from './text.js';
export { registerDiagnostics } from './diag.js';

/** Cordis 插件名，同时是 npm 包名。 */
export const name = '@dsh-plugin/dsh-prompt-router';

/** 依赖的宿主服务。 */
export const inject = ['dshLoader', 'agents'];

/** 宿主 Agent 注册表的最小接口。 */
interface AgentsService {
  list(): RoutedAgent[];
  get(id: string): RoutedAgent | undefined;
}

/** 带宿主服务的 Cordis 上下文。 */
type PluginContext = CordisContext & {
  dshLoader: HostAPI;
  agents?: AgentsService;
};

/**
 * Cordis 插件入口。
 *
 * @param ctx - 宿主上下文。
 */
export async function apply(ctx: PluginContext): Promise<void> {
  const loader = ctx.dshLoader;
  const hostPaths = deriveHostPaths();
  const handle = await loader.config.register<RouterSettings>(ctx, defineConfig({
    id: CONFIG_ID,
    packageName: name,
    title: '提示词路由',
    description: '按会话动态拼装系统提示词与工具白名单；规则来自 AGENTS.md / SKILL.md 的 YAML 头部，模式来自本机模式目录。',
    fields: [
      { type: 'boolean', key: 'enabled', label: '启用插件', default: true },
      {
        type: 'text',
        key: 'defaultMode',
        label: '默认模式 id',
        description: '会话未绑定模式时使用的模式；留空表示只使用规则与默认模板。',
        default: '',
      },
      {
        type: 'textarea',
        key: 'defaultTemplate',
        label: '默认提示词模板',
        description: '未命中模式与规则时注入；支持 {{cwd}}、{{model}}、{{mode}}、{{route}}、{{tools}}、{{rules}} 占位符。',
        default: DEFAULT_TEMPLATE,
      },
      {
        type: 'group',
        label: '目录',
        collapsible: true,
        defaultCollapsed: false,
        fields: [
          {
            type: 'text',
            key: 'modesDir',
            label: '自定义模式目录',
            description: `留空使用 ${defaultModesDir(hostPaths)}。`,
            default: '',
          },
          {
            type: 'text',
            key: 'dataDir',
            label: '会话绑定目录',
            description: `留空使用 ${defaultDataDir(hostPaths)}。`,
            default: '',
          },
          {
            type: 'array',
            key: 'extraRulePaths',
            label: '额外规则路径',
            description: '文件、目录或通配符（相对插件启动目录解析）。',
            item: { type: 'text', label: '路径' },
          },
        ],
      },
      {
        type: 'group',
        label: '规则预算',
        collapsible: true,
        defaultCollapsed: true,
        fields: [
          { type: 'number', key: 'maxScopedBytes', label: 'scoped 规则总预算（字节）', default: 24000, min: 512, max: 4_000_000 },
          { type: 'number', key: 'maxRules', label: '最多规则文件数', default: 100, min: 1, max: 2000 },
          { type: 'number', key: 'maxRuleBytes', label: '单文件上限（字节）', default: 131072, min: 1024, max: 8_000_000 },
          { type: 'number', key: 'cacheMs', label: '缓存有效期（毫秒）', default: 5000, min: 0, max: 600_000 },
        ],
      },
      {
        type: 'group',
        label: '注入与诊断',
        collapsible: true,
        defaultCollapsed: true,
        fields: [
          { type: 'boolean', key: 'injectTaskContext', label: '注入任务摘要', default: true },
          { type: 'boolean', key: 'diagnostics', label: '启用诊断接口', description: '/_dsh/prompt-router', default: true },
        ],
      },
    ],
  }));

  const state = new RouterState({
    config: resolveConfig(handle.get().value, hostPaths, process.cwd()),
    logger: ctx.logger ?? {},
  });
  await state.load();
  ctx.effect(() => () => state.dispose(), 'dsh-prompt-router:state');

  const routers = new Map<string, AgentRouterHandle>();
  const disposeSession = (sessionId: string): void => {
    const router = routers.get(sessionId);
    if (router === undefined) return;
    routers.delete(sessionId);
    router.dispose();
  };

  /** 预热目录后安装单个 Agent 的路由贡献。 */
  const install = async (agent: RoutedAgent): Promise<void> => {
    const sessionId = agent.session.id;
    if (routers.has(sessionId)) return;
    const cwd = agent.session.header?.cwd ?? process.cwd();
    await Promise.all([state.warmRules(cwd), state.warmModes()]);
    if (routers.has(sessionId)) return;
    routers.set(sessionId, installAgentRouter(agent, state));
  };

  let diagnostics: (() => void) | undefined;
  const reconcileDiagnostics = (): void => {
    if (!state.current.diagnostics) {
      diagnostics?.();
      diagnostics = undefined;
      return;
    }
    if (diagnostics !== undefined) return;
    try {
      diagnostics = registerDiagnostics(ctx, loader, {
        state,
        session: sessionId => routers.get(sessionId),
        refresh: sessionId => {
          const router = routers.get(sessionId);
          if (router === undefined) return;
          void state.warmRules(router.cwd)
            .then(() => state.warmModes())
            .then(() => router.refresh())
            .catch(error => ctx.logger?.error?.(`dsh-prompt-router: 刷新会话失败：${String(error)}`));
        },
      });
    } catch (error) {
      ctx.logger?.warn?.(`dsh-prompt-router: 诊断接口未注册：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const agents = ctx.agents;
  if (agents === undefined) {
    ctx.logger?.warn?.('dsh-prompt-router: 宿主缺少 agents 服务，插件未生效');
    return;
  }

  ctx.effect(
    () => ctx.on?.('agent/created', (async (payload: { agent?: RoutedAgent }) => {
      if (payload?.agent !== undefined) await install(payload.agent);
    }) as (...args: never[]) => unknown) ?? (() => {}),
    'dsh-prompt-router:agent-created',
  );
  ctx.effect(
    () => ctx.on?.('agent/disposed', ((payload: { agent?: RoutedAgent }) => {
      const agent = payload?.agent;
      if (agent !== undefined) disposeSession(agent.session.id);
    }) as (...args: never[]) => unknown) ?? (() => {}),
    'dsh-prompt-router:agent-disposed',
  );

  handle.watch(({ value }) => {
    void (async () => {
      await state.update(value, process.cwd());
      reconcileDiagnostics();
      const handles = [...routers.values()];
      await Promise.all(handles.map(router => Promise.all([state.warmRules(router.cwd), state.warmModes()])));
      for (const router of handles) router.refresh();
    })().catch(error => ctx.logger?.error?.(`dsh-prompt-router: 应用配置失败：${String(error)}`));
  });

  await Promise.all([state.warmModes(), state.warmRules(process.cwd())]);
  for (const agent of agents.list()) await install(agent);
  reconcileDiagnostics();
}
