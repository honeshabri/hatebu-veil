import test from "node:test";
import assert from "node:assert/strict";

const values = { enabled: true, apiKey: "dummy" };
const listeners = {};
let apiCalls = 0;

globalThis.chrome = {
  runtime: {
    id: "hatebu-veil-test",
    getURL(path) { return `chrome-extension://hatebu-veil-test/${path}`; },
    onMessage: { addListener(listener) { listeners.message = listener; } }
  },
  storage: {
    local: {
      async setAccessLevel({ accessLevel }) {
        assert.equal(accessLevel, "TRUSTED_CONTEXTS");
      },
      async get(keys) {
        if (keys === null) return { ...values };
        if (typeof keys === "string") keys = [keys];
        return Object.fromEntries(keys.filter(key => key in values).map(key => [key, values[key]]));
      },
      async set(entries) { Object.assign(values, entries); },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
      }
    },
    onChanged: { addListener(listener) { listeners.storage = listener; } }
  },
  tabs: { async query() { return []; }, async sendMessage() {} }
};

globalThis.fetch = async (_url, options) => {
  apiCalls++;
  const request = JSON.parse(options.body);
  const answers = {};
  request.state.comments.forEach((_, index) => {
    answers[`h${index}`] = { score: 4 };
    answers[`u${index}`] = { score: 1 };
  });
  return { ok: true, json: async () => ({ answers }) };
};

await import("../extension/background.js");

const sender = {
  id: "hatebu-veil-test",
  url: "https://b.hatena.ne.jp/entry/s/example.com/",
  tab: { id: 1 }
};

function message(input, from = sender) {
  return new Promise(resolve => {
    const accepted = listeners.message(input, from, resolve);
    if (!accepted) resolve(null);
  });
}

const comment = { id: "1", commentId: "/entry/42/comment/user", text: "攻撃的な文章" };

test("スコア表示設定と境界をコンテンツへ渡し、件数通知でAPIを呼ばない", async () => {
  const initial = await message({ type: "GET_STATUS" });
  assert.equal(initial.showScores, false);
  assert.deepEqual(initial.filterBoundary, [-1, -1, -1, 2, 2, 5]);
  await chrome.storage.local.set({ showScores: true });
  assert.equal((await message({ type: "GET_STATUS" })).showScores, true);
  const before = apiCalls;
  assert.equal((await message({ type: "PAGE_STATS_UPDATED" })).status, "ok");
  assert.equal(apiCalls, before);
  await chrome.storage.local.remove("showScores");
});

test("キャッシュ未登録を判定後に保存し、再訪時はAPIを呼ばない", async () => {
  const before = await message({ type: "LOOKUP_CACHE", comments: [comment] });
  assert.deepEqual(before.missing, ["1"]);
  const classified = await message({ type: "CLASSIFY", comments: [comment] });
  assert.equal(classified.results[0].sensitive, true);
  assert.equal(apiCalls, 1);
  const after = await message({ type: "LOOKUP_CACHE", comments: [comment] });
  assert.deepEqual(after.missing, []);
  assert.equal(after.results[0].sensitive, true);
  assert.equal(apiCalls, 1);
});

test("フィルター範囲を変えるとキャッシュ済みスコアを再判定する", async () => {
  values.filterBoundary = [-1, -1, -1, -1, -1, -1];
  const visible = await message({ type: "LOOKUP_CACHE", comments: [comment] });
  assert.equal(visible.results[0].sensitive, false);
  assert.equal(apiCalls, 1);

  values.filterBoundary = [-1, -1, -1, 2, 2, 5];
  const hidden = await message({ type: "LOOKUP_CACHE", comments: [comment] });
  assert.equal(hidden.results[0].sensitive, true);
  assert.equal(apiCalls, 1);
});

