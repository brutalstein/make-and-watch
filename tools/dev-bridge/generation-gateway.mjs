// Backward-compatible bridge import surface. The actual localhost media API
// client lives in tools/generation so Director/media runtimes can share one
// bounded implementation without depending on dev-bridge internals.
export { GenerationGatewayClient } from '../generation/gateway-api-client.mjs';
