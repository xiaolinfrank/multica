import { toCanvas } from "html-to-image";

function isOpaqueColor(color: string): boolean {
  if (!color || color === "transparent" || color.includes("var(")) return false;
  const alpha = color.includes("/")
    ? color.split("/")[1]?.replace(")", "").trim()
    : color.startsWith("rgba(") ? color.slice(5, -1).split(",")[3]?.trim() : undefined;
  return alpha === undefined || (alpha.endsWith("%") ? Number.parseFloat(alpha) === 100 : Number(alpha) === 1);
}

/** Ancestor surfaces are outside the captured subtree. Resolve them before
 * moving the clone so exports retain the source theme's opaque backing. */
function captureBackground(source: HTMLElement): string {
  for (let element: HTMLElement | null = source; element; element = element.parentElement) {
    const color = getComputedStyle(element).backgroundColor;
    if (isOpaqueColor(color)) return color;
  }
  // A transparent page can still expose the theme's semantic canvas token.
  const probe = document.createElement("div");
  const computed = getComputedStyle(source);
  for (let i = 0; i < computed.length; i++) {
    const property = computed.item(i);
    if (property.startsWith("--")) probe.style.setProperty(property, computed.getPropertyValue(property));
  }
  probe.style.backgroundColor = "var(--background)";
  probe.style.display = "none";
  document.body.append(probe);
  try {
    const color = getComputedStyle(probe).backgroundColor;
    if (isOpaqueColor(color)) return color;
    throw new Error("Gantt backing surface is unavailable");
  } finally {
    probe.remove();
  }
}

/** Capture the actual chart DOM, not a second renderer. Only the offscreen clone
 * is expanded; scrolling, focus and editing state in the live chart stay intact. */
export async function captureCockpitGantt(source: HTMLElement, summaryPdf = false): Promise<HTMLCanvasElement> {
  await document.fonts?.ready;
  const backgroundColor = captureBackground(source);
  const clone = source.cloneNode(true) as HTMLElement;
  const originals = [source, ...source.querySelectorAll<HTMLElement>("*")];
  const copies = [clone, ...clone.querySelectorAll<HTMLElement>("*")];
  originals.forEach((element, index) => {
    const copy = copies[index]!;
    const computed = getComputedStyle(element);
    for (let i = 0; i < computed.length; i++) {
      const property = computed.item(i);
      copy.style.setProperty(property, computed.getPropertyValue(property));
    }
    if (computed.position === "sticky") {
      copy.style.position = "relative";
      copy.style.top = "auto";
      copy.style.left = "auto";
    }
    if (element instanceof HTMLInputElement && copy instanceof HTMLInputElement) copy.value = element.value;
  });
  const viewport = source.querySelector<HTMLElement>("[data-cockpit-scroll]");
  const expanded = clone.querySelector<HTMLElement>("[data-cockpit-scroll]");
  if (!viewport || !expanded) throw new Error("Gantt viewport is unavailable");
  const width = summaryPdf && source.dataset.summaryWidth
    ? Math.min(Number(source.dataset.summaryWidth), viewport.scrollWidth) : viewport.scrollWidth;
  expanded.style.cssText += `;overflow:hidden;width:${width}px;height:${viewport.scrollHeight}px;flex:none;max-height:none`;
  clone.style.cssText += `;position:fixed;left:0;top:0;width:${width}px;height:auto;max-height:none;flex:none;overflow:hidden;z-index:-1;pointer-events:none`;
  clone.style.backgroundColor = backgroundColor;
  document.body.append(clone);
  try {
    return await toCanvas(clone, { width, height: clone.scrollHeight, pixelRatio: 2, skipAutoScale: false, backgroundColor });
  } finally {
    clone.remove();
  }
}

export function downloadCockpitPng(canvas: HTMLCanvasElement, filename: string): Promise<void> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => {
    if (!blob) { reject(new Error("PNG encoding failed")); return; }
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = filename;
    document.body.append(link);
    try { link.click(); resolve(); } finally { link.remove(); URL.revokeObjectURL(url); }
  }, "image/png"));
}

/** Slice the captured pixels into A3 landscape pages at a single scale. The
 * popup is opened synchronously by the caller, before asynchronous capture. */
export async function printCockpitGantt(canvas: HTMLCanvasElement, popup: Window, title: string): Promise<void> {
  const doc = popup.document;
  doc.title = title;
  const style = doc.createElement("style");
  style.textContent = "@page{size:A3 landscape;margin:8mm}body{margin:0}img{display:block;width:100%;break-after:page}img:last-child{break-after:auto}";
  doc.head.append(style);
  doc.body.replaceChildren();
  const pageHeight = Math.max(1, Math.floor(canvas.width * 281 / 404));
  const loads: Promise<void>[] = [];
  for (let y = 0; y < canvas.height; y += pageHeight) {
    const slice = doc.createElement("canvas");
    slice.width = canvas.width; slice.height = Math.min(pageHeight, canvas.height - y);
    const context = slice.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable");
    context.drawImage(canvas, 0, y, slice.width, slice.height, 0, 0, slice.width, slice.height);
    const image = doc.createElement("img"); image.alt = title;
    loads.push(new Promise((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("Print image failed")); }));
    image.src = slice.toDataURL("image/png");
    doc.body.append(image);
  }
  await Promise.all(loads);
  popup.focus(); popup.print();
}
