export function proposedMemoryContent(current: string, proposal: string): string {
  const next = proposal.trim();
  if (!next) return current;
  const base = current.trimEnd();
  return `${base}${base ? '\n\n' : ''}## 已批准记忆\n\n${next}\n`;
}

export function proposalPreview(current: string, proposal: string): readonly string[] {
  const next = proposal.trim();
  if (!next) return ['尚未输入记忆提议。'];
  return [
    `当前记忆：${current.length.toLocaleString()} 字符`,
    `提议追加：${next.length.toLocaleString()} 字符`,
    '',
    '--- AI_WORK_OS_MEMORY.md',
    '+++ 已批准提议（仅在主人确认后写入）',
    ...next.split('\n').map((line) => `+ ${line}`),
  ];
}
