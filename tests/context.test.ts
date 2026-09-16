import { describe, it, expect } from "vitest";
import { cleanScreenContext } from "../src/core/context";
describe("bounded screen context", () => {
  it("retains references while removing detected credentials", () => {
    const result = cleanScreenContext({
      appName: "Preview",
      windowTitle: "September report.pdf",
      selectedText: "Email Lawrence at lawrence@example.com",
      launcher: {
        query: "Chrome",
        selectedResult: "Chrome Remote Desktop Host Uninstaller",
      },
      visibleText: "password=fixture_secret",
      documentName: "September report.pdf",
      recentWindows: [{ appName: "Numbers", title: "Investors" }],
      recentFiles: ["Investors.xlsx"],
      recentTasks: [{ task: "Open the report", status: "completed" }],
    });
    expect(result?.selectedText).toContain("lawrence@example.com");
    expect(result?.launcher?.selectedResult).toBe(
      "Chrome Remote Desktop Host Uninstaller",
    );
    expect(result?.visibleText).not.toContain("fixture_secret");
    expect(result?.recentWindows?.[0].title).toBe("Investors");
  });
  it("rejects unbounded context and unknown capability fields", () => {
    expect(
      cleanScreenContext({ appName: "x", windowTitle: "x", shell: "ls" }),
    ).toBeUndefined();
    expect(
      cleanScreenContext({
        appName: "x",
        windowTitle: "x",
        selectedText: "x".repeat(2001),
      }),
    ).toBeUndefined();
  });
});
