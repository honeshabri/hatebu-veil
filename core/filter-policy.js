// Chrome content scripts load this file before the site adapter.
const HATEBU_VEIL_DEFAULT_BOUNDARY = Object.freeze([-1, -1, -1, 2, 2, 5]);

function normalizeBoundary(boundary) {
  if (!Array.isArray(boundary) || boundary.length !== 6) {
    return [...HATEBU_VEIL_DEFAULT_BOUNDARY];
  }

  const normalized = [];
  let previous = -1;
  for (let hostility = 0; hostility <= 5; hostility++) {
    const raw = Number.isInteger(boundary[hostility])
      ? boundary[hostility]
      : HATEBU_VEIL_DEFAULT_BOUNDARY[hostility];
    const clamped = Math.max(-1, Math.min(5, raw));
    const value = Math.max(previous, clamped);
    normalized.push(value);
    previous = value;
  }
  return normalized;
}

function scoreToLevel(score) {
  if (!Number.isFinite(score) || score < 0 || score > 5) return null;
  return Math.round(score);
}

function isSensitive(hostility, usefulness, boundary = HATEBU_VEIL_DEFAULT_BOUNDARY) {
  const hostilityLevel = scoreToLevel(hostility);
  const usefulnessLevel = scoreToLevel(usefulness);
  if (hostilityLevel === null || usefulnessLevel === null) return false;

  const normalized = normalizeBoundary(boundary);
  return usefulnessLevel <= normalized[hostilityLevel];
}

globalThis.HatebuVeilPolicy = {
  isSensitive,
  defaultBoundary: HATEBU_VEIL_DEFAULT_BOUNDARY,
  normalizeBoundary,
  scoreToLevel
};
