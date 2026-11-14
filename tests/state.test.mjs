/**
 * 运行状态、模式目录、规则发现与会话绑定的单测（全部在临时目录中进行）。
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { discoverRuleFiles, findProjectRoot } from '../lib/discovery.js';
import { readModeCatalog } from '../lib/modes.js';
import { BindingStore, normalizeTask } from '../lib/store.js';
import { RouterState } from '../lib/state.js';
import { deriveHostPaths, resolveConfig } from '../lib/config.js';

let root;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dpr-state-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

/** 写文件并自动建目录。 */
async function write(path, content) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content, 'utf8');
}

describe('discovery', () => {
  it('自工作目录向上找到包含 .git 的项目根', async () => {
    const project = join(root, 'proj-a');
    await mkdir(join(project, '.git'), { recursive: true });
    const nested = join(project, 'src', 'deep');
    await mkdir(nested, { recursive: true });
    assert.equal(await findProjectRoot(nested), project);
    assert.equal(await findProjectRoot(join(root, 'no-root')), join(root, 'no-root'));
  });

  it('发现目录链上的 AGENTS.md、SKILL.md 与技能子目录', async () => {
    const project = join(root, 'proj-b');
    await mkdir(join(project, '.git'), { recursive: true });
    await write(join(project, 'AGENTS.md'), '---\ntier: pinned\n---\n项目规则');
    await write(join(project, 'src', 'AGENTS.md'), '---\ntier: scoped\n---\n子目录规则');
    await write(join(project, 'skills', 'demo', 'SKILL.md'), '---\ntier: scoped\n---\n技能规则');
    await write(join(project, 'src', 'main.ts'), 'export {}');
    const found = await discoverRuleFiles({ cwd: join(project, 'src'), extras: [], maxFiles: 20, maxRuleBytes: 10000 });
    const displays = found.files.map(file => file.displayPath).sort();
    assert.deepEqual(displays, ['AGENTS.md', 'skills/demo/SKILL.md', 'src/AGENTS.md']);
    assert.equal(found.scanned, 3);
  });

  it('额外路径支持文件、目录与通配符', async () => {
    const project = join(root, 'proj-c');
    await mkdir(join(project, '.git'), { recursive: true });
    await write(join(project, 'extra', 'one.md'), '---\ntier: scoped\n---\n一');
    await write(join(project, 'extra', 'two.md'), '---\ntier: scoped\n---\n二');
    const byPattern = await discoverRuleFiles({
      cwd: project,
      extras: [join(project, 'extra', '*.md')],
      maxFiles: 20,
      maxRuleBytes: 10000,
    });
    assert.equal(byPattern.files.length, 2);
    const byDir = await discoverRuleFiles({ cwd: project, extras: [join(project, 'extra')], maxFiles: 20, maxRuleBytes: 10000 });
    assert.equal(byDir.files.length, 2);
    const byFile = await discoverRuleFiles({ cwd: project, extras: [join(project, 'extra', 'one.md')], maxFiles: 20, maxRuleBytes: 10000 });
    assert.equal(byFile.files.length, 1);
    assert.equal(byFile.files[0].displayPath, 'extra/one.md');
  });

  it('超过单文件上限时记录诊断并跳过', async () => {
    const project = join(root, 'proj-d');
    await mkdir(join(project, '.git'), { recursive: true });
    await write(join(project, 'AGENTS.md'), 'x'.repeat(5000));
    const found = await discoverRuleFiles({ cwd: project, extras: [], maxFiles: 20, maxRuleBytes: 1000 });
    assert.equal(found.files.length, 0);
    assert.ok(found.issues.some(issue => issue.message.includes('上限')));
  });
});

describe('readModeCatalog', () => {
  it('读取模式 JSON 并计算哈希', async () => {
    const dir = join(root, 'modes-a');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'planner.json'), JSON.stringify({ id: 'planner', name: '规划', prompt: '你是规划者', tools: ['read'] }));
    await writeFile(join(dir, 'broken.json'), '{ not json');
    await writeFile(join(dir, 'noprompt.json'), JSON.stringify({ id: 'empty' }));
    const catalog = await readModeCatalog(dir);
    assert.deepEqual([...catalog.modes.keys()], ['planner']);
    assert.equal(catalog.scanned, 3);
    assert.equal(catalog.issues.length, 2);
    assert.match(catalog.modes.get('planner').hash, /^[0-9a-f]{64}$/);
  });

  it('目录不存在时返回空目录', async () => {
    const catalog = await readModeCatalog(join(root, 'missing-dir'));
    assert.equal(catalog.modes.size, 0);
    assert.deepEqual(catalog.issues, []);
  });
});

describe('BindingStore', () => {
  it('写入、读取并在解绑后清理', async () => {
    const dir = join(root, 'bindings-a');
    const store = new BindingStore(dir);
    await store.load();
    await store.bindMode('s1', { id: 'planner', name: '规划', prompt: 'p', capturedAt: 1, hash: 'h' });
    const reloaded = new BindingStore(dir);
    await reloaded.load();
    assert.equal(reloaded.get('s1').mode.id, 'planner');
    await reloaded.bindMode('s1', null);
    assert.equal(reloaded.get('s1'), undefined);
    const empty = new BindingStore(dir);
    await empty.load();
    assert.deepEqual(empty.snapshot(), {});
  });

  it('任务摘要与模式共存', async () => {
    const dir = join(root, 'bindings-b');
    const store = new BindingStore(dir);
    await store.load();
    await store.setTask('s2', normalizeTask({ title: '任务', tags: ['bugfix'] }).task);
    await store.bindMode('s2', { id: 'm', name: 'm', prompt: 'p', capturedAt: 1, hash: 'h' });
    const binding = store.get('s2');
    assert.equal(binding.task.title, '任务');
    assert.equal(binding.mode.id, 'm');
  });

  it('损坏的存储文件不会抛出', async () => {
    const dir = join(root, 'bindings-c');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'sessions.json'), '{ broken');
    const errors = [];
    const store = new BindingStore(dir, error => errors.push(error));
    await store.load();
    assert.equal(errors.length, 1);
    assert.deepEqual(store.snapshot(), {});
  });

  it('normalizeTask 校验标题并截取最近历史', () => {
    assert.equal(normalizeTask({}).error, '任务摘要缺少非空 title');
    const { task } = normalizeTask({ title: 't', tags: ['a', 3, ''], history: Array.from({ length: 60 }, (_, i) => `s${i}`) });
    assert.deepEqual(task.tags, ['a']);
    assert.equal(task.history.length, 50);
    assert.equal(task.history.at(-1).status, 's59');
  });
});

