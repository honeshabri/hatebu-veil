(() => {
  const { defaultBoundary, normalizeBoundary } = globalThis.HatebuVeilPolicy;

  const toggle = document.querySelector("#enabled-toggle");
  const scoreToggle = document.querySelector("#score-toggle");
  const pageStats = document.querySelector("#current-page-stats");
  const matrix = document.querySelector("#filter-matrix");
  const resetFilterButton = document.querySelector("#reset-filter");
  const resetFeedbackButton = document.querySelector("#reset-feedback");
  const keyInput = document.querySelector("#api-key");
  const saveKeyButton = document.querySelector("#save-key");
  const deleteKeyButton = document.querySelector("#delete-key");
  const keyStatus = document.querySelector("#key-status");
  const errorMessage = document.querySelector("#error-message");
  const noticeMessage = document.querySelector("#notice-message");

  const state = {
    enabled: true,
    showScores: false,
    filterBoundary: [...defaultBoundary],
    keyConfigured: false,
    feedbackCells: Array.from({ length: 36 }, () => ({ seenCount: 0, explodedCount: 0 })),
    currentTabId: null,
    pageStatsRevision: 0,
    pageStatsRefreshTimer: null,
    ready: false,
    busy: false,
  };

  const pageStatsError = "現在のページの件数を取得できません（ページを再読み込み）";

  function isHatenaEntryUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.hostname === "b.hatena.ne.jp" &&
        (url.pathname === "/entry" || url.pathname.startsWith("/entry/"));
    } catch {
      return false;
    }
  }

  async function refreshPageStats(expectedTabId = null) {
    const revision = ++state.pageStatsRevision;
    let tabs;
    try {
      tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    } catch {
      if (revision === state.pageStatsRevision) {
        state.currentTabId = null;
        pageStats.textContent = "現在のページ: 件数を確認できません";
      }
      return;
    }

    if (revision !== state.pageStatsRevision) return;
    const tab = tabs[0];
    if (expectedTabId !== null && tab?.id !== expectedTabId) return;
    state.currentTabId = tab?.id ?? null;

    if (!tab) {
      pageStats.textContent = "現在のページ: 確認できません";
      return;
    }
    if (!isHatenaEntryUrl(tab.url)) {
      pageStats.textContent = "現在のページ: はてなブックマークのエントリ対象外";
      return;
    }

    pageStats.textContent = "現在のページ: 件数を確認中…";
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: "GET_PAGE_STATS" });
      if (revision !== state.pageStatsRevision || state.currentTabId !== tab.id) return;
      const counts = [response?.judged, response?.hidden, response?.exploded];
      if (response?.status !== "ok" || !counts.every(value => Number.isFinite(value) && value >= 0)) {
        pageStats.textContent = pageStatsError;
        return;
      }
      const [judged, hidden, exploded] = counts.map(value => Math.floor(value));
      pageStats.textContent = `現在のページ: 判定済み ${judged}件・非表示 ${hidden}件・爆破 ${exploded}件`;
    } catch {
      if (revision === state.pageStatsRevision && state.currentTabId === tab.id) {
        pageStats.textContent = pageStatsError;
      }
    }
  }

  function queuePageStatsRefresh(expectedTabId = null) {
    clearTimeout(state.pageStatsRefreshTimer);
    state.pageStatsRefreshTimer = setTimeout(() => {
      state.pageStatsRefreshTimer = null;
      void refreshPageStats(expectedTabId);
    }, 100);
  }

  function showError(message) {
    errorMessage.textContent = message;
    errorMessage.hidden = false;
    noticeMessage.hidden = true;
  }

  function showNotice(message) {
    noticeMessage.textContent = message;
    noticeMessage.hidden = false;
    errorMessage.hidden = true;
  }

  function clearMessages() {
    errorMessage.hidden = true;
    noticeMessage.hidden = true;
  }

  function normalizeFeedbackStats(stats) {
    const cells = Array.isArray(stats?.cells) ? stats.cells : [];
    return Array.from({ length: 36 }, (_, index) => {
      const cell = cells[index];
      const seenCount = Number.isFinite(cell?.seenCount)
        ? Math.max(0, Math.floor(cell.seenCount))
        : 0;
      const explodedCount = Number.isFinite(cell?.explodedCount)
        ? Math.max(0, Math.floor(cell.explodedCount))
        : 0;
      return { seenCount, explodedCount };
    });
  }

  function renderMatrix(interactive) {
    matrix.replaceChildren();

    const corner = document.createElement("span");
    corner.className = "matrix-corner";
    corner.textContent = "";
    corner.setAttribute("aria-hidden", "true");
    matrix.append(corner);

    for (let usefulness = 0; usefulness <= 5; usefulness++) {
      const header = document.createElement("span");
      header.className = "matrix-column-label";
      header.textContent = String(usefulness);
      matrix.append(header);
    }

    for (let hostility = 0; hostility <= 5; hostility++) {
      const rowLabel = document.createElement("span");
      rowLabel.className = "matrix-row-label";
      rowLabel.textContent = String(hostility);
      matrix.append(rowLabel);

      for (let usefulness = 0; usefulness <= 5; usefulness++) {
        const hidden = usefulness <= state.filterBoundary[hostility];
        const cell = document.createElement("button");
        cell.type = "button";
        cell.className = "matrix-cell";
        cell.dataset.hidden = String(hidden);
        cell.dataset.hostility = String(hostility);
        cell.dataset.usefulness = String(usefulness);
        cell.disabled = !interactive;
        cell.setAttribute("role", "gridcell");
        cell.setAttribute("aria-pressed", String(hidden));
        const { seenCount, explodedCount } = state.feedbackCells[hostility * 6 + usefulness];
        const rate = seenCount > 0 ? Math.min(1, explodedCount / seenCount) : 0;
        const confidence = seenCount > 0 ? Math.sqrt(seenCount / (seenCount + 4)) : 0;
        const opacity = seenCount > 0 ? 0.06 + Math.min(0.38, rate * confidence * 0.46) : 0;
        if (seenCount > 0) {
          cell.style.backgroundColor = `rgba(229, 83, 76, ${opacity.toFixed(3)})`;
        }
        const rateLabel = seenCount > 0 ? `${Math.round(rate * 100)}%` : "履歴なし";
        const details = `爆破 ${explodedCount} / 見た ${seenCount}（爆破率 ${rateLabel}）`;
        cell.setAttribute(
          "aria-label",
          `攻撃性 ${hostility}、有益さ ${usefulness}：${hidden ? "隠す" : "表示する"}。${details}`
        );
        cell.title = `攻撃性 ${hostility} / 有益さ ${usefulness}：${details}`;
        const count = document.createElement("span");
        count.className = "matrix-cell-count";
        count.textContent = `${explodedCount}/${seenCount}`;
        cell.append(count);
        cell.addEventListener("click", () => {
          void toggleMatrixCell(hostility, usefulness);
        });
        matrix.append(cell);
      }
    }
  }

  function render() {
    const interactive = state.ready && !state.busy;
    toggle.disabled = !interactive;
    toggle.setAttribute("aria-checked", String(state.enabled));
    toggle.querySelector(".toggle-label").textContent = state.enabled ? "ON" : "OFF";

    scoreToggle.disabled = !interactive;
    scoreToggle.setAttribute("aria-checked", String(state.showScores));
    scoreToggle.querySelector(".toggle-label").textContent = state.showScores ? "ON" : "OFF";

    resetFilterButton.disabled = !interactive;
    resetFeedbackButton.disabled = !interactive;
    renderMatrix(interactive);

    keyInput.disabled = !interactive;
    saveKeyButton.disabled = !interactive;
    deleteKeyButton.disabled = !interactive || !state.keyConfigured;

    keyStatus.textContent = state.ready
      ? state.keyConfigured ? "登録済み" : "未登録"
      : "確認中…";
    keyStatus.dataset.configured = String(state.keyConfigured);
  }

  async function loadSettings() {
    try {
      const values = await chrome.storage.local.get([
        "enabled",
        "showScores",
        "apiKey",
        "filterBoundary",
        "lastError",
        "feedback:v1:stats"
      ]);
      state.enabled = typeof values.enabled === "boolean" ? values.enabled : true;
      state.showScores = typeof values.showScores === "boolean" ? values.showScores : false;
      state.filterBoundary = normalizeBoundary(values.filterBoundary);
      state.keyConfigured = typeof values.apiKey === "string" && values.apiKey.length > 0;
      state.feedbackCells = normalizeFeedbackStats(values["feedback:v1:stats"]);
      state.ready = true;
      render();
      if (values.lastError) showError(`判定エラー: ${values.lastError}`);
    } catch {
      state.ready = false;
      render();
      showError("設定を読み込めませんでした。拡張機能を再読み込みしてください。");
    }
  }

  function nextBoundaryForCell(hostility, usefulness) {
    const next = [...state.filterBoundary];
    const currentlyHidden = usefulness <= next[hostility];

    if (currentlyHidden) {
      for (let level = 0; level <= hostility; level++) {
        next[level] = Math.min(next[level], usefulness - 1);
      }
    } else {
      for (let level = hostility; level <= 5; level++) {
        next[level] = Math.max(next[level], usefulness);
      }
    }
    return normalizeBoundary(next);
  }

  async function saveFilterBoundary(filterBoundary, message) {
    if (!state.ready || state.busy) return;
    clearMessages();
    state.busy = true;
    render();
    try {
      await chrome.storage.local.set({ filterBoundary });
      state.filterBoundary = filterBoundary;
      showNotice(message);
    } catch {
      showError("フィルター範囲を保存できませんでした。");
    } finally {
      state.busy = false;
      render();
    }
  }

  async function toggleMatrixCell(hostility, usefulness) {
    const filterBoundary = nextBoundaryForCell(hostility, usefulness);
    await saveFilterBoundary(filterBoundary, "フィルター範囲を更新しました。");
  }

  toggle.addEventListener("click", async () => {
    if (!state.ready || state.busy) return;
    clearMessages();
    state.busy = true;
    render();
    const enabled = !state.enabled;
    try {
      await chrome.storage.local.set({ enabled });
      state.enabled = enabled;
      showNotice(enabled ? "自動フィルターをONにしました。" : "自動フィルターをOFFにしました。");
    } catch {
      showError("設定を保存できませんでした。");
    } finally {
      state.busy = false;
      render();
    }
  });

  scoreToggle.addEventListener("click", async () => {
    if (!state.ready || state.busy) return;
    const previousValue = state.showScores;
    const nextValue = !previousValue;
    clearMessages();
    state.busy = true;
    render();
    try {
      await chrome.storage.local.set({ showScores: nextValue });
      state.showScores = nextValue;
      showNotice(nextValue ? "判定スコアを表示します。" : "判定スコアを非表示にしました。");
    } catch {
      state.showScores = previousValue;
      showError("判定スコアの設定を保存できませんでした。");
    } finally {
      state.busy = false;
      render();
    }
  });

  resetFilterButton.addEventListener("click", () => {
    void saveFilterBoundary([...defaultBoundary], "フィルター範囲を初期値に戻しました。");
  });

  resetFeedbackButton.addEventListener("click", async () => {
    if (!state.ready || state.busy) return;
    if (!window.confirm("爆破履歴をすべてリセットします。この操作は取り消せません。")) return;

    clearMessages();
    state.busy = true;
    render();
    try {
      const response = await chrome.runtime.sendMessage({ type: "RESET_FEEDBACK" });
      if (response?.status !== "ok") {
        throw new Error("履歴をリセットできませんでした。");
      }
      state.feedbackCells = normalizeFeedbackStats(response.stats);
      showNotice("爆破履歴をリセットしました。");
    } catch {
      showError("爆破履歴をリセットできませんでした。");
    } finally {
      state.busy = false;
      render();
    }
  });

  saveKeyButton.addEventListener("click", async () => {
    if (!state.ready || state.busy) return;
    const apiKey = keyInput.value.trim();
    clearMessages();
    if (!apiKey) {
      showError("APIキーを入力してください。");
      keyInput.focus();
      return;
    }

    state.busy = true;
    render();
    try {
      await chrome.storage.local.set({ apiKey });
      state.keyConfigured = true;
      keyInput.value = "";
      showNotice("APIキーを保存しました。");
    } catch {
      showError("APIキーを保存できませんでした。");
    } finally {
      state.busy = false;
      render();
    }
  });

  deleteKeyButton.addEventListener("click", async () => {
    if (!state.ready || state.busy || !state.keyConfigured) return;
    clearMessages();
    state.busy = true;
    render();
    try {
      await chrome.storage.local.remove("apiKey");
      state.keyConfigured = false;
      keyInput.value = "";
      showNotice("APIキーを削除しました。");
    } catch {
      showError("APIキーを削除できませんでした。");
    } finally {
      state.busy = false;
      render();
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;

    if (Object.hasOwn(changes, "enabled")) {
      const newValue = changes.enabled.newValue;
      state.enabled = typeof newValue === "boolean" ? newValue : true;
    }
    if (Object.hasOwn(changes, "showScores")) {
      state.showScores = typeof changes.showScores.newValue === "boolean"
        ? changes.showScores.newValue
        : false;
    }
    if (Object.hasOwn(changes, "filterBoundary")) {
      state.filterBoundary = normalizeBoundary(changes.filterBoundary.newValue);
    }
    if (Object.hasOwn(changes, "apiKey")) {
      const newValue = changes.apiKey.newValue;
      state.keyConfigured = typeof newValue === "string" && newValue.length > 0;
    }
    if (Object.hasOwn(changes, "lastError")) {
      const message = changes.lastError.newValue;
      if (message) showError(`判定エラー: ${message}`);
      else clearMessages();
    }
    if (Object.hasOwn(changes, "feedback:v1:stats")) {
      state.feedbackCells = normalizeFeedbackStats(changes["feedback:v1:stats"].newValue);
    }
    render();
  });

  chrome.tabs.onActivated.addListener(activeInfo => {
    state.currentTabId = activeInfo.tabId;
    queuePageStatsRefresh(activeInfo.tabId);
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId !== state.currentTabId) return;
    if (changeInfo.status === "complete" || changeInfo.url) queuePageStatsRefresh();
  });
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (message?.type === "PAGE_STATS_UPDATED" && sender?.tab?.id === state.currentTabId) {
      queuePageStatsRefresh(sender.tab.id);
    }
  });

  render();
  void refreshPageStats();
  void loadSettings();
})();
