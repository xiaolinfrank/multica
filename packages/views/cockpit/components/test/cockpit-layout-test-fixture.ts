import { vi } from "vitest";

/** jsdom has no layout. Supply viewport/row geometry while keeping the real virtualizer and scroll behavior. */
export function installCockpitTestLayout() {
  const height = (element: HTMLElement) => element.hasAttribute("data-index") ? element.tagName === "TR" ? 56 : element.tagName === "LI" ? 70 : 32 : 600;
  const spies = [
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) { return height(this); }),
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(1200),
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600),
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200),
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) { return new DOMRect(0, 0, 1200, height(this)); }),
  ];
  const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: function (this: HTMLElement, options: ScrollToOptions | number, y?: number) {
    this.scrollTop = typeof options === "number" ? y ?? this.scrollTop : options.top ?? this.scrollTop;
    this.scrollLeft = typeof options === "number" ? options : options.left ?? this.scrollLeft;
    queueMicrotask(() => this.dispatchEvent(new Event("scroll")));
  } });
  return () => {
    for (const spy of spies) spy.mockRestore();
    if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScrollTo);
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  };
}
