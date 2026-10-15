// 一个文件=一种作用：sampling 维度不变式夹具（宿主/服务端发起请求的准入与代际绑定）。
//
// 上游出处：ZCode `packages/desktop/scripts/mcp-apps-host-fixture/sampling-main.ts`、
// `sampling-extra-checks.ts`（Apache-2.0）。上游这一维跑的是「宿主代应用向模型发起采样请求」：
// 准入（实例凭据）、操作去重、取消、模型冻结、绝不写入主对话，以及伪造/越权必须被拒。
//
// b07 现状：**尚无采样路径**（`mcp-client-session.ts` 明确「sampling 不在本批」）。故本维度
// 移植的是同一类不变式——「宿主/服务端代表不可信应用发起请求」这条缝，在 b07 由
// `McpAppMountController`（准入 + 网关）→ `McpAppToolGateway`（手势/风险/并发/超时收口）
// → `McpAppInstanceLease`（代际绑定）→ `@awo/protocol` 桥（线格式与二次准入）承载。
// 因此本维度是**部分覆盖**：协议门、凭据绑定、去重、取消语义可测；真实模型采样不可测（未实现）。
//
// 读清楚的不变式（逐条来自上游源码）：
// 必须成立：
// 1. 准入白名单内的工具才执行，结果回投并留审计；
// 2. 特权调用必须被**新鲜的一次性用户手势**背书；
// 3. medium/high 必须经人工裁决（low 免批）；无人裁决入口 = 拒绝；
// 4. 并发上限成立（超出即拒，不排队）；单次超时成立（超时后不再回投）；
// 5. 请求与结果按**代际**绑定，重挂载后迟到结果必须丢弃（不得重放）。
// 必须被拒：
// 6. 白名单外的工具名（网关 + 桥上二次准入）；
// 7. 无手势 / 手势 token 已消费；
// 8. 未裁决 / 裁决拒绝；
// 9. 白名单外方法、未声明参数键、带 id 的通知、非 JSON-RPC 载荷、超限载荷；
// 10. 卸载后的调用必须回到未挂载语义，绝不静默成功。

import {
  MCP_APP_BRIDGE_ERROR_CODES,
  MCP_APP_MAX_MESSAGE_CHARS,
  parseMcpAppBridgeMessage,
} from '@awo/protocol';
import { McpAppInstanceLease } from '../mcp-app-lease';
import { McpAppMountController } from '../mcp-app-mount-controller';
import { McpAppToolGateway } from '../mcp-app-tool-gateway';
import {
  expect,
  expectEqual,
  type McpAppFixtureCheck,
  type McpAppFixtureDimension,
} from './dimension-report';

/** 夹具 MCP 服务器：只声明 read_note；manifest 只请求它。 */
const FIXTURE_SERVER = { id: 'demo', declaredTools: [{ name: 'read_note' }] };

/** 夹具 manifest：白名单 = declaredTools ∩ requestedToolNames = ['read_note']。 */
function fixtureManifest(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'mcpapp-demo-notes',
    serverId: 'demo',
    displayName: '笔记',
    htmlResourceUri: 'ui://demo/notes',
    requestedToolNames: ['read_note'],
  };
}

/** 桥的准入视图：与 manifest 的 admittedToolNames 同形。 */
const BRIDGE_ADMISSION = { admittedToolNames: ['read_note'] } as const;

