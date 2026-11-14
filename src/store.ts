/**
 * 会话级绑定与任务摘要的持久化。
 *
 * 存储位置：`<dataDir>/sessions.json`，结构为
 * `{ formatVersion: 1, sessions: { [sessionId]: SessionBinding } }`。
 * 写入串行化并采用「同目录临时文件 + rename」的原子替换；单个文件损坏时
 * 只记录错误并保留内存状态，不会让插件加载失败。
 *
 * @module dsh-prompt-router/store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModeSnapshot, SessionBinding, TaskBinding, TaskHistoryEntry } from './schema.js';

/** 存储文件的格式版本。 */
const FORMAT_VERSION = 1;

/** 单个会话最多保留的状态条目（防止文件无限增长）。 */
const MAX_SESSIONS = 500;

/** 校验并规范化任务摘要输入。 */
export function normalizeTask(value: unknown, now: number = Date.now()): { task?: TaskBinding; error?: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { error: '任务摘要必须是 JSON 对象' };
  }
  const record = value as Record<string, unknown>;
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  if (title.length === 0) return { error: '任务摘要缺少非空 title' };
  const description = typeof record.description === 'string' ? record.description.trim() : undefined;
  const tags = Array.isArray(record.tags)
    ? record.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0).map(tag => tag.trim())
    : [];
  const history: TaskHistoryEntry[] = [];
  if (Array.isArray(record.history)) {
    for (const entry of record.history.slice(-50)) {
      if (typeof entry === 'string') {
        history.push({ status: entry });
        continue;
      }
      if (entry === null || typeof entry !== 'object') continue;
      const item = entry as Record<string, unknown>;
      const status = typeof item.status === 'string' ? item.status.trim() : '';
      if (status.length === 0) continue;
      history.push({
        status,
        ...typeof item.at === 'string' ? { at: item.at } : {},
        ...typeof item.note === 'string' && item.note.length > 0 ? { note: item.note } : {},
      });
    }
  }
  const id = typeof record.id === 'string' && record.id.trim().length > 0 ? record.id.trim() : undefined;
  return {
    task: {
      ...id === undefined ? {} : { id },
      title,
      ...description === undefined || description.length === 0 ? {} : { description },
      tags,
      history,
      updatedAt: now,
    },
  };
}

/** 会话绑定存储。 */
export class BindingStore {
  private readonly sessions = new Map<string, SessionBinding>();
  private queue: Promise<void> = Promise.resolve();
  private loaded = false;

  /**
   * @param directory - 状态目录。
   * @param onError - 持久化失败回调（默认静默，由调用方注入 logger）。
   */
  constructor(
    private readonly directory: string,
    private readonly onError: (error: unknown) => void = () => {},
  ) {}

  /** 存储文件绝对路径。 */
  get file(): string {
    return join(this.directory, 'sessions.json');
  }

  /** 是否已完成首次读取。 */
  get ready(): boolean {
    return this.loaded;
  }

  /**
   * 读取磁盘状态；文件不存在时保持空状态。
   * @returns 读取完成。
   */
  async load(): Promise<void> {
    this.loaded = true;
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.onError(error);
      return;
    }
    try {
      const parsed = JSON.parse(text) as { formatVersion?: unknown; sessions?: unknown };
      if (parsed.formatVersion !== FORMAT_VERSION || parsed.sessions === null || typeof parsed.sessions !== 'object') {
        throw new Error(`不支持的存储格式：${String(parsed.formatVersion)}`);
      }
      for (const [sessionId, binding] of Object.entries(parsed.sessions as Record<string, SessionBinding>)) {
        if (sessionId.length === 0 || binding === null || typeof binding !== 'object') continue;
        this.sessions.set(sessionId, binding);
      }
    } catch (error) {
      this.onError(error);
    }
  }

  /**
   * 读取一个会话的绑定。
   * @param sessionId - 会话 id。
   * @returns 绑定副本，未绑定则为 `undefined`。
   */
  get(sessionId: string): SessionBinding | undefined {
    const binding = this.sessions.get(sessionId);
    return binding === undefined ? undefined : structuredClone(binding);
  }

  /** 当前全部绑定的浅快照（诊断用）。 */
  snapshot(): Record<string, SessionBinding> {
    const result: Record<string, SessionBinding> = {};
    for (const [sessionId, binding] of this.sessions) result[sessionId] = structuredClone(binding);
    return result;
  }

  /**
   * 绑定或解绑自定义模式。
   * @param sessionId - 会话 id。
   * @param mode - 模式快照；`null` 表示解绑。
   */
  async bindMode(sessionId: string, mode: ModeSnapshot | null): Promise<void> {
    const current = this.sessions.get(sessionId) ?? { updatedAt: Date.now() };
    const next: SessionBinding = { ...current, updatedAt: Date.now() };
    if (mode === null) delete next.mode;
    else next.mode = mode;
    await this.write(sessionId, next);
  }

  /**
   * 写入或清除任务摘要。
   * @param sessionId - 会话 id。
   * @param task - 任务摘要；`null` 表示清除。
   */
  async setTask(sessionId: string, task: TaskBinding | null): Promise<void> {
    const current = this.sessions.get(sessionId) ?? { updatedAt: Date.now() };
    const next: SessionBinding = { ...current, updatedAt: Date.now() };
    if (task === null) delete next.task;
    else next.task = task;
    await this.write(sessionId, next);
  }

  /**
   * 保存一个会话的绑定并在空绑定出现时清理。
   * @param sessionId - 会话 id。
   * @param binding - 新绑定。
   */
  private async write(sessionId: string, binding: SessionBinding): Promise<void> {
    if (binding.mode === undefined && binding.task === undefined) this.sessions.delete(sessionId);
    else this.sessions.set(sessionId, binding);
    if (this.sessions.size > MAX_SESSIONS) {
      const oldest = [...this.sessions.entries()].sort((left, right) => left[1].updatedAt - right[1].updatedAt)[0];
      if (oldest !== undefined) this.sessions.delete(oldest[0]);
    }
    await this.persist();
  }

  /** 串行化落盘。 */
  private persist(): Promise<void> {
    this.queue = this.queue.then(async () => {
      try {
        await mkdir(this.directory, { recursive: true });
        const payload = JSON.stringify({
          formatVersion: FORMAT_VERSION,
          sessions: Object.fromEntries(this.sessions),
        }, null, 2);
        const temporary = `${this.file}.tmp`;
        await writeFile(temporary, `${payload}\n`, 'utf8');
        await rename(temporary, this.file);
      } catch (error) {
        this.onError(error);
      }
    });
    return this.queue;
  }
}
