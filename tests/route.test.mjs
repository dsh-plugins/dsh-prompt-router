/**
 * 拼装计划（route.ts）的单测：优先级、预算裁剪、override、工具白名单与任务摘要。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planRoute, renderTaskContext, ruleVerdict } from '../lib/route.js';
import { modeSnapshot, parseRule } from '../lib/schema.js';
import { DEFAULT_TEMPLATE } from '../lib/config.js';

/** 构造运行时配置（只覆盖测试关心的字段）。 */
function config(overrides = {}) {
  return {
    enabled: true,
    defaultMode: '',
    modesDir: '/modes',
    dataDir: '/data',
    defaultTemplate: DEFAULT_TEMPLATE,
    extraRulePaths: [],
    maxScopedBytes: 24000,
    maxRules: 100,
    maxRuleBytes: 131072,
    injectTaskContext: true,
    diagnostics: true,
    cacheMs: 5000,
    profile: 'web',
    dshHome: '/dsh',
    ...overrides,
  };
}

/** 构造上下文。 */
function context(overrides = {}) {
  return { cwd: '/proj', model: 'deepseek-v4', paths: ['/proj'], taskTags: [], availableTools: [], ...overrides };
}

/** 构造规则。 */
function rule(header, body = '正文', displayPath = 'AGENTS.md') {
  const { rule: parsed } = parseRule(`---\n${header}\n---\n${body}`, { path: `/proj/${displayPath}`, displayPath });
  assert.ok(parsed, `规则未解析成功：${header}`);
  return parsed;
}

describe('ruleVerdict', () => {
  it('pinned 规则始终命中', () => {
    assert.deepEqual(ruleVerdict(rule('tier: pinned\nmodes: [code]'), context()), { ok: true, by: 'pinned' });
  });

  it('modes 限制要求绑定模式', () => {
    const entry = rule('modes: [code]');
    assert.equal(ruleVerdict(entry, context()).ok, false);
    assert.deepEqual(ruleVerdict(entry, context({ boundMode: 'code' })), { ok: true, by: 'mode' });
    assert.equal(ruleVerdict(entry, context({ boundMode: 'review' })).ok, false);
  });

  it('paths 限制匹配工作目录或涉及文件', () => {
    const entry = rule('paths: [src/main/java/**]');
    assert.equal(ruleVerdict(entry, context()).ok, false);
    const hit = ruleVerdict(entry, context({ paths: ['/proj/src/main/java/A.java'] }));
    assert.equal(hit.ok, true);
    assert.match(hit.by, /^path:/);
  });

  it('task_tags 限制要求标签交集', () => {
    const entry = rule('task_tags: [bugfix, database]');
    assert.equal(ruleVerdict(entry, context()).ok, false);
    assert.deepEqual(ruleVerdict(entry, context({ taskTags: ['Database'] })), { ok: true, by: 'tag:database' });
  });

  it('无限制的 scoped 规则恒命中', () => {
    assert.deepEqual(ruleVerdict(rule('tier: scoped'), context()), { ok: true, by: 'always' });
  });
});

