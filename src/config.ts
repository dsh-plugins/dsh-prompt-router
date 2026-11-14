/**
 * 插件配置的默认值、宿主路径推导与解析。
 *
 * 配置由 dsh-loader 的 config-api 持久化到 `<profile>/config/dsh-prompt-router/
 * config.json`；这里只负责把界面值规范化为运行时配置，并推导默认的模式目录与
 * 状态目录。默认路径的推导规则（DSH_HOME + profile）在 docs/CONFIG.md 中说明，
 * 任何一条都可以在设置页覆盖。
 *
 * @module dsh-prompt-router/config
 */

import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/** config-api 模板 id，同时决定磁盘目录名。 */
export const CONFIG_ID = 'dsh-prompt-router';

/** 诊断 HTTP 路由前缀。 */
export const ROUTE_PREFIX = '/_dsh/prompt-router';

/** 运行时配置（已规范化）。 */
export interface ResolvedRouterConfig {
  enabled: boolean;
  /** 未绑定会话时使用的默认模式 id；空串表示不使用。 */
  defaultMode: string;
  /** 自定义模式目录（绝对路径）。 */
  modesDir: string;
  /** 会话绑定与任务摘要的持久化目录（绝对路径）。 */
  dataDir: string;
  /** 默认提示词模板。 */
  defaultTemplate: string;
  /** 额外规则文件或目录。 */
  extraRulePaths: string[];
  /** scoped 规则正文的总预算（字节）。 */
  maxScopedBytes: number;
  /** 单次拼装最多读取的规则文件数。 */
  maxRules: number;
  /** 单个规则文件的读取上限（字节）。 */
  maxRuleBytes: number;
  /** 是否把任务摘要注入运行时上下文。 */
  injectTaskContext: boolean;
  /** 是否注册诊断 HTTP 路由。 */
  diagnostics: boolean;
  /** 规则与模式目录缓存有效期（毫秒）。 */
  cacheMs: number;
  /** 当前 profile 名与 DSH home（诊断输出用）。 */
  profile: string;
  dshHome: string;
}

/** 设置页表单值（config-api 提交的结构）。 */
export interface RouterSettings {
  enabled: boolean;
  defaultMode: string;
  modesDir: string;
  dataDir: string;
  defaultTemplate: string;
  extraRulePaths: string[];
  maxScopedBytes: number;
  maxRules: number;
  maxRuleBytes: number;
  injectTaskContext: boolean;
  diagnostics: boolean;
  cacheMs: number;
}

/** 默认提示词模板。 */
export const DEFAULT_TEMPLATE = [
  'You are working in {{cwd}} with the {{model}} model.',
  'Route: {{route}}. No bound mode or matching scoped rule customized this session yet.',
  'Keep answers grounded in the repository and state assumptions explicitly when required context is missing.',
].join('\n');

/** 表单默认值（同时作为缺失字段的兜底）。 */
export const DEFAULT_SETTINGS: RouterSettings = {
  enabled: true,
  defaultMode: '',
  modesDir: '',
  dataDir: '',
  defaultTemplate: DEFAULT_TEMPLATE,
  extraRulePaths: [],
  maxScopedBytes: 24000,
  maxRules: 100,
  maxRuleBytes: 131072,
  injectTaskContext: true,
  diagnostics: true,
  cacheMs: 5000,
};

/** 宿主路径推导结果。 */
export interface HostPaths {
  dshHome: string;
  profile: string;
}

/**
 * 展开 `~` 前缀并解析为绝对路径。
 * @param value - 用户输入的路径。
 * @param base - 相对路径的解析基准。
 * @returns 绝对路径。
 */
export function expandPath(value: string, base: string): string {
  const trimmed = value.trim();
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return join(homedir(), trimmed.slice(2));
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(base, trimmed);
}

/**
 * 从环境变量与命令行推导 DSH home 与当前 profile。
 *
 * DSH 启动参数形如 `bin.js --profile web --port 55391`，插件运行在同一进程，
 * 因此优先读 `process.argv`；`DSH_PROFILE` 与默认 `web` 依次兜底。
 * @param env - 环境变量（测试可注入）。
 * @param argv - 进程参数（测试可注入）。
 * @returns 推导出的宿主路径。
 */
