import { DEV_SEED_COMMANDS } from './dev-seed.mjs';

const nodes = new Map();

function fail(index, message) {
  throw new Error(`development seed command ${index + 1}: ${message}`);
}

for (const [index, command] of DEV_SEED_COMMANDS.entries()) {
  switch (command.type) {
    case 'node.create': {
      const { id } = command.node;
      if (!id) fail(index, 'node.create requires an id');
      if (nodes.has(id)) fail(index, `duplicate node.create for ${id}`);
      if (command.node.locked === true) {
        fail(index, `${id} is created locked; seed topology must be completed before locks are applied`);
      }
      nodes.set(id, { locked: false });
      break;
    }
    case 'node.lock': {
      const node = nodes.get(command.id);
      if (!node) fail(index, `node.lock references missing node ${command.id}`);
      node.locked = command.locked;
      break;
    }
    case 'dependency.add':
    case 'dependency.remove': {
      const dependent = nodes.get(command.dependent);
      const dependency = nodes.get(command.dependency);
      if (!dependent || !dependency) {
        fail(index, `${command.type} references an endpoint before node creation`);
      }
      if (dependent.locked) {
        fail(index, `${command.dependent} is locked before dependency topology is complete`);
      }
      break;
    }
    default:
      break;
  }
}

for (const expectedLocked of ['character.mira', 'scene.01']) {
  if (!nodes.get(expectedLocked)?.locked) {
    throw new Error(`development seed must finish with ${expectedLocked} locked`);
  }
}

console.log('[seed-check] development seed respects native lock/topology invariants');