const checks: readonly McpAppFixtureCheck[] = [
  {
    name: '准入成立：白名单内工具必须执行、结果回投并留审计',
    run: async () => {
      const controller = new McpAppMountController();
      const mounted = controller.mount({
        server: FIXTURE_SERVER,
        manifest: fixtureManifest(),
        riskTable: { read_note: 'low' },
        executor: { execute: async (toolName) => `ran:${toolName}` },
      });
      expect(mounted.ok, '准入必须通过');
      const outcome = await controller.callTool('read_note', { q: 1 });
      expect(outcome.ok, '白名单内工具必须执行');
      if (!outcome.ok) return;
      expectEqual(outcome.result, 'ran:read_note', '结果必须回投给调用方');
      expectEqual(controller.audit.at(-1)?.outcome, 'executed', '执行必须留审计');
    },
  },
  {
    name: '必须被拒：白名单外的工具名（网关纵深防御 + 桥上二次准入）',
    run: async () => {
      const controller = new McpAppMountController();
      controller.mount({
        server: FIXTURE_SERVER,
        manifest: fixtureManifest(),
        executor: { execute: async () => 'should-not-run' },
      });
      const outcome = await controller.callTool('write_note', { text: 'x' });
      expect(!outcome.ok, '白名单外工具必须被网关拒绝');
      if (outcome.ok) return;
      expectEqual(outcome.reason, 'mcpapp-tool-not-admitted', '网关拒绝原因必须外显');

      const forged = parseMcpAppBridgeMessage(
        { jsonrpc: '2.0', id: 'call-1', method: 'tools/call', params: { name: 'write_note' } },
        BRIDGE_ADMISSION,
      );
      expect(!forged.ok, '桥上二次准入必须拦下伪造工具名');
      if (forged.ok) return;
      expectEqual(forged.code, MCP_APP_BRIDGE_ERROR_CODES.invalidParams, '必须按 invalidParams 应答');
    },
  },
  {
    name: '手势门成立：无新鲜手势拒绝、有手势放行、一次性 token 不得重放',
    run: async () => {
      const controller = new McpAppMountController();
      const tokens = new Set<string>();
      controller.mount({
        server: FIXTURE_SERVER,
        manifest: fixtureManifest(),
        appInstanceId: 'panel',
        riskTable: { read_note: 'low' },
        executor: { execute: async () => 'ok' },
        consumeUserGesture: () => tokens.delete('panel'),
      });

      const withoutGesture = await controller.callTool('read_note', {});
      expect(!withoutGesture.ok, '无新鲜手势必须拒绝');
      if (!withoutGesture.ok) {
        expectEqual(withoutGesture.reason, 'mcpapp-user-gesture-required', '拒绝原因必须是缺手势');
      }

      tokens.add('panel');
      expect((await controller.callTool('read_note', {})).ok, '有手势背书必须放行');
      const replayed = await controller.callTool('read_note', {});
      expect(!replayed.ok, '一次性 token 不得重放');
      if (!replayed.ok) {
        expectEqual(replayed.reason, 'mcpapp-user-gesture-required', '重放必须按缺手势拒绝');
      }
    },
  },
  {
    name: '人工裁决成立：low 免批、无人裁决入口拒绝、裁决拒绝不执行、裁决通过执行一次',
    run: async () => {
      const low = new McpAppMountController();
      low.mount({
        server: FIXTURE_SERVER,
        manifest: fixtureManifest(),
        riskTable: { read_note: 'low' },
        executor: { execute: async () => 'ok' },
      });
      expect((await low.callTool('read_note', {})).ok, 'low 风险免人工裁决');

      const noGate = new McpAppMountController();
      noGate.mount({
        server: FIXTURE_SERVER,
        manifest: fixtureManifest(),
        riskTable: { read_note: 'high' },
        executor: { execute: async () => 'ok' },
      });
      const required = await noGate.callTool('read_note', {});
      expect(!required.ok, '无人裁决入口时必须拒绝');
      if (!required.ok) {
        expectEqual(required.reason, 'mcpapp-approval-required', '拒绝原因必须是缺裁决入口');
      }

      let deniedExecuted = 0;
      const denied = new McpAppMountController();
      denied.mount({
        server: FIXTURE_SERVER,
        manifest: fixtureManifest(),
        riskTable: { read_note: 'medium' },
        executor: { execute: async () => { deniedExecuted += 1; return 'ok'; } },
        approve: async () => false,
      });
      const rejected = await denied.callTool('read_note', {});
      expect(!rejected.ok, '裁决拒绝必须不执行');
      if (!rejected.ok) {
        expectEqual(rejected.reason, 'mcpapp-approval-denied', '拒绝原因必须是裁决拒绝');
      }
      expectEqual(deniedExecuted, 0, '裁决拒绝后不得触达执行器');

      let approvedExecuted = 0;
      const approved = new McpAppMountController();
      approved.mount({
        server: FIXTURE_SERVER,
        manifest: fixtureManifest(),
        riskTable: { read_note: 'medium' },
        executor: { execute: async () => { approvedExecuted += 1; return 'ok'; } },
        approve: async () => true,
      });
      expect((await approved.callTool('read_note', {})).ok, '裁决通过必须执行');
      expectEqual(approvedExecuted, 1, '裁决通过恰好执行一次');
    },
  },
  {
    name: '并发上限成立：超出上限立即拒绝而不是排队，在途结束后放行',
    run: async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const gateway = new McpAppToolGateway({
        admittedToolNames: ['read_note'],
        appInstanceId: 'fixture',
        riskFor: () => 'low',
        maxConcurrent: 1,
        execute: async () => {
          await gate;
          return 'ok';
        },
      });
      const first = gateway.call('call-1', 'read_note', {});
      const second = await gateway.call('call-2', 'read_note', {});
      expect(!second.ok, '超出并发上限必须拒绝');
      if (!second.ok) {
        expectEqual(second.reason, 'mcpapp-concurrency-limit', '拒绝原因必须是并发上限');
      }
      release();
      expect((await first).ok, '在途调用完成后必须放行');
      expectEqual(gateway.inFlightCount, 0, '结束后在途计数必须归零');
    },
  },
  {
    name: '超时成立：单次超时按超时原因返回、留审计并释放并发额度',
    run: async () => {
      const gateway = new McpAppToolGateway({
        admittedToolNames: ['read_note'],
        appInstanceId: 'fixture',
        riskFor: () => 'low',
        timeoutMs: 5,
        execute: () => new Promise<never>(() => {}),
      });
      const outcome = await gateway.call('call-1', 'read_note', {});
      expect(!outcome.ok, '超时必须失败');
      if (!outcome.ok) {
        expectEqual(outcome.reason, 'mcpapp-tool-timeout', '失败原因必须是超时');
      }
      expectEqual(gateway.audit.at(-1)?.outcome, 'timeout', '超时必须留审计');
      expectEqual(gateway.inFlightCount, 0, '超时后必须释放并发额度');
    },
  },
  {
    name: '代际绑定：同代际结果放行一次，重挂载后迟到结果与未入账结果必须丢弃',
    run: () => {
      const lease = new McpAppInstanceLease();
      lease.rotate();
      lease.issue('op-1');
      expect(lease.deliver('op-1'), '同代际结果必须放行');
      expect(!lease.deliver('op-1'), '同一操作不得回投两次（不得重放）');
      lease.issue('op-2');
      lease.rotate();
      expect(!lease.deliver('op-2'), '重挂载后旧实例的迟到结果必须丢弃');
      expect(!lease.deliver('never-issued'), '从未入账的结果必须丢弃');
    },
  },
  {
    name: '必须被拒：白名单外方法、未声明参数键、带 id 的通知、非 JSON-RPC、超限载荷',
    run: () => {
      const unknown = parseMcpAppBridgeMessage({ jsonrpc: '2.0', id: 1, method: 'ui/teleport' }, BRIDGE_ADMISSION);
      expect(!unknown.ok, '白名单外方法必须拒绝');
      if (!unknown.ok) {
        expectEqual(unknown.code, MCP_APP_BRIDGE_ERROR_CODES.methodNotFound, '必须是 methodNotFound');
      }

      const extraKey = parseMcpAppBridgeMessage(
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_note', extra: 1 } },
        BRIDGE_ADMISSION,
      );
      expect(!extraKey.ok, '未声明参数键必须拒绝');
      if (!extraKey.ok) {
        expectEqual(extraKey.code, MCP_APP_BRIDGE_ERROR_CODES.invalidParams, '必须是 invalidParams');
      }

      const notification = parseMcpAppBridgeMessage(
        { jsonrpc: '2.0', id: 3, method: 'ui/notifications/initialized' },
        BRIDGE_ADMISSION,
      );
      expect(!notification.ok, '通知不得携带 id');
      if (!notification.ok) {
        expectEqual(notification.reason, 'mcpapp-bridge-notification-with-id', '必须是带 id 的通知违规');
      }

      const noise = parseMcpAppBridgeMessage('hello', BRIDGE_ADMISSION);
      expect(!noise.ok, '非 JSON-RPC 载荷必须拒绝');
      if (!noise.ok) {
        expectEqual(noise.reason, 'mcpapp-bridge-not-jsonrpc', '必须是非 JSON-RPC');
      }

      const oversized = parseMcpAppBridgeMessage(
        { jsonrpc: '2.0', id: 4, method: 'ping', params: {}, pad: 'x'.repeat(MCP_APP_MAX_MESSAGE_CHARS + 10) },
        BRIDGE_ADMISSION,
      );
      expect(!oversized.ok, '超限载荷必须拒绝');
      if (!oversized.ok) {
        expectEqual(oversized.reason, 'mcpapp-message-too-large', '必须是超限载荷');
      }
    },
  },
  {
    name: '卸载后调用必须回到未挂载语义，绝不静默成功',
    run: async () => {
      const controller = new McpAppMountController();
      controller.mount({
        server: FIXTURE_SERVER,
        manifest: fixtureManifest(),
        riskTable: { read_note: 'low' },
        executor: { execute: async () => 'ok' },
      });
      controller.unmount();
      const outcome = await controller.callTool('read_note', {});
      expect(!outcome.ok, '卸载后调用必须失败');
      if (!outcome.ok) {
        expectEqual(outcome.message, 'mcpapp-not-mounted', '必须回到未挂载语义');
      }
      expectEqual(controller.audit.length, 0, '审计轨迹必须随网关释放');
    },
  },
];

/** sampling 维度：可被 CI 逐项运行，也可被 WebView2 夹具整段运行（b07 无采样路径，部分覆盖）。 */
export const SAMPLING_DIMENSION: McpAppFixtureDimension = {
  id: 'sampling',
  title: 'sampling：宿主代表应用发起请求的准入与代际绑定',
  checks,
};
