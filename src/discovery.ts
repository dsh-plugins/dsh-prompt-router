/**
 * 规则文件发现。
 *
 * 规则直接复用 `AGENTS.md` 与 `SKILL.md` 的 YAML 头部，因此发现范围是：
 * 1. 项目根（含 `.git` 的最近祖先）到会话工作目录整条链上的 `AGENTS.md` 与 `SKILL.md`；
 * 2. 项目根与会话工作目录下 `skills/`、`.dsh/skills/`、`.agents/skills/` 中的子目录 `SKILL.md`；
 * 3. 设置页 `extraRulePaths` 指定的文件、目录或通配符。
 *
 * 所有扫描都是有界的：深度、文件数、单文件字节数均受限，`node_modules`、
 * `.git`、`lib`、`dist` 等目录一律跳过。
 *
 * @module dsh-prompt-router/discovery
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { matchGlob, normalizePath } from './glob.js';
import type { Issue } from './schema.js';

/** 目录扫描时跳过的目录名。 */
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'lib', 'dist', 'coverage', '.pnpm-store']);

/** 发现参数。 */
export interface DiscoverOptions {
  /** 会话工作目录。 */
  cwd: string;
  /** 额外规则路径（已展开为绝对路径）。 */
  extras: readonly string[];
  /** 最多读取的规则文件数。 */
  maxFiles: number;
  /** 单个文件的读取上限（字节）。 */
  maxRuleBytes: number;
}

/** 一个已读取的规则文件。 */
export interface DiscoveredFile {
  path: string;
  displayPath: string;
  content: string;
}

/** 发现结果。 */
export interface DiscoveryResult {
  files: DiscoveredFile[];
  issues: Issue[];
  /** 扫描过的候选文件数（含未通过上限的）。 */
  scanned: number;
}

/**
 * 找到最近的项目根：自 `cwd` 向上第一个包含 `.git` 的目录，找不到时返回 `cwd`。
 * @param cwd - 会话工作目录。
 * @returns 项目根绝对路径。
 */
export async function findProjectRoot(cwd: string): Promise<string> {
  let current = resolve(cwd);
  for (;;) {
    try {
      const info = await stat(join(current, '.git'));
      if (info.isDirectory() || info.isFile()) return current;
    } catch {
      /* 继续向上 */
    }
    const parent = dirname(current);
    if (parent === current) return resolve(cwd);
    current = parent;
  }
}

/** 目录链：项目根到 `cwd`（含两端）。 */
function ancestorChain(root: string, cwd: string): string[] {
  const result: string[] = [];
  let current = resolve(cwd);
  for (;;) {
    result.push(current);
    if (current === resolve(root)) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return result.reverse();
}

/** 安全读取目录项。 */
async function listDirectory(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  } catch {
    return [];
  }
}

/** 文件是否存在且为普通文件。 */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** 受字节上限保护的读取。 */
async function readCapped(path: string, maxBytes: number): Promise<string | undefined> {
  try {
    const buffer = await readFile(path);
    if (buffer.byteLength > maxBytes) return undefined;
    return buffer.toString('utf8');
  } catch {
    return undefined;
  }
}

/**
 * 递归收集目录下的 Markdown 文件（受深度上限约束）。
 * @param directory - 起始目录。
 * @param depth - 剩余可下探深度。
 * @param out - 结果收集器。
 */
async function collectMarkdown(directory: string, depth: number, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIPPED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (depth > 1) await collectMarkdown(path, depth - 1, out);
      continue;
    }
    if (entry.isFile() && /\.md$/i.test(entry.name)) out.push(path);
  }
}

/**
 * 展开一条额外规则路径（文件、目录或通配符）。
 * @param entry - 已展开的绝对路径或通配符模式。
 * @param cwd - 会话工作目录（通配符展开的根）。
 * @param out - 结果收集器。
 */
async function collectExtra(entry: string, cwd: string, out: string[]): Promise<void> {
  if (/[*?]/.test(entry)) {
    const normalized = normalizePath(entry);
    const wildcardAt = normalized.search(/[*?]/);
    const fixedPrefix = normalized.slice(0, wildcardAt);
    const base = fixedPrefix.endsWith('/') ? fixedPrefix.slice(0, -1) : dirname(fixedPrefix);
    const depth = 5;
    const walked: string[] = [];
    await collectMarkdown(base.length === 0 ? cwd : base, depth, walked);
    for (const path of walked) {
      if (matchGlob(entry, normalizePath(path)) || matchGlob(entry, normalizePath(relative(cwd, path)))) out.push(path);
    }
    return;
  }
  try {
    const info = await stat(entry);
    if (info.isFile()) {
      out.push(entry);
      return;
    }
    if (info.isDirectory()) {
      const walked: string[] = [];
      await collectMarkdown(entry, 3, walked);
      out.push(...walked);
    }
  } catch {
    /* 不存在的额外路径直接忽略，由设置页自行核对 */
  }
}

/**
 * 发现并读取全部规则文件。
 * @param options - 发现参数。
 * @returns 已读取的文件、诊断信息与扫描计数。
 */
export async function discoverRuleFiles(options: DiscoverOptions): Promise<DiscoveryResult> {
  const cwd = resolve(options.cwd);
  const root = await findProjectRoot(cwd);
  const candidates: string[] = [];
  const chain = ancestorChain(root, cwd);
  for (const directory of chain) {
    candidates.push(join(directory, 'AGENTS.md'), join(directory, 'SKILL.md'));
  }
  const skillRoots = [...new Set([root, cwd])];
  for (const directory of skillRoots) {
    for (const sub of ['skills', join('.dsh', 'skills'), join('.agents', 'skills')]) {
      for (const name of await listDirectory(join(directory, sub))) {
        candidates.push(join(directory, sub, name, 'SKILL.md'));
      }
    }
  }
  const extraFiles: string[] = [];
  for (const extra of options.extras) await collectExtra(extra, cwd, extraFiles);
  candidates.push(...extraFiles);

  const issues: Issue[] = [];
  const files: DiscoveredFile[] = [];
  const seen = new Set<string>();
  let scanned = 0;
  for (const candidate of candidates) {
    const absolute = resolve(candidate);
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    if (!(await isFile(absolute))) continue;
    scanned += 1;
    if (files.length >= options.maxFiles) {
      issues.push({ path: absolute, message: `规则文件数超过上限 ${options.maxFiles}，已忽略其余文件` });
      break;
    }
    const content = await readCapped(absolute, options.maxRuleBytes);
    if (content === undefined) {
      issues.push({ path: absolute, message: `文件超过单文件上限 ${options.maxRuleBytes} 字节或读取失败，已跳过` });
      continue;
    }
    const rel = normalizePath(relative(root, absolute));
    files.push({
      path: absolute,
      displayPath: rel.startsWith('..') ? basename(absolute) : rel,
      content,
    });
  }
  return { files, issues, scanned };
}
