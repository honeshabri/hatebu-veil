(() => {
  const adapter = globalThis.HatebuVeilAdapter;
  const { isSensitive, normalizeBoundary, scoreToLevel } = globalThis.HatebuVeilPolicy;
  const MAX_BATCH = 10;
  const MAX_TEXT_LENGTH = 2000;
  let tracked = new WeakMap();
  const records = new Set();
  const queue = [];
  let enabled = false;
  let hasKey = false;
  let showScores = false;
  let filterBoundary = normalizeBoundary();
  let generation = 0;
  let running = 0;
  let scanTimer = null;
  let batchTimer = null;
  let nextId = 0;
  let statsScheduled = false;
  let lastStatsKey = "";

  function compactScore(scores) {
    return `💢${scoreToLevel(scores.hostility)}　💡${scoreToLevel(scores.usefulness)}`;
  }

  function detailedScore(scores) {
    return `💢 攻撃性 ${scoreToLevel(scores.hostility)}　💡 有益さ ${scoreToLevel(scores.usefulness)}`;
  }

  function pageStats() {
    const current = [...records].filter(record =>
      record.element.isConnected && tracked.get(record.element) === record
    );
    return {
      status: "ok",
      judged: current.filter(record => record.scores !== null).length,
      hidden: current.filter(record => record.scores && !record.revealed &&
        isSensitive(record.scores.hostility, record.scores.usefulness, filterBoundary)).length,
      exploded: current.filter(record => record.exploded).length
    };
  }

  function scheduleStats() {
    if (statsScheduled) return;
    statsScheduled = true;
    queueMicrotask(() => {
      statsScheduled = false;
      const { judged, hidden, exploded } = pageStats();
      const key = `${judged}:${hidden}:${exploded}`;
      if (key === lastStatsKey) return;
      lastStatsKey = key;
      void chrome.runtime.sendMessage({ type: "PAGE_STATS_UPDATED" }).catch(() => {});
    });
  }

  function renderScore(record) {
    if (!record.scoreBadge) return;
    const visible = showScores && record.scores && record.noticeType !== "sensitive";
    record.scoreBadge.hidden = !visible;
    record.action.hidden = record.noticeType === "exploded";
    if (visible) {
      record.scoreBadge.textContent = compactScore(record.scores);
      record.scoreBadge.title = detailedScore(record.scores);
    }
  }

  function removeNotice(record) {
    record.notice?.remove();
    record.notice = null;
    record.noticeType = null;
    record.element.classList.remove("hatebu-veil-hidden");
    renderScore(record);
    scheduleStats();
  }

  function showNotice(record, type) {
    if (!record.element.isConnected) return;
    removeNotice(record);
    const notice = document.createElement("div");
    notice.className = "hatebu-veil-notice hatebu-veil-notice-" + type;
    const title = document.createElement("strong");
    title.textContent = type === "exploded" ? "💥 爆破済み" : "⚠ センシティブなコメントです";
    const description = document.createElement("span");
    description.textContent = "Hatebu Veilによって非表示になっています。";
    const score = document.createElement("span");
    score.className = "hatebu-veil-notice-score";
    if (showScores && record.scores && type === "sensitive") {
      score.textContent = detailedScore(record.scores);
      score.title = detailedScore(record.scores);
    }
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = type === "exploded" ? "戻す" : "表示する";
    button.addEventListener("click", () => {
      record.exploded = false;
      record.revealed = true;
      record.manualTouched = true;
      removeNotice(record);
      renderScore(record);
    }, { once: true });
    if (type === "sensitive") {
      notice.append(title);
      if (score.textContent) notice.append(score);
      notice.append(description, button);
    } else {
      notice.append(title, button);
    }
    record.element.after(notice);
    record.element.classList.add("hatebu-veil-hidden");
    record.notice = notice;
    record.noticeType = type;
    renderScore(record);
    scheduleStats();
  }

  function applyVisibility(record) {
    if (record.exploded) {
      if (record.animating) return;
      if (record.noticeType !== "exploded") showNotice(record, "exploded");
      return;
    }
    if (record.revealed || !record.scores) return;
    if (isSensitive(record.scores.hostility, record.scores.usefulness, filterBoundary)) {
      if (record.noticeType !== "sensitive") showNotice(record, "sensitive");
    } else if (record.noticeType === "sensitive") {
      removeNotice(record);
    }
    renderScore(record);
  }

  function createAction(record) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "hatebu-veil-explode";
    button.textContent = "💣";
    button.title = "このコメントを爆破";
    button.setAttribute("aria-label", "このコメントを爆破");
    button.addEventListener("click", async event => {
      event.stopPropagation();
      if (record.exploded || button.disabled) return;
      button.disabled = true;
      button.textContent = "💥";
      try {
        const response = await chrome.runtime.sendMessage({
          type: "RECORD_EXPLOSION",
          comment: { text: record.text, commentId: record.commentId, ...record.scores }
        });
        if (response?.status !== "ok") throw new Error("履歴を保存できませんでした");
        if (!enabled || tracked.get(record.element) !== record) return;
        record.exploded = true;
        record.revealed = false;
        record.manualTouched = true;
        record.animating = true;
        scheduleStats();
        if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
          record.element.classList.add("hatebu-veil-exploding");
          await new Promise(resolve => setTimeout(resolve, 380));
          record.element.classList.remove("hatebu-veil-exploding");
        }
        record.animating = false;
        if (!enabled || tracked.get(record.element) !== record) return;
        showNotice(record, "exploded");
      } catch {
        button.title = "履歴を保存できませんでした。再度お試しください";
        record.element.classList.remove("hatebu-veil-exploding");
        record.exploded = false;
        record.animating = false;
      } finally {
        button.textContent = "💣";
        button.disabled = false;
      }
    });
    record.actionTarget.insertBefore(button, record.actionBefore);
    record.action = button;
    const scoreBadge = document.createElement("span");
    scoreBadge.className = "hatebu-veil-score";
    scoreBadge.hidden = true;
    record.actionTarget.insertBefore(scoreBadge, button);
    record.scoreBadge = scoreBadge;
  }

  async function restoreExploded(newRecords) {
    for (let index = 0; index < newRecords.length; index += MAX_BATCH) {
      const batch = newRecords.slice(index, index + MAX_BATCH);
      try {
        const response = await chrome.runtime.sendMessage({
          type: "LOOKUP_FEEDBACK",
          comments: batch.map(record => ({ id: record.id, text: record.text, commentId: record.commentId }))
        });
        if (response?.status !== "ok") continue;
        const exploded = new Set(response.exploded);
        for (const record of batch) {
          if (!exploded.has(record.id) || record.manualTouched ||
              tracked.get(record.element) !== record || !record.element.isConnected) continue;
          record.exploded = true;
          showNotice(record, "exploded");
          scheduleStats();
        }
      } catch {
        // The manual action remains available if history cannot be read.
      }
    }
  }

  function scan(root = document) {
    if (!enabled) return;
    const newRecords = [];
    for (const record of records) {
      if (record.element.isConnected) continue;
      removeNotice(record);
      record.action.remove();
      record.scoreBadge?.remove();
      tracked.delete(record.element);
      records.delete(record);
      scheduleStats();
    }
    for (const element of adapter.find(root)) {
      const item = adapter.extract(element);
      if (!item) continue;
      const previous = tracked.get(element);
      if (previous?.text === item.text && previous.generation === generation) continue;
      if (previous?.text === item.text) {
        previous.generation = generation;
        previous.revealed = false;
        applyVisibility(previous);
        if (enabled && hasKey && !previous.scores && item.text.length <= MAX_TEXT_LENGTH) {
          queue.push(previous);
        }
        continue;
      }
      if (previous) {
        removeNotice(previous);
        previous.action.remove();
        previous.scoreBadge?.remove();
        records.delete(previous);
      }
      const record = {
        ...item, id: String(++nextId), generation,
        notice: null, noticeType: null, scores: null, scoreBadge: null, animating: false,
        exploded: false, revealed: false,
        manualTouched: false, action: null
      };
      tracked.set(element, record);
      records.add(record);
      newRecords.push(record);
      createAction(record);
      if (record.exploded) showNotice(record, "exploded");
      if (enabled && hasKey && item.text.length <= MAX_TEXT_LENGTH) queue.push(record);
    }
    if (newRecords.length) void restoreExploded(newRecords);
    if (newRecords.length) scheduleStats();
    scheduleBatch();
  }

  function scheduleBatch() {
    if (!enabled || !hasKey || batchTimer || running >= 2 || !queue.length) return;
    batchTimer = setTimeout(() => {
      batchTimer = null;
      void drain();
    }, 80);
  }

  async function drain() {
    if (!enabled || !hasKey || running >= 2 || !queue.length) return;
    const batch = queue.splice(0, MAX_BATCH).filter(record =>
      record.generation === generation && record.element.isConnected &&
      tracked.get(record.element) === record
    );
    if (!batch.length) {
      scheduleBatch();
      return;
    }
    running++;
    const batchGeneration = generation;
    try {
      const comments = batch.map(record => ({
        id: record.id, text: record.text, commentId: record.commentId
      }));
      const applyResults = results => {
        if (!enabled || !hasKey || batchGeneration !== generation) return;
        const byId = new Map(results.map(result => [result.id, result]));
        const seen = [];
        for (const record of batch) {
          if (tracked.get(record.element) !== record || !record.element.isConnected) continue;
          if (record.element.textContent?.trim() !== record.text) continue;
          const result = byId.get(record.id);
          if (!result) continue;
          record.scores = { hostility: result.hostility, usefulness: result.usefulness };
          scheduleStats();
          seen.push({ text: record.text, commentId: record.commentId, ...record.scores });
          if (record.exploded && record.noticeType === "exploded" && showScores) {
            showNotice(record, "exploded");
          } else {
            applyVisibility(record);
          }
        }
        if (seen.length) {
          void chrome.runtime.sendMessage({ type: "RECORD_SEEN", comments: seen }).catch(() => {});
        }
      };
      const lookup = await chrome.runtime.sendMessage({ type: "LOOKUP_CACHE", comments });
      if (lookup?.status !== "ok") return;
      applyResults(lookup.results);
      const missing = new Set(lookup.missing);
      if (!missing.size || batchGeneration !== generation) return;
      const response = await chrome.runtime.sendMessage({
        type: "CLASSIFY", comments: comments.filter(comment => missing.has(comment.id))
      });
      if (response?.status === "ok") applyResults(response.results);
    } catch {
      // A failed or interrupted classification leaves the original comment visible.
    } finally {
      running--;
      scheduleBatch();
    }
  }

  function updateStatus(status) {
    const nextShowScores = status.showScores === true;
    const nextBoundary = normalizeBoundary(status.filterBoundary);
    const scoreDisplayChanged = showScores !== nextShowScores;
    const filterChanged = Boolean(status.filterChanged) ||
      nextBoundary.some((value, index) => value !== filterBoundary[index]);
    const changed = enabled !== Boolean(status.enabled) || hasKey !== Boolean(status.hasKey) ||
      filterChanged;
    enabled = Boolean(status.enabled);
    hasKey = Boolean(status.hasKey);
    showScores = nextShowScores;
    filterBoundary = nextBoundary;
    if (scoreDisplayChanged && !changed) {
      for (const record of records) {
        if (record.noticeType) showNotice(record, record.noticeType);
        else renderScore(record);
      }
    }
    if (!changed) return;
    generation++;
    clearTimeout(batchTimer);
    batchTimer = null;
    queue.length = 0;
    if (!enabled) {
      for (const record of records) {
        removeNotice(record);
        record.action.remove();
        record.scoreBadge?.remove();
      }
      records.clear();
      tracked = new WeakMap();
      scheduleStats();
      return;
    }
    for (const record of records) {
      if (!record.element.isConnected) {
        records.delete(record);
        continue;
      }
      if (filterChanged && record.scores) applyVisibility(record);
      if (scoreDisplayChanged) {
        if (record.noticeType) showNotice(record, record.noticeType);
        else renderScore(record);
      }
    }
    scan();
    scheduleStats();
  }

  new MutationObserver(mutations => {
    if (scanTimer) return;
    if (!mutations.some(mutation => {
      if (mutation.type === "characterData") {
        return mutation.target.parentElement?.closest(adapter.selector);
      }
      if (mutation.target instanceof Element && mutation.target.closest(adapter.selector)) return true;
      return [...mutation.addedNodes, ...mutation.removedNodes].some(node =>
        node instanceof Element &&
        (node.matches(adapter.selector) || Boolean(node.querySelector(adapter.selector)))
      );
    })) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, 60);
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "STATUS_CHANGED") updateStatus(message);
    if (message?.type === "GET_PAGE_STATS") {
      sendResponse(pageStats());
      return false;
    }
  });

  scan();
  chrome.runtime.sendMessage({ type: "GET_STATUS" }).then(response => {
    if (response?.status === "ok") updateStatus(response);
  }).catch(() => {});
})();
