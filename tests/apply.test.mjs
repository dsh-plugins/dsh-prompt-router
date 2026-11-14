/**
 * 宿主接线（apply.ts / diag.ts）的单测：用假 Cordis 上下文验证提示词贡献、
 * 工具限制、守卫拒绝与诊断路由的鉴权和请求处理。
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { installAgentRouter, ROUTING_SECTION, TASK_CONTEXT } from '../lib/apply.js';
import { resolveConfig } from '../lib/config.js';
import { registerDiagnostics } from '../lib/diag.js';
import { RouterState } from '../lib/state.js';
import { normalizeTask } from '../lib/store.js';

let root;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dpr-apply-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

/** 假 Agent 作用域。 */
function createAgentScope(events) {
  const sections = new Map();
  const contexts = new Map();
  const restrictions = [];
  const listeners = new Map();
  const ctx = {
    get: () => undefined,
    logger: { warn() {}, error() {} },
    systemPrompt: {
      section(entry) {
        sections.set(entry.name, entry);
        return () => sections.delete(entry.name);
      },
      context(entry) {
        contexts.set(entry.name, entry);
        return () => contexts.delete(entry.name);
      },
      getSectionOrder: name => (name === 'DEPLOYMENT_PERSONA_PREFIX' ? 0 : 100),
      getContextOrder: name => (name === 'WORKING_DIRECTORY' ? 100 : 200),
    },
    tools: {
      restrict(filter) {
        restrictions.push(filter);
        return () => restrictions.splice(restrictions.indexOf(filter), 1);
      },
      definitions: () => events.tools.map(name => ({ name })),
      guard(fn) {
        listeners.set('tools/guard', fn);
        return () => listeners.delete('tools/guard');
      },
    },
    on(event, listener) {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    },
  };
  return { ctx, sections, contexts, restrictions, listeners };
}

/** 构造一个 Agent。 */
function createAgent(events, sessionId = 'session-1') {
  const scope = createAgentScope(events);
  const agent = {
    id: sessionId,
    session: { id: sessionId, header: { cwd: events.cwd }, snapshotEvents: () => events.messages ?? [] },
    ctx: scope.ctx,
  };
  return { agent, scope };
}

/** 构造运行时状态。 */
async function createState(events, settings = {}) {
  const paths = { dshHome: join(root, 'dsh'), profile: 'web' };
  const config = resolveConfig({
    modesDir: join(root, 'modes'),
    dataDir: join(root, 'data'),
    defaultTemplate: 'cwd={{cwd}} model={{model}} route={{route}}',
    ...settings,
  }, paths, root);
  const state = new RouterState({ config, logger: {} });
  await state.load();
  await mkdir(join(root, 'modes'), { recursive: true });
  await writeFile(join(root, 'modes', 'planner.json'), JSON.stringify({
    id: 'planner', name: '规划', prompt: '你是规划者。', tools: ['read', 'grep'],
  }));
  await state.warmModes();
  await state.warmRules(events.cwd);
  return state;
}

