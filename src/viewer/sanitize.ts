// Word documents are untrusted input. mammoth emits a small set of tags, but a crafted file can
// still carry links or attributes we don't want, so rebuild the tree from an allowlist.

const ALLOWED = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "table",
  "thead",
  "tbody",
  "tr",
  "td",
  "th",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "sub",
  "sup",
  "br",
  "a",
  "img",
  "blockquote",
  "pre",
  "code",
]);
// Elements whose content must be dropped along with the element.
const DROP = new Set(["script", "style", "iframe", "object", "embed", "template", "noscript", "svg", "math"]);

const safeHref = (value: string) => /^(https?:|mailto:|#)/i.test(value.trim());
const safeSrc = (value: string) => /^data:image\/(png|jpe?g|gif|webp|bmp);base64,/i.test(value.trim());

export function sanitize(html: string, doc: Document = document): DocumentFragment {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const out = doc.createDocumentFragment();
  const copy = (from: Node, to: Node) => {
    for (const node of from.childNodes) {
      if (node.nodeType === 3) {
        to.appendChild(doc.createTextNode(node.textContent ?? ""));
        continue;
      }
      if (node.nodeType !== 1) continue;
      const el = node as Element;
      const tag = el.localName;
      if (DROP.has(tag)) continue;
      if (!ALLOWED.has(tag)) {
        // Unknown wrappers keep their text.
        copy(el, to);
        continue;
      }
      const clean = doc.createElement(tag);
      if (tag === "a") {
        const href = el.getAttribute("href") ?? "";
        if (safeHref(href)) {
          clean.setAttribute("href", href);
          if (!href.startsWith("#")) {
            clean.setAttribute("target", "_blank");
            clean.setAttribute("rel", "noreferrer noopener");
          }
        }
      } else if (tag === "img") {
        const src = el.getAttribute("src") ?? "";
        if (!safeSrc(src)) continue;
        clean.setAttribute("src", src);
        clean.setAttribute("alt", el.getAttribute("alt") ?? "");
      } else if (tag === "td" || tag === "th") {
        for (const name of ["colspan", "rowspan"]) {
          const value = el.getAttribute(name);
          if (value && /^\d{1,3}$/.test(value)) clean.setAttribute(name, value);
        }
      }
      copy(el, clean);
      to.appendChild(clean);
    }
  };
  copy(parsed.body, out);
  return out;
}
