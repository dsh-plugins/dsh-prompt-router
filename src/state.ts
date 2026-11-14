/**
 * 路由运行时状态：配置快照、规则发现缓存、模式目录缓存与会话绑定。
 *
 * 系统提示词的分段提供函数是同步的，而规则发现需要 IO，因此这里采用
 * 「异步预热 + 同步读缓存」：发现结果按会话工作目录缓存；缓存过期时在本次
 * 拼装中继续使用旧快照，并在后台刷新，下一轮生效。
 *
 * @module dsh-prompt-router/state
 */

import { readModeCatalog, type ModeCatalog } from './modes.js';
import { deriveHostPaths, resolveConfig, type HostPaths, type ResolvedRouterConfig, type RouterSettings } from './config.js';
import { discoverRuleFiles } from './discovery.js';
import { parseRule, type Issue, type ModeDefinition, type ModeSnapshot, type RuleFile, type SessionBinding } from './schema.js';
import { BindingStore } from './store.js';

/** 插件 logger 的最小接口。 */
export interface RouterLogger {
  info?(message: string): void;
  warn?(message: string): void;
  error?(message: unknown): void;
}

/** 规则缓存条目。 */
interface RuleEntry {
  files: RuleFile[];
  issues: Issue[];
  loadedAt: number;
  pending?: Promise<void>;
  reported: Set<string>;
}

/** 模式缓存条目。 */
interface ModeEntry {
  catalog: ModeCatalog;
  loadedAt: number;
  pending?: Promise<void>;
  reported: Set<string>;
}

/** 运行时状态构造参数。 */
export interface RouterStateOptions {
  config: ResolvedRouterConfig;
  logger: RouterLogger;
  /** 注入时间源，测试可替换。 */
  now?: () => number;
}

/** 路由运行时状态。 */
export class RouterState {
  private config: ResolvedRouterConfig;
  private readonly rules = new Map<string, RuleEntry>();
  private modes?: ModeEntry;
  private paths: HostPaths;
  private store: BindingStore;
  private readonly logger: RouterLogger;
  private readonly now: () => number;
  private disposed = false;

  constructor(options: RouterStateOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.paths = deriveHostPaths();
    this.store = new BindingStore(this.config.dataDir, error => this.reportError(error));
  }

  /** 当前运行时配置。 */
  get current(): ResolvedRouterConfig {
    return this.config;
  }

  /** 会话绑定存储。 */
  get bindings(): BindingStore {
    return this.store;
  }

  /** 宿主路径（DSH home 与 profile）。 */
  get hostPaths(): HostPaths {
    return this.paths;
  }

  /** 首次加载：读取会话绑定；失败只记录。 */
  async load(): Promise<void> {
    await this.store.load();
  }

  /**
   * 应用新的设置页值并清空缓存。
   *
   * 数据目录变更时重新打开绑定存储（旧目录内容保留在磁盘上，不做迁移）。
   * @param value - 表单值。
   * @param cwd - 相对路径解析基准。
   */
  async update(value: Partial<RouterSettings>, cwd: string): Promise<void> {
    const next = resolveConfig(value, this.paths, cwd);
    const dataDirChanged = next.dataDir !== this.config.dataDir;
    this.config = next;
    this.rules.clear();
    if (this.modes !== undefined) this.modes = undefined;
    if (dataDirChanged) {
      this.store = new BindingStore(next.dataDir, error => this.reportError(error));
      await this.store.load();
    }
  }

  /** 释放状态，取消后续后台刷新。 */
  dispose(): void {
    this.disposed = true;
    this.rules.clear();
    this.modes = undefined;
  }

  /**
   * 预热某个工作目录的规则。
   * @param cwd - 会话工作目录。
   */
  async warmRules(cwd: string): Promise<void> {
    if (this.disposed) return;
    const key = cwd;
    const existing = this.rules.get(key);
    if (existing?.pending !== undefined) {
      await existing.pending;
      return;
    }
    const entry: RuleEntry = existing ?? { files: [], issues: [], loadedAt: 0, reported: new Set() };
    this.rules.set(key, entry);
    entry.pending = (async () => {
      try {
        const found = await discoverRuleFiles({
          cwd: key,
          extras: this.config.extraRulePaths,
          maxFiles: this.config.maxRules,
          maxRuleBytes: this.config.maxRuleBytes,
        });
        const rules: RuleFile[] = [];
        const issues: Issue[] = [...found.issues];
        for (const file of found.files) {
          const parsed = parseRule(file.content, { path: file.path, displayPath: file.displayPath });
          issues.push(...parsed.issues);
          if (parsed.rule !== undefined) rules.push(parsed.rule);
        }
        entry.files = rules;
        entry.issues = issues;
        entry.loadedAt = this.now();
        this.reportIssues(entry.reported, issues);
      } catch (error) {
        entry.loadedAt = this.now();
        this.reportError(error);
      } finally {
        entry.pending = undefined;
      }
    })();
    await entry.pending;
  }

