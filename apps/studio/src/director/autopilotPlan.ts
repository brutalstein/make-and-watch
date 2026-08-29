import type { ProjectGraphSnapshot } from '@makewatch/contracts';

import { defaultWorkflowPositions, type WorkflowPositions } from '../workflowLayout';
import type { AutopilotPlan, AutopilotStep } from './autopilotTypes';

const MAX_DRAGS_PER_PASS = 120;

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
  // Camera follow keeps the held node under the cursor, so long cross-canvas
  // movement should not translate into equally long presentation time.
  return Math.round(clamp(360 + distanceUnits * 0.20, 440, 820));
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
      message: 'I’ll find each displaced node, grab it, place it in dependency order, and return control.',
      holdMs: 260,
    },
  ];

  const allCandidates = snapshot.nodes
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
  const candidates = allCandidates.slice(0, MAX_DRAGS_PER_PASS);

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

  const remaining = allCandidates.length - candidates.length;
  steps.push({
    id: 'announce.finish',
    type: 'announce',
    message: candidates.length > 0
      ? remaining > 0
        ? `Workspace pass complete. ${candidates.length} displaced nodes were placed safely; ${remaining} remain for the next bounded pass.`
        : `Workspace pass complete. ${candidates.length} displaced node${candidates.length === 1 ? '' : 's'} were placed individually without changing semantic project state.`
      : 'Workspace pass complete. The graph was already organized, so I only inspected its structure.',
    holdMs: 240,
  });

  return {
    schemaVersion: 1,
    planId: `workspace-r${snapshot.projectRevision}-n${candidates.length}`,
    title: 'AI Workspace Drive',
    summary: remaining > 0
      ? `The AI Director is organizing a bounded batch of ${candidates.length} displaced workflow nodes while native project truth remains protected.`
      : 'The AI Director is physically organizing each displaced workflow node while native project truth remains protected.',
    mode: 'assist',
    provider: 'demo',
    expectedProjectRevision: snapshot.projectRevision,
    steps,
  };
}
