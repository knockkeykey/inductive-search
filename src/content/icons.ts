// Hand-drawn line icons in the spirit of SF Symbols (which can't be redistributed on the web).
const PATHS = {
  chevronUp: "M5 12.5 10 7.5l5 5",
  chevronDown: "M5 7.5l5 5 5-5",
  xmark: "M6 6l8 8M14 6l-8 8",
  arrowUp: "M10 16V4.5M5 9.5l5-5 5 5",
  plus: "M10 4.5v11M4.5 10h11",
  magnifier: "M8.75 14a5.25 5.25 0 1 0 0-10.5 5.25 5.25 0 0 0 0 10.5zM12.5 12.5l4 4",
  sparkles:
    "M10 3l1.6 4.4L16 9l-4.4 1.6L10 15l-1.6-4.4L4 9l4.4-1.6zM15.5 13.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z",
  warning: "M10 3.5 17 16H3zM10 8.5v3.5M10 14.25v.25",
  sun: "M10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM10 2.5v1.5M10 16v1.5M2.5 10H4M16 10h1.5M4.7 4.7l1.06 1.06M14.24 14.24l1.06 1.06M4.7 15.3l1.06-1.06M14.24 5.76l1.06-1.06",
  moon: "M16 12.2A6.5 6.5 0 0 1 7.8 4a6.5 6.5 0 1 0 8.2 8.2z",
  circleHalf: "M10 16.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM10 3.5v13",
  viewfinder:
    "M3.5 7V5.5a2 2 0 0 1 2-2H7M13 3.5h1.5a2 2 0 0 1 2 2V7M16.5 13v1.5a2 2 0 0 1-2 2H13M7 16.5H5.5a2 2 0 0 1-2-2V13M7 8h6M7 10.5h6M7 13h3.5",
  refresh: "M15.5 8A6 6 0 0 0 4.6 6.5M4.5 3.5v3h3M4.5 12a6 6 0 0 0 10.9 1.5M15.5 16.5v-3h-3",
  gear: "M15.17 7.86L15.43 8.65L17.26 8.56L17.26 11.44L15.43 11.35L15.17 12.14L14.8 12.89L16.15 14.11L14.11 16.15L12.89 14.8L12.14 15.17L11.35 15.43L11.44 17.26L8.56 17.26L8.65 15.43L7.86 15.17L7.11 14.8L5.89 16.15L3.85 14.11L5.2 12.89L4.83 12.14L4.57 11.35L2.74 11.44L2.74 8.56L4.57 8.65L4.83 7.86L5.2 7.11L3.85 5.89L5.89 3.85L7.11 5.2L7.86 4.83L8.65 4.57L8.56 2.74L11.44 2.74L11.35 4.57L12.14 4.83L12.89 5.2L14.11 3.85L16.15 5.89L14.8 7.11zM10 12.4a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8z",
  copy: "M7.5 7.5V5a1.5 1.5 0 0 1 1.5-1.5h6A1.5 1.5 0 0 1 16.5 5v6a1.5 1.5 0 0 1-1.5 1.5h-2.5M5 7.5h6A1.5 1.5 0 0 1 12.5 9v6a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 15V9A1.5 1.5 0 0 1 5 7.5z",
  reset: "M4 10a6 6 0 1 0 1.76-4.24L4 7.5M4 3.5v4h4",
  checkmark: "M4.5 10.5l3.5 3.5 7.5-8",
  question: "M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM7.9 7.9a2.15 2.15 0 1 1 3 2c-.55.25-.9.8-.9 1.4v.45M10 14.1v.15",
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
