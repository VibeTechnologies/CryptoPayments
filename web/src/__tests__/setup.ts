import "@testing-library/jest-dom/vitest";

// Mock window.Telegram for all tests
Object.defineProperty(window, "Telegram", {
  value: undefined,
  writable: true,
  configurable: true,
});

// Mock navigator.clipboard
Object.defineProperty(navigator, "clipboard", {
  value: {
    writeText: vi.fn().mockResolvedValue(undefined),
    readText: vi.fn().mockResolvedValue(""),
  },
  writable: true,
  configurable: true,
});
