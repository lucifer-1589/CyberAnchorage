import "@testing-library/jest-dom/vitest";

// jsdom lacks these browser APIs used by Radix / ECharts
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as any).ResizeObserver ??= RO;
Element.prototype.scrollIntoView ??= () => {};