describe('RouterState', () => {
  it('预热后同步读取规则，模式热更新并保留删除后的快照', async () => {
    const project = join(root, 'state-proj');
    const modesDir = join(root, 'state-modes');
    const dataDir = join(root, 'state-data');
    await mkdir(join(project, '.git'), { recursive: true });
    await write(join(project, 'AGENTS.md'), '---\ntier: pinned\n---\n项目规则');
    await mkdir(modesDir, { recursive: true });
    await writeFile(join(modesDir, 'planner.json'), JSON.stringify({ id: 'planner', name: '规划', prompt: 'v1' }));

    const paths = { dshHome: join(root, 'dsh'), profile: 'web' };
    const config = resolveConfig({ modesDir, dataDir }, paths, root);
    const state = new RouterState({ config, logger: {} });
    await state.load();

    await state.warmRules(project);
    assert.equal(state.rulesFor(project).files.length, 1);
    assert.equal(state.rulesFor(project).files[0].body, '项目规则');

    await state.warmModes();
    assert.equal(state.modesSnapshot().modes.get('planner').prompt, 'v1');

    await state.bindings.bindMode('session-1', { ...state.modesSnapshot().modes.get('planner'), capturedAt: 1 });
    assert.equal(state.resolveMode('session-1').mode.prompt, 'v1');

    // 内容变化 → 热更新快照。
    await writeFile(join(modesDir, 'planner.json'), JSON.stringify({ id: 'planner', name: '规划', prompt: 'v2' }));
    await state.warmModes();
    const updated = state.resolveMode('session-1');
    assert.equal(updated.mode.prompt, 'v2');
    assert.equal(updated.hotUpdated, true);

    // 文件删除 → 继续使用会话内快照。
    await rm(join(modesDir, 'planner.json'));
    await state.warmModes();
    assert.equal(state.resolveMode('session-1').mode.prompt, 'v2');

    // 未绑定会话使用默认模式。
    const withDefault = new RouterState({ config: { ...state.current, defaultMode: 'planner' }, logger: {} });
    await withDefault.warmModes();
    assert.equal(withDefault.resolveMode('other').mode, undefined);

    state.dispose();
    withDefault.dispose();
  });

  it('配置更新清空缓存并按新目录重新加载绑定', async () => {
    const paths = { dshHome: join(root, 'dsh2'), profile: 'web' };
    const dataA = join(root, 'data-a');
    const dataB = join(root, 'data-b');
    const state = new RouterState({ config: resolveConfig({ dataDir: dataA }, paths, root), logger: {} });
    await state.load();
    await state.bindings.setTask('s', normalizeTask({ title: '旧任务' }).task);
    const project = join(root, 'state-proj-2');
    await mkdir(join(project, '.git'), { recursive: true });
    await state.warmRules(project);
    assert.equal(state.rulesFor(project).files.length, 0);

    await state.update({ dataDir: dataB, maxScopedBytes: 4096 }, root);
    assert.equal(state.current.maxScopedBytes, 4096);
    assert.equal(state.bindings.get('s'), undefined);
    state.dispose();
  });
});

describe('deriveHostPaths / resolveConfig', () => {
  it('从 --profile 参数推导 profile', () => {
    // 用当前平台可解析的绝对路径，避免 Windows 字面路径在其他平台被当成相对路径。
    const home = resolve(root, 'custom-dsh-home');
    const paths = deriveHostPaths({ DSH_HOME: home }, ['node', 'bin.js', '--profile', 'web', '--port', '1']);
    assert.equal(paths.profile, 'web');
    assert.equal(paths.dshHome, home);
  });

  it('缺少参数时依次回退 DSH_PROFILE 与 web', () => {
    assert.equal(deriveHostPaths({}, ['node']).profile, 'web');
    assert.equal(deriveHostPaths({ DSH_PROFILE: 'biz' }, ['node']).profile, 'biz');
    assert.equal(deriveHostPaths({}, ['node', '--profile=daily']).profile, 'daily');
  });

  it('默认目录落在 profile 的 data 下，非法数值被钳制', () => {
    const paths = { dshHome: join(root, 'dsh3'), profile: 'web' };
    const config = resolveConfig({ maxScopedBytes: 1, maxRules: -5, cacheMs: Number.NaN }, paths, root);
    assert.equal(config.modesDir, join(paths.dshHome, 'profiles', 'web', 'data', 'dsh-mode-builder', 'modes'));
    assert.equal(config.dataDir, join(paths.dshHome, 'profiles', 'web', 'data', 'dsh-prompt-router'));
    assert.equal(config.maxScopedBytes, 512);
    assert.equal(config.maxRules, 1);
    assert.equal(config.cacheMs, 5000);
  });
});
