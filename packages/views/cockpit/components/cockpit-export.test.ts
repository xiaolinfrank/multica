import { describe, it, expect, vi, afterEach } from "vitest";
import { toCanvas } from "html-to-image";
import { captureCockpitGantt, downloadCockpitPng, printCockpitGantt } from "./cockpit-export";
vi.mock("html-to-image", () => ({ toCanvas: vi.fn() }));
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.clearAllMocks(); });
function chart() {
  const root = document.createElement("div");
  root.dataset.summaryWidth = "900";
  root.style.backgroundColor = "rgb(255, 255, 255)";
  root.innerHTML = '<div data-cockpit-scroll style="overflow:auto"><div style="position:sticky;left:0">Task</div></div>';
  const viewport = root.firstElementChild as HTMLElement;
  Object.defineProperties(viewport, { scrollWidth: { value: 1800 }, scrollHeight: { value: 1200 } });
  viewport.scrollLeft = 400; viewport.scrollTop = 300;
  document.body.append(root);
  return { root, viewport };
}
describe("actual Gantt DOM capture (mocked rasterizer, not browser acceptance)", () => {
  it("expands full content and removes sticky positioning on a clone, leaving the live viewport untouched", async () => {
    const { root, viewport } = chart();
    const canvas = document.createElement("canvas");
    vi.mocked(toCanvas).mockImplementation(async (clone, options) => {
      expect(clone).not.toBe(root);
      expect(clone.isConnected).toBe(true);
      expect(options?.width).toBe(1800);
      expect(options?.backgroundColor).toBe("rgb(255, 255, 255)");
      expect(clone.style.backgroundColor).toBe("rgb(255, 255, 255)");
      expect(clone.querySelector<HTMLElement>("[data-cockpit-scroll]")?.style.height).toBe("1200px");
      expect(clone.querySelector<HTMLElement>("[data-cockpit-scroll] > div")?.style.position).toBe("relative");
      return canvas;
    });
    expect(await captureCockpitGantt(root)).toBe(canvas);
    expect(document.body.children).toHaveLength(1);
    expect(viewport.scrollLeft).toBe(400); expect(viewport.scrollTop).toBe(300);
    expect(viewport.style.overflow).toBe("auto");
  });
  it("applies summary PDF cutoff only to the clone and restores on capture failure", async () => {
    const { root } = chart();
    vi.mocked(toCanvas).mockImplementation(async (_clone, options) => { expect(options?.width).toBe(900); throw new Error("raster failed"); });
    await expect(captureCockpitGantt(root, true)).rejects.toThrow("raster failed");
    expect(document.body.children).toHaveLength(1);
    expect(root.style.width).toBe("");
  });
  it.each([
    ["dark", "rgb(19, 23, 32)"],
    ["light", "rgb(246, 247, 249)"],
  ])("captures the opaque %s ancestor surface for both PNG and PDF without changing the live chart", async (_theme, color) => {
    const { root, viewport } = chart();
    root.style.backgroundColor = "transparent";
    const ancestor = document.createElement("section");
    ancestor.style.backgroundColor = color;
    const transparentParent = document.createElement("div");
    transparentParent.style.backgroundColor = "rgba(0, 0, 0, 0)";
    document.body.append(ancestor);
    ancestor.append(transparentParent);
    transparentParent.append(root);
    const canvas = document.createElement("canvas");
    vi.mocked(toCanvas).mockImplementation(async (clone, options) => {
      expect(options?.backgroundColor).toBe(getComputedStyle(ancestor).backgroundColor);
      expect(getComputedStyle(clone).backgroundColor).toBe(color);
      return canvas;
    });
    for (const summaryPdf of [false, true]) {
      expect(await captureCockpitGantt(root, summaryPdf)).toBe(canvas);
      expect(document.body.children).toHaveLength(1);
      expect(root.parentElement).toBe(transparentParent);
      expect(root.style.backgroundColor).toBe("transparent");
      expect(viewport.scrollLeft).toBe(400);
      expect(viewport.scrollTop).toBe(300);
    }
    vi.mocked(toCanvas).mockRejectedValueOnce(new Error("raster failed"));
    await expect(captureCockpitGantt(root)).rejects.toThrow("raster failed");
    expect(document.body.children).toHaveLength(1);
    expect(root.style.backgroundColor).toBe("transparent");
  });
  it("fails rather than exporting transparency when neither ancestors nor theme provide an opaque surface", async () => {
    const { root, viewport } = chart();
    root.style.backgroundColor = "transparent";
    await expect(captureCockpitGantt(root)).rejects.toThrow("backing surface is unavailable");
    expect(toCanvas).not.toHaveBeenCalled();
    expect(document.body.children).toHaveLength(1);
    expect(viewport.scrollLeft).toBe(400);
    expect(root.style.backgroundColor).toBe("transparent");
  });
  it("rejects failed PNG encoding", async () => {
    const canvas = document.createElement("canvas");
    vi.spyOn(canvas, "toBlob").mockImplementation((callback) => callback(null));
    await expect(downloadCockpitPng(canvas, "board.png")).rejects.toThrow("encoding failed");
  });
  it("paginates captured pixels at a consistent landscape scale and waits for every image before printing", async () => {
    const doc = document.implementation.createHTMLDocument();
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,test");
    const canvas = document.createElement("canvas"); canvas.width = 404; canvas.height = 600;
    const popup = { document: doc, focus: vi.fn(), print: vi.fn() };
    const result = printCockpitGantt(canvas, popup as unknown as Window, "<Board>");
    expect(doc.querySelectorAll("img")).toHaveLength(3);
    expect(drawImage.mock.calls.map((call) => call[2])).toEqual([0, 281, 562]);
    expect(popup.print).not.toHaveBeenCalled();
    doc.querySelectorAll("img").forEach((image) => image.dispatchEvent(new Event("load")));
    await result; expect(popup.print).toHaveBeenCalledOnce();
    expect(doc.title).toBe("<Board>");
  });
});
