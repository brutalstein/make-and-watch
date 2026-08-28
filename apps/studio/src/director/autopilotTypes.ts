import type { ProjectCommand } from '@makewatch/contracts';

export type AutopilotMode = 'assist' | 'guided' | 'director';

export type AutopilotStatus =
  | 'idle'
  | 'planning'
  | 'executing'
  | 'paused'
  | 'waiting_approval'
  | 'completed'
  | 'cancelled'
  | 'failed';

export type AutopilotProvider = 'demo' | 'claude' | 'codex';

interface StepBase {
  id: string;
  label?: string;
}

export type AutopilotStep =
  | (StepBase & { type: 'announce'; message: string; holdMs?: number })
  | (StepBase & { type: 'focusNode'; nodeId: string; zoom?: number })
  | (StepBase & { type: 'dragNode'; nodeId: string; to: { x: number; y: number }; durationMs?: number })
  | (StepBase & { type: 'previewImpact'; nodeId: string })
  | (StepBase & { type: 'arrangeWorkflow' })
  | (StepBase & { type: 'fitWorkflow' })
  | (StepBase & { type: 'applyCommands'; commands: ProjectCommand[]; reason: string })
  | (StepBase & { type: 'checkpoint'; message: string })
  | (StepBase & { type: 'wait'; durationMs: number });

export interface AutopilotPlan {
  schemaVersion: 1;
  planId: string;
  title: string;
  summary: string;
  mode: AutopilotMode;
  provider: AutopilotProvider;
  expectedProjectRevision: number;
  steps: AutopilotStep[];
}

export interface CursorVisualState {
  visible: boolean;
  x: number;
  y: number;
  pressed: boolean;
  pulse: number;
  label: string;
}

export interface AutopilotUiState {
  status: AutopilotStatus;
  planId: string | null;
  title: string;
  stepIndex: number;
  stepCount: number;
  activity: string;
  error: string | null;
}

export const IDLE_AUTOPILOT_STATE: AutopilotUiState = {
  status: 'idle',
  planId: null,
  title: '',
  stepIndex: 0,
  stepCount: 0,
  activity: '',
  error: null,
};