test("OFFと未登録キーでは判定せず、不正な送信元を拒否する", async () => {
  values.enabled = false;
  assert.equal((await message({ type: "CLASSIFY", comments: [comment] })).status, "inactive");
  values.enabled = true;
  delete values.apiKey;
  assert.equal((await message({ type: "CLASSIFY", comments: [comment] })).status, "inactive");
  assert.equal(apiCalls, 1);
  assert.equal(await message({ type: "CLASSIFY", comments: [comment] }, {
    ...sender, url: "https://example.com/"
  }), null);
});

test("seenは同じコメントを重複計上せず、爆破はキャッシュ済みスコアのセルへ記録する", async () => {
  values.apiKey = "dummy";
  const scored = { ...comment, hostility: 0, usefulness: 5 };
  assert.equal((await message({ type: "RECORD_SEEN", comments: [scored] })).status, "ok");
  assert.equal((await message({ type: "RECORD_SEEN", comments: [scored] })).status, "ok");
  const before = apiCalls;
  assert.equal((await message({ type: "RECORD_EXPLOSION", comment: scored })).status, "ok");
  assert.equal((await message({ type: "RECORD_EXPLOSION", comment: scored })).status, "ok");
  const history = await message({ type: "LOOKUP_FEEDBACK", comments: [scored] });
  assert.deepEqual(history.exploded, [comment.id]);
  assert.equal(apiCalls, before);
  const stats = values["feedback:v1:stats"];
  assert.deepEqual(stats.cells[4 * 6 + 1], { seenCount: 1, explodedCount: 1 });
  assert.deepEqual(stats.cells[0 * 6 + 5], { seenCount: 0, explodedCount: 0 });
  const entry = Object.entries(values).find(([key]) => key.startsWith("feedback:v1:entry:"))[1];
  assert.equal(entry.site, "hatena-bookmark");
  assert.equal(entry.commentId, comment.commentId);
  assert.match(entry.textHash, /^[0-9a-f]{64}$/);
  assert.equal(entry.hostility, 4);
  assert.equal(entry.usefulness, 1);
  assert.ok(entry.explodedAt);
  assert.ok(!JSON.stringify(entry).includes(comment.text));
});

test("未判定の爆破はAPIを呼ばず、後の判定時に同じセルのseenと爆破を集計する", async () => {
  const unscored = { text: "判定前のコメント", commentId: "/entry/43/comment/user" };
  const before = apiCalls;
  assert.equal((await message({ type: "RECORD_EXPLOSION", comment: unscored })).status, "ok");
  assert.equal(apiCalls, before);
  assert.equal((await message({ type: "RECORD_SEEN", comments: [{
    ...unscored, hostility: 2.4, usefulness: 3.6
  }] })).status, "ok");
  assert.deepEqual(values["feedback:v1:stats"].cells[2 * 6 + 4], {
    seenCount: 1, explodedCount: 1
  });
});

test("フィルター変更で履歴は残り、履歴リセットはキー・境界・判定キャッシュを保持する", async () => {
  values.filterBoundary = [-1, -1, 0, 1, 3, 5];
  const historyBefore = values["feedback:v1:stats"];
  const cacheKey = Object.keys(values).find(key => key.startsWith("cache:v1:"));
  const cached = values[cacheKey];
  assert.equal((await message({ type: "LOOKUP_CACHE", comments: [comment] })).status, "ok");
  assert.deepEqual(values["feedback:v1:stats"], historyBefore);
  const popup = { id: "hatebu-veil-test", url: "chrome-extension://hatebu-veil-test/popup/popup.html" };
  assert.equal((await message({ type: "RESET_FEEDBACK" }, popup)).status, "ok");
  const history = await message({ type: "LOOKUP_FEEDBACK", comments: [comment] });
  assert.deepEqual(history.exploded, []);
  assert.equal(Object.keys(values).some(key => key.startsWith("feedback:v1:")), false);
  assert.equal(values.apiKey, "dummy");
  assert.deepEqual(values.filterBoundary, [-1, -1, 0, 1, 3, 5]);
  assert.deepEqual(values[cacheKey], cached);
});
