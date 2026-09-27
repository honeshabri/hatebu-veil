import "../core/filter-policy.js";
import "../core/feedback.js";
import { classifyBatch, MAX_BATCH, MAX_TEXT_LENGTH } from "../core/classifier.js";

const { isSensitive, defaultBoundary, normalizeBoundary } = globalThis.HatebuVeilPolicy;
const CACHE_PREFIX = "cache:v1:";
const HATENA_URL = "https://b.hatena.ne.jp/entry/*";
const FEEDBACK_PREFIX = "feedback:v1:";
const FEEDBACK_STATS_KEY = `${FEEDBACK_PREFIX}stats`;
const { recordFeedback, normalizeStats, emptyStats } = globalThis.HatebuVeilFeedback;
let feedbackQueue = Promise.resolve();

// Content scripts need only the ON/OFF state; the API key stays in trusted extension contexts.
const storageReady = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });

function validSender(sender) {
  if (sender.id !== chrome.runtime.id || !sender.tab || !sender.url) return false;
  try {
    const url = new URL(sender.url);
    return url.protocol === "https:" && url.hostname === "b.hatena.ne.jp" &&
      url.pathname.startsWith("/entry/");
  } catch {
    return false;
  }
}

function validComments(comments) {
  return Array.isArray(comments) && comments.length > 0 && comments.length <= MAX_BATCH &&
    comments.every(comment => comment && typeof comment.id === "string" &&
      comment.id.length > 0 && comment.id.length <= 120 &&
      typeof comment.text === "string" && comment.text.trim().length > 0 &&
      comment.text.length <= MAX_TEXT_LENGTH &&
      (comment.commentId === null ||
        (typeof comment.commentId === "string" && comment.commentId.length <= 200)));
}

