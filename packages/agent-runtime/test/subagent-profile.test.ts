// 一个文件=一种作用：子代理 profile 归一化与 markdown 覆盖的验收测试。

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EXPLORE_AGENT_TYPE,
  GENERAL_PURPOSE_AGENT_TYPE,
  agentProfileDisplayName,
  createBuiltInExploreProfile,
  createBuiltInGeneralPurposeProfile,
  formatAgentProfileForPrompt,
  formatAgentProfilesForPrompt,
  isBuiltInExploreProfile,
  normalizeAgentProfiles,
  parseAgentProfileFromMarkdown,
  type SubagentProfile,
} from '../src/index.js';

function userProfile(overrides: Partial<SubagentProfile> = {}): SubagentProfile {
  return {
    name: 'my-agent',
    description: '用户自定义子代理',
    source: 'user',
    systemPrompt: '只做被要求的事。',
    ...overrides,
  };
}

test('内置 general-purpose / explore 先入表', () => {
  const active = normalizeAgentProfiles([]);
  assert.deepEqual(active.map((profile) => profile.name), [GENERAL_PURPOSE_AGENT_TYPE, EXPLORE_AGENT_TYPE]);
  const generalPurpose = createBuiltInGeneralPurposeProfile();
  assert.deepEqual(generalPurpose.tools, ['*']);
  assert.equal(generalPurpose.injectAgentsMd, true);
  assert.equal(generalPurpose.source, 'built-in');
  assert.equal(createBuiltInExploreProfile().injectAgentsMd, false);
});

test('同名覆盖：用户 profile 覆盖内置 explore，且不继承内置只读行为', () => {
  const override = userProfile({ name: EXPLORE_AGENT_TYPE, tools: ['Read', 'Write'] });
  const active = normalizeAgentProfiles([override]);
  const explore = active.find((profile) => profile.name === EXPLORE_AGENT_TYPE);
  assert.equal(explore?.source, 'user');
  assert.equal(isBuiltInExploreProfile(explore!), false, '同名但非 built-in，不得套用内置判据');
  // 非内置 explore 走 profile.tools，而不是内置的优先级工具清单。
  assert.match(formatAgentProfileForPrompt(explore!), /\(Tools: Read, Write\)$/u);
});

test('内置 explore 的提示词行用优先级排序后的工具清单', () => {
  const line = formatAgentProfileForPrompt(createBuiltInExploreProfile());
  assert.match(line, /\(Tools: Glob, Grep, Read, Bash, WebFetch, WebSearch, TodoWrite\)$/u);
  const listed = formatAgentProfilesForPrompt([]);
  assert.match(listed ?? '', /Available agent types and the tools they have access to:/u);
});

test('markdown 覆盖：frontmatter 定义 profile，正文即 systemPrompt', () => {
  const markdown = [
    '---',
    'name: reviewer',
    'description: 审查代码',
    'color: purple',
    'tools: [Read, Grep]',
    'disallowedTools: Bash',
    'maxTurns: 5',
    'memory: project',
    '---',
    '你是审查者。',
    '',
  ].join('\n');
  const result = parseAgentProfileFromMarkdown({ content: markdown, path: '/agents/reviewer.md', source: 'project' });
  assert.equal(result.diagnostic, undefined);
  assert.deepEqual(result.profile, {
    name: 'reviewer',
    description: '审查代码',
    source: 'project',
    systemPrompt: '你是审查者。',
    path: '/agents/reviewer.md',
    color: 'purple',
    memory: 'project',
    maxTurns: 5,
    tools: ['Read', 'Grep'],
    disallowedTools: ['Bash'],
  });
  assert.equal(agentProfileDisplayName(result.profile!), 'reviewer (reviewer.md)');
});

test('markdown 解析：缺 frontmatter / 缺必填字段返回 diagnostic，不抛错', () => {
  const noFrontmatter = parseAgentProfileFromMarkdown({ content: '没有 frontmatter', source: 'user' });
  assert.equal(noFrontmatter.profile, undefined);
  assert.equal(noFrontmatter.diagnostic?.code, 'agent_missing_frontmatter');

  const noName = parseAgentProfileFromMarkdown({ content: '---\ndescription: 缺名字\n---\n', source: 'user' });
  assert.equal(noName.diagnostic?.code, 'agent_missing_required_frontmatter');
  assert.match(noName.diagnostic?.message ?? '', /name/u);
});

test('显式空工具列表表示「无工具」，不被折叠成未指定', () => {
  const result = parseAgentProfileFromMarkdown({
    content: '---\nname: locked\ndescription: 无工具\ntools: []\n---\n',
    source: 'project',
  });
  assert.deepEqual(result.profile?.tools, []);
  // 未指定 tools 时字段缺省，交给上层决定继承语义。
  const unspecified = parseAgentProfileFromMarkdown({
    content: '---\nname: plain\ndescription: 未指定\n---\n',
    source: 'project',
  });
  assert.equal(unspecified.profile?.tools, undefined);
});
