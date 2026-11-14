/**
 * 路由规则与自定义模式的数据结构与校验。
 *
 * 两部分共用同一套诊断结构：任何单个文件的问题都只产生 {@link Issue}，
 * 由调用方记录并继续拼装，绝不因为一条坏规则让整轮对话失败。
 *
 * @module dsh-prompt-router/schema
 */

import { splitFrontmatter } from './frontmatter.js';

/** 规则层级：pinned 固顶绝不截断，scoped 按需加载且超预算可裁剪。 */
export type RuleTier = 'pinned' | 'scoped';

/** 一处可恢复的文件问题。 */
export interface Issue {
  /** 出问题的文件路径（绝对路径）。 */
  path: string;
  /** 面向用户的简体中文说明。 */
  message: string;
}

/** 一条从 AGENTS.md / SKILL.md 的 YAML 头部解析出的路由规则。 */
export interface RuleFile {
  /** 绝对路径。 */
  path: string;
  /** 相对会话工作目录的展示路径（跨盘等无法相对时退回文件名）。 */
  displayPath: string;
  /** 规则层级，默认 `scoped`。 */
  tier: RuleTier;
  /** 工作阶段/模式限制；空数组表示不限制。 */
  modes: string[];
  /** 文件路径限制（通配符）；空数组表示不限制。 */
  paths: string[];
  /** 任务标签限制；空数组表示不限制。 */
  taskTags: string[];
  /** 工具白名单；未声明时为 `undefined`（不收窄）。 */
  tools?: string[];
  /** 是否覆盖此前拼装出的提示词基线。 */
  override: boolean;
  /** 文件正文（已去掉 YAML 头部）。 */
  body: string;
  /** 正文 UTF-8 字节数。 */
  bytes: number;
}

/** 已绑定的自定义模式定义。 */
export interface ModeDefinition {
  id: string;
  name: string;
  description?: string;
  prompt: string;
  tools?: string[];
  icon?: string;
  /** 模式文件绝对路径。 */
  sourcePath: string;
  /** 模式文件内容哈希（sha256，十六进制），用于快照比对。 */
  hash: string;
}

/** 模式快照：绑定会话时保存，模式文件被删改后仍按快照拼装。 */
export interface ModeSnapshot {
  id: string;
  name: string;
  description?: string;
  prompt: string;
  tools?: string[];
  sourcePath?: string;
  capturedAt: number;
  hash: string;
}

/** 任务上下文摘要（与 dsh-task-board 约定的绑定注入内容）。 */
export interface TaskHistoryEntry {
  at?: string;
  status: string;
  note?: string;
}

export interface TaskBinding {
  id?: string;
  title: string;
  description?: string;
  tags: string[];
  history: TaskHistoryEntry[];
  updatedAt: number;
}

/** 会话级绑定：模式快照与任务摘要。 */
export interface SessionBinding {
  mode?: ModeSnapshot;
  task?: TaskBinding;
  updatedAt: number;
}

/**
 * 读取字符串数组：接受未声明、单个字符串与字符串数组。
 * @param value - 头部原始值。
 * @param key - 字段名，用于诊断信息。
 * @param issues - 诊断收集器。
 * @param path - 文件路径，用于诊断信息。
 * @returns 规范化后的字符串数组。
 */
export function stringArray(
  value: unknown,
  key: string,
  issues: Issue[],
  path: string,
): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length === 0 ? [] : [trimmed];
  }
  if (!Array.isArray(value)) {
    issues.push({ path, message: `字段 ${key} 应为字符串或字符串数组，已忽略` });
    return [];
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim().length > 0) result.push(item.trim());
    else if (typeof item === 'number') result.push(String(item));
    else issues.push({ path, message: `字段 ${key} 含非字符串项，已忽略该项` });
  }
  return result;
}

/**
 * 解析一条规则的 YAML 头部并校验 Schema。
 * @param source - 文件完整内容。
 * @param meta - 文件的绝对路径与展示路径。
 * @param split - 已拆分的头部结果；省略时内部重新拆分。
 * @returns 规则（无效时为 `undefined`）与诊断信息。
 */
