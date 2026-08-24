import assert from 'node:assert/strict';
import test from 'node:test';
import { proposedMemoryContent, proposalPreview } from '../src/runtime/project-memory-proposal';

test('项目记忆提议仅在批准后以可见区块追加，不覆盖既有内容', () => {
  assert.equal(proposedMemoryContent('# 决策\n\n保留直连。', '使用已选模型。'), '# 决策\n\n保留直连。\n\n## 已批准记忆\n\n使用已选模型。\n');
  assert.equal(proposedMemoryContent('已有内容', '   '), '已有内容');
  assert.match(proposalPreview('已有内容', '新约定').join('\n'), /^当前记忆：4 字符/);
});
