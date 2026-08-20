import {
  AuthenticatedNativeComponentManagementBridge,
  ComponentManagementAuthority,
  NativeHostBridgeTrustRegistry,
  NativeHostChallengeIssuer,
  NativeHostEnvelopeVerifier,
  SqliteNativeHostBridgeTrustStore,
  SqliteNativeHostChallengeStore,
  TrustedDesktopIssuerRegistry,
} from '@awo/agent-runtime';
import { createGatewayNativeHostAuthenticationReport, type GatewayNativeHostAuthenticationReportV1 } from './native-host-authentication-report.js';

/**
 * P6.4 应用组合层：创建 native bridge 信任/nonce 账本与唯一认证桥。
 * 仅 composition root 能调用本工厂；HTTP router 和 Workbench 从不接触其存储、challenge、envelope 或 mutation 接口。
 */
export interface NativeHostAuthenticationComposition {
  readonly nativeHost: { readonly componentManagement: AuthenticatedNativeComponentManagementBridge };
  report(): GatewayNativeHostAuthenticationReportV1;
  close(): void;
}

export function createNativeHostAuthenticationComposition(input: {
  readonly bridgeTrustPath: string;
  readonly challengePath: string;
  readonly issuers: TrustedDesktopIssuerRegistry;
  readonly componentManagement: ComponentManagementAuthority;
}): NativeHostAuthenticationComposition {
  const bridgeTrustStore = new SqliteNativeHostBridgeTrustStore(input.bridgeTrustPath);
  const bridges = new NativeHostBridgeTrustRegistry(bridgeTrustStore);
  const challengeStore = new SqliteNativeHostChallengeStore(input.challengePath);
  const challengeIssuer = new NativeHostChallengeIssuer(input.issuers, bridges, challengeStore);
  const envelopeVerifier = new NativeHostEnvelopeVerifier(input.issuers, bridges, challengeStore);
  const nativeHost = {
    componentManagement: new AuthenticatedNativeComponentManagementBridge(challengeIssuer, envelopeVerifier, input.componentManagement),
  };
  return {
    nativeHost,
    report: () => createGatewayNativeHostAuthenticationReport(bridges, challengeStore),
    close: () => {
      bridgeTrustStore.close();
      challengeStore.close();
    },
  };
}
