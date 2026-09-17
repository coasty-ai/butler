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
  it("redacts only the credential span and keeps ordinary labels", () => {
    const result = cleanScreenContext({
      appName: "Safari",
      windowTitle: "Reset your password: Step 1",
      visibleText:
        "Sign in to Example. Password: Forgot? MFA: enabled. api_key=sk-fixtureSECRET123456 Continue",
    });
    expect(result?.windowTitle).toBe("Reset your password: Step 1");
    expect(result?.visibleText).toContain("Sign in to Example.");
    expect(result?.visibleText).toContain("Password: Forgot?");
    expect(result?.visibleText).toContain("MFA: enabled.");
    expect(result?.visibleText).toContain("[Sensitive text omitted] Continue");
    expect(result?.visibleText).not.toContain("fixtureSECRET");
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
  it("keeps bounded grounded controls and redacts credential labels", () => {
    const controls = [
      { role: "button", label: "2", x: 0.318, y: 0.524 },
      {
        role: "textfield",
        label: "token=sk-fixtureSECRET123456",
        x: 0.5,
        y: 0.1,
      },
      { role: "button", x: 0.9, y: 0.9, enabled: false },
    ];
    const result = cleanScreenContext({
      appName: "Calculator",
      windowTitle: "Calculator",
      controls,
    });
    expect(result?.controls?.[0]).toEqual(controls[0]);
    expect(result?.controls?.[1].label).not.toContain("fixtureSECRET");
    expect(result?.controls?.[2]).toEqual(controls[2]);
    const long = cleanScreenContext({
      appName: "A".repeat(400),
      windowTitle: "B",
      controls: [{ role: "link", label: "नमस्ते".repeat(30), x: 0.1, y: 0.1 }],
    });
    expect(long?.appName).toHaveLength(300);
    expect(long?.controls?.[0].label?.length).toBeLessThanOrEqual(80);
    expect(cleanScreenContext(long)).toBeDefined();
    for (const bad of [
      [{ role: "button", x: 1.5, y: 0.2 }],
      [{ role: "button", x: 0.2, y: 0.2, value: "secret" }],
      Array.from({ length: 61 }, () => ({ role: "button", x: 0.1, y: 0.1 })),
    ])
      expect(
        cleanScreenContext({ appName: "A", windowTitle: "B", controls: bad }),
      ).toBeUndefined();
  });
});
