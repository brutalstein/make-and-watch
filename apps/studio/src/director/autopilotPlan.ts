import type { ProjectGraphSnapshot } from '@makewatch/contracts';

import { defaultWorkflowPositions, type WorkflowPositions } from '../workflowLayout';
import type { AutopilotPlan, AutopilotStep } from './autopilotTypes';

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

function deterministicTextCompare(left: string, right: string) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function dragDurationMs(distanceUnits: number) {
  return Math.round(clamp(900 + distanceUnits * 0.46, 980, 1800));
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
      message: 'I’ll find every displaced workflow node, pick it up visibly, place it in dependency order, and hand control back.',
      holdMs: 720,
    },
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
      return rightDistance - leftDistance || deterministicTextCompare(left.node.id, right.node.id);
    });

  for (const [index, entry] of candidates.entries()) {
    if (!entry.from || !entry.to) continue;
    const travel = distance(entry.from, entry.to);
    steps.push({
      id: `drag.${index}.${entry.node.id}`,
      type: 'dragNode',
      nodeId: entry.node.id,
      to: entry.to,
      durationMs: dragDurationMs(travel),
      label: `Placing ${entry.node.title}`,
    });
    if (index + 1 < candidates.length) {
      steps.push({
        id: `wait.after.${index}`,
        type: 'wait',
        durationMs: 150,
        label: 'Checking the placement',
      });
    }
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
      ? `Workspace pass complete. ${candidates.length} displaced node${candidates.length === 1 ? '' : 's'} were found and placed individually without changing semantic project state.`
      : 'Workspace pass complete. The graph was already organized, so I only inspected its structure.',
    holdMs: 620,
  });

  return {
    schemaVersion: 1,
    planId: `workspace-r${snapshot.projectRevision}-n${candidates.length}`,
    title: 'AI Workspace Drive',
    summary: 'The AI Director is physically organizing each displaced workflow node while native project truth remains protected.',
    mode: 'assist',
    provider: 'demo',
    expectedProjectRevision: snapshot.projectRevision,
    steps,
  };
}