export function deriveHostPaths(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): HostPaths {
  const dshHomeEnv = env.DSH_HOME?.trim();
  const dshHome = dshHomeEnv === undefined || dshHomeEnv.length === 0 ? join(homedir(), '.dsh') : expandPath(dshHomeEnv, homedir());
  let profile = '';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--profile' || arg === '-p') {
      profile = argv[index + 1] ?? '';
      break;
    }
    if (arg.startsWith('--profile=')) {
      profile = arg.slice('--profile='.length);
      break;
    }
  }
  if (profile.length === 0) profile = env.DSH_PROFILE?.trim() || 'web';
  return { dshHome, profile };
}

/**
 * 默认模式目录：dsh-mode-builder 写入的全局数据目录。
 * @param paths - 宿主路径。
 * @returns 绝对路径。
 */
export function defaultModesDir(paths: HostPaths): string {
  return join(paths.dshHome, 'profiles', paths.profile, 'data', 'dsh-mode-builder', 'modes');
}

/**
 * 默认状态目录：会话绑定与任务摘要。
 * @param paths - 宿主路径。
 * @returns 绝对路径。
 */
export function defaultDataDir(paths: HostPaths): string {
  return join(paths.dshHome, 'profiles', paths.profile, 'data', 'dsh-prompt-router');
}

/**
 * 把设置页值规范化为运行时配置。
 * @param value - 表单值（可能缺字段或被写坏）。
 * @param paths - 宿主路径，用于默认值。
 * @param cwd - 相对路径的解析基准。
 * @returns 规范化配置。
 */
export function resolveConfig(
  value: Partial<RouterSettings> | undefined,
  paths: HostPaths,
  cwd: string = process.cwd(),
): ResolvedRouterConfig {
  const settings: RouterSettings = {
    enabled: typeof value?.enabled === 'boolean' ? value.enabled : DEFAULT_SETTINGS.enabled,
    defaultMode: typeof value?.defaultMode === 'string' ? value.defaultMode.trim() : '',
    modesDir: typeof value?.modesDir === 'string' ? value.modesDir.trim() : '',
    dataDir: typeof value?.dataDir === 'string' ? value.dataDir.trim() : '',
    defaultTemplate: typeof value?.defaultTemplate === 'string' && value.defaultTemplate.trim().length > 0
      ? value.defaultTemplate
      : DEFAULT_TEMPLATE,
    extraRulePaths: Array.isArray(value?.extraRulePaths)
      ? value!.extraRulePaths.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim())
      : [],
    maxScopedBytes: clampNumber(value?.maxScopedBytes, 512, 4_000_000, DEFAULT_SETTINGS.maxScopedBytes),
    maxRules: clampNumber(value?.maxRules, 1, 2000, DEFAULT_SETTINGS.maxRules),
    maxRuleBytes: clampNumber(value?.maxRuleBytes, 1024, 8_000_000, DEFAULT_SETTINGS.maxRuleBytes),
    injectTaskContext: typeof value?.injectTaskContext === 'boolean' ? value.injectTaskContext : DEFAULT_SETTINGS.injectTaskContext,
    diagnostics: typeof value?.diagnostics === 'boolean' ? value.diagnostics : DEFAULT_SETTINGS.diagnostics,
    cacheMs: clampNumber(value?.cacheMs, 0, 600_000, DEFAULT_SETTINGS.cacheMs),
  };
  return {
    ...settings,
    modesDir: settings.modesDir.length === 0 ? defaultModesDir(paths) : expandPath(settings.modesDir, cwd),
    dataDir: settings.dataDir.length === 0 ? defaultDataDir(paths) : expandPath(settings.dataDir, cwd),
    extraRulePaths: settings.extraRulePaths.map(item => expandPath(item, cwd)),
    profile: paths.profile,
    dshHome: paths.dshHome,
  };
}

/** 数值型字段的边界钳制。 */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** 模板可用的占位变量。 */
export interface TemplateVariables {
  cwd: string;
  model: string;
  mode: string;
  route: string;
  tools: string;
  rules: string;
}

/**
 * 渲染默认模板：只替换已声明的 `{{变量}}`，未知占位原样保留。
 * @param template - 模板文本。
 * @param variables - 变量值。
 * @returns 渲染结果。
 */
export function renderTemplate(template: string, variables: TemplateVariables): string {
  return template.replace(/\{\{([a-z][a-z0-9_]*)\}\}/g, (match, name: string) => {
    if (!Object.hasOwn(variables, name)) return match;
    return variables[name as keyof TemplateVariables];
  });
}
