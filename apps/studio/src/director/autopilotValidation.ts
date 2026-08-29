import type { ProjectGraphSnapshot, ProjectCommand } from '@makewatch/contracts';

import type { AutopilotPlan, AutopilotStep } from './autopilotTypes';

const MAX_STEPS = 512;
const MAX_COMMANDS_PER_STEP = 48;
const MAX_COORDINATE = 100_000;
const MAX_WAIT_MS = 15_000;

export interface AutopilotValidationResult {
  ok: boolean;
  errors: string[];
}

function commandTarget(command: ProjectCommand): string | null {
  if (command.type === 'node.create') return null;
  if (command.type === 'dependency.add' || command.type === 'dependency.remove') return command.dependent;
  return command.id;
}

function validateNodeStep(step: AutopilotStep, nodeIds: Set<string>, errors: string[]) {
  if (step.type !== 'focusNode' && step.type !== 'dragNode' && step.type !== 'previewImpact') return;
  if (!nodeIds.has(step.nodeId)) errors.push(`${step.id}: unknown node ${step.nodeId}`);
}

export function validateAutopilotPlan(plan: AutopilotPlan, snapshot: ProjectGraphSnapshot): AutopilotValidationResult {
  const errors: string[] = [];
  const nodeIds = new Set(snapshot.nodes.map((node) => node.id));
  const stepIds = new Set<string>();

  if (plan.schemaVersion !== 1) errors.push('unsupported autopilot plan schema');
  if (!plan.planId.trim()) errors.push('planId is required');
  if (!plan.title.trim()) errors.push('plan title is required');
  if (plan.expectedProjectRevision !== snapshot.projectRevision) {
    errors.push(`plan revision ${plan.expectedProjectRevision} does not match live revision ${snapshot.projectRevision}`);
  }
  if (plan.steps.length === 0) errors.push('plan must contain at least one step');
  if (plan.steps.length > MAX_STEPS) errors.push(`plan exceeds ${MAX_STEPS} steps`);

  for (const step of plan.steps) {
    if (!step.id.trim()) errors.push('every autopilot step requires an id');
    if (stepIds.has(step.id)) errors.push(`duplicate autopilot step id ${step.id}`);
    stepIds.add(step.id);
    validateNodeStep(step, nodeIds, errors);

    if (step.type === 'dragNode') {
      if (!Number.isFinite(step.to.x) || !Number.isFinite(step.to.y)) {
        errors.push(`${step.id}: drag coordinates must be finite`);
      }
      if (Math.abs(step.to.x) > MAX_COORDINATE || Math.abs(step.to.y) > MAX_COORDINATE) {
        errors.push(`${step.id}: drag coordinates exceed workspace safety bounds`);
      }
      if (step.durationMs !== undefined && (!Number.isFinite(step.durationMs) || step.durationMs < 120 || step.durationMs > 4_000)) {
        errors.push(`${step.id}: drag duration must be between 120 and 4000 ms`);
      }
    }

    if (step.type === 'wait') {
      if (!Number.isFinite(step.durationMs) || step.durationMs < 0 || step.durationMs > MAX_WAIT_MS) {
        errors.push(`${step.id}: wait exceeds bounded execution time`);
      }
    }

    if (step.type === 'announce' && step.holdMs !== undefined) {
      if (!Number.isFinite(step.holdMs) || step.holdMs < 0 || step.holdMs > MAX_WAIT_MS) {
        errors.push(`${step.id}: announcement hold exceeds bounded execution time`);
      }
    }

    if (step.type === 'applyCommands') {
      if (plan.mode === 'assist') errors.push(`${step.id}: assist mode cannot mutate semantic project state`);
      if (!step.reason.trim()) errors.push(`${step.id}: semantic mutation requires a reason`);
      if (step.commands.length === 0) errors.push(`${step.id}: applyCommands requires at least one command`);
      if (step.commands.length > MAX_COMMANDS_PER_STEP) errors.push(`${step.id}: too many commands in one native transaction`);

      for (const command of step.commands) {
        const target = commandTarget(command);
        if (target !== null && !nodeIds.has(target)) errors.push(`${step.id}: command targets unknown node ${target}`);
        if (command.type === 'dependency.add' || command.type === 'dependency.remove') {
          if (!nodeIds.has(command.dependency)) errors.push(`${step.id}: dependency endpoint ${command.dependency} is unknown`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
