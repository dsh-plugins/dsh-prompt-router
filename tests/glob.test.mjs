/**
 * 通配符匹配与文本工具的单测。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compileGlob, matchAnyGlob, matchGlob, normalizePath } from '../lib/glob.js';
import { extractArgumentPaths, extractPaths, truncateUtf8 } from '../lib/text.js';

describe('glob', () => {
  it('归一化 Windows 分隔符与重复分隔符', () => {
    assert.equal(normalizePath('C:\\proj\\src\\a.ts'), 'C:/proj/src/a.ts');
    assert.equal(normalizePath('a//b'), 'a/b');
  });

  it('不含斜杠的模式匹配任意层级的文件名', () => {
    assert.ok(matchGlob('build.gradle', 'C:/proj/build.gradle'));
    assert.ok(matchGlob('build.gradle', 'build.gradle'));
    assert.ok(!matchGlob('build.gradle', 'C:/proj/build.gradle.kts'));
  });

  it('** 跨目录匹配', () => {
    assert.ok(matchGlob('src/main/java/**', 'C:/proj/src/main/java/com/acme/A.java'));
    assert.ok(matchGlob('src/**/A.java', 'C:/proj/src/main/java/com/acme/A.java'));
    assert.ok(!matchGlob('src/main/java/**', 'C:/proj/src/test/java/A.java'));
  });

  it('* 不跨目录，? 匹配单字符', () => {
    assert.ok(matchGlob('src/*.ts', 'C:/proj/src/a.ts'));
    assert.ok(!matchGlob('src/*.ts', 'C:/proj/src/nested/a.ts'));
    assert.ok(matchGlob('src/a?.ts', 'C:/proj/src/ab.ts'));
  });

  it('目录模式匹配目录自身与其下文件', () => {
    assert.ok(matchGlob('docs/', 'C:/proj/docs'));
    assert.ok(matchGlob('docs/', 'C:/proj/docs/a.md'));
  });

  it('空模式永不匹配，正则元字符按字面处理', () => {
    assert.ok(!matchGlob('', 'C:/proj'));
    assert.ok(matchGlob('a+b(c).ts', 'C:/proj/a+b(c).ts'));
    assert.ok(!matchGlob('a+b(c).ts', 'C:/proj/aab(c).ts'));
  });

  it('matchAnyGlob 返回命中的首个模式', () => {
    assert.equal(matchAnyGlob(['build.gradle', 'src/**'], ['C:/proj/src/main/A.java']), 'src/**');
    assert.equal(matchAnyGlob(['build.gradle'], ['C:/proj/x.ts']), undefined);
  });

  it('compileGlob 结果被缓存', () => {
    assert.equal(compileGlob('cache/**'), compileGlob('cache/**'));
  });
});

describe('text', () => {
  it('按字节截断不会切出半个字符', () => {
    const text = '中文内容测试';
    const truncated = truncateUtf8(text, 7);
    assert.ok(Buffer.byteLength(truncated, 'utf8') <= 7);
    assert.ok(!truncated.includes('\uFFFD'));
  });

  it('未超限时原样返回', () => {
    assert.equal(truncateUtf8('abc', 10), 'abc');
    assert.equal(truncateUtf8('abc', 0), '');
  });

  it('从自然语言提取路径', () => {
    const paths = extractPaths('请检查 src/main/java/A.java 与 build.gradle，还有 https://example.com/a/b');
    assert.ok(paths.includes('src/main/java/A.java'));
    assert.ok(paths.includes('build.gradle'));
    assert.ok(!paths.some(path => path.includes('://')));
  });

  it('从工具参数提取路径', () => {
    const paths = extractArgumentPaths({ path: 'src/a.ts', nested: { file: 'docs/x.md', count: 1 }, list: ['lib/b.js'] });
    assert.deepEqual(new Set(paths), new Set(['src/a.ts', 'docs/x.md', 'lib/b.js']));
  });
});