describe('planRoute', () => {
  it('未命中任何规则时使用默认模板', () => {
    const plan = planRoute({ config: config(), rules: [rule('modes: [code]')], context: context() });
    assert.equal(plan.route, 'default');
    assert.ok(plan.prompt.includes('/proj'));
    assert.ok(plan.prompt.includes('deepseek-v4'));
    assert.equal(plan.skipped.length, 1);
  });

  it('规则优先于默认模板，pinned 始终排在 scoped 之前', () => {
    const plan = planRoute({
      config: config(),
      rules: [rule('tier: scoped', '普通规则', 'scoped.md'), rule('tier: pinned', '固顶规则', 'pinned.md')],
      context: context(),
    });
    assert.equal(plan.route, 'rules');
    assert.deepEqual(plan.matched.map(entry => entry.path), ['pinned.md', 'scoped.md']);
    assert.ok(plan.prompt.indexOf('固顶规则') < plan.prompt.indexOf('普通规则'));
    assert.ok(plan.prompt.includes('<!-- prompt-router: pinned.md (pinned) -->'));
  });

  it('绑定模式接管基线，规则在其后追加', () => {
    const mode = modeSnapshot({ id: 'planner', name: '规划', prompt: '你是规划者。', sourcePath: '/modes/planner.json', hash: 'h' });
    const plan = planRoute({ config: config(), rules: [rule('tier: pinned', '固定规则')], mode, context: context({ boundMode: 'planner' }) });
    assert.equal(plan.route, 'mode');
    assert.deepEqual(plan.mode, { id: 'planner', name: '规划' });
    assert.equal(plan.sections[0].kind, 'mode');
    assert.ok(plan.prompt.startsWith('你是规划者。'));
  });

  it('override 规则清空此前拼装结果', () => {
    const mode = modeSnapshot({ id: 'planner', name: '规划', prompt: '模式提示词', sourcePath: '/m.json', hash: 'h' });
    const plan = planRoute({
      config: config(),
      rules: [rule('tier: pinned\noverride: true', '覆盖后的规则', 'override.md')],
      mode,
      context: context({ boundMode: 'planner' }),
    });
    assert.ok(!plan.prompt.includes('模式提示词'));
    assert.ok(plan.prompt.includes('覆盖后的规则'));
    assert.deepEqual(plan.overridden, ['mode']);
  });

  it('scoped 规则超预算时按字节截断，pinned 不截断', () => {
    const big = 'x'.repeat(4000);
    const plan = planRoute({
      config: config({ maxScopedBytes: 1000 }),
      rules: [rule('tier: pinned', 'p'.repeat(2000), 'pinned.md'), rule('tier: scoped', big, 'big.md')],
      context: context(),
    });
    assert.deepEqual(plan.truncated, ['big.md']);
    assert.ok(plan.prompt.includes('p'.repeat(2000)));
    assert.ok(plan.prompt.includes('truncated by dsh-prompt-router'));
    const scopedBytes = plan.sections.filter(section => section.tier === 'scoped').reduce((sum, section) => sum + section.bytes, 0);
    // 截断后仍带规则头与省略标记，允许少量固定开销。
    assert.ok(scopedBytes <= 1200, `scoped 分段超出预算：${scopedBytes}`);
  });

  it('预算耗尽后跳过后续 scoped 规则', () => {
    const plan = planRoute({
      config: config({ maxScopedBytes: 900 }),
      rules: [rule('tier: scoped', 'a'.repeat(800), 'a.md'), rule('tier: scoped', 'b'.repeat(800), 'b.md')],
      context: context(),
    });
    // 第一条恰好装进预算，第二条剩余不足 512 字节，整条跳过。
    assert.deepEqual(plan.truncated, []);
    assert.ok(plan.prompt.includes('a'.repeat(800)));
    assert.ok(!plan.prompt.includes('b'.repeat(800)));
    assert.ok(plan.skipped.some(entry => entry.path === 'b.md'));
  });

  it('模式与规则的工具白名单取交集，并记录未命中的宿主工具', () => {
    const mode = modeSnapshot({ id: 'm', name: 'm', prompt: 'p', tools: ['read', 'grep', 'write'], sourcePath: '/m.json', hash: 'h' });
    const plan = planRoute({
      config: config(),
      rules: [rule('tools: [read, grep, bash]', '', 'tools.md')],
      mode,
      context: context({ boundMode: 'm', availableTools: ['read', 'grep', 'write'] }),
    });
    assert.deepEqual(plan.tools.declared, ['read', 'grep']);
    assert.deepEqual(plan.tools.known, ['read', 'grep']);
    assert.deepEqual(plan.tools.allow, ['read', 'grep']);
    assert.deepEqual(plan.tools.ignored, []);
    assert.ok(plan.prompt.includes('Only the following tools are available'));
    assert.ok(plan.prompt.includes('read, grep'));
  });

  it('声明值都不在宿主可见清单时保留声明白名单，只跳过宿主级限制', () => {
    const plan = planRoute({
      config: config(),
      rules: [rule('tools: [missing]', '', 'tools.md')],
      context: context({ availableTools: ['read'], restrictableTools: ['read'] }),
    });
    assert.deepEqual(plan.tools.known, []);
    assert.deepEqual(plan.tools.restrictable, []);
    assert.deepEqual(plan.tools.allow, ['missing']);
    assert.deepEqual(plan.tools.ignored, ['missing']);
    assert.ok(plan.diagnostics.some(message => message.includes('调用守卫')));
    assert.ok(plan.prompt.includes('missing'));
  });

  it('只有全局工具可交给宿主 restrict', () => {
    const plan = planRoute({
      config: config(),
      rules: [rule('tools: [read, grep]', '', 'tools.md')],
      context: context({ availableTools: ['read', 'grep'], restrictableTools: ['read'] }),
    });
    assert.deepEqual(plan.tools.known, ['read', 'grep']);
    assert.deepEqual(plan.tools.restrictable, ['read']);
    assert.deepEqual(plan.tools.allow, ['read', 'grep']);
  });

  it('宿主未提供工具清单时按声明放行且不记录忽略项', () => {
    const plan = planRoute({
      config: config(),
      rules: [rule('tools: [read, ghost]', '', 'tools.md')],
      context: context({ availableTools: [] }),
    });
    assert.deepEqual(plan.tools.known, []);
    assert.deepEqual(plan.tools.allow, ['read', 'ghost']);
    assert.deepEqual(plan.tools.ignored, []);
  });

  it('部分工具不在宿主注册表时只取存在的部分做宿主级限制', () => {
    const plan = planRoute({
      config: config(),
      rules: [rule('tools: [read, ghost]', '', 'tools.md')],
      context: context({ availableTools: ['read'] }),
    });
    assert.deepEqual(plan.tools.known, ['read']);
    assert.deepEqual(plan.tools.ignored, ['ghost']);
    assert.deepEqual(plan.tools.allow, ['read']);
  });

  it('禁用后不产生任何分段', () => {
    const plan = planRoute({ config: config({ enabled: false }), rules: [], context: context() });
    assert.equal(plan.route, 'disabled');
    assert.equal(plan.prompt, '');
  });
});

describe('renderTaskContext', () => {
  it('渲染标题、描述、标签与最近 5 条历史', () => {
    const text = renderTaskContext({
      id: 'T-1',
      title: '修复登录',
      description: '登录 500',
      tags: ['bugfix'],
      history: Array.from({ length: 7 }, (_, index) => ({ status: `s${index}` })),
      updatedAt: 0,
    });
    assert.ok(text.includes('Title: 修复登录'));
    assert.ok(text.includes('Tags: bugfix'));
    assert.ok(!text.includes('s1\n') && !text.includes('s0'));
    assert.ok(text.includes('s6'));
  });
});
