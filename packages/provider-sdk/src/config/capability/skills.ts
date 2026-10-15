// 一个文件=一种作用：provider「技能」能力面契约（纯类型，零 IO）。

/** 归一化后的一条技能记录。 */
export interface ProviderSkill {
  readonly name: string;
  readonly description?: string;
  /** provider 原生命令语法（如斜杠命令）；不同 provider 可能不同。 */
  readonly command?: string;
}

/**
 * 技能能力面。
 * 只声明「provider 能列出 / 安装 / 移除自己的技能」。
 */
export interface ProviderSkillsFacet {
  /** 列出该 provider 在指定工作区可见的技能。 */
  listSkills(options?: { readonly workspacePath?: string }): Promise<readonly ProviderSkill[]>;
  /** 写入一条用户级技能（markdown 正文），返回归一化后的记录。 */
  addSkill(input: { readonly name: string; readonly markdown: string }): Promise<ProviderSkill>;
  /** 移除一条技能；返回是否确有移除。 */
  removeSkill(input: { readonly name: string }): Promise<boolean>;
}
