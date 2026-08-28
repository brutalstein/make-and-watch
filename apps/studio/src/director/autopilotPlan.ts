import type { ProjectGraphSnapshot } from '@makewatch/contracts';

import { defaultWorkflowPositions, type WorkflowPositions } from '../workflowLayout';
import type { AutopilotPlan, AutopilotStep } from './autopilotTypes';

const MAX_VISIBLE_DRAGS = 5;

function distance(left: { x: number; y: number }, right: { x: number; y: number }) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function kindWeight(kind: string) {
  if (kind === 'series') return 0;
  if (kind === 'episode') return 1;
  if (kind === 'character' || kind === 'location') return 2;
  if (kind === 'scene') return 3;
  if (kind === 'shot') return 4;
  return 5;
}

function dragDurationMs(distanceUnits: number) {
  // Layout-space distance produces deterministic pacing regardless of monitor
  // refresh rate. Very short drags still read as intentional; long drags do not
  // race across the workflow faster than the user can visually follow.
  return Math.round(clamp(760 + distanceUnits * 0.42, 820, 1500));
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
      message: 'I’ll read the workflow, organize the important areas, and hand control back when the pass is complete.',
      holdMs: 760,
    },
    { id: 'fit.before', type: 'fitWorkflow', label: 'Scanning the full production graph' },
    { id: 'wait.scan', type: 'wait', durationMs: 320, label: 'Reading workflow structure' },
  ];

  const candidates = snapshot.nodes
    .map((node) => ({
      node,
      from: currentPositions[node.id],
      to: defaults[node.id],
    }))
    .filter((entry) => entry.from && entry.to && distance(entry.from, entry.to) > 18)
    .sort((left, right) => {
      const semanticOrder = kindWeight(left.node.kind) - kindWeight(right.node.kind);
      if (semanticOrder !== 0) return semanticOrder;
      const leftDistance = left.from && left.to ? distance(left.from, left.to) : 0;
      const rightDistance = right.from && right.to ? distance(right.from, right.to) : 0;
      return rightDistance - leftDistance || left.node.title.localeCompare(right.node.title);
    });

  const visibleCandidates = candidates.slice(0, MAX_VISIBLE_DRAGS);
  for (const [index, entry] of visibleCandidates.entries()) {
    if (!entry.from || !entry.to) continue;
    const travel = distance(entry.from, entry.to);
    steps.push({
      id: `drag.${index}.${entry.node.id}`,
      type: 'dragNode',
      nodeId: entry.node.id,
      to: entry.to,
      durationMs: dragDurationMs(travel),
      label: `Finding and placing ${entry.node.title}`,
    });

    if ((index + 1) % 2 === 0 && index + 1 < visibleCandidates.length) {
      steps.push(
        { id: `wait.breathe.${index}`, type: 'wait', durationMs: 180, label: 'Checking the composition' },
        {
          id: `fit.rescan.${index}`,
          type: 'fitWorkflow',
          label: 'Reframing the workflow before continuing',
        },
      );
    }
  }

  if (candidates.length > visibleCandidates.length) {
    const remaining = candidates.length - visibleCandidates.length;
    steps.push(
      {
        id: 'announce.bulk-settle',
        type: 'announce',
        message: `${remaining} additional workspace items follow the same dependency layout. I’ll settle those together instead of wasting your time with repetitive cursor motion.`,
        holdMs: 520,
      },
      {
        id: 'arrange.remaining',
        type: 'arrangeWorkflow',
        label: 'Settling the remaining dependency layout',
      },
    );
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
        zoom: 1.02,
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

  steps.push({
    id: 'announce.finish',
    type: 'announce',
    message: candidates.length > 0
      ? 'Workspace pass complete. The layout is organized and semantic project state was not changed.'
      : 'Workspace pass complete. The graph was already organized, so I only inspected its structure.',
    holdMs: 680,
  });

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
