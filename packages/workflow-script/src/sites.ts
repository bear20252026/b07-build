// 站点收集：把脚本里的**效应**静态枚举出来。
//
// ## 为什么这是本模块的核心
//
// "批准一次运行"要有确切含义，前提是**运行前就知道它会做哪些有副作用的事**。脚本是自由
// 文本，只有把 ask / world.run 这类站点静态找出来，才谈得上：把命令清单摆给用户确认、
// 给每次运行设上限、以及——最重要的——把它们记进 journal，使续跑不重跑。
//
// 这也是 ZCode 那句 "site identity" 的落点：每个站点要有**稳定身份**，否则续跑时对不上
// 记录，效应就会被重做一遍。
//
// ## 站点身份怎么算（照搬 ZCode 的规则）
//
// **按种类各自计数**，按源码顺序：`actor#1`、`ask#1`、`ask#2`、`world-run#1`、`world-read#1`。
//
// 为什么按种类分开而不是全局一个序号：全局序号会让"在脚本前面加一条 world-read"
// 把后面所有 ask 的编号整体挪位，于是续跑认不出原来的 ask、把它们**重跑一遍**。
// 按种类计数把影响限制在同一种类内 —— 这是能做对的最小代价。
//
// 代价也要说清：在同类站点**前面**插入一个同类站点，仍会挪位。这不是疏漏，是
// "按顺序计数"这一选择的固有性质；ZCode 同样如此。真要完全稳定需要内容寻址，
// 而内容会随编辑变化，那是另一种不稳定。
//
// ## 与 ZCode 的差别
//
// ZCode 在这一层之上还有一整棵 may-flow 图（污点不动点、fan-out 提升、actor 车道、
// 四张投影图）。b07 只做**站点表**：谁在哪、叫什么、是哪种。理由：那张图的用途是
// "把运行画给用户看 + 推断数据依赖"，而 b07 还没有那张图要渲染的面。
// 少而真优于多而假 —— 一个算不准的依赖图比没有依赖图更误导人。

import * as ts from 'typescript';

import { WORKFLOW_FACADE_FILE_NAME } from './facade.js';
import { WORKFLOW_FUNCTION_NAME, toAuthorLocation, type WorkflowProgram } from './compile.js';

/** 站点的种类。 */
export type WorkflowSiteKind = 'actor' | 'ask' | 'world-run' | 'world-read';

/** 一个站点。 */
export interface WorkflowSite {
  /**
   * 稳定身份：`${kind}#${n}`，n 是**该种类内**按源码顺序的序号（从 1 开始）。
   * journal 按它索引。
   */
  readonly id: string;
  readonly kind: WorkflowSiteKind;
  /** 1-based 行列，脚本原文坐标。 */
  readonly line: number;
  /** 1-based 列，脚本原文坐标。 */
  readonly column: number;
  /** 可读标签：agent 名 / 命令 / 路径 / ask 的指令片段。 */
  readonly label: string;
}

/** 站点收集发现的编写问题（稳定码，便于测试与归因）。 */
export interface WorkflowSiteDiagnostic {
  /** 稳定码。 */
  readonly code: string;
  readonly message: string;
  readonly line: number;
  readonly column: number;
}

/** 收集结果。 */
export interface WorkflowSiteTable {
  /** 按源码顺序排列的全部站点。 */
  readonly sites: readonly WorkflowSite[];
  readonly diagnostics: readonly WorkflowSiteDiagnostic[];
}

/** `world.run` 的 cmd 不是编译期字面量。 */
export const NON_LITERAL_COMMAND_CODE = 'workflow-non-literal-command' as const;

/** 标签过长时截断到这个长度（站点表是要给人看的，不是转储源码）。 */
const MAX_LABEL_CHARS = 80;

/** facade 里的一个成员：`world.run` 的 owner 是 `world`、member 是 `run`。 */
interface FacadeMember {
  readonly owner: string;
  readonly member: string;
}

/** 这个声明是不是 facade 提供的？ */
function isFacadeDeclaration(declaration: ts.Declaration): boolean {
  return declaration.getSourceFile().fileName === WORKFLOW_FACADE_FILE_NAME;
}

/** 往上找最近的有名字的声明，取出它的名字。 */
function enclosingName(node: ts.Node): string | undefined {
  let current: ts.Node | undefined = node;
  while (current) {
    if (
      (ts.isVariableDeclaration(current) ||
        ts.isInterfaceDeclaration(current) ||
        ts.isFunctionDeclaration(current) ||
        ts.isMethodSignature(current) ||
        ts.isPropertySignature(current)) &&
      current.name &&
      ts.isIdentifier(current.name)
    ) {
      return current.name.text;
    }
    current = current.parent;
  }
  return undefined;
}

/**
 * 这个声明属于 facade 的哪个成员？
 *
 * 两类：
 * - 顶层 `declare function agent(...)` → owner 是 `global`（它不属于任何对象）；
 * - 对象/接口的成员（`world.run`、`files.glob`、`Agent.ask`）→ owner 是那个对象/接口名。
 */
function facadeOwnerOf(declaration: ts.Declaration): string | undefined {
  if (ts.isFunctionDeclaration(declaration)) return 'global';
  return enclosingName(declaration.parent);
}

/**
 * 被调用的表达式是不是 facade 的成员？
 *
 * 走**类型**而不是走语法：`const w = world; w.run(...)` 这种别名也要认出来，
 * 而只看语法文本会漏掉它 —— 漏掉的后果是那条命令不进站点表，于是既不在确认清单里、
 * 也不进 journal，续跑时会**重跑**。
 */
