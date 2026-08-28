import type { ImpactReport, ProjectCommand } from '@makewatch/contracts';

import { AutopilotCancelledError, AutopilotExecutionControl, controlledDelay } from './autopilotControl';
import type { AutopilotPlan, AutopilotStep, AutopilotUiState } from './autopilotTypes';

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
          await runtime.focusNode(step.nodeId, step.zoom);
          break;
        case 'dragNode':
          await runtime.dragNode(step.nodeId, step.to, step.durationMs ?? 680, activity);
          break;
        case 'previewImpact':
          await runtime.previewImpact(step.nodeId);
          break;
        case 'arrangeWorkflow':
          await runtime.arrangeWorkflow();
          break;
        case 'fitWorkflow':
          await runtime.fitWorkflow();
          break;
        case 'applyCommands':
          await runtime.applyCommands(step.commands, { planId: plan.planId, reason: step.reason });
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

    runtime.setUiState({
      ...base,
      status: 'completed',
      stepIndex: plan.steps.length,
      activity: 'AI Director finished the workflow pass',
    });
  } catch (error) {
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
