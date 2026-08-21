// packages/provider-sdk/src/index.ts —— 一个文件=一个作用：包导出面（只 re-export，不写逻辑）
export type { ModelDriver, ChatRequest, ChatMessage, ModelCapabilities, ModelCostTier } from './driver';
export { ModelRouter } from './router';
export {
  InMemoryProviderProfileStore,
  ProviderProfileRegistry,
  SqliteProviderProfileStore,
} from './provider-profile';
export { LocalEndpointRegistry } from './local-endpoint-registry';
export { LocalModelHealthRegistry } from './local-model-health';
export type { LocalModelHealthSummaryV1 } from './local-model-health';
export type {
  LocalEndpointAvailability,
  LocalEndpointCapabilities,
  LocalEndpointFetch,
  LocalEndpointHealth,
  LocalEndpointHealthStatus,
  LocalEndpointProbeMethod,
  LocalModelEndpoint,
  RegisterLocalModelEndpoint,
} from './local-endpoint-registry';
export type { TaskKind, DataBoundary, ModelRouteRequest, ModelRouteCandidate, ModelRouteDecision } from './router';
export type {
  ProfileRouteRequest,
  ProviderProfile,
  ProviderProfileRouteDecision,
  ProviderProfileStatus,
  ProviderProfileStore,
  RegisterProviderProfileRequest,
  UpdateProviderProfileRequest,
} from './provider-profile';
export { OpenAICompatible } from './adapters/openai';
export type { OpenAICompatibleOptions } from './adapters/openai';
export { LocalOpenAICompatible } from './adapters/local-openai';
export type { LocalOpenAIOptions } from './adapters/local-openai';
export { AnthropicMessages } from './adapters/anthropic';
export type { AnthropicOptions } from './adapters/anthropic';
export { ProviderCatalog, BUILT_IN_PROVIDER_CATALOG } from './provider-catalog';
export type { ProviderCatalogEntry, ProviderTransportKind } from './provider-catalog';
export { EnvironmentCredentialResolver, SessionCredentialResolver, summarizeProviderCredentials } from './credential-resolver';
export type { CredentialAvailability, CredentialAvailabilitySummary, CredentialResolver, SessionCredentialStore, ProviderCredentialStatus } from './credential-resolver';
export { ProviderConnectionService } from './provider-connection-service';
export type {
  ActivateCatalogProviderRequest,
  ConfigureSessionProviderRequest,
  ProviderConnectionProbeOutcome,
  ProviderConnectionProbeResult,
  ProviderConnectionProfileStatus,
  ProviderConnectionStatus,
  RegisterCatalogProviderRequest,
} from './provider-connection-service';
export { ProviderInferenceService } from './provider-inference-service';
export type { ProviderDriverFactory, ProviderInferenceRequest, ProviderInferenceResult } from './provider-inference-service';
export { MimoTtsService } from './mimo-tts-service';
export type { MimoTtsPreviewRequest, MimoTtsPreviewResult } from './mimo-tts-service';
export { SessionCustomProviderService } from './session-custom-provider-service';
export type { ConfigureCustomProviderSessionRequest, CustomProviderInferenceRequest, CustomProviderProtocol } from './session-custom-provider-service';
