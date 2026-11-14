/**
 * 诊断 HTTP 路由。
 *
 * 挂载在 `/_dsh/prompt-router` 下的同源接口，用于核对拼装结果、绑定模式与写入
 * 任务摘要。所有请求复用宿主 `connection.authorizeIndex` 的浏览器鉴权（查询串
 * 里的 `token`），并拒绝跨站请求；请求体上限 1 MiB。
 *
 * 接口清单：
 * - `GET  /health`                  插件与目录概况
 * - `GET  /state`                   完整运行时状态（含会话绑定）
 * - `GET  /rules?cwd=`              某个工作目录已解析的规则
 * - `GET  /sessions/<id>`           会话绑定与实时拼装摘要
 * - `POST /sessions/<id>/mode`      `{ mode: string | null }` 绑定/解绑模式
 * - `POST /sessions/<id>/task`      `{ task: object | null }` 写入/清除任务摘要
 *
 * @module dsh-prompt-router/diag
 */

import type { HostAPI } from '@dsh-plugin/dsh-loader';
import { ROUTE_PREFIX } from './config.js';
import { modeSnapshot } from './schema.js';
import type { RouterState } from './state.js';
import { normalizeTask } from './store.js';
import type { AgentRouterHandle } from './apply.js';

/** 请求体上限。 */
const MAX_BODY_BYTES = 1_048_576;

/** 诊断路由依赖。 */
export interface DiagnosticsOptions {
  state: RouterState;
  /** 查找活跃会话的路由句柄。 */
  session(sessionId: string): AgentRouterHandle | undefined;
  /** 绑定变化后刷新该会话。 */
  refresh(sessionId: string): void;
}

/** Node 风格请求/响应的最小结构。 */
interface RequestLike {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array>;
}

interface ResponseLike {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string): void;
}

/** 写出 JSON 响应。 */
function json(response: ResponseLike, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(Buffer.byteLength(body, 'utf8')),
  });
  response.end(body);
}

/** 读取并解析 JSON 请求体。 */
async function readBody(request: RequestLike): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error(`请求体超过 ${MAX_BODY_BYTES} 字节上限`);
    chunks.push(buffer);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** 是否允许该请求访问诊断路由。 */
function authorize(loader: HostAPI, request: RequestLike, response: ResponseLike): boolean {
  const connection = loader.services.get('connection') as
    | { authorizeIndex?(req: unknown, res: unknown): boolean }
    | undefined;
  if (connection?.authorizeIndex === undefined) {
    json(response, 503, { ok: false, error: '宿主鉴权服务不可用' });
    return false;
  }
  if (!connection.authorizeIndex(request, response)) return false;
  const headers = request.headers ?? {};
  const origin = typeof headers.origin === 'string' ? headers.origin : undefined;
  const host = typeof headers.host === 'string' ? headers.host : undefined;
  if (headers['sec-fetch-site'] === 'cross-site') {
    json(response, 403, { ok: false, error: '拒绝跨站请求' });
    return false;
  }
  if (origin !== undefined && host !== undefined) {
    try {
      if (new URL(origin).host !== host) {
        json(response, 403, { ok: false, error: '拒绝跨站请求' });
        return false;
      }
    } catch {
      json(response, 403, { ok: false, error: 'Origin 非法' });
      return false;
    }
  }
  return true;
}

/**
 * 注册诊断路由。
 * @param ctx - Cordis 上下文（用于生命周期回收）。
 * @param loader - dsh-loader 宿主 API。
 * @param options - 状态与刷新回调。
 * @returns 清理函数。
 */