async function cacheKey(comment) {
  const input = `hatena-bookmark\u0000${comment.commentId || ""}\u0000${comment.text}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return CACHE_PREFIX + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function enqueueFeedback(task) {
  const result = feedbackQueue.then(task, task);
  feedbackQueue = result.catch(() => {});
  return result;
}

function validFeedbackComment(comment) {
  return comment && typeof comment.text === "string" && comment.text.trim().length > 0 &&
    comment.text.length <= 20000 &&
    (comment.commentId === null || comment.commentId === undefined ||
      (typeof comment.commentId === "string" && comment.commentId.length <= 200)) &&
    ((comment.hostility === undefined && comment.usefulness === undefined) || validScores(comment));
}

async function feedbackIdentity(comment, sender) {
  const textHash = await sha256(comment.text);
  const site = "hatena-bookmark";
  const path = new URL(sender.url).pathname;
  const identity = comment.commentId || `${path}\u0000${textHash}`;
  const key = `${FEEDBACK_PREFIX}entry:${await sha256(`${site}\u0000${identity}`)}`;
  return { key, site, commentId: comment.commentId || null, textHash };
}

async function saveFeedback(event, comments, sender) {
  if (!Array.isArray(comments) || comments.length < 1 || comments.length > MAX_BATCH ||
      !comments.every(validFeedbackComment)) throw new Error("履歴対象が不正です");
  return enqueueFeedback(async () => {
    const stored = await chrome.storage.local.get(FEEDBACK_STATS_KEY);
    let stats = normalizeStats(stored[FEEDBACK_STATS_KEY]);
    for (const comment of comments) {
      const identity = await feedbackIdentity(comment, sender);
      const classificationKey = await cacheKey(comment);
      const saved = await chrome.storage.local.get([identity.key, classificationKey]);
      const scores = validScores(saved[classificationKey]) ? saved[classificationKey] : comment;
      const details = {
        ...identity,
        hostility: scores.hostility,
        usefulness: scores.usefulness
      };
      const outcome = recordFeedback(saved[identity.key], stats, event, details);
      if (!outcome.changed) continue;
      stats = outcome.stats;
      await chrome.storage.local.set({ [identity.key]: outcome.entry, [FEEDBACK_STATS_KEY]: stats });
    }
    return { status: "ok" };
  });
}

async function lookupFeedback(comments, sender) {
  if (!Array.isArray(comments) || comments.length < 1 || comments.length > MAX_BATCH ||
      !comments.every(comment => typeof comment?.id === "string" && validFeedbackComment(comment))) {
    throw new Error("履歴対象が不正です");
  }
  const identities = await Promise.all(comments.map(comment => feedbackIdentity(comment, sender)));
  const saved = await chrome.storage.local.get(identities.map(identity => identity.key));
  return {
    status: "ok",
    exploded: comments.filter((_, index) => Boolean(saved[identities[index].key]?.explodedAt))
      .map(comment => comment.id)
  };
}

async function resetFeedback() {
  return enqueueFeedback(async () => {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter(key => key.startsWith(FEEDBACK_PREFIX));
    if (keys.length) await chrome.storage.local.remove(keys);
    return { status: "ok", stats: emptyStats() };
  });
}

function validScores(value) {
  return value && Number.isFinite(value.hostility) && Number.isFinite(value.usefulness) &&
    value.hostility >= 0 && value.hostility <= 5 &&
    value.usefulness >= 0 && value.usefulness <= 5;
}

async function getConfig() {
  await storageReady;
  const { enabled, apiKey, filterBoundary, showScores } = await chrome.storage.local.get([
    "enabled",
    "apiKey",
    "filterBoundary",
    "showScores"
  ]);
  return {
    enabled: enabled !== false,
    hasKey: Boolean(apiKey?.trim()),
    apiKey: apiKey?.trim() || "",
    filterBoundary: normalizeBoundary(filterBoundary),
    showScores: showScores === true
  };
}

async function lookupCache(comments, filterBoundary = defaultBoundary) {
  if (!validComments(comments)) throw new Error("判定対象が不正です");
  const keys = await Promise.all(comments.map(cacheKey));
  const cached = await chrome.storage.local.get(keys);
  const results = [];
  const missing = [];
  comments.forEach((comment, index) => {
    const saved = cached[keys[index]];
    if (validScores(saved)) {
      results.push({
        id: comment.id,
        ...saved,
        sensitive: isSensitive(saved.hostility, saved.usefulness, filterBoundary)
      });
    } else {
      missing.push({ ...comment, index });
    }
  });
  return { results, missing, keys };
}

async function handleClassify(comments) {
  if (!validComments(comments)) throw new Error("判定対象が不正です");
  const config = await getConfig();
  if (!config.enabled || !config.hasKey) return { status: "inactive", results: [] };
  const { results, missing, keys } = await lookupCache(comments, config.filterBoundary);

  if (missing.length) {
    try {
      const scores = await classifyBatch(missing, config.apiKey);
      const writes = {};
      scores.forEach((score, position) => {
        const item = missing[position];
        results.push({
          id: item.id,
          ...score,
          sensitive: isSensitive(score.hostility, score.usefulness, config.filterBoundary)
        });
        writes[keys[item.index]] = score;
      });
      try {
        await chrome.storage.local.set({ ...writes, lastError: "" });
      } catch {
        // A full cache must not discard a successful classification.
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "判定に失敗しました";
      try {
        await chrome.storage.local.set({ lastError: message });
      } catch {
        // The page still receives the failure even if local storage is full.
      }
      throw new Error(message);
    }
  }
  return { status: "ok", results };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id === chrome.runtime.id &&
      sender.url === chrome.runtime.getURL("popup/popup.html") &&
      message?.type === "RESET_FEEDBACK") {
    resetFeedback().then(sendResponse, error => sendResponse({
      status: "error", error: error instanceof Error ? error.message : "履歴を削除できませんでした"
    }));
    return true;
  }
  if (!validSender(sender)) return false;
  if (message?.type === "PAGE_STATS_UPDATED") {
    sendResponse({ status: "ok" });
    return false;
  }
  (async () => {
    if (message?.type === "GET_STATUS") {
      const { enabled, hasKey, filterBoundary, showScores } = await getConfig();
      return { status: "ok", enabled, hasKey, filterBoundary, showScores };
    }
    if (message?.type === "LOOKUP_CACHE") {
      const { enabled, hasKey, filterBoundary } = await getConfig();
      if (!enabled || !hasKey) return { status: "inactive", results: [], missing: [] };
      const { results, missing } = await lookupCache(message.comments, filterBoundary);
      return { status: "ok", results, missing: missing.map(({ id }) => id) };
    }
    if (message?.type === "CLASSIFY") return handleClassify(message.comments);
    if (message?.type === "LOOKUP_FEEDBACK") return lookupFeedback(message.comments, sender);
    if (message?.type === "RECORD_SEEN") return saveFeedback("seen", message.comments, sender);
    if (message?.type === "RECORD_EXPLOSION") return saveFeedback("exploded", [message.comment], sender);
    throw new Error("不明なリクエストです");
  })().then(sendResponse, error => sendResponse({
    status: "error",
    error: error instanceof Error ? error.message : "処理に失敗しました"
  }));
  return true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" ||
      !("enabled" in changes || "apiKey" in changes || "filterBoundary" in changes ||
        "showScores" in changes)) return;
  void (async () => {
    if ("apiKey" in changes) await chrome.storage.local.set({ lastError: "" });
    const { enabled, hasKey, filterBoundary, showScores } = await getConfig();
    const tabs = await chrome.tabs.query({ url: HATENA_URL });
    const filterChanged = "filterBoundary" in changes;
    await Promise.allSettled(tabs.map(tab => chrome.tabs.sendMessage(tab.id, {
      type: "STATUS_CHANGED",
      enabled,
      hasKey,
      filterBoundary,
      showScores,
      filterChanged
    })));
  })();
});
