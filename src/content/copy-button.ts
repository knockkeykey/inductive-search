import { element } from "./element";
import type { Hit } from "./hits";
import { icon } from "./icons";

const SIZE = 20;
// Room for the score badge that sits on the paragraph's top-right corner.
const BADGE = 46;
const EDGE = 4;

// A copy button pinned beside the score badge of the hovered paragraph (or the current one).
// It lives in the shadow UI rather than the page, so the page's DOM and text stay untouched.
export class CopyButton {
  readonly root = element("button", {
    type: "button",
    class: "hunch-copy",
    title: "复制段落",
    "aria-label": "复制段落",
    hidden: "",
  });
  private hits: readonly Hit[] = [];
  private current: Hit | undefined;
  private hovered: HTMLElement | undefined;
  // Paragraph whose score badge is held visible while the pointer is over this button.
  private held: HTMLElement | undefined;
  private frame = 0;
  private doneTimer: number | undefined;

  constructor(private readonly onCopied: (ok: boolean) => void) {
    this.root.append(icon("copy"));
    this.root.addEventListener("pointerenter", () => this.hold(this.target));
    this.root.addEventListener("pointerleave", () => this.hold(undefined));
    this.root.addEventListener("click", () => void this.copy());
    document.addEventListener(
      "pointerover",
      (event) => {
        const target = event.target instanceof Element ? event.target : undefined;
        // Moving onto the button itself is retargeted to the UI host; keep the paragraph it belongs to.
        if (target?.localName === "hunch-ui") return;
        const el = target?.closest<HTMLElement>(".hunch-hl") ?? undefined;
        if (el === this.hovered) return;
        this.hovered = el;
        this.schedule();
      },
      { passive: true },
    );
    document.addEventListener("scroll", () => this.schedule(), { capture: true, passive: true });
    window.addEventListener("resize", () => this.schedule());
  }

  update(hits: readonly Hit[], current: Hit | undefined) {
    this.hits = hits;
    this.current = current;
    this.layout();
  }

  private get target(): HTMLElement | undefined {
    const hovered = this.hovered && this.hits.some((hit) => hit.el === this.hovered) ? this.hovered : undefined;
    return hovered ?? this.current?.el;
  }

  // Leaving the paragraph for the button would hide the badge it sits beside; keep it shown.
  private hold(el: HTMLElement | undefined) {
    this.held?.classList.remove("hunch-hover");
    this.held = el;
    el?.classList.add("hunch-hover");
  }

  private schedule() {
    if (!this.frame) this.frame = requestAnimationFrame(() => this.layout());
  }

  private layout() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    const el = this.target;
    const rect = el?.isConnected ? viewportRect(el) : undefined;
    const visible = rect && rect.bottom > 0 && rect.top < window.innerHeight && rect.width > SIZE + BADGE;
    this.root.hidden = !visible;
    if (!visible) return;
    // Match the paragraph's palette, which follows the page background rather than the bar theme.
    this.root.classList.toggle("hunch-copy-dark", !!el?.classList.contains("hunch-dark"));
    const left = Math.min(rect.right - BADGE - SIZE, window.innerWidth - SIZE - EDGE);
    const top = Math.max(rect.top - 4 - SIZE / 2, EDGE);
    Object.assign(this.root.style, { left: `${Math.max(left, EDGE)}px`, top: `${top}px` });
  }

  private async copy() {
    const el = this.target;
    if (!el) return;
    // One element can hold several split blocks; copy them all, in reading order.
    const text = this.hits
      .filter((hit) => hit.el === el)
      .map((hit) => hit.text)
      .join("\n");
    const ok = await writeClipboard(text || el.innerText.trim(), this.root);
    this.onCopied(ok);
    if (!ok) return;
    clearTimeout(this.doneTimer);
    this.root.replaceChildren(icon("checkmark"));
    this.root.classList.add("hunch-copy-done");
    this.doneTimer = window.setTimeout(() => {
      this.root.replaceChildren(icon("copy"));
      this.root.classList.remove("hunch-copy-done");
    }, 1500);
  }
}

// The async clipboard API can be refused (insecure page, permissions policy); fall back to execCommand.
async function writeClipboard(text: string, anchor: HTMLElement): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = element("textarea", { class: "hunch-copy-buffer", "aria-hidden": "true" });
    area.value = text;
    anchor.after(area);
    area.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      area.remove();
      anchor.focus();
    }
  }
}

// Rect in the top window's viewport, adding the offsets of any same-origin frames on the way up.
function viewportRect(el: HTMLElement): DOMRect {
  const r = el.getBoundingClientRect();
  let { left, top } = r;
  let view = el.ownerDocument.defaultView;
  while (view && view !== window) {
    const frame = view.frameElement as HTMLElement | null;
    if (!frame) break;
    const f = frame.getBoundingClientRect();
    left += f.left;
    top += f.top;
    view = frame.ownerDocument.defaultView;
  }
  return new DOMRect(left, top, r.width, r.height);
}