export function parseRule(
  source: string,
  meta: { path: string; displayPath: string },
  split?: { data: Record<string, unknown>; body: string; present: boolean; warnings: string[] },
): { rule?: RuleFile; issues: Issue[] } {
  const issues: Issue[] = [];
  let header: { data: Record<string, unknown>; body: string; present: boolean; warnings: string[] };
  try {
    header = split ?? splitFrontmatter(source);
  } catch (error) {
    issues.push({ path: meta.path, message: error instanceof Error ? error.message : String(error) });
    return { issues };
  }
  const { data } = header;
  const tierValue = data.tier;
  let tier: RuleTier = 'scoped';
  if (tierValue !== undefined) {
    const raw = String(tierValue).toLowerCase();
    if (raw === 'pinned' || raw === 'scoped') tier = raw;
    else issues.push({ path: meta.path, message: `tier 只能是 pinned 或 scoped，实际为 ${JSON.stringify(tierValue)}，已按 scoped 处理` });
  }
  const overrideValue = data.override;
  let override = false;
  if (overrideValue !== undefined) {
    if (typeof overrideValue === 'boolean') override = overrideValue;
    else issues.push({ path: meta.path, message: `override 必须是布尔值，实际为 ${JSON.stringify(overrideValue)}，已按 false 处理` });
  }
  const toolsValue = data.tools;
  let tools: string[] | undefined;
  if (toolsValue !== undefined) {
    const declared = stringArray(toolsValue, 'tools', issues, meta.path);
    tools = [...new Set(declared)];
  }
  const modes = stringArray(data.modes, 'modes', issues, meta.path);
  const paths = stringArray(data.paths, 'paths', issues, meta.path);
  const taskTags = stringArray(data.task_tags, 'task_tags', issues, meta.path);
  const body = header.body.trim();
  if (body.length === 0 && (tools === undefined || tools.length === 0)) {
    issues.push({ path: meta.path, message: '规则正文为空且未声明 tools，属于空操作，已跳过' });
    return { issues };
  }
  return {
    issues,
    rule: {
      path: meta.path,
      displayPath: meta.displayPath,
      tier,
      modes,
      paths,
      taskTags,
      ...tools === undefined ? {} : { tools },
      override,
      body,
      bytes: Buffer.byteLength(body, 'utf8'),
    },
  };
}

/**
 * 解析一个自定义模式 JSON 文件内容。
 * @param value - `JSON.parse` 后的对象。
 * @param fallbackId - 文件名推导出的模式 id。
 * @param sourcePath - 模式文件绝对路径。
 * @param hash - 文件内容哈希。
 * @returns 模式定义（无效时为 `undefined`）与诊断信息。
 */
export function parseMode(
  value: unknown,
  fallbackId: string,
  sourcePath: string,
  hash: string,
): { mode?: ModeDefinition; issues: Issue[] } {
  const issues: Issue[] = [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { issues: [{ path: sourcePath, message: '模式文件根节点必须是 JSON 对象' }] };
  }
  const record = value as Record<string, unknown>;
  const formatVersion = record.formatVersion;
  if (formatVersion !== undefined && formatVersion !== 1) {
    issues.push({ path: sourcePath, message: `未知的 formatVersion ${JSON.stringify(formatVersion)}，仍按 formatVersion 1 解析` });
  }
  const id = typeof record.id === 'string' && record.id.trim().length > 0 ? record.id.trim() : fallbackId;
  if (id.length === 0) return { issues: [...issues, { path: sourcePath, message: '模式缺少 id，且无法从文件名推导' }] };
  const name = typeof record.name === 'string' && record.name.trim().length > 0 ? record.name.trim() : id;
  const description = typeof record.description === 'string' ? record.description.trim() : undefined;
  const promptCandidate = record.prompt ?? record.systemPrompt ?? record.promptText ?? record.instructions;
  const prompt = typeof promptCandidate === 'string' ? promptCandidate.trim() : '';
  if (prompt.length === 0) {
    return { issues: [...issues, { path: sourcePath, message: `模式 ${id} 缺少 prompt / systemPrompt 提示词，无法接管拼装` }] };
  }
  const toolsRaw = record.tools ?? record.toolWhitelist ?? record.allowedTools;
  const tools = toolsRaw === undefined ? undefined : stringArray(toolsRaw, 'tools', issues, sourcePath);
  const icon = typeof record.icon === 'string' ? record.icon : undefined;
  return {
    issues,
    mode: {
      id,
      name,
      ...description === undefined || description.length === 0 ? {} : { description },
      prompt,
      ...tools === undefined ? {} : { tools: [...new Set(tools)] },
      ...icon === undefined ? {} : { icon },
      sourcePath,
      hash,
    },
  };
}

/**
 * 生成模式的会话内快照。
 * @param mode - 当前模式定义。
 * @param now - 捕获时间戳，默认当前时间。
 * @returns 可直接持久化的快照。
 */
export function modeSnapshot(mode: ModeDefinition, now: number = Date.now()): ModeSnapshot {
  return {
    id: mode.id,
    name: mode.name,
    ...mode.description === undefined ? {} : { description: mode.description },
    prompt: mode.prompt,
    ...mode.tools === undefined ? {} : { tools: [...mode.tools] },
    sourcePath: mode.sourcePath,
    capturedAt: now,
    hash: mode.hash,
  };
}
