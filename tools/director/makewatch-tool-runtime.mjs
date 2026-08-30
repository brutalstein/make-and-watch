import { GenerationGatewayClient } from '../generation/gateway-api-client.mjs';
import { handleMakeWatchToolCall, makeWatchDynamicToolSpecs } from './makewatch-tools.mjs';
import {
  handleTemporalMediaToolCall,
  temporalMediaDynamicToolSpecs,
  temporalMediaToolLimits,
} from './temporal-media-tools.mjs';

let runtime = null;
let temporalRuntime = null;

function createTemporalRuntime(client = new GenerationGatewayClient()) {
  return {
    referenceProvider: () => client.referenceProviderStatus(),
    startReferenceGeneration: (input) => client.startReferenceGeneration(input),
    referenceJob: ({ jobId }) => client.referenceJob(jobId),
    referenceJobs: ({ limit }) => client.referenceJobs(limit),
    temporalProviders: () => client.temporalProviders(),
    temporalShotPlan: ({ shotId, maxSegmentSeconds }) => client.temporalShotPlan(shotId, { maxSegmentSeconds }),
    startTemporalShotGeneration: ({ shotId, providerId }) => client.startTemporalShot(shotId, providerId),
    temporalJob: ({ jobId }) => client.temporalJob(jobId),
    temporalJobs: ({ limit }) => client.temporalJobs(limit),
  };
}

export function configureMakeWatchToolRuntime(nextRuntime, options = {}) {
  if (!nextRuntime || typeof nextRuntime !== 'object') {
    throw new Error('Make & Watch tool runtime must be an object');
  }
  const required = [
    'snapshot', 'history', 'impact', 'apply',
    'newWorkflow', 'saveWorkflow', 'listWorkflows', 'loadWorkflow', 'deleteWorkflow',
    'generationProvider', 'startSceneGeneration', 'startAudioGeneration',
    'episodeComposition', 'startEpisodeRender',
    'generationJob', 'generationJobs',
  ];
  for (const name of required) {
    if (typeof nextRuntime[name] !== 'function') {
      throw new Error(`Make & Watch tool runtime is missing ${name}()`);
    }
  }
  runtime = nextRuntime;
  temporalRuntime = options.temporalRuntime ?? createTemporalRuntime(options.generationGatewayClient);
}

export function clearMakeWatchToolRuntime() {
  runtime = null;
  temporalRuntime = null;
}

export function hasMakeWatchToolRuntime() {
  return runtime !== null;
}

export function configuredMakeWatchDynamicToolSpecs() {
  return runtime ? [...makeWatchDynamicToolSpecs(), ...temporalMediaDynamicToolSpecs()] : [];
}

export async function handleConfiguredMakeWatchToolCall(call) {
  if (!runtime) throw new Error('Make & Watch project tool runtime is not configured');
  if (call?.namespace === temporalMediaToolLimits.namespace) {
    return handleTemporalMediaToolCall(call, temporalRuntime);
  }
  return handleMakeWatchToolCall(call, runtime);
}