describe('installAgentRouter', () => {
  it('注册提示词分段与任务上下文，并在首次拼装时使用默认模板', async () => {
    const cwd = join(root, 'proj-a');
    await mkdir(join(cwd, '.git'), { recursive: true });
    const events = { cwd, tools: ['read', 'grep'] };
    const state = await createState(events);
    const { agent, scope } = createAgent(events);
    const router = installAgentRouter(agent, state);

    assert.ok(scope.sections.has(ROUTING_SECTION));
    assert.ok(scope.contexts.has(TASK_CONTEXT));
    const text = scope.sections.get(ROUTING_SECTION).text();
    assert.ok(text.includes(`cwd=${cwd}`));
    assert.ok(text.includes('route=default'));

    const plan = router.plan();
    assert.equal(plan.route, 'default');
    assert.equal(scope.contexts.get(TASK_CONTEXT).text(), '');

    router.dispose();
    assert.equal(scope.sections.has(ROUTING_SECTION), false);
    assert.equal(scope.contexts.has(TASK_CONTEXT), false);
    state.dispose();
  });

  it('绑定模式后启用白名单限制，守卫拒绝白名单外的工具', async () => {
    const cwd = join(root, 'proj-b');
    await mkdir(join(cwd, '.git'), { recursive: true });
    const events = { cwd, tools: ['read', 'grep', 'write'] };
    const state = await createState(events);
    await state.bindings.bindMode('session-1', {
      id: 'planner', name: '规划', prompt: '你是规划者。', tools: ['read', 'grep'], capturedAt: 1, hash: 'h',
    });
    const { agent, scope } = createAgent(events);
    const router = installAgentRouter(agent, state);

    assert.equal(router.plan().route, 'mode');
    assert.ok(scope.sections.get(ROUTING_SECTION).text().includes('你是规划者。'));

    // 宿主提供 tools.guard 时用它做单调拒绝。
    const guard = scope.listeners.get('tools/guard');
    assert.equal(typeof guard, 'function');
    assert.match(guard({ name: 'write' }), /write/);
    assert.equal(guard({ name: 'read' }), undefined);

    router.dispose();
    assert.equal(scope.restrictions.length, 0);
    state.dispose();
  });

  it('没有 tools.guard 的宿主退回 pre-execute 瀑布拒绝', async () => {
    const cwd = join(root, 'proj-f');
    await mkdir(join(cwd, '.git'), { recursive: true });
    const events = { cwd, tools: ['read', 'write'] };
    const state = await createState(events);
    await state.bindings.bindMode('session-1', {
      id: 'planner', name: '规划', prompt: 'p', tools: ['read'], capturedAt: 1, hash: 'h',
    });
    const { agent, scope } = createAgent(events);
    delete scope.ctx.tools.guard;
    const router = installAgentRouter(agent, state);
    const listener = scope.listeners.get('tools/pre-execute');
    const denied = await listener({ name: 'write', arguments: {} }, async () => ({ kind: 'allow' }));
    assert.equal(denied.kind, 'deny');
    assert.ok(denied.reason.includes('write'));
    router.dispose();
    state.dispose();
  });

  it('拼装时分段逐名探测本步骤作用域内的工具可见性', async () => {
    const cwd = join(root, 'proj-e');
    await mkdir(join(cwd, '.git'), { recursive: true });
    const events = { cwd, tools: ['global_only'] };
    await writeFile(join(cwd, 'AGENTS.md'), '---\ntier: pinned\ntools: [read, grep]\n---\n规则');
    const state = await createState(events);
    const { agent, scope } = createAgent(events);
    const calls = [];
    scope.ctx.tools.definitions = scoped => (scoped === undefined ? [{ name: 'global_only' }] : [{ name: 'read' }]);
    scope.ctx.tools.get = (name, scoped, toolSet) => {
      calls.push({ name, scoped, toolSet });
      return ['read', 'grep', 'write'].includes(name) ? { name } : undefined;
    };
    const router = installAgentRouter(agent, state);
    const text = scope.sections.get(ROUTING_SECTION).text({ scope: 'agent-scope', toolSet: 'step-set' });
    assert.ok(text.includes('read, grep'));
    assert.ok(calls.some(call => call.name === 'read' && call.scoped === 'agent-scope' && call.toolSet === 'step-set'));
    const plan = router.plan();
    assert.deepEqual(plan.tools.known, ['read', 'grep']);
    // 只有全局层里的工具才能交给 tools.restrict。
    assert.deepEqual(plan.tools.restrictable, []);
    assert.deepEqual(plan.tools.allow, ['read', 'grep']);
    router.dispose();
    state.dispose();
  });

  it('任务摘要注入运行时上下文', async () => {
    const cwd = join(root, 'proj-c');
    await mkdir(join(cwd, '.git'), { recursive: true });
    const events = { cwd, tools: [] };
    const state = await createState(events);
    await state.bindings.setTask('session-1', normalizeTask({ title: '修复登录', tags: ['bugfix'] }).task);
    const { agent, scope } = createAgent(events);
    const router = installAgentRouter(agent, state);
    const text = scope.contexts.get(TASK_CONTEXT).text();
    assert.ok(text.includes('修复登录'));
    assert.ok(text.includes('bugfix'));
    assert.deepEqual(router.plan().matched.length >= 0, true);
    router.dispose();
    state.dispose();
  });

  it('消息里提到的路径参与 paths 规则匹配', async () => {
    const cwd = join(root, 'proj-d');
    await mkdir(join(cwd, '.git'), { recursive: true });
    const events = {
      cwd,
      tools: [],
      messages: [{ type: 'user/message', data: { content: [{ type: 'text', text: '请看看 src/main/java/A.java' }] } }],
    };
    await mkdir(join(root, 'modes'), { recursive: true });
    await writeFile(join(cwd, 'AGENTS.md'), '---\ntier: scoped\npaths: [src/main/java/**]\n---\nJava 规则');
    const paths = { dshHome: join(root, 'dsh'), profile: 'web' };
    const state = new RouterState({
      // 独立的数据目录：避免复用到前面用例写入的 session-1 模式绑定。
      config: resolveConfig({ modesDir: join(root, 'modes'), dataDir: join(root, 'data-message-paths') }, paths, root),
      logger: {},
    });
    await state.load();
    await state.warmRules(cwd);
    const { agent } = createAgent(events);
    const router = installAgentRouter(agent, state);
    assert.equal(router.plan().route, 'rules');
    assert.ok(router.plan().prompt.includes('Java 规则'));
    router.dispose();
    state.dispose();
  });
});

