/**
 * 提示词路由使用的路径通配符匹配。
 *
 * 支持 `**`（跨目录任意层）、`*`（段内任意字符）、`?`（单个非 `/` 字符）：
 * - 模式从路径段边界起匹配到路径末尾，因此仓库相对的 `src/main/java/**` 既能
 *   匹配 `src/main/java/A.java`，也能匹配绝对路径 `C:/proj/src/main/java/A.java`。
 * - 以 `/**` 或 `/` 结尾的模式同时匹配目录自身及其下任意文件。
 * - 候选路径先按 `/` 归一化，Windows 反斜杠会被转换。
 *
 * @module dsh-prompt-router/glob
 */

const REGEX_SPECIAL = /[.+^${}()|[\]\\]/g;
const compiled = new Map<string, RegExp>();

/** 转义正则字面量字符。 */
function escapeLiteral(char: string): string {
  return char.replace(REGEX_SPECIAL, '\\$&');
}

/**
 * 把通配符片段翻译为正则正文（不含锚点）。
 * @param pattern - 已归一化的模式片段。
 * @returns 可直接拼接的正则正文。
 */
function translate(pattern: string): string {
  let text = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          text += '(?:.*/)?';
          index += 2;
        } else {
          text += '.*';
          index += 1;
        }
      } else {
        text += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      text += '[^/]';
      continue;
    }
    text += escapeLiteral(char);
  }
  return text;
}

/**
 * 归一化路径：反斜杠转 `/`，折叠重复分隔符与 `./` 片段。
 * @param value - 原始路径或模式。
 * @returns 归一化结果。
 */
export function normalizePath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/\/\.\//g, '/')
    .trim();
}

/**
 * 编译一条通配符模式（带缓存）。
 * @param pattern - 通配符模式，例如 `src/main/java/**` 或 `build.gradle`。
 * @returns 该模式对应的正则表达式。
 */
export function compileGlob(pattern: string): RegExp {
  const cached = compiled.get(pattern);
  if (cached !== undefined) return cached;
  const normalized = normalizePath(pattern.replace(/^\.\//, ''));
  let regex: RegExp;
  if (normalized.length === 0) {
    // 空模式永不匹配，避免意外放行。
    regex = /(?!)/;
  } else {
    let body: string;
    if (normalized.endsWith('/**')) body = `${translate(normalized.slice(0, -3))}(?:/.*)?`;
    else if (normalized.endsWith('/')) body = `${translate(normalized.slice(0, -1))}(?:/.*)?`;
    else body = translate(normalized);
    // 从段边界起匹配，使仓库相对模式同样命中绝对候选路径。
    regex = new RegExp(`(?:^|/)${body}$`);
  }
  compiled.set(pattern, regex);
  return regex;
}

/**
 * 判断一条候选路径是否命中模式。
 * @param pattern - 通配符模式。
 * @param candidate - 候选路径（绝对路径或相对路径均可）。
 * @returns 是否命中。
 */
export function matchGlob(pattern: string, candidate: string): boolean {
  const value = normalizePath(candidate);
  if (value.length === 0) return false;
  return compileGlob(pattern).test(value);
}

/**
 * 判断候选集合中是否有任意一项命中任意模式。
 * @param patterns - 通配符模式列表。
 * @param candidates - 候选路径列表。
 * @returns 命中的第一个模式；未命中返回 `undefined`。
 */
export function matchAnyGlob(patterns: readonly string[], candidates: readonly string[]): string | undefined {
  for (const pattern of patterns) {
    for (const candidate of candidates) {
      if (matchGlob(pattern, candidate)) return pattern;
    }
  }
  return undefined;
}
