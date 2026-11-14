/**
 * YAML 头部（frontmatter）解析。
 *
 * 路由规则直接复用 DSH 的 AGENTS.md / SKILL.md 文件，因此这里只实现头部
 * 需要的 YAML 子集：顶层标量、引号字符串、布尔、数字、行内数组与 `- ` 块
 * 数组。嵌套映射、块标量（`|` / `>`）等构造不在路由 Schema 内，解析时记为
 * 警告并跳过，不阻断整份规则；头部结构本身损坏时才判定文件无效。
 *
 * @module dsh-prompt-router/frontmatter
 */

/** 头部结构损坏。调用方应记录警告并跳过该文件，而不是中断拼装。 */
export class FrontmatterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrontmatterError';
  }
}

/** 拆分结果。 */
export interface FrontmatterSplit {
  /** 头部解析出的键值；无头部时为空对象。 */
  data: Record<string, unknown>;
  /** 去掉头部后的正文。 */
  body: string;
  /** 是否存在头部。 */
  present: boolean;
  /** 解析过程中被忽略的构造。 */
  warnings: string[];
}

/** 去掉行尾注释：引号内的 `#` 不视为注释。 */
function stripComment(value: string): string {
  let quote: string | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else if (char === '\\' && quote === '"') index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#' && (index === 0 || /\s/.test(value[index - 1]!))) return value.slice(0, index);
  }
  return value;
}

/** 解析标量：引号字符串、布尔、null、数字与普通文本。 */
function parseScalar(raw: string): unknown {
  const value = raw.trim();
  if (value.length === 0) return '';
  if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2)) {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (inner.length === 0) return [];
    return splitInline(inner).map(parseScalar);
  }
  const lowered = value.toLowerCase();
  if (lowered === 'true' || lowered === 'yes' || lowered === 'on') return true;
  if (lowered === 'false' || lowered === 'no' || lowered === 'off') return false;
  if (lowered === 'null' || lowered === '~') return null;
  if (/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) return Number(value);
  return value;
}

/** 按逗号拆分行内数组，忽略引号内的逗号。 */
function splitInline(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (quote !== undefined) {
      current += char;
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ',') {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map(part => part.trim()).filter(part => part.length > 0);
}

/** 数组项：去掉 `- ` 前缀后按标量解析。 */
function parseListItem(line: string): unknown {
  return parseScalar(line.replace(/^\s*-\s?/, ''));
}

/**
 * 解析 YAML 头部的顶层键值。
 * @param source - 头部原文（不含 `---` 分隔线）。
 * @returns 顶层数据与被忽略的构造说明。
 */
export function parseYamlLite(source: string): { data: Record<string, unknown>; warnings: string[] } {
  const data: Record<string, unknown> = {};
  const warnings: string[] = [];
  const lines = source.split(/\r?\n/);
  let listKey: string | undefined;
  let list: unknown[] | undefined;
  let nestedKey: string | undefined;

  const flush = (): void => {
    if (listKey !== undefined && list !== undefined) data[listKey] = list;
    listKey = undefined;
    list = undefined;
  };

  for (const line of lines) {
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue;
    const indented = /^\s/.test(line);
    if (indented) {
      if (listKey !== undefined && /^\s*-(\s|$)/.test(line)) {
        list!.push(parseListItem(line));
        continue;
      }
      if (nestedKey !== undefined) continue;
      warnings.push(`忽略不支持的多行构造：${line.trim().slice(0, 40)}`);
      continue;
    }
    flush();
    nestedKey = undefined;
    const match = /^([A-Za-z0-9_.-]+):(.*)$/.exec(line);
    if (match === null) {
      warnings.push(`忽略无法解析的头部行：${line.trim().slice(0, 40)}`);
      continue;
    }
    const key = match[1]!;
    const raw = stripComment(match[2] ?? '').trim();
    if (raw.length === 0) {
      // 值在后续缩进行里：只支持 `- ` 列表，其余（嵌套映射、块标量）跳过。
      listKey = key;
      list = [];
      nestedKey = key;
      continue;
    }
    if (raw.startsWith('|') || raw.startsWith('>')) {
      nestedKey = key;
      warnings.push(`忽略块标量字段 ${key}`);
      continue;
    }
    data[key] = parseScalar(raw);
  }
  flush();
  return { data, warnings };
}

/**
 * 拆分 YAML 头部与正文。
 * @param source - 完整文件内容。
 * @returns 头部数据、正文与警告。
 * @throws {FrontmatterError} 开始分隔线存在但缺少结束分隔线时。
 */
export function splitFrontmatter(source: string): FrontmatterSplit {
  const text = source.replace(/^\uFEFF/, '');
  const open = /^---[ \t]*\r?\n/.exec(text);
  if (open === null) return { data: {}, body: text, present: false, warnings: [] };
  const rest = text.slice(open[0].length);
  const close = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (close === null) throw new FrontmatterError('YAML 头部缺少结束分隔线（---）');
  const header = rest.slice(0, close.index);
  const parsed = parseYamlLite(header);
  return {
    data: parsed.data,
    body: rest.slice(close.index + close[0].length),
    present: true,
    warnings: parsed.warnings,
  };
}
