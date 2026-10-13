import { MAX_CONDITIONS, parseConditions } from "../shared/questions";
import { element } from "./element";
import { icon } from "./icons";

const EXAMPLES = ["包含作者实际测试的结果", "给出了具体数据"];

interface Handlers {
  onChange(): void;
  onSubmit(): void;
}

// One input per condition, so lines are structured rows rather than hand-typed newlines.
export class ConditionList {
  readonly root = element("div", { class: "hunch-condition-list", role: "group", "aria-label": "搜索条件" });
  private readonly rows = element("ol", { class: "hunch-condition-rows" });
  private readonly addButton = element(
    "button",
    { type: "button", class: "hunch-add-condition" },
    icon("plus"),
    "添加条件",
  );

  constructor(private readonly handlers: Handlers) {
    this.root.append(
      this.rows,
      element(
        "div",
        { class: "hunch-condition-footer" },
        this.addButton,
        element("span", { class: "hunch-condition-hint" }, "Enter 下一条 · ⌘/Ctrl + Enter 搜索"),
      ),
    );
    this.addButton.addEventListener("click", () => this.insert()?.focus());
    this.insert();
  }

  values(): string[] {
    return parseConditions(
      this.inputs()
        .map((input) => input.value)
        .join("\n"),
    );
  }
  focus() {
    const inputs = this.inputs();
    (inputs.find((input) => !input.value.trim()) ?? inputs.at(-1))?.focus();
  }

  private inputs() {
    return [...this.rows.querySelectorAll<HTMLInputElement>(".hunch-condition-input")];
  }
  private insert(after?: HTMLElement, value = "") {
    if (this.rows.children.length >= MAX_CONDITIONS) return;
    const input = element("input", {
      type: "text",
      class: "hunch-condition-input",
      maxlength: "500",
      autocomplete: "off",
    });
    input.value = value;
    const remove = element(
      "button",
      {
        type: "button",
        class: "hunch-icon-button hunch-condition-remove",
        title: "删除条件",
        "aria-label": "删除条件",
      },
      icon("xmark"),
    );
    const row = element(
      "li",
      { class: "hunch-condition-row" },
      element("span", { class: "hunch-condition-index", "aria-hidden": "true" }),
      input,
      remove,
    );
    if (after) after.after(row);
    else this.rows.append(row);
    remove.addEventListener("click", () => {
      const neighbor = (row.previousElementSibling ?? row.nextElementSibling) as HTMLElement | null;
      this.remove(row);
      neighbor?.querySelector("input")?.focus();
    });
    input.addEventListener("input", (event) => {
      if (!(event as InputEvent).isComposing) this.handlers.onChange();
    });
    input.addEventListener("compositionend", this.handlers.onChange);
    input.addEventListener("paste", (event) => {
      const lines = parseConditions(event.clipboardData?.getData("text") ?? "");
      if (lines.length < 2) return;
      event.preventDefault();
      input.setRangeText(lines[0]!, input.selectionStart ?? 0, input.selectionEnd ?? 0, "end");
      let last: HTMLElement = row;
      for (const line of lines.slice(1)) {
        const added = this.insert(last, line);
        if (!added) break;
        last = added.closest("li")!;
      }
      this.handlers.onChange();
    });
    input.addEventListener("keydown", (event) => this.key(event, row, input));
    this.paint();
    return input;
  }
  private key(event: KeyboardEvent, row: HTMLElement, input: HTMLInputElement) {
    if (event.isComposing || event.keyCode === 229) return;
    const prev = row.previousElementSibling?.querySelector("input");
    const next = row.nextElementSibling?.querySelector("input");
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey || !input.value.trim()) return this.handlers.onSubmit();
      if (next && !next.value.trim()) return next.focus();
      const added = this.insert(row);
      if (added) added.focus();
      else this.handlers.onSubmit();
    } else if (event.key === "Backspace" && !input.value && this.rows.children.length > 1) {
      event.preventDefault();
      this.remove(row);
      (prev ?? next)?.focus();
    } else if (event.key === "ArrowUp" && prev) {
      event.preventDefault();
      prev.focus();
    } else if (event.key === "ArrowDown" && next) {
      event.preventDefault();
      next.focus();
    }
  }
  private remove(row: HTMLElement) {
    const hadText = Boolean(row.querySelector("input")?.value.trim());
    row.remove();
    if (!this.rows.children.length) this.insert();
    this.paint();
    if (hadText) this.handlers.onChange();
  }
  private paint() {
    const inputs = this.inputs();
    inputs.forEach((input, i) => {
      input.placeholder = i < EXAMPLES.length ? `例如：${EXAMPLES[i]}` : "再加一个条件";
      input.setAttribute("aria-label", `条件 ${i + 1}`);
      const remove = input.nextElementSibling as HTMLElement;
      remove.hidden = inputs.length === 1;
    });
    this.addButton.disabled = inputs.length >= MAX_CONDITIONS;
    this.addButton.lastChild!.textContent = `添加条件 ${inputs.length}/${MAX_CONDITIONS}`;
  }
}
