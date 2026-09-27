import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import "../core/filter-policy.js";

const source = readFileSync(new URL("../extension/content-script.js", import.meta.url), "utf8");

class FakeElement {
  constructor(tag = "div") {
    this.tagName = tag;
    this.children = [];
    this.listeners = new Map();
    this.classes = new Set();
    this.classList = {
      add: name => this.classes.add(name),
      remove: name => this.classes.delete(name),
      contains: name => this.classes.has(name)
    };
    this.isConnected = true;
    this.textContent = "";
    this.hidden = false;
    this.attributes = new Map();
  }

  set className(value) { this.classes = new Set(value.split(/\s+/)); }
  get className() { return [...this.classes].join(" "); }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  insertBefore(node, before) {
    node.parent = this;
    const index = this.children.indexOf(before);
    this.children.splice(index < 0 ? this.children.length : index, 0, node);
  }
  after(node) {
    const index = this.parent.children.indexOf(this);
    node.parent = this.parent;
    this.parent.children.splice(index + 1, 0, node);
  }
  remove() {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
    this.isConnected = false;
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  async click() { return this.listeners.get("click")?.({ stopPropagation() {} }); }
}

function setup({ reducedMotion = false } = {}) {
  const scored = [
    { text: "低有益", hostility: 4, usefulness: 1 },
    { text: "有益", hostility: 1, usefulness: 4 }
  ];
  const root = new FakeElement();
  const elements = scored.map(({ text }, index) => {
    const element = new FakeElement("p");
    element.textContent = text;
    element.parent = root;
    root.children.push(element);
    const menu = new FakeElement();
    return { element, menu, index };
  });
  let contentListener;
  let classifyCalls = 0;
  let explosionCalls = 0;
  const messages = [];
  const config = { enabled: true, hasKey: true, showScores: false,
    filterBoundary: [-1, -1, -1, 2, 2, 5] };
  const chrome = {
    runtime: {
      onMessage: { addListener(listener) { contentListener = listener; } },
      async sendMessage(message) {
        messages.push(message.type);
        if (message.type === "GET_STATUS") return { status: "ok", ...config };
        if (message.type === "LOOKUP_FEEDBACK") return { status: "ok", exploded: [] };
        if (message.type === "LOOKUP_CACHE") return {
          status: "ok", missing: [],
          results: message.comments.map(item => ({ id: item.id, ...scored[Number(item.id) - 1] }))
        };
        if (message.type === "CLASSIFY") { classifyCalls++; return { status: "ok", results: [] }; }
        if (message.type === "RECORD_EXPLOSION") explosionCalls++;
        return { status: "ok" };
      }
    }
  };
  const document = { documentElement: root, createElement: tag => new FakeElement(tag) };
  const adapter = {
    find: () => elements.map(item => item.element).filter(element => element.isConnected),
    extract: element => {
      const item = elements.find(candidate => candidate.element === element);
      return { element, text: element.textContent, commentId: `/entry/1/comment/${item.index}`,
        actionTarget: item.menu, actionBefore: null };
    }
  };
  const context = { chrome, document, Element: FakeElement, MutationObserver: class {
    observe() {}
  }, window: { matchMedia: () => ({ matches: reducedMotion }) },
  HatebuVeilPolicy: globalThis.HatebuVeilPolicy, HatebuVeilAdapter: adapter,
  setTimeout, clearTimeout, queueMicrotask };
  vm.runInNewContext(source, context);
  const send = message => new Promise(resolve => contentListener(message, {}, resolve));
  const status = changes => contentListener({ type: "STATUS_CHANGED", ...config, ...changes });
  return { elements, root, scored, messages, send, status,
    get classifyCalls() { return classifyCalls; },
    get explosionCalls() { return explosionCalls; } };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 120));

test("キャッシュ済みスコアは追加判定なく表示でき、OFFでは従来表示を保つ", async () => {
  const app = setup();
  await settle();
  const [hidden, visible] = app.elements;
  assert.equal(hidden.element.parent.children[1].children.some(node => node.textContent.includes("💢")), false);
  assert.equal(visible.menu.children[0].hidden, true);
  assert.deepEqual(JSON.parse(JSON.stringify(await app.send({ type: "GET_PAGE_STATS" }))),
    { status: "ok", judged: 2, hidden: 1, exploded: 0 });
  app.status({ showScores: true });
  assert.equal(visible.menu.children[0].textContent, "💢1　💡4");
  assert.equal(visible.menu.children[0].hidden, false);
  assert.match(hidden.element.parent.children[1].children[1].textContent, /💢 攻撃性 4　💡 有益さ 1/);
  app.status({ showScores: false });
  assert.equal(visible.menu.children[0].hidden, true);
  assert.equal(hidden.element.parent.children[1].children.some(node => node.textContent.includes("💢")), false);
  assert.equal(app.classifyCalls, 0);
});

test("フィルター変更時の非表示件数は保持済みスコアから更新しJevを呼ばない", async () => {
  const app = setup();
  await settle();
  app.status({ filterBoundary: [-1, -1, -1, -1, -1, -1], filterChanged: true });
  assert.equal((await app.send({ type: "GET_PAGE_STATS" })).hidden, 0);
  app.status({ filterBoundary: [5, 5, 5, 5, 5, 5], filterChanged: true });
  assert.equal((await app.send({ type: "GET_PAGE_STATS" })).hidden, 2);
  assert.equal(app.classifyCalls, 0);
});

test("爆破後に短い演出を経て履歴と件数を保ち、戻すと表示を復元する", async () => {
  const app = setup();
  await settle();
  app.status({ showScores: true });
  const visible = app.elements[1];
  const action = visible.menu.children[1];
  const pending = action.click();
  assert.equal(action.textContent, "💥");
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(visible.element.classList.contains("hatebu-veil-exploding"), true);
  await pending;
  assert.equal(app.explosionCalls, 1);
  assert.equal((await app.send({ type: "GET_PAGE_STATS" })).exploded, 1);
  const notice = visible.element.parent.children[3];
  assert.equal(notice.children[0].textContent, "💥 爆破済み");
  assert.equal(visible.menu.children[0].textContent, "💢1　💡4");
  assert.equal(visible.menu.children[0].hidden, false);
  assert.equal(action.hidden, true);
  await notice.children[1].click();
  assert.equal((await app.send({ type: "GET_PAGE_STATS" })).exploded, 0);
  assert.equal(visible.element.classList.contains("hatebu-veil-hidden"), false);
  assert.equal(action.hidden, false);
  assert.equal(app.classifyCalls, 0);
});

test("自動フィルター対象は爆破済み表示に切り替わっても非表示件数から落ちない", async () => {
  const app = setup({ reducedMotion: true });
  await settle();
  assert.equal((await app.send({ type: "GET_PAGE_STATS" })).hidden, 1);
  await app.elements[0].menu.children[1].click();
  const stats = await app.send({ type: "GET_PAGE_STATS" });
  assert.equal(stats.hidden, 1);
  assert.equal(stats.exploded, 1);
  const notice = app.elements[0].element.parent.children[1];
  await notice.children[1].click();
  assert.equal((await app.send({ type: "GET_PAGE_STATS" })).hidden, 0);
  assert.equal(app.classifyCalls, 0);
});

test("動きを減らす設定では爆破アニメーションを省略する", async () => {
  const app = setup({ reducedMotion: true });
  await settle();
  await app.elements[1].menu.children[1].click();
  assert.equal(app.elements[1].element.classList.contains("hatebu-veil-exploding"), false);
  assert.equal((await app.send({ type: "GET_PAGE_STATS" })).exploded, 1);
});
