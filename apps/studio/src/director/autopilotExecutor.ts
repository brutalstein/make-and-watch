import type { ImpactReport, ProjectCommand } from '@makewatch/contracts';

import { AutopilotCancelledError, AutopilotExecutionControl, controlledDelay } from './autopilotControl';
import type { AutopilotPlan, AutopilotStep, AutopilotUiState } from './autopilotTypes';

class AutopilotStepTimeoutError extends Error {
  constructor(stepId: string, timeoutMs: number) {
    super(`autopilot step ${stepId} exceeded ${timeoutMs} ms execution budget`);
    this.name = 'AutopilotStepTimeoutError';
  }
}

export interface AutopilotRuntime {
  announce(message: string): void;
  focusNode(nodeId: string, zoom?: number): Promise<void>;
  dragNode(nodeId: string, to: { x: number; y: number }, durationMs: number, label: string): Promise<void>;
  previewImpact(nodeId: string): Promise<ImpactReport>;
  arrangeWorkflow(): Promise<void>;
  fitWorkflow(): Promise<void>;
  applyCommands(commands: ProjectCommand[], context: { planId: string; reason: string }): Promise<void>;
  checkpoint(message: string): Promise<boolean>;
  setUiState(next: AutopilotUiState): void;
}

function stepActivity(step: AutopilotStep) {
  if (step.label) return step.label;
  switch (step.type) {
    case 'announce': return step.message;
    case 'focusNode': return `Inspecting ${step.nodeId}`;
    case 'dragNode': return `Repositioning ${step.nodeId}`;
    case 'previewImpact': return `Checking downstream impact for ${step.nodeId}`;
    case 'arrangeWorkflow': return 'Organizing workflow';
    case 'fitWorkflow': return 'Framing the production graph';
    case 'applyCommands': return step.reason;
    case 'checkpoint': return step.message;
    case 'wait': return 'Reviewing the current state';
  }
}

function presentationDeadlineMs(step: AutopilotStep) {
  switch (step.type) {
    case 'dragNode': return 30_000;
    case 'focusNode': return 24_000;
    case 'previewImpact': return 24_000;
    case 'arrangeWorkflow': return 14_000;
    case 'fitWorkflow': return 14_000;
    default: return 10_000;
  }
}

async function runBoundedPresentationStep(
  step: AutopilotStep,
  control: AutopilotExecutionControl,
  action: () => Promise<void>,
) {
  const deadlineMs = presentationDeadlineMs(step);
  let timeoutId = 0;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(
      () => reject(new AutopilotStepTimeoutError(step.id, deadlineMs)),
      deadlineMs,
    );
  });

  try {
    await Promise.race([action(), timeout]);
  } catch (error) {
    if (error instanceof AutopilotStepTimeoutError) control.cancel();
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export async function executeAutopilotPlan(
  plan: AutopilotPlan,
  runtime: AutopilotRuntime,
  control: AutopilotExecutionControl,
) {
  const base = {
    planId: plan.planId,
    title: plan.title,
    stepCount: plan.steps.length,
    error: null,
  } as const;

  runtime.setUiState({
    ...base,
    status: 'executing',
    stepIndex: 0,
    activity: plan.summary,
  });

  try {
    for (let index = 0; index < plan.steps.length; index += 1) {
      await control.checkpoint();
      const step = plan.steps[index];
      if (!step) continue;
      const activity = stepActivity(step);

      runtime.setUiState({
        ...base,
        status: control.isPaused ? 'paused' : 'executing',
        stepIndex: index + 1,
        activity,
      });

      switch (step.type) {
        case 'announce':
          runtime.announce(step.message);
          await controlledDelay(control, step.holdMs ?? 650);
          break;
        case 'focusNode':
          await runBoundedPresentationStep(step, control, () => runtime.focusNode(step.nodeId, step.zoom));
          break;
        case 'dragNode':
          await runBoundedPresentationStep(step, control, () => runtime.dragNode(step.nodeId, step.to, step.durationMs ?? 980, activity));
          break;
        case 'previewImpact':
          await runBoundedPresentationStep(step, control, async () => {
            await runtime.previewImpact(step.nodeId);
          });
          break;
        case 'arrangeWorkflow':
          await runBoundedPresentationStep(step, control, runtime.arrangeWorkflow);
          break;
        case 'fitWorkflow':
          await runBoundedPresentationStep(step, control, runtime.fitWorkflow);
          break;
        case 'applyCommands':
          // Semantic commits are authoritative transactions. Do not add a
          // second UI-only race timeout that could report failure while a
          // native commit is still completing. Transport/native correlation
          // and timeout policy own this boundary.
          await runtime.applyCommands(step.commands, {
            planId: plan.planId,
            reason: step.reason,
          });
          break;
        case 'checkpoint': {
          runtime.setUiState({
            ...base,
            status: 'waiting_approval',
            stepIndex: index + 1,
            activity,
          });
          const approved = await runtime.checkpoint(step.message);
          if (!approved) throw new AutopilotCancelledError();
          break;
        }
        case 'wait':
          await controlledDelay(control, step.durationMs);
          break;
      }
    }

    await control.checkpoint();
    runtime.setUiState({
      ...base,
      status: 'completed',
      stepIndex: plan.steps.length,
      activity: 'Workflow pass complete · returning control',
    });
  } catch (error) {
    if (error instanceof AutopilotStepTimeoutError) {
      runtime.setUiState({
        ...base,
        status: 'failed',
        stepIndex: 0,
        activity: 'AI Director stopped a stalled presentation step safely',
        error: error.message,
      });
      throw error;
    }

    if (error instanceof AutopilotCancelledError || control.signal.aborted) {
      runtime.setUiState({
        ...base,
        status: 'cancelled',
        stepIndex: 0,
        activity: 'Control returned to you',
      });
      return;
    }

    runtime.setUiState({
      ...base,
      status: 'failed',
      stepIndex: 0,
      activity: 'AI Director stopped safely',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