describe('registerDiagnostics', () => {
  /** 假响应。 */
  function response() {
    const state = { status: 0, headers: {}, body: '' };
    return {
      state,
      writeHead(status, headers) {
        state.status = status;
        Object.assign(state.headers, headers ?? {});
      },
      end(body) {
        state.body = body ?? '';
      },
    };
  }

  /** 假请求。 */
  function request(method, url, body, headers = {}) {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    return {
      method,
      url,
      headers: { host: 'localhost:1', ...headers },
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield chunk;
      },
    };
  }

  /** 假 loader。 */
  function loader(allow = true) {
    const routes = [];
    return {
      routes,
      services: { get: () => ({ authorizeIndex: () => allow }) },
      web: {
        register(prefix, handler) {
          routes.push({ prefix, handler });
          return () => routes.splice(routes.indexOf({ prefix, handler }), 1);
        },
      },
    };
  }

  it('注册前缀路由并返回健康状态', async () => {
    const cwd = join(root, 'diag-a');
    await mkdir(join(cwd, '.git'), { recursive: true });
    const events = { cwd, tools: [] };
    const state = await createState(events);
    const fake = loader();
    const disposers = [];
    const ctx = { effect: fn => disposers.push(fn()) };
    const dispose = registerDiagnostics(ctx, fake, {
      state,
      session: () => undefined,
      refresh: () => {},
    });
    assert.equal(fake.routes.length, 1);
    assert.equal(fake.routes[0].prefix, '/_dsh/prompt-router');

    const health = response();
    await fake.routes[0].handler(request('GET', '/_dsh/prompt-router/health'), health);
    const payload = JSON.parse(health.state.body);
    assert.equal(payload.ok, true);
    assert.equal(payload.name, '@dsh-plugin/dsh-prompt-router');
    assert.equal(payload.enabled, true);

    const rules = response();
    await fake.routes[0].handler(request('GET', `/_dsh/prompt-router/rules?cwd=${encodeURIComponent(cwd)}`), rules);
    assert.equal(JSON.parse(rules.state.body).cwd, cwd);

    const missing = response();
    await fake.routes[0].handler(request('GET', '/_dsh/prompt-router/nope'), missing);
    assert.equal(missing.state.status, 404);

    dispose();
    assert.equal(disposers.length, 1);
    state.dispose();
  });

  it('鉴权失败时直接返回，跨站请求被拒绝', async () => {
    const cwd = join(root, 'diag-b');
    await mkdir(join(cwd, '.git'), { recursive: true });
    const events = { cwd, tools: [] };
    const state = await createState(events);
    const fake = loader(false);
    registerDiagnostics({ effect: () => {} }, fake, { state, session: () => undefined, refresh: () => {} });
    const blocked = response();
    await fake.routes[0].handler(request('GET', '/_dsh/prompt-router/health'), blocked);
    assert.equal(blocked.state.body, '');
    state.dispose();

    const allowedFake = loader(true);
    const cwd2 = join(root, 'diag-c');
    await mkdir(join(cwd2, '.git'), { recursive: true });
    const events2 = { cwd: cwd2, tools: [] };
    const state2 = await createState(events2);
    registerDiagnostics({ effect: () => {} }, allowedFake, { state: state2, session: () => undefined, refresh: () => {} });
    const crossSite = response();
    await allowedFake.routes[0].handler(
      request('GET', '/_dsh/prompt-router/health', undefined, { origin: 'https://evil.example', host: 'localhost:1' }),
      crossSite,
    );
    assert.equal(crossSite.state.status, 403);
    state2.dispose();
  });

  it('绑定/解绑模式与写入任务摘要', async () => {
    const cwd = join(root, 'diag-d');
    await mkdir(join(cwd, '.git'), { recursive: true });
    const events = { cwd, tools: [] };
    const state = await createState(events);
    const fake = loader();
    const refreshed = [];
    registerDiagnostics({ effect: () => {} }, fake, {
      state,
      session: () => undefined,
      refresh: sessionId => refreshed.push(sessionId),
    });
    const handler = fake.routes[0].handler;

    const bind = response();
    await handler(request('POST', '/_dsh/prompt-router/sessions/s1/mode', { mode: 'planner' }), bind);
    assert.equal(JSON.parse(bind.state.body).binding.mode.id, 'planner');

    const unknown = response();
    await handler(request('POST', '/_dsh/prompt-router/sessions/s1/mode', { mode: 'ghost' }), unknown);
    assert.equal(unknown.state.status, 404);

    const unbind = response();
    await handler(request('POST', '/_dsh/prompt-router/sessions/s1/mode', { mode: null }), unbind);
    assert.equal(JSON.parse(unbind.state.body).binding, null);

    const task = response();
    await handler(request('POST', '/_dsh/prompt-router/sessions/s1/task', { task: { title: '任务', tags: ['bugfix'] } }), task);
    assert.equal(JSON.parse(task.state.body).binding.task.title, '任务');

    const badTask = response();
    await handler(request('POST', '/_dsh/prompt-router/sessions/s1/task', { task: { tags: ['x'] } }), badTask);
    assert.equal(badTask.state.status, 400);

    const session = response();
    await handler(request('GET', '/_dsh/prompt-router/sessions/s1'), session);
    assert.equal(JSON.parse(session.state.body).binding.task.title, '任务');
    assert.deepEqual(refreshed, ['s1', 's1', 's1']);

    const wrongMethod = response();
    await handler(request('GET', '/_dsh/prompt-router/sessions/s1/task'), wrongMethod);
    assert.equal(wrongMethod.state.status, 405);
    state.dispose();
  });
});
