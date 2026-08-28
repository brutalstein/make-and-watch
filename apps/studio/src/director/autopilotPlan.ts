import type { ProjectGraphSnapshot } from '@makewatch/contracts';

import { defaultWorkflowPositions, type WorkflowPositions } from '../workflowLayout';
import type { AutopilotPlan, AutopilotStep } from './autopilotTypes';

function distance(left: { x: number; y: number }, right: { x: number; y: number }) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

export function buildWorkspaceAutopilotPlan(
  snapshot: ProjectGraphSnapshot,
  currentPositions: WorkflowPositions,
): AutopilotPlan {
  const defaults = defaultWorkflowPositions(snapshot);
  const steps: AutopilotStep[] = [
    {
      id: 'announce.start',
      type: 'announce',
      message: 'I’ll organize the workflow for you. You can watch every move and take control back at any time.',
      holdMs: 900,
    },
    { id: 'fit.before', type: 'fitWorkflow', label: 'Reading the full production graph' },
  ];

  const candidates = snapshot.nodes
    .map((node) => ({ node, from: currentPositions[node.id], to: defaults[node.id] }))
    .filter((entry) => entry.from && entry.to && distance(entry.from, entry.to) > 18)
    .sort((left, right) => {
      const kindWeight = (kind: string) => {
        if (kind === 'series') return 0;
        if (kind === 'episode') return 1;
        if (kind === 'character' || kind === 'location') return 2;
        if (kind === 'scene') return 3;
        if (kind === 'shot') return 4;
        return 5;
      };
      return kindWeight(left.node.kind) - kindWeight(right.node.kind) || left.node.title.localeCompare(right.node.title);
    });

  for (const [index, entry] of candidates.entries()) {
    if (!entry.from || !entry.to) continue;
    steps.push({
      id: `drag.${index}.${entry.node.id}`,
      type: 'dragNode',
      nodeId: entry.node.id,
      to: entry.to,
      durationMs: 560,
      label: `Placing ${entry.node.title}`,
    });
  }

  const reviewTarget = snapshot.nodes.find((node) => node.kind === 'scene' && node.approval === 'review')
    ?? snapshot.nodes.find((node) => node.kind === 'shot')
    ?? snapshot.nodes.find((node) => node.kind === 'scene');

  if (reviewTarget) {
    steps.push(
      {
        id: `focus.${reviewTarget.id}`,
        type: 'focusNode',
        nodeId: reviewTarget.id,
        zoom: 1.08,
        label: `Reviewing ${reviewTarget.title}`,
      },
      {
        id: `impact.${reviewTarget.id}`,
        type: 'previewImpact',
        nodeId: reviewTarget.id,
        label: `Checking what ${reviewTarget.title} influences`,
      },
    );
  }

  steps.push(
    {
      id: 'announce.finish',
      type: 'announce',
      message: candidates.length > 0
        ? 'The workspace is organized. Semantic project state was not changed.'
        : 'The workspace was already organized. I inspected the graph without changing semantic state.',
      holdMs: 850,
    },
    { id: 'fit.after', type: 'fitWorkflow', label: 'Finishing the workspace pass' },
  );

  return {
    schemaVersion: 1,
    planId: `workspace-${snapshot.projectRevision}-${Date.now()}`,
    title: 'AI Workspace Drive',
    summary: 'The AI Director is organizing the visual workflow while native project truth remains protected.',
    mode: 'assist',
    provider: 'demo',
    expectedProjectRevision: snapshot.projectRevision,
    steps,
  };
}
