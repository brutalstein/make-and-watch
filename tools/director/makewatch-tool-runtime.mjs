import { handleMakeWatchToolCall, makeWatchDynamicToolSpecs } from './makewatch-tools.mjs';

let runtime = null;

export function configureMakeWatchToolRuntime(nextRuntime) {
  if (!nextRuntime || typeof nextRuntime !== 'object') {
    throw new Error('Make & Watch tool runtime must be an object');
  }
  const required = [
    'snapshot', 'history', 'impact', 'apply',
    'newWorkflow', 'saveWorkflow', 'listWorkflows', 'loadWorkflow', 'deleteWorkflow',
  ];
  for (const name of required) {
    if (typeof nextRuntime[name] !== 'function') {
      throw new Error(`Make & Watch tool runtime is missing ${name}()`);
    }
  }
  runtime = nextRuntime;
}

export function clearMakeWatchToolRuntime() {
  runtime = null;
}

export function hasMakeWatchToolRuntime() {
  return runtime !== null;
}

export function configuredMakeWatchDynamicToolSpecs() {
  return runtime ? makeWatchDynamicToolSpecs() : [];
}

export async function handleConfiguredMakeWatchToolCall(call) {
  if (!runtime) throw new Error('Make & Watch project tool runtime is not configured');
  return handleMakeWatchToolCall(call, runtime);
}
