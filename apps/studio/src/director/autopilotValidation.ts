import type { ProjectGraphSnapshot, ProjectCommand } from '@makewatch/contracts';

import type { AutopilotPlan, AutopilotStep } from './autopilotTypes';

const MAX_STEPS = 128;
const MAX_COMMANDS_PER_STEP = 48;
const MAX_COORDINATE = 100_000;
const MAX_WAIT_MS = 15_000;

export interface AutopilotValidationResult {
  ok: boolean;
  errors: string[];
}

function validateNodeStep(step: AutopilotStep, nodeIds: Set<string>, errors: string[]) {
  if (step.type !== 'focusNode' && step.type !== 'dragNode' && step.type !== 'previewImpact') return;
  if (typeof step.nodeId !== 'string' || !nodeIds.has(step.nodeId)) {
    errors.push(`${typeof step.id === 'string' ? step.id : 'step'}: unknown node ${String(step.nodeId)}`);
  }
}

function validateAndApplyCommandShape(
  command: ProjectCommand,
  nodeIds: Set<string>,
  stepId: string,
  errors: string[],
) {
  if (!command || typeof command !== 'object' || typeof (command as { type?: unknown }).type !== 'string') {
    errors.push(`${stepId}: every command requires a known type`);
    return;
  }

  if (command.type === 'node.create') {
    const id = command.node?.id;
    if (typeof id !== 'string' || !id.trim()) {
      errors.push(`${stepId}: node.create requires a non-empty node id`);
      return;
    }
    if (nodeIds.has(id)) {
      errors.push(`${stepId}: node.create duplicates existing node ${id}`);
      return;
    }
    nodeIds.add(id);
    return;
  }

  if (command.type === 'dependency.add' || command.type === 'dependency.remove') {
    if (!nodeIds.has(command.dependent)) {
      errors.push(`${stepId}: dependency dependent ${command.dependent} is unknown`);
    }
    if (!nodeIds.has(command.dependency)) {
      errors.push(`${stepId}: dependency endpoint ${command.dependency} is unknown`);
    }
    if (command.dependent === command.dependency) {
      errors.push(`${stepId}: dependency cannot target itself`);
    }
    return;
  }

  if (!nodeIds.has(command.id)) {
    errors.push(`${stepId}: command targets unknown node ${command.id}`);
    return;
  }
  if (command.type === 'node.remove') nodeIds.delete(command.id);
}

export function validateAutopilotPlan(plan: AutopilotPlan, snapshot: ProjectGraphSnapshot): AutopilotValidationResult {
  const errors: string[] = [];
  const liveNodeIds = new Set(snapshot.nodes.map((node) => node.id));
  const simulatedNodeIds = new Set(liveNodeIds);
  const stepIds = new Set<string>();

  if (!plan || typeof plan !== 'object') return { ok: false, errors: ['autopilot plan must be an object'] };
  if (plan.schemaVersion !== 1) errors.push('unsupported autopilot plan schema');
  if (typeof plan.planId !== 'string' || !plan.planId.trim()) errors.push('planId is required');
  if (typeof plan.title !== 'string' || !plan.title.trim()) errors.push('plan title is required');
  if (plan.expectedProjectRevision !== snapshot.projectRevision) {
    errors.push(`plan revision ${String(plan.expectedProjectRevision)} does not match live revision ${snapshot.projectRevision}`);
  }
  if (!Array.isArray(plan.steps)) return { ok: false, errors: [...errors, 'plan steps must be an array'] };
  if (plan.steps.length === 0) errors.push('plan must contain at least one step');
  if (plan.steps.length > MAX_STEPS) errors.push(`plan exceeds ${MAX_STEPS} steps`);

  for (const step of plan.steps) {
    if (!step || typeof step !== 'object' || typeof (step as { type?: unknown }).type !== 'string') {
      errors.push('every autopilot step requires a known type');
      continue;
    }
    const stepId = typeof step.id === 'string' ? step.id : '';
    if (!stepId.trim()) errors.push('every autopilot step requires an id');
    if (stepIds.has(stepId)) errors.push(`duplicate autopilot step id ${stepId}`);
    stepIds.add(stepId);
    validateNodeStep(step, simulatedNodeIds, errors);

    if (step.type === 'dragNode') {
      if (!step.to || !Number.isFinite(step.to.x) || !Number.isFinite(step.to.y)) {
        errors.push(`${stepId}: drag coordinates must be finite`);
      } else if (Math.abs(step.to.x) > MAX_COORDINATE || Math.abs(step.to.y) > MAX_COORDINATE) {
        errors.push(`${stepId}: drag coordinates exceed workspace safety bounds`);
      }
      if (step.durationMs !== undefined && (!Number.isFinite(step.durationMs) || step.durationMs < 120 || step.durationMs > 4_000)) {
        errors.push(`${stepId}: drag duration must be between 120 and 4000 ms`);
      }
    }

    if (step.type === 'wait') {
      if (!Number.isFinite(step.durationMs) || step.durationMs < 0 || step.durationMs > MAX_WAIT_MS) {
        errors.push(`${stepId}: wait exceeds bounded execution time`);
      }
    }

    if (step.type === 'announce' && step.holdMs !== undefined) {
      if (!Number.isFinite(step.holdMs) || step.holdMs < 0 || step.holdMs > MAX_WAIT_MS) {
        errors.push(`${stepId}: announcement hold exceeds bounded execution time`);
      }
    }

    if (step.type === 'applyCommands') {
      if (plan.mode === 'assist') errors.push(`${stepId}: assist mode cannot mutate semantic project state`);
      if (typeof step.reason !== 'string' || !step.reason.trim()) {
        errors.push(`${stepId}: semantic mutation requires a reason`);
      }
      if (!Array.isArray(step.commands)) {
        errors.push(`${stepId}: applyCommands commands must be an array`);
        continue;
      }
      if (step.commands.length === 0) errors.push(`${stepId}: applyCommands requires at least one command`);
      if (step.commands.length > MAX_COMMANDS_PER_STEP) {
        errors.push(`${stepId}: too many commands in one native transaction`);
      }

      for (const command of step.commands) {
        validateAndApplyCommandShape(command, simulatedNodeIds, stepId, errors);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
