import browser from "webextension-polyfill";
import { type Excerpt, type ExcerptRequest, type ExcerptResponse, validateExcerpt } from "../shared/excerpts";

let queue = Promise.resolve();

export function handleExcerpts(request: ExcerptRequest): Promise<ExcerptResponse> {
  const result = queue.then(async (): Promise<ExcerptResponse> => {
    try {
      const stored = (await browser.storage.local.get("excerpts")) as { excerpts?: Excerpt[] };
      let excerpts = Array.isArray(stored.excerpts) ? stored.excerpts : [];
      if (request.type === "excerpt-save") {
        const draft = validateExcerpt(request.excerpt);
        if (!excerpts.some((item) => item.url === draft.url && item.text === draft.text)) {
          if (excerpts.length >= 500) throw new Error("摘录已达到 500 条，请先导出并删除不需要的记录。");
          excerpts = [{ ...draft, id: crypto.randomUUID(), createdAt: new Date().toISOString() }, ...excerpts];
        }
      } else if (request.type === "excerpt-delete") {
        excerpts = excerpts.filter((item) => item.id !== request.id);
      }
      if (request.type !== "excerpt-list") await browser.storage.local.set({ excerpts });
      return { ok: true, excerpts };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  // Serialize changes across tabs; a rejected write must not poison subsequent requests.
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
