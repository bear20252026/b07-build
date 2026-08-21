import { createHash } from 'node:crypto';
import { AGENCY_AGENT_ROLE_CONTENT } from './agency-agents-builtins.generated.js';
import type { RegisterSkillPackCandidateRequest, SkillPackSource } from './skill-pack.js';

/**
 * Selected agency-agents role texts, derived from https://github.com/msitarzewski/agency-agents.
 * Copyright (c) 2025 AgentLand Contributors
 * SPDX-License-Identifier: MIT
 * Full license: ../../../THIRD_PARTY_NOTICES.md
 *
 * Role text is untrusted context: it cannot grant tools, approval, secret access, external installation, or execution.
 */
export interface AgencyRoleSource {
  readonly repository: 'msitarzewski/agency-agents';
  readonly upstreamPath: string;
  readonly upstreamUrl: string;
  readonly license: 'MIT';
  readonly copyright: 'Copyright (c) 2025 AgentLand Contributors';
  readonly contentDigest: string;
}

export interface AgencyRoleDefinition {
  readonly id: string;
  readonly division: 'engineering' | 'design' | 'product' | 'testing';
  readonly displayName: string;
  readonly description: string;
  readonly source: AgencyRoleSource;
  readonly content: string;
  readonly canAutoInject: false;
  readonly canAuthorize: false;
  readonly canGrantCapabilities: false;
}

export type AgencyRoleSummary = Omit<AgencyRoleDefinition, 'content'>;

interface RoleSeed {
  id: string;
  division: AgencyRoleDefinition['division'];
  displayName: string;
  description: string;
  upstreamPath: string;
  contentFile: keyof typeof AGENCY_AGENT_ROLE_CONTENT;
}

const SEEDS: readonly RoleSeed[] = [
  { id: 'agency.software-architect', division: 'engineering', displayName: 'Software Architect', description: '系统设计、领域边界和架构权衡。', upstreamPath: 'engineering/engineering-software-architect.md', contentFile: 'engineering-software-architect.md' },
  { id: 'agency.frontend-developer', division: 'engineering', displayName: 'Frontend Developer', description: '界面实现、性能与前端可访问性。', upstreamPath: 'engineering/engineering-frontend-developer.md', contentFile: 'engineering-frontend-developer.md' },
  { id: 'agency.code-reviewer', division: 'engineering', displayName: 'Code Reviewer', description: '代码质量、安全性与可维护性审查。', upstreamPath: 'engineering/engineering-code-reviewer.md', contentFile: 'engineering-code-reviewer.md' },
  { id: 'agency.sre', division: 'engineering', displayName: 'SRE', description: '可靠性、SLO、可观测性与容量规划。', upstreamPath: 'engineering/engineering-sre.md', contentFile: 'engineering-sre.md' },
  { id: 'agency.ui-designer', division: 'design', displayName: 'UI Designer', description: '视觉系统、组件一致性与界面设计。', upstreamPath: 'design/design-ui-designer.md', contentFile: 'design-ui-designer.md' },
  { id: 'agency.ux-researcher', division: 'design', displayName: 'UX Researcher', description: '用户研究、可用性测试与行为洞察。', upstreamPath: 'design/design-ux-researcher.md', contentFile: 'design-ux-researcher.md' },
  { id: 'agency.product-manager', division: 'product', displayName: 'Product Manager', description: '问题发现、路线图、价值与交付权衡。', upstreamPath: 'product/product-manager.md', contentFile: 'product-manager.md' },
  { id: 'agency.test-automation-engineer', division: 'testing', displayName: 'Test Automation Engineer', description: '端到端测试、稳定性、隔离与 CI 证据。', upstreamPath: 'testing/testing-test-automation-engineer.md', contentFile: 'testing-test-automation-engineer.md' },
];

function digest(content: string): string { return createHash('sha256').update(content, 'utf8').digest('hex'); }

function freezeRole(seed: RoleSeed): AgencyRoleDefinition {
  const content = AGENCY_AGENT_ROLE_CONTENT[seed.contentFile];
  const upstreamUrl = `https://github.com/msitarzewski/agency-agents/blob/main/${seed.upstreamPath}`;
  return Object.freeze({
    id: seed.id,
    division: seed.division,
    displayName: seed.displayName,
    description: seed.description,
    source: Object.freeze({ repository: 'msitarzewski/agency-agents', upstreamPath: seed.upstreamPath, upstreamUrl, license: 'MIT', copyright: 'Copyright (c) 2025 AgentLand Contributors', contentDigest: digest(content) }),
    content,
    canAutoInject: false,
    canAuthorize: false,
    canGrantCapabilities: false,
  });
}

const BUILT_INS = SEEDS.map(freezeRole);

function copySummary(role: AgencyRoleDefinition): AgencyRoleSummary {
  const { content: _content, ...summary } = role;
  return { ...summary, source: { ...summary.source } };
}

function copyDefinition(role: AgencyRoleDefinition): AgencyRoleDefinition {
  return { ...role, source: { ...role.source } };
}

/** Static licensed catalog only. There is no directory scan, network fetch, installer, hook or automatic activation. */
export class AgencyRoleCatalog {
  list(): readonly AgencyRoleSummary[] { return BUILT_INS.map(copySummary); }

  get(id: string): AgencyRoleDefinition | undefined {
    const role = BUILT_INS.find((item) => item.id === id);
    return role ? copyDefinition(role) : undefined;
  }

  toSkillPackCandidate(id: string, at: number): RegisterSkillPackCandidateRequest {
    const role = this.get(id);
    if (!role) throw new Error(`预置角色 ${id} 不存在`);
    return {
      id: `role.${role.id}`,
      version: '1.0.0',
      displayName: `Agency · ${role.displayName}`,
      source: this.skillPackSource(role),
      content: role.content,
      estimatedTokens: Math.ceil(role.content.length / 4),
      maxInjectionTokens: Math.min(Math.ceil(role.content.length / 4), 8_000),
      scope: {},
      note: `来源：${role.source.repository} (${role.source.license})；必须保留版权归因。角色文本不授予权限。`,
      at,
    };
  }

  private skillPackSource(role: AgencyRoleDefinition): SkillPackSource {
    return { type: 'git', locator: role.source.upstreamUrl, digest: role.source.contentDigest };
  }
}
