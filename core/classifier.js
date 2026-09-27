const ENDPOINT = "https://opencode.ai/zen/v1/systemone";
export const MODEL = "jev-1.13-free";
export const MAX_BATCH = 10;
export const MAX_TEXT_LENGTH = 2000;

const hostilityCriteria = [
  "No hostile, insulting, mocking, abusive, or personally attacking language.",
  "Mild negative tone without personal attack.",
  "Strong criticism of a claim, action, or work, without personal attack.",
  "Personal attack or clear mockery directed at a person.",
  "Strong insult, abuse, or contempt directed at a person.",
  "Extreme abuse, dehumanization, or threat."
];

const usefulnessCriteria = [
  "No substantive information, reason, evidence, or useful feedback.",
  "Almost entirely a reaction or opinion without supporting reasons.",
  "Some relevant point or reason, but little detail.",
  "Specific reason, concrete criticism, or relevant information.",
  "Useful counterargument, evidence, or actionable feedback.",
  "Exceptionally informative criticism or evidence with strong reasoning."
];

export function buildRequest(comments) {
  if (!Array.isArray(comments) || comments.length < 1 || comments.length > MAX_BATCH) {
    throw new Error("判定件数が範囲外です");
  }
  const state = { comments: comments.map(({ text }) => ({ text })) };
  const questions = {};
  comments.forEach((_, index) => {
    questions[`h${index}`] = {
      type: "score",
      instructions: `How hostile, insulting, abusive, mocking, or personally attacking is \`comments[${index}].text\`? Do not treat ordinary disagreement or substantive criticism as hostility merely because it is negative. Judge the comment text only.`,
      criteria: hostilityCriteria
    };
    questions[`u${index}`] = {
      type: "score",
      instructions: `How much substantive information, reasoning, evidence, concrete criticism, or useful feedback does \`comments[${index}].text\` contain? A strongly critical comment may still be highly useful. Judge the comment text only.`,
      criteria: usefulnessCriteria
    };
  });
  return { model: MODEL, state, questions };
}

export function parseAnswers(data, count) {
  if (!data || typeof data !== "object" || !data.answers || typeof data.answers !== "object") {
    throw new Error("判定結果の形式が不正です");
  }
  return Array.from({ length: count }, (_, index) => {
    const hostility = data.answers[`h${index}`]?.score;
    const usefulness = data.answers[`u${index}`]?.score;
    if (![hostility, usefulness].every(value => Number.isFinite(value) && value >= 0 && value <= 5)) {
      throw new Error("判定スコアが不正です");
    }
    return { hostility, usefulness };
  });
}

export async function classifyBatch(comments, apiKey, fetchImpl = fetch) {
  const response = await fetchImpl(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(buildRequest(comments)),
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error("APIキーを確認してください");
    if (response.status === 429) throw new Error("APIの利用制限に達しました");
    throw new Error(`判定APIでエラーが発生しました (${response.status})`);
  }
  return parseAnswers(await response.json(), comments.length);
}