  /**
   * 读取同步规则快照，必要时后台刷新。
   * @param cwd - 会话工作目录。
   * @returns 已解析规则与诊断。
   */
  rulesFor(cwd: string): { files: RuleFile[]; issues: Issue[] } {
    const entry = this.rules.get(cwd);
    if (entry === undefined) {
      void this.warmRules(cwd);
      return { files: [], issues: [] };
    }
    if (this.disposed) return { files: entry.files, issues: entry.issues };
    if (entry.pending === undefined && this.now() - entry.loadedAt > this.config.cacheMs) {
      void this.warmRules(cwd);
    }
    return { files: entry.files, issues: entry.issues };
  }

  /**
   * 预热模式目录。
   * @returns 读取完成。
   */
  async warmModes(): Promise<void> {
    if (this.disposed) return;
    if (this.modes?.pending !== undefined) {
      await this.modes.pending;
      return;
    }
    const entry: ModeEntry = this.modes ?? { catalog: { modes: new Map(), issues: [], scanned: 0 }, loadedAt: 0, reported: new Set() };
    this.modes = entry;
    entry.pending = (async () => {
      try {
        const catalog = await readModeCatalog(this.config.modesDir);
        entry.catalog = catalog;
        entry.loadedAt = this.now();
        this.reportIssues(entry.reported, catalog.issues);
      } catch (error) {
        entry.loadedAt = this.now();
        this.reportError(error);
      } finally {
        entry.pending = undefined;
      }
    })();
    await entry.pending;
  }

  /**
   * 读取同步模式目录快照，必要时后台刷新。
   * @returns 模式目录。
   */
  modesSnapshot(): ModeCatalog {
    const entry = this.modes;
    if (entry === undefined) {
      void this.warmModes();
      return { modes: new Map(), issues: [], scanned: 0 };
    }
    if (this.disposed) return entry.catalog;
    if (entry.pending === undefined && this.now() - entry.loadedAt > this.config.cacheMs) {
      void this.warmModes();
    }
    return entry.catalog;
  }

  /**
   * 解析某个会话实际生效的模式。
   *
   * 已绑定会话优先使用会话内快照；模式文件仍存在且内容哈希变化时热更新快照，
   * 文件被删除时继续使用旧快照（不报错）。未绑定会话使用默认模式。
   * @param sessionId - 会话 id。
   * @returns 生效的模式（目录定义或快照）与绑定。
   */
  resolveMode(sessionId: string): { mode?: ModeDefinition | ModeSnapshot; binding?: SessionBinding; hotUpdated: boolean } {
    const binding = this.store.get(sessionId);
    const catalog = this.modesSnapshot();
    if (binding?.mode !== undefined) {
      const live = catalog.modes.get(binding.mode.id);
      if (live !== undefined && live.hash !== binding.mode.hash) {
        const snapshot: ModeSnapshot = {
          id: live.id,
          name: live.name,
          ...live.description === undefined ? {} : { description: live.description },
          prompt: live.prompt,
          ...live.tools === undefined ? {} : { tools: [...live.tools] },
          sourcePath: live.sourcePath,
          capturedAt: this.now(),
          hash: live.hash,
        };
        // 热更新持久化失败只影响下次启动，本次仍使用活版本。
        void this.store.bindMode(sessionId, snapshot).catch(error => this.reportError(error));
        return { mode: snapshot, binding, hotUpdated: true };
      }
      return { mode: binding.mode, binding, hotUpdated: false };
    }
    const fallback = this.config.defaultMode.length === 0 ? undefined : catalog.modes.get(this.config.defaultMode);
    return { mode: fallback, binding, hotUpdated: false };
  }

  /** 收集当前配置与运行状态（诊断路由用）。 */
  describe(): Record<string, unknown> {
    const ruleStats: Record<string, { rules: number; issues: number; loadedAt: number }> = {};
    for (const [cwd, entry] of this.rules) {
      ruleStats[cwd] = { rules: entry.files.length, issues: entry.issues.length, loadedAt: entry.loadedAt };
    }
    return {
      enabled: this.config.enabled,
      defaultMode: this.config.defaultMode,
      modesDir: this.config.modesDir,
      dataDir: this.config.dataDir,
      profile: this.config.profile,
      dshHome: this.config.dshHome,
      maxScopedBytes: this.config.maxScopedBytes,
      cacheMs: this.config.cacheMs,
      bindings: this.store.snapshot(),
      rules: ruleStats,
      modes: this.modes === undefined
        ? { scanned: 0, loadedAt: 0, entries: [] }
        : {
            scanned: this.modes.catalog.scanned,
            loadedAt: this.modes.loadedAt,
            entries: [...this.modes.catalog.modes.values()].map(mode => ({
              id: mode.id,
              name: mode.name,
              tools: mode.tools ?? [],
              hash: mode.hash,
              sourcePath: mode.sourcePath,
            })),
            issues: this.modes.catalog.issues,
          },
    };
  }

  /**
   * 记录去重后的文件问题。
   * @param reported - 已上报过的消息集合。
   * @param issues - 新诊断。
   */
  private reportIssues(reported: Set<string>, issues: readonly Issue[]): void {
    for (const issue of issues) {
      const key = `${issue.path}\u0000${issue.message}`;
      if (reported.has(key)) continue;
      reported.add(key);
      this.logger.warn?.(`dsh-prompt-router: ${issue.path}: ${issue.message}`);
    }
  }

  /** 记录运行时错误。 */
  private reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error?.(`dsh-prompt-router: ${message}`);
  }
}
