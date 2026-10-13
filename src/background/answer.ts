import type { NoulResponse } from "@typesafe-ai/sdk";
import { createClient, PROVIDERS } from "../shared/api";
import { type Block, type BlockId, type Progress, pageText, type Search } from "../shared/protocol";
import {
  combineConditions,
  conditionId,
  conditionQuestions,
  MAX_CHUNK_BLOCKS,
  MAX_CHUNK_CHARS,
  MAX_CONCURRENT_REQUESTS,
  MAX_CONDITIONS,
  questionsFor,
} from "../shared/questions";
import type { Settings } from "../shared/settings";

export async function answer(
  req: Search,
  settings: Settings,
  signal: AbortSignal,
  emit: (p: Progress) => void,
): Promise<void> {
  const client = createClient(settings);
  const conditions = req.mode === "conditions" ? (req.conditions ?? []) : [];
  if (req.mode === "conditions" && (!conditions.length || conditions.length > MAX_CONDITIONS)) {
    throw new Error(`请输入 1 至 ${MAX_CONDITIONS} 个条件。`);
  }
  // OpenLux lists a 32k-token context. Leave more room for the per-block questions.
  const budget =
    settings.provider === "openlux"
      ? { chars: 12_000, blocks: 40 }
      : { chars: MAX_CHUNK_CHARS, blocks: MAX_CHUNK_BLOCKS };
  const chunks = chunkByBudget(req.blocks, {
    ...budget,
    blocks: Math.max(1, Math.floor(budget.blocks / Math.max(1, conditions.length))),
  });

  const started = performance.now();
  const scores: Record<BlockId, number> = {};
  const conditionScores: Record<BlockId, number[]> = {};
  let done = 0;
  let failed = 0;
  let firstError: unknown;
  const report = () =>
    emit({
      type: "progress",
      scores: { ...scores },
      done,
      total: chunks.length,
      failed,
      ms: Math.round(performance.now() - started),
      ...(conditions.length ? { conditionScores: { ...conditionScores } } : {}),
    });

  if (chunks.length === 0) return report();

  await parallel(chunks, MAX_CONCURRENT_REQUESTS, signal, async (blocks) => {
    try {
      const result = await client.systemOne(
        {
          state: { url: req.url, title: req.title, page_text: pageText(blocks) },
          questions: conditions.length
            ? conditionQuestions(
                conditions,
                blocks.map((b) => b.id),
              )
            : questionsFor(
                req.query,
                blocks.map((b) => b.id),
              ),
        },
        { signal },
      );
      const chunkScores: Record<BlockId, number> = {};
      const chunkConditions: Record<BlockId, number[]> = {};
      for (const { id } of blocks) {
        const ids = conditions.length ? conditions.map((_, index) => conditionId(id, index)) : [id];
        const values = ids.map((questionId) => {
          const a = (result.answers as Record<string, NoulResponse> | undefined)?.[questionId];
          if (
            a?.type !== "noul" ||
            typeof a.noul !== "number" ||
            !Number.isFinite(a.noul) ||
            a.noul < 0 ||
            a.noul > 1
          ) {
            throw new Error(
              `${PROVIDERS[settings.provider].name} 返回了无效的 Jev 概率（${questionId}）。`,
            );
          }
          return a.noul;
        });
        chunkScores[id] = conditions.length ? combineConditions(values, req.combination ?? "all") : values[0]!;
        if (conditions.length) {
          chunkConditions[id] = values;
        }
      }
      Object.assign(scores, chunkScores);
      Object.assign(conditionScores, chunkConditions);
    } catch (error) {
      if (signal.aborted) return;
      firstError ??= error;
      failed++;
    }
    done++;
    report();
  });
  if (!signal.aborted && failed === chunks.length) {
    throw firstError instanceof Error ? firstError : new Error("所有搜索请求均失败。");
  }
}

async function parallel<T>(items: T[], limit: number, signal: AbortSignal, work: (item: T) => Promise<void>) {
  let index = 0;
  const worker = async () => {
    while (index < items.length && !signal.aborted) await work(items[index++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function chunkByBudget(blocks: Block[], budget = { chars: MAX_CHUNK_CHARS, blocks: MAX_CHUNK_BLOCKS }): Block[][] {
  const out: Block[][] = [];
  let current: Block[] = [];
  let chars = 0;
  for (const b of blocks) {
    if (current.length && (chars + b.text.length > budget.chars || current.length >= budget.blocks)) {
      out.push(current);
      current = [];
      chars = 0;
    }
    current.push(b);
    chars += b.text.length;
  }
  if (current.length) out.push(current);
  return out;
}
