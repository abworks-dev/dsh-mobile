/**
 * Authenticated LAN gateway for the existing DSH Web application. The ordinary
 * Web listener remains loopback-only; this package owns pairing and the only
 * listener intended for phones.
 */
export { AccessController, AccessError, BoundedRateLimiter } from './access.js'
export type {
  AccessControllerOptions,
  DeviceProbeResult,
  DeviceSummary,
  PairingResult,
  RenewalResult,
  SessionAuthorization,
  SessionEndReason,
} from './access.js'
export { Config, parseControlFile, parseGatewayConfig } from './config.js'
export type {
  DisabledTlsConfig,
  PluginConfig,
  ProvidedTlsConfig,
  ResolvedGatewayConfig,
  TlsConfig,
} from './config.js'
export {
  JsonMobileAccessControlStore,
  MobileAccessGatewayController,
  parseMobileAccessControlState,
} from './control.js'
export type {
  MobileAccessControlState,
  MobileAccessControlStore,
  MobileAccessRuntime,
} from './control.js'
export { MobileAccessGateway, rewriteMobileIndex } from './gateway.js'
export {
  EXTENSION_LIMITS,
  MobileAccessService,
  MobileExtensionError,
  assertExtensionId,
  createMobileAccessService,
  parseExtensionManifest,
} from './extensions.js'
export type {
  LocalExtensionManifest,
  MobileAccessService as MobileAccessRegistry,
  MobileActionContext,
  MobileExtensionClientEntry,
  MobileExtensionDefinition,
  MobileExtensionManifest,
  MobileExtensionStatus,
  MobileHostAction,
  MobileHostRoute,
  MobileRouteRequest,
  MobileRouteResponse,
} from './extensions.js'
export {
  AUTH_PREFIX,
  CSRF_COOKIE,
  CSRF_HEADER,
  DEVICE_COOKIE,
  LOCAL_ADMIN_PREFIX,
  SESSION_COOKIE,
  WS_PATHS,
} from './http-security.js'
export {
  addressAllowed,
  isGloballyRoutableIpv4,
  isLoopbackAddress,
  parseAuthority,
  parseCidr,
  RequestTrustPolicy,
  resolveAuthority,
} from './network.js'
export type { AuthoritySpec, ParsedCidr } from './network.js'
export {
  JsonDeviceStore,
  MemoryDeviceStore,
  parseDeviceSnapshot,
} from './storage.js'
export type { DeviceSnapshot, DeviceStore, StoredDevice } from './storage.js'
export { FRP_COMPONENT_RELEASES, FrpComponentManager } from './frp-component.js'
export {
  BlockedUpgradePathLog,
  MAX_BLOCKED_UPGRADE_PATHS,
  MAX_EXTRA_WEBSOCKET_PATHS,
  MAX_WEBSOCKET_PATH_LENGTH,
  normalizeWebSocketPaths,
  validateWebSocketPath,
  WebSocketPathStore,
} from './websocket-paths.js'
export type { BlockedUpgradePathEntry } from './websocket-paths.js'
export type { FrpComponentStatus } from './frp-component.js'
export {
  DEFAULT_VHOST_HTTP_PORT,
  FrpConfigStore,
  createFrpServerTemplate,
  createFrpcToml,
  mergeSavedFrpSettings,
  mergeSavedFrpTarget,
  parseFrpSettings,
  validateFrpPublicOrigin,
  validateFrpServerAddress,
  validateFrpServerPort,
  validateFrpToken,
} from './frp-config.js'
export {
  FRP_CADDY_IMPORT_LINE,
  FRP_CADDY_SNIPPET_MARKER,
  FRP_CADDY_SNIPPET_PATH,
  createCaddySite,
  createRestrictedFrpServerTemplate,
  FRP_VHOST_HTTP_PORT,
} from './frp-template.js'
export type { FrpConfigurationStatus, FrpSettings } from './frp-config.js'
export { FrpController } from './frp.js'
export type { FrpControllerOptions, FrpState, FrpStatus } from './frp.js'
export { DEFAULT_ORIGIN_LISTEN_PORT, OriginConfigStore, parseOriginSettings, validateOriginPublicOrigin,
  validateOriginListenHost, validateOriginListenPort, validateOriginAllowedCidrs } from './origin-proxy-config.js'
export type { OriginSettings, OriginConfigurationStatus } from './origin-proxy-config.js'
export { OriginController } from './origin-proxy.js'
export type { OriginControllerOptions, OriginState, OriginStatus } from './origin-proxy.js'
export { CLOUDFLARED_COMPONENT_RELEASE, CloudflaredComponentManager } from './cloudflared-component.js'
export type { CloudflaredComponentStatus } from './cloudflared-component.js'
export { CloudflaredController, isCloudflaredRegistration, parseCloudflaredOrigin } from './cloudflared.js'
export type { CloudflaredControllerOptions, CloudflaredState, CloudflaredStatus } from './cloudflared.js'
export {
  CloudflaredTunnelStore, mergeSavedCloudflaredTunnelSettings, parseCloudflaredTunnelSettings,
  validateCloudflaredTunnelHostname, validateCloudflaredTunnelPort, validateCloudflaredTunnelToken,
} from './cloudflared-tunnel.js'
export type {
  CloudflaredTunnelMode, CloudflaredTunnelSettings, CloudflaredTunnelStatus,
} from './cloudflared-tunnel.js'
export { configuredRemoteProvider, JsonRemoteProviderStore, parseRemoteProviderState, REMOTE_PROVIDERS } from './remote.js'
export type {
  RemoteProvider,
  RemoteProviderController,
  RemoteProviderState,
  RemoteProviderStatus,
} from './remote.js'
export {
  TASK_EVENT_DEBOUNCE_MS,
  TaskEventHub,
  watchTaskCompletions,
} from './task-events.js'
export type {
  TaskCompletionEvent,
  TaskEventContext,
  TaskEventSession,
  TaskEventSink,
  TaskEventWatcherOptions,
  TaskTurnEvent,
} from './task-events.js'
export { apply, inject, name, originGatewayConfig } from './plugin.js'
