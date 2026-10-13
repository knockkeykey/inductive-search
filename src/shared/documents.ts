// Documents the extension opens in its own viewer instead of searching the browser's page.
export type DocumentKind = "pdf" | "docx";

export const VIEWER_PAGE = "viewer.html";
export const DOCUMENT_ACCEPT =
  ".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export function documentKind(name: string, mime = ""): DocumentKind | undefined {
  if (/^application\/pdf\b/i.test(mime)) return "pdf";
  if (/wordprocessingml\.document/i.test(mime)) return "docx";
  let path = name;
  try {
    path = new URL(name).pathname;
  } catch {
    // A plain file name.
  }
  if (/\.pdf$/i.test(path)) return "pdf";
  if (/\.docx$/i.test(path)) return "docx";
  return undefined;
}

// Legacy binary .doc is a different format; say so instead of failing to parse it.
export const isLegacyDoc = (name: string) => /\.doc$/i.test(name);

export const viewerQuery = (src: string) => `${VIEWER_PAGE}?${new URLSearchParams({ src })}`;
