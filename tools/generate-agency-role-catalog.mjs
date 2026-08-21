import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const sourceDirectory = resolve(root, 'packages/knowledge-workflow/src/third-party/agency-agents');
const output = resolve(root, 'packages/knowledge-workflow/src/agency-agents-builtins.generated.ts');
const roles = [
  'engineering-software-architect.md',
  'engineering-frontend-developer.md',
  'engineering-code-reviewer.md',
  'engineering-sre.md',
  'design-ui-designer.md',
  'design-ux-researcher.md',
  'product-manager.md',
  'testing-test-automation-engineer.md',
];
const content = Object.fromEntries(roles.map((name) => [name, readFileSync(resolve(sourceDirectory, name), 'utf8')]));
const banner = `/*\n * GENERATED FILE — do not edit by hand.\n * Source: packages/knowledge-workflow/src/third-party/agency-agents/*.md\n * Derived from msitarzewski/agency-agents (MIT).\n * Copyright (c) 2025 AgentLand Contributors\n * SPDX-License-Identifier: MIT\n * Full license: ../../../THIRD_PARTY_NOTICES.md\n */\n\n`;
writeFileSync(output, `${banner}export const AGENCY_AGENT_ROLE_CONTENT = ${JSON.stringify(content, null, 2)} as const;\n`, 'utf8');
