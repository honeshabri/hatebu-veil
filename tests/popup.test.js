import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

class FakeElement {
  constructor() {
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.children = [];
    this.listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this.textContent = "";
    this.label = null;
  }

  setAttribute(name, value) { this.attributes[name] = value; }
  querySelector(selector) {
    if (selector === ".toggle-label") return this.label;
    return null;
  }
  addEventListener(type, listener) {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(listener);
    this.listeners.set(type, handlers);
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  focus() {}
  async click() {
    for (const listener of this.listeners.get("click") ?? []) await listener({});
  }
}

async function settle() {
  await new Promise(resolve => setImmediate(resolve));
}

async function waitForPopupEvents() {
  await new Promise(resolve => setTimeout(resolve, 140));
  await settle();
}

test("スコア設定は初期OFFで保存失敗時に戻り、現在ページ件数は対象タブだけ取得する", async () => {
  const source = await readFile(new URL("../popup/popup.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../popup/popup.html", import.meta.url), "utf8");
  const ids = [
    "enabled-toggle", "score-toggle", "current-page-stats", "filter-matrix",
    "reset-filter", "reset-feedback", "api-key", "save-key", "delete-key",
    "key-status", "error-message", "notice-message"
  ];
  const elements = Object.fromEntries(ids.map(id => [id, new FakeElement()]));
  for (const id of ["enabled-toggle", "score-toggle"]) elements[id].label = new FakeElement();

  const values = { enabled: true, apiKey: "present", filterBoundary: [-1, -1, 0, 1, 3, 5] };
  const storageListeners = [];
  const activationListeners = [];
  const updateListeners = [];
  const runtimeListeners = [];
  const tabMessages = [];
  const runtimeMessages = [];
  const activeTab = { id: 17, url: "https://b.hatena.ne.jp/entry/https://example.com/" };
  let nextStats = { status: "ok", judged: 7, hidden: 2, exploded: 1 };
  let failScoreSave = true;

  const chrome = {
    storage: {
      local: {
        async get(keys) {
          return Object.fromEntries(keys.filter(key => key in values).map(key => [key, values[key]]));
        },
        async set(entries) {
          if (failScoreSave && Object.hasOwn(entries, "showScores")) {
            throw new Error("storage unavailable");
          }
          Object.assign(values, entries);
        },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
        }
      },
      onChanged: { addListener(listener) { storageListeners.push(listener); } }
    },
    tabs: {
      async query() { return [activeTab]; },
      async sendMessage(tabId, message) {
        tabMessages.push({ tabId, message });
        if (nextStats instanceof Error) throw nextStats;
        return nextStats;
      },
      onActivated: { addListener(listener) { activationListeners.push(listener); } },
      onUpdated: { addListener(listener) { updateListeners.push(listener); } }
    },
    runtime: {
      sendMessage(message) { runtimeMessages.push(message); },
      onMessage: { addListener(listener) { runtimeListeners.push(listener); } }
    }
  };
  const defaultBoundary = [-1, -1, 0, 1, 3, 5];
  const context = {
    chrome,
    document: {
      querySelector(selector) { return elements[selector.slice(1)]; },
      createElement() { return new FakeElement(); }
    },
    window: { confirm: () => true },
    URL,
    setTimeout,
    clearTimeout,
    HatebuVeilPolicy: {
      defaultBoundary,
      normalizeBoundary(value) {
        return Array.isArray(value) && value.length === 6 ? [...value] : [...defaultBoundary];
      }
    }
  };
  vm.runInNewContext(source, context);
  await settle();

  assert.equal(elements["score-toggle"].attributes["aria-checked"], "false");
  assert.equal(elements["score-toggle"].label.textContent, "OFF");
  assert.equal(elements["filter-matrix"].children[0].textContent, "");
  assert.equal(elements["filter-matrix"].children[7].textContent, "0");
  assert.equal(elements["filter-matrix"].children[42].textContent, "5");
  assert.match(html, /💡 有益さ →[\s\S]*💢 攻撃性 ↓/);
  assert.match(html, /<strong>赤の濃淡<\/strong>：爆破率/);
  assert.match(html, /<strong>青い内枠<\/strong>：自動フィルター/);
  assert.match(elements["current-page-stats"].textContent, /判定済み 7件・非表示 2件・爆破 1件/);
  assert.equal(tabMessages.length, 1);
  assert.equal(tabMessages[0].tabId, 17);
  assert.equal(tabMessages[0].message.type, "GET_PAGE_STATS");

  await elements["score-toggle"].click();
  assert.equal(elements["score-toggle"].attributes["aria-checked"], "false");
  assert.equal(values.showScores, undefined);
  assert.equal(elements["error-message"].hidden, false);

  failScoreSave = false;
  await elements["score-toggle"].click();
  assert.equal(values.showScores, true);
  assert.equal(elements["score-toggle"].attributes["aria-checked"], "true");
  assert.equal(elements["notice-message"].textContent, "判定スコアを表示します。");

  nextStats = { status: "ok", judged: 8, hidden: 3, exploded: 2 };
  runtimeListeners[0]({ type: "PAGE_STATS_UPDATED" }, { tab: { id: 17 } });
  await waitForPopupEvents();
  assert.match(elements["current-page-stats"].textContent, /判定済み 8件・非表示 3件・爆破 2件/);

  activeTab.url = "https://example.com/";
  activationListeners[0]({ tabId: 17 });
  await waitForPopupEvents();
  assert.match(elements["current-page-stats"].textContent, /対象外/);
  assert.equal(tabMessages.length, 2);

  activeTab.url = "https://b.hatena.ne.jp/entry/https://example.com/";
  nextStats = new Error("content script did not respond");
  updateListeners[0](17, { status: "complete" });
  await waitForPopupEvents();
  assert.match(elements["current-page-stats"].textContent, /再読み込み/);
  assert.deepEqual(runtimeMessages, []);
  assert.equal(storageListeners.length, 1);
  assert.equal(runtimeListeners.length, 1);
});