export function registerDiagnostics(
  ctx: { effect(fn: () => void | (() => void), label?: string): void },
  loader: HostAPI,
  options: DiagnosticsOptions,
): () => void {
  const dispose = loader.web.register(ROUTE_PREFIX, (async (request: RequestLike, response: ResponseLike) => {
    if (!authorize(loader, request, response)) return;
    const method = (request.method ?? 'GET').toUpperCase();
    let pathname: string;
    try {
      pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    } catch {
      json(response, 400, { ok: false, error: '非法的请求地址' });
      return;
    }
    const segments = pathname.slice(ROUTE_PREFIX.length).split('/').filter(segment => segment.length > 0);
    const state = options.state;
    try {
      if (segments.length === 1 && segments[0] === 'health') {
        json(response, 200, { ok: true, name: '@dsh-plugin/dsh-prompt-router', ...state.describe() });
        return;
      }
      if (segments.length === 1 && segments[0] === 'state') {
        json(response, 200, { ok: true, ...state.describe() });
        return;
      }
      if (segments.length === 1 && segments[0] === 'rules') {
        const cwd = new URL(request.url ?? '/', 'http://localhost').searchParams.get('cwd') ?? process.cwd();
        const snapshot = state.rulesFor(cwd);
        json(response, 200, {
          ok: true,
          cwd,
          rules: [...snapshot.files].map(rule => ({
            path: rule.path,
            displayPath: rule.displayPath,
            tier: rule.tier,
            modes: rule.modes,
            paths: rule.paths,
            taskTags: rule.taskTags,
            ...rule.tools === undefined ? {} : { tools: rule.tools },
            override: rule.override,
            bytes: rule.bytes,
          })),
          issues: snapshot.issues,
        });
        return;
      }
      if (segments[0] === 'sessions' && segments.length >= 2) {
        const sessionId = decodeURIComponent(segments[1]!);
        if (segments.length === 2) {
          if (method !== 'GET') {
            json(response, 405, { ok: false, error: '仅支持 GET' });
            return;
          }
          const handle = options.session(sessionId);
          json(response, 200, {
            ok: true,
            sessionId,
            binding: state.bindings.get(sessionId) ?? null,
            plan: handle?.describe() ?? null,
          });
          return;
        }
        if (segments.length === 3 && segments[2] === 'assemble') {
          if (method !== 'GET') {
            json(response, 405, { ok: false, error: '仅支持 GET' });
            return;
          }
          const handle = options.session(sessionId);
          if (handle === undefined) {
            json(response, 404, { ok: false, error: '会话当前没有活跃的 Agent' });
            return;
          }
          const assembly = await handle.assemble();
          json(response, 200, { ok: true, sessionId, ...assembly });
          return;
        }
        if (segments.length === 3 && segments[2] === 'mode') {
          if (method !== 'POST') {
            json(response, 405, { ok: false, error: '仅支持 POST' });
            return;
          }
          const body = (await readBody(request)) as { mode?: unknown };
          const modeValue = body.mode;
          if (modeValue === null || modeValue === '') {
            await state.bindings.bindMode(sessionId, null);
          } else if (typeof modeValue === 'string') {
            const live = state.modesSnapshot().modes.get(modeValue);
            if (live === undefined) {
              json(response, 404, {
                ok: false,
                error: `未找到模式 ${modeValue}`,
                modes: [...state.modesSnapshot().modes.keys()],
              });
              return;
            }
            await state.bindings.bindMode(sessionId, modeSnapshot(live));
          } else {
            json(response, 400, { ok: false, error: 'mode 必须是模式 id 字符串或 null' });
            return;
          }
          options.refresh(sessionId);
          json(response, 200, { ok: true, sessionId, binding: state.bindings.get(sessionId) ?? null });
          return;
        }
        if (segments.length === 3 && segments[2] === 'task') {
          if (method !== 'POST') {
            json(response, 405, { ok: false, error: '仅支持 POST' });
            return;
          }
          const body = (await readBody(request)) as { task?: unknown };
          if (body.task === null) {
            await state.bindings.setTask(sessionId, null);
          } else {
            const normalized = normalizeTask(body.task);
            if (normalized.task === undefined) {
              json(response, 400, { ok: false, error: normalized.error ?? '任务摘要非法' });
              return;
            }
            await state.bindings.setTask(sessionId, normalized.task);
          }
          options.refresh(sessionId);
          json(response, 200, { ok: true, sessionId, binding: state.bindings.get(sessionId) ?? null });
          return;
        }
      }
      json(response, 404, { ok: false, error: `未找到路由 ${method} ${pathname}` });
    } catch (error) {
      json(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }) as unknown as (...args: unknown[]) => unknown);
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    dispose();
  };
  ctx.effect(() => release, 'dsh-prompt-router:diagnostics');
  return release;
}
