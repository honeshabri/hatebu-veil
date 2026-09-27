import test from "node:test";
import assert from "node:assert/strict";
import "../core/filter-policy.js";
import { buildRequest, parseAnswers, classifyBatch } from "../core/classifier.js";

const {
  isSensitive,
  defaultBoundary,
  normalizeBoundary,
  scoreToLevel
} = globalThis.HatebuVeilPolicy;

test("既定の階段状フィルターで有益な批判を残し、情報価値の低い攻撃を折り畳む", () => {
  assert.deepEqual([...defaultBoundary], [-1, -1, -1, 2, 2, 5]);
  assert.equal(isSensitive(1.5, 4.5), false);
  assert.equal(isSensitive(3, 2.49), true);
  assert.equal(isSensitive(3, 2.5), false);
  assert.equal(isSensitive(4.5, 5), true);
  assert.equal(isSensitive(NaN, 0), false);
});

test("6段階スコアへ丸め、攻撃性が高いほど隠す範囲が狭くならない", () => {
  assert.equal(scoreToLevel(0), 0);
  assert.equal(scoreToLevel(2.49), 2);
  assert.equal(scoreToLevel(2.5), 3);
  assert.equal(scoreToLevel(5), 5);
  assert.equal(scoreToLevel(6), null);

  const custom = [-1, -1, 0, 1, 3, 5];
  assert.equal(isSensitive(2, 0, custom), true);
  assert.equal(isSensitive(2, 1, custom), false);
  assert.equal(isSensitive(4, 3, custom), true);
  assert.equal(isSensitive(4, 4, custom), false);
  assert.equal(isSensitive(5, 5, custom), true);

  assert.deepEqual(normalizeBoundary([-1, 2, 0, 3, 2, 5]), [-1, 2, 2, 3, 3, 5]);
});

test("複数コメントの2軸を一回のJevリクエストへまとめる", () => {
  const body = buildRequest([{ text: "批判" }, { text: "暴言" }]);
  assert.equal(body.model, "jev-1.13-free");
  assert.deepEqual(body.state, { comments: [{ text: "批判" }, { text: "暴言" }] });
  assert.deepEqual(Object.keys(body.questions), ["h0", "u0", "h1", "u1"]);
  assert.equal(body.questions.h0.criteria.length, 6);
  assert.match(body.questions.u1.instructions, /comments\[1\]\.text/);
});

test("Jevのスコア応答を解析し、欠損値を拒否する", () => {
  assert.deepEqual(parseAnswers({ answers: {
    h0: { score: 3.2 }, u0: { score: 1.4 }
  } }, 1), [{ hostility: 3.2, usefulness: 1.4 }]);
  assert.throws(() => parseAnswers({ answers: { h0: { score: 3 } } }, 1));
  assert.throws(() => parseAnswers({ answers: { h0: { score: 6 }, u0: { score: 0 } } }, 1));
});

test("API送信先と認証ヘッダーを固定し、無効なAPI応答を通さない", async () => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ answers: {
      h0: { score: 4 }, u0: { score: 1 }
    } }) };
  };
  const result = await classifyBatch([{ text: "テスト" }], "dummy", fakeFetch);
  assert.deepEqual(result, [{ hostility: 4, usefulness: 1 }]);
  assert.equal(calls[0].url, "https://opencode.ai/zen/v1/systemone");
  assert.equal(calls[0].options.headers.Authorization, "Bearer dummy");
  assert.equal(JSON.parse(calls[0].options.body).state.comments[0].text, "テスト");
});
