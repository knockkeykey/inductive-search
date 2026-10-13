// Hand-drawn line icons in the spirit of SF Symbols (which can't be redistributed on the web).
const PATHS = {
  chevronUp: "M5 12.5 10 7.5l5 5",
  chevronDown: "M5 7.5l5 5 5-5",
  xmark: "M6 6l8 8M14 6l-8 8",
  arrowUp: "M10 16V4.5M5 9.5l5-5 5 5",
  download: "M10 3.5v9M6 9l4 4 4-4M4 16.5h12",
  plus: "M10 4.5v11M4.5 10h11",
  magnifier: "M8.75 14a5.25 5.25 0 1 0 0-10.5 5.25 5.25 0 0 0 0 10.5zM12.5 12.5l4 4",
  sparkles:
    "M10 3l1.6 4.4L16 9l-4.4 1.6L10 15l-1.6-4.4L4 9l4.4-1.6zM15.5 13.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z",
  copy: "M7 7V5.5a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-1.5M5.5 7.5h5a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2z",
  bookmark: "M6 3.5h8a1 1 0 0 1 1 1v12l-5-3.5L5 16.5v-12a1 1 0 0 1 1-1z",
  trash: "M4 6h12M8 6V4.5h4V6M5.5 6l.8 9.6a1 1 0 0 0 1 .9h5.4a1 1 0 0 0 1-.9L14.5 6",
  warning: "M10 3.5 17 16H3zM10 8.5v3.5M10 14.25v.25",
  sun: "M10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM10 2.5v1.5M10 16v1.5M2.5 10H4M16 10h1.5M4.7 4.7l1.06 1.06M14.24 14.24l1.06 1.06M4.7 15.3l1.06-1.06M14.24 5.76l1.06-1.06",
  moon: "M16 12.2A6.5 6.5 0 0 1 7.8 4a6.5 6.5 0 1 0 8.2 8.2z",
  circleHalf: "M10 16.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM10 3.5v13",
  viewfinder:
    "M3.5 7V5.5a2 2 0 0 1 2-2H7M13 3.5h1.5a2 2 0 0 1 2 2V7M16.5 13v1.5a2 2 0 0 1-2 2H13M7 16.5H5.5a2 2 0 0 1-2-2V13M7 8h6M7 10.5h6M7 13h3.5",
} as const;

export type IconName = keyof typeof PATHS;

const SVG = "http://www.w3.org/2000/svg";

export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "hunch-icon");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", PATHS[name]);
  svg.append(path);
  return svg;
}