function facadeMemberOf(checker: ts.TypeChecker, expression: ts.Expression): FacadeMember | undefined {
  const nameNode = ts.isPropertyAccessExpression(expression) ? expression.name : expression;
  const symbol = checker.getSymbolAtLocation(nameNode);
  if (!symbol) return undefined;
  for (const declaration of symbol.declarations ?? []) {
    if (!isFacadeDeclaration(declaration)) continue;
    const owner = facadeOwnerOf(declaration);
    const member = ts.isIdentifier(nameNode) ? nameNode.text : symbol.getName();
    if (owner) return { owner, member };
  }
  return undefined;
}

/** 成员 → 站点种类。没登记的不是效应站点（例如 `log`）。 */
function siteKindOf(member: FacadeMember): WorkflowSiteKind | undefined {
  if (member.owner === 'world' && member.member === 'run') return 'world-run';
  if (member.owner === 'files' && ['glob', 'read', 'grep'].includes(member.member)) return 'world-read';
  if (member.owner === 'Agent' && member.member === 'ask') return 'ask';
  if (member.owner === 'global' && member.member === 'agent') return 'actor';
  return undefined;
}

/** 取调用里第 index 个实参，如果是字符串字面量就返回它的值。 */
function stringLiteralArgument(call: ts.CallExpression, index: number): string | undefined {
  const argument = call.arguments[index];
  if (!argument) return undefined;
  if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) return argument.text;
  return undefined;
}

/** 把标签截断到可读长度。 */
function trimLabel(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_LABEL_CHARS ? `${collapsed.slice(0, MAX_LABEL_CHARS - 1)}…` : collapsed;
}

/** 给一个站点算标签。 */
function labelFor(kind: WorkflowSiteKind, call: ts.CallExpression): string {
  switch (kind) {
    case 'actor': {
      const name = stringLiteralArgument(call, 0);
      return name ? trimLabel(name) : '（未命名）';
    }
    case 'world-run': {
      const command = stringLiteralArgument(call, 0);
      if (command) return trimLabel(command);
      // 非字面量命令：把源码片段原样放进来，便于用户认出是哪一条。
      return trimLabel(call.arguments[0]?.getText() ?? '（空）');
    }
    case 'world-read': {
      const target = stringLiteralArgument(call, 0);
      const method = ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : 'read';
      return trimLabel(target ? `${method}(${target})` : method);
    }
    case 'ask': {
      const instructions = stringLiteralArgument(call, 0);
      return instructions ? trimLabel(instructions) : '（非字面量指令）';
    }
  }
}

/** 收集站点表。 */
export function collectSites(program: WorkflowProgram): WorkflowSiteTable {
  const checker = program.program.getTypeChecker();
  /** 先收成"无名"的，排完序再编号 —— 编号顺序必须是**源码位置顺序**，见下方注释。 */
  const collected: { kind: WorkflowSiteKind; line: number; column: number; end: number; label: string }[] = [];
  const diagnostics: WorkflowSiteDiagnostic[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const member = facadeMemberOf(checker, node.expression);
      const kind = member ? siteKindOf(member) : undefined;
      if (kind) {
        const start = node.getStart(program.sourceFile);
        const location = toAuthorLocation(program.sourceFile, start);
        collected.push({
          kind,
          line: location.line,
          column: location.column,
          end: node.getEnd(),
          label: labelFor(kind, node),
        });
        // 命令必须是编译期字面量：它会在确认时展示给用户。
        // 允许计算出来的命令，就等于允许"用户确认的"和"实际跑的"不是同一件事。
        if (kind === 'world-run' && stringLiteralArgument(node, 0) === undefined) {
          diagnostics.push({
            code: NON_LITERAL_COMMAND_CODE,
            message: 'world.run 的命令必须是编译期字符串字面量：它要在确认时展示给用户，算出来的命令无法如实展示。',
            line: location.line,
            column: location.column,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  // 只遍历作者写的函数体：wrapped 源码里还有前缀（async function 声明）与后缀，
  // 它们不是作者的代码，混进来会凭空多出站点。
  const body = program.sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === WORKFLOW_FUNCTION_NAME,
  );
  if (body) visit(body);

  // **按源码位置排序后再编号**。遍历是"外层调用先于内层"的（`agent(x).ask(y)` 先碰到
  // `ask` 再下沉到 `agent`），而源码顺序里 `agent` 在前。不排序的话站点表读起来是
  // 倒的，更糟的是编号顺序与作者读代码的顺序不一致 —— 排查时对不上。
  //
  // 平手用 `end` 破：嵌套调用**起始位置相同**（`agent(name).ask(…)` 的起点就是
  // `agent`），只有结束位置能区分内外；内层结束更早，因此排在前面 —— 这也正是
  // 它们的求值顺序（先建 actor，再派活）。
  const ordered = [...collected].sort(
    (left, right) => left.line - right.line || left.column - right.column || left.end - right.end,
  );
  const counters = new Map<WorkflowSiteKind, number>();
  const sites: WorkflowSite[] = ordered.map((site) => {
    const count = (counters.get(site.kind) ?? 0) + 1;
    counters.set(site.kind, count);
    return { id: `${site.kind}#${count}`, kind: site.kind, line: site.line, column: site.column, label: site.label };
  });
  diagnostics.sort((left, right) => left.line - right.line || left.column - right.column);

  return { sites, diagnostics };
}
