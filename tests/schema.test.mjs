/**
 * YAML 头部解析与规则/模式 Schema 的单测。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FrontmatterError, parseYamlLite, splitFrontmatter } from '../lib/frontmatter.js';
import { modeSnapshot, parseMode, parseRule } from '../lib/schema.js';

const rulePath = { path: '/proj/AGENTS.md', displayPath: 'AGENTS.md' };

describe('frontmatter', () => {
  it('拆分头部与正文', () => {
    const split = splitFrontmatter('---\ntier: pinned\n---\n正文第一行\n正文第二行\n');
    assert.equal(split.present, true);
    assert.equal(split.data.tier, 'pinned');
    assert.equal(split.body.trim(), '正文第一行\n正文第二行');
  });

  it('无头部时整份内容都是正文', () => {
    const split = splitFrontmatter('# 标题\n\n正文\n');
    assert.equal(split.present, false);
    assert.deepEqual(split.data, {});
    assert.equal(split.body, '# 标题\n\n正文\n');
  });

  it('缺少结束分隔线时报错', () => {
    assert.throws(() => splitFrontmatter('---\ntier: pinned\n'), FrontmatterError);
  });

  it('支持引号、布尔、数字、行内与块数组', () => {
    const parsed = parseYamlLite([
      'tier: "scoped"',
      "modes: ['code', \"review\"]",
      'paths:',
      '  - src/main/java/**',
      '  - build.gradle',
      'task_tags: [bugfix]',
      'override: false',
      'count: 3',
    ].join('\n'));
    assert.deepEqual(parsed.data, {
      tier: 'scoped',
      modes: ['code', 'review'],
      paths: ['src/main/java/**', 'build.gradle'],
      task_tags: ['bugfix'],
      override: false,
      count: 3,
    });
    assert.deepEqual(parsed.warnings, []);
  });

  it('忽略注释与嵌套构造并记录警告', () => {
    const parsed = parseYamlLite(['tier: scoped # 行内注释', 'nested:', '  a: 1', 'text: |', '  多行'].join('\n'));
    assert.equal(parsed.data.tier, 'scoped');
    assert.ok(parsed.warnings.length >= 1);
  });
});

describe('parseRule', () => {
  it('解析完整 Schema', () => {
    const source = [
      '---',
      'tier: pinned',
      'modes: [code]',
      'paths: [src/**]',
      'task_tags: [bugfix]',
      'tools: [read, grep]',
      'override: true',
      '---',
      '正文规则',
    ].join('\n');
    const { rule, issues } = parseRule(source, rulePath);
    assert.deepEqual(issues, []);
    assert.equal(rule.tier, 'pinned');
    assert.deepEqual(rule.modes, ['code']);
    assert.deepEqual(rule.paths, ['src/**']);
    assert.deepEqual(rule.taskTags, ['bugfix']);
    assert.deepEqual(rule.tools, ['read', 'grep']);
    assert.equal(rule.override, true);
    assert.equal(rule.body, '正文规则');
    assert.equal(rule.bytes, Buffer.byteLength('正文规则', 'utf8'));
  });

  it('缺失字段按默认值处理', () => {
    const { rule } = parseRule('---\n---\n只有正文', rulePath);
    assert.equal(rule.tier, 'scoped');
    assert.deepEqual(rule.modes, []);
    assert.equal(rule.tools, undefined);
    assert.equal(rule.override, false);
  });

  it('非法 tier 记录诊断并回落 scoped', () => {
    const { rule, issues } = parseRule('---\ntier: wild\n---\n正文', rulePath);
    assert.equal(rule.tier, 'scoped');
    assert.ok(issues.some(issue => issue.message.includes('tier')));
  });

  it('空正文且无 tools 时跳过', () => {
    const { rule, issues } = parseRule('---\ntier: scoped\n---\n   \n', rulePath);
    assert.equal(rule, undefined);
    assert.ok(issues.some(issue => issue.message.includes('空操作')));
  });

  it('只有 tools 的规则有效', () => {
    const { rule } = parseRule('---\ntools: [read]\n---\n', rulePath);
    assert.deepEqual(rule.tools, ['read']);
    assert.equal(rule.body, '');
  });

  it('头部损坏时返回诊断而非抛错', () => {
    const { rule, issues } = parseRule('---\ntier: pinned\n', rulePath);
    assert.equal(rule, undefined);
    assert.ok(issues.length > 0);
  });
});

describe('parseMode', () => {
  it('解析模式 JSON', () => {
    const { mode, issues } = parseMode({
      formatVersion: 1,
      id: 'planner',
      name: '规划模式',
      description: '先规划后编码',
      prompt: '你是规划者。',
      tools: ['read', 'grep'],
      icon: 'map',
    }, 'fallback', '/modes/planner.json', 'abc');
    assert.deepEqual(issues, []);
    assert.equal(mode.id, 'planner');
    assert.equal(mode.name, '规划模式');
    assert.equal(mode.prompt, '你是规划者。');
    assert.deepEqual(mode.tools, ['read', 'grep']);
    assert.equal(mode.hash, 'abc');
  });

  it('缺少 prompt 时判为无效', () => {
    const { mode, issues } = parseMode({ id: 'x' }, 'x', '/modes/x.json', 'h');
    assert.equal(mode, undefined);
    assert.ok(issues[0].message.includes('prompt'));
  });

  it('接受 systemPrompt 别名并从文件名推导 id', () => {
    const { mode } = parseMode({ systemPrompt: '做这个' }, 'daily', '/modes/daily.json', 'h');
    assert.equal(mode.id, 'daily');
    assert.equal(mode.prompt, '做这个');
  });

  it('未知 formatVersion 记录诊断但仍解析', () => {
    const { mode, issues } = parseMode({ formatVersion: 9, id: 'a', prompt: 'p' }, 'a', '/modes/a.json', 'h');
    assert.equal(mode.id, 'a');
    assert.ok(issues.some(issue => issue.message.includes('formatVersion')));
  });

  it('modeSnapshot 复制工具列表', () => {
    const { mode } = parseMode({ id: 'a', prompt: 'p', tools: ['read'] }, 'a', '/modes/a.json', 'h');
    const snapshot = modeSnapshot(mode, 1234);
    assert.equal(snapshot.capturedAt, 1234);
    assert.deepEqual(snapshot.tools, ['read']);
    snapshot.tools.push('write');
    assert.deepEqual(mode.tools, ['read']);
  });
});
