/**
 * 自定义模式目录的读取与解析。
 *
 * 目录结构由 dsh-mode-builder 约定：每个模式一个 JSON 文件，文件名（去掉
 * `.json`）是 id 的兜底来源。路由只读取拼装需要的字段（提示词与工具白名单），
 * 其余字段（图标、RAG 范围、输出约束等）原样忽略，不做迁移。
 *
 * @module dsh-prompt-router/modes
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { parseMode, type Issue, type ModeDefinition } from './schema.js';

/** 单个模式文件的大小上限（字节）。 */
export const MAX_MODE_BYTES = 262_144;

/** 模式目录读取结果。 */
export interface ModeCatalog {
  modes: Map<string, ModeDefinition>;
  issues: Issue[];
  /** 扫描到的 JSON 文件数。 */
  scanned: number;
}

/**
 * 读取并解析模式目录。
 * @param directory - 模式目录绝对路径。
 * @returns 模式目录；目录不存在时返回空目录而不是抛错。
 */
export async function readModeCatalog(directory: string): Promise<ModeCatalog> {
  const issues: Issue[] = [];
  const modes = new Map<string, ModeDefinition>();
  let names: string[];
  try {
    names = (await readdir(directory)).filter(name => extname(name).toLowerCase() === '.json').sort();
  } catch {
    return { modes, issues, scanned: 0 };
  }
  let scanned = 0;
  for (const name of names) {
    const path = join(directory, name);
    let buffer: Buffer;
    try {
      buffer = await readFile(path);
    } catch (error) {
      issues.push({ path, message: `读取失败：${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    if (buffer.byteLength > MAX_MODE_BYTES) {
      issues.push({ path, message: `模式文件超过 ${MAX_MODE_BYTES} 字节上限，已跳过` });
      continue;
    }
    scanned += 1;
    let json: unknown;
    try {
      // 手工编辑过的文件可能带 UTF-8 BOM，JSON.parse 会直接失败，先剥掉。
      json = JSON.parse(buffer.toString('utf8').replace(/^\uFEFF/, ''));
    } catch (error) {
      issues.push({ path, message: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    const fallbackId = basename(name, extname(name));
    const hash = createHash('sha256').update(buffer).digest('hex');
    const parsed = parseMode(json, fallbackId, path, hash);
    issues.push(...parsed.issues);
    if (parsed.mode === undefined) continue;
    if (modes.has(parsed.mode.id)) {
      issues.push({ path, message: `模式 id ${parsed.mode.id} 与已有文件重复，后读取的文件生效` });
    }
    modes.set(parsed.mode.id, parsed.mode);
  }
  return { modes, issues, scanned };
}
