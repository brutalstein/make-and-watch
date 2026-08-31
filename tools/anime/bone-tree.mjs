// One skeleton normalizer shared by the MotionClip contract and the CharacterRig
// contract so a clip's bones and the rig they retarget onto cannot drift apart.
// Deterministic: unique ids, exactly one root, acyclic, parents emitted before
// children. Returns `{ bones: ordered, ids: Set, root: rootId }`.

const BONE_ID = /^[a-z][a-z0-9_]*$/;
export const MAX_BONES = 64;

function invalid(message) {
  throw Object.assign(new Error(message), { code: 'invalid_argument' });
}
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`);
  return value;
}
function finiteNumber(value, label, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) invalid(`${label} must be a finite number in ${min}..${max}`);
  return n;
}
export function boneName(value, label) {
  const s = String(value ?? '');
  if (!BONE_ID.test(s) || s.length > 60) invalid(`${label} must match ${BONE_ID} and be <= 60 chars`);
  return s;
}

export function normalizeBoneTree(value, label) {
  const input = object(value, label);
  if (!Array.isArray(input.bones) || input.bones.length < 1 || input.bones.length > MAX_BONES) {
    invalid(`${label}.bones must contain 1..${MAX_BONES} bones`);
  }
  const bones = input.bones.map((raw, index) => {
    const bone = object(raw, `${label}.bones[${index}]`);
    const rest = object(bone.rest ?? {}, `${label}.bones[${index}].rest`);
    return {
      id: boneName(bone.id, `${label}.bones[${index}].id`),
      parent: bone.parent === undefined || bone.parent === null ? null : boneName(bone.parent, `${label}.bones[${index}].parent`),
      rest: {
        x: finiteNumber(rest.x ?? 0, `${label}.bones[${index}].rest.x`, -100000, 100000),
        y: finiteNumber(rest.y ?? 0, `${label}.bones[${index}].rest.y`, -100000, 100000),
        rot: finiteNumber(rest.rot ?? 0, `${label}.bones[${index}].rest.rot`, -3600, 3600),
        len: finiteNumber(rest.len ?? 0, `${label}.bones[${index}].rest.len`, 0, 100000),
      },
    };
  });

  const ids = bones.map((bone) => bone.id);
  if (new Set(ids).size !== ids.length) invalid(`${label} bone ids must be unique`);
  const idSet = new Set(ids);
  const roots = bones.filter((bone) => bone.parent === null);
  if (roots.length !== 1) invalid(`${label} must have exactly one root bone (parent: null)`);
  for (const bone of bones) {
    if (bone.parent !== null && !idSet.has(bone.parent)) invalid(`${label} bone ${bone.id} references missing parent ${bone.parent}`);
    if (bone.parent === bone.id) invalid(`${label} bone ${bone.id} cannot be its own parent`);
  }
  // acyclic: every bone must reach the root
  const parentOf = new Map(bones.map((bone) => [bone.id, bone.parent]));
  for (const start of ids) {
    let cursor = start;
    let hops = 0;
    while (cursor !== null) {
      cursor = parentOf.get(cursor) ?? null;
      if (++hops > bones.length) invalid(`${label} has a cycle through bone ${start}`);
    }
  }
  // topological order: parents before children, deterministic
  const ordered = [];
  const placed = new Set();
  while (ordered.length < bones.length) {
    const before = ordered.length;
    for (const bone of bones) {
      if (placed.has(bone.id)) continue;
      if (bone.parent === null || placed.has(bone.parent)) {
        ordered.push(bone);
        placed.add(bone.id);
      }
    }
    if (ordered.length === before) invalid(`${label} could not be ordered (disconnected or cyclic)`);
  }
  return { bones: ordered, ids: idSet, root: roots[0].id };
}
