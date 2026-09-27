// Shared feedback accounting. Storage and site-specific extraction live elsewhere.
const FEEDBACK_SIZE = 6;

function emptyStats() {
  return { cells: Array.from({ length: FEEDBACK_SIZE ** 2 }, () => ({ seenCount: 0, explodedCount: 0 })) };
}

function normalizeStats(value) {
  const stats = emptyStats();
  if (!Array.isArray(value?.cells)) return stats;
  value.cells.slice(0, stats.cells.length).forEach((cell, index) => {
    for (const key of ["seenCount", "explodedCount"]) {
      if (Number.isSafeInteger(cell?.[key]) && cell[key] >= 0) stats.cells[index][key] = cell[key];
    }
  });
  return stats;
}

function cellIndex(hostility, usefulness) {
  const h = globalThis.HatebuVeilPolicy.scoreToLevel(hostility);
  const u = globalThis.HatebuVeilPolicy.scoreToLevel(usefulness);
  return h === null || u === null ? null : h * FEEDBACK_SIZE + u;
}

function recordFeedback(previous, statsValue, event, details, now = Date.now()) {
  const stats = normalizeStats(statsValue);
  const entry = previous ? { ...previous } : {
    site: details.site,
    commentId: details.commentId || null,
    textHash: details.textHash,
    hostility: null,
    usefulness: null,
    seenAt: null,
    explodedAt: null
  };
  const oldCell = cellIndex(entry.hostility, entry.usefulness);
  const newCell = cellIndex(details.hostility, details.usefulness);
  if (oldCell === null && newCell !== null) {
    entry.hostility = details.hostility;
    entry.usefulness = details.usefulness;
  }
  const cell = cellIndex(entry.hostility, entry.usefulness);
  let changed = !previous;
  if (oldCell === null && cell !== null && entry.explodedAt && !entry.seenAt) {
    entry.seenAt = now;
    stats.cells[cell].seenCount++;
    stats.cells[cell].explodedCount++;
    changed = true;
  }
  if (event === "seen" && cell !== null && !entry.seenAt) {
    entry.seenAt = now;
    stats.cells[cell].seenCount++;
    if (entry.explodedAt) stats.cells[cell].explodedCount++;
    changed = true;
  }
  if (event === "exploded" && !entry.explodedAt) {
    entry.explodedAt = now;
    if (cell !== null) {
      if (!entry.seenAt) {
        entry.seenAt = now;
        stats.cells[cell].seenCount++;
      }
      stats.cells[cell].explodedCount++;
    }
    changed = true;
  }
  return { entry, stats, changed };
}

globalThis.HatebuVeilFeedback = { emptyStats, normalizeStats, cellIndex, recordFeedback };
