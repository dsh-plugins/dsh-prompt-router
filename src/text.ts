/**
 * 纯文本工具：按 UTF-8 字节截断、从自然语言与工具参数里提取路径。
 *
 * 路径提取服务于 `paths` 规则：会话工作目录恒为候选，用户消息里提到的文件与
 * 最近工具调用操作过的文件也是候选。不做文件系统校验（规则匹配之后再
 * 交给通配符），因此这里只做保守的形态过滤。
 *
 * @module dsh-prompt-router/text
 */

/** 形如 `src/a.ts`、`./build.gradle`、`C:\proj\x` 的路径（至少一个分隔符）。 */
const PATH_WITH_SEPARATOR = /^(?:[A-Za-z]:[\\/]|~[\\/]|\/|\.{1,2}[\\/])?[\w@$.-]+(?:[\\/][\w@$.-]+)+$/;

/** 带常见扩展名的裸文件名。 */
const BARE_FILE_NAME = /^[\w@$.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|mdx|ya?ml|toml|ini|java|kt|kts|gradle|xml|py|go|rs|cs|cpp|cc|cxx|c|h|hpp|sql|sh|ps1|bat|cmd|css|scss|less|html|vue|svelte|lock|txt|log|env|conf|properties)$/i;

/** 扫描工具参数时视为路径容器或路径值的键名。 */
const PATH_KEY = /(?:^|[_:-])(?:path|paths|file|files|filename|filepath|dir|directory|cwd|target|source|destination)$/i;

/**
 * 按 UTF-8 字节安全截断，不会切出半个字符。
 * @param text - 原始文本。
 * @param maxBytes - 允许的最大字节数。
 * @returns 截断后的文本。
 */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.byteLength <= maxBytes) return text;
  let sliced = buffer.subarray(0, maxBytes).toString('utf8');
  while (sliced.endsWith('\uFFFD')) sliced = sliced.slice(0, -1);
  return sliced;
}

/**
 * 判断一个字符串是否像路径。
 * @param token - 已去掉首尾标点的候选。
 * @returns 是否像路径。
 */
function looksLikePath(token: string): boolean {
  if (token.length < 3 || token.length > 260) return false;
  if (token.includes('://')) return false;
  return PATH_WITH_SEPARATOR.test(token) || BARE_FILE_NAME.test(token);
}

/**
 * 从一段文本中提取路径候选。
 * @param text - 用户消息或说明文本。
 * @param limit - 最多返回的数量。
 * @returns 去重后的路径候选。
 */
export function extractPaths(text: string, limit = 32): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/[\s"'`()<>\[\]{},;，。；、]+/)) {
    const token = raw.replace(/^[`"'(<]+/, '').replace(/[`"')>.,;:!?]+$/, '').replace(/\\/g, '\\');
    if (!looksLikePath(token) || seen.has(token)) continue;
    seen.add(token);
    result.push(token);
    if (result.length >= limit) break;
  }
  return result;
}

/**
 * 从工具调用参数中提取路径，最多下探三层。
 * @param value - 工具参数（任意 JSON 值）。
 * @param limit - 最多返回的数量。
 * @returns 去重后的路径候选。
 */
export function extractArgumentPaths(value: unknown, limit = 16): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const push = (candidate: string): void => {
    if (result.length >= limit || seen.has(candidate) || !looksLikePath(candidate)) return;
    seen.add(candidate);
    result.push(candidate);
  };
  const walk = (node: unknown, depth: number): void => {
    if (result.length >= limit || depth > 3 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) {
        if (typeof item === 'string') push(item);
        else walk(item, depth + 1);
      }
      return;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (typeof child === 'string') {
        if (PATH_KEY.test(key)) push(child);
        else if (looksLikePath(child)) push(child);
        continue;
      }
      walk(child, depth + 1);
    }
  };
  walk(value, 0);
  return result;
}
