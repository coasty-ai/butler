import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultSettings } from "../src/core/schema";
import { selectProvider } from "../src/providers/catalog";
import {
  forgetToolSecrets,
  importEnvCredentials,
  importLaunchCredentials,
  providerKey,
  toolSecrets,
  withProviderKey,
  withToolSecret,
} from "../electron/credentials";

const roots: string[] = [];
function fixture(content: string) {
  const root = mkdtempSync(join(tmpdir(), "butler-credentials-"));
  roots.push(root);
  const file = join(root, ".env");
  writeFileSync(file, content, { mode: 0o600 });
  return file;
}
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);
describe("local credential import", () => {
  it("imports only provider keys without executing or loading environment directives", () => {
    const file = fixture(
      'OPENAI_API_KEY="test-openai"\nANTHROPIC_API_KEY=test-anthropic\nGEMINI_API_KEY=test-google\nNODE_OPTIONS=--inspect\nOPEN_ASSIST_TEST_INJECTION=$(touch should-not-exist)\n',
    );
    const keys = importEnvCredentials(file, {});
    expect(Object.keys(keys)).toHaveLength(3);
    expect(providerKey(keys, selectProvider(defaultSettings, "openai"))).toBe(
      "test-openai",
    );
    expect(providerKey(keys, selectProvider(defaultSettings, "google"))).toBe(
      "test-google",
    );
    expect(process.env.OPEN_ASSIST_TEST_INJECTION).toBeUndefined();
    expect(JSON.stringify(keys)).not.toContain("NODE_OPTIONS");
  });
  it("preserves privacy and model unless provider selection is explicit", () => {
    const file = fixture("OPENAI_API_KEY=test-openai");
    const imported = importLaunchCredentials(
      ["--import-env", file],
      defaultSettings,
      {},
    );
    expect(imported?.settings).toEqual(defaultSettings);
    expect(importLaunchCredentials([], defaultSettings, {})).toBeUndefined();
    const selected = importLaunchCredentials(
      ["--import-env", file, "--provider", "openai"],
      defaultSettings,
      {},
    );
    expect(selected?.settings.privacy).toBe("PRIVATE_BYOM");
    expect(selected?.settings.model).toBe("gpt-5.4-mini");
  });
  it("isolates keys across providers, endpoint paths and custom endpoints", () => {
    const openai = selectProvider(defaultSettings, "openai");
    const keys = withProviderKey({}, openai, "saved-key");
    expect(
      providerKey(keys, { ...openai, endpoint: openai.endpoint + "/" }),
    ).toBe("saved-key");
    expect(
      providerKey(keys, {
        ...openai,
        endpoint: openai.endpoint + "/different",
      }),
    ).toBe("");
    expect(providerKey(keys, { ...openai, provider: "compatible" })).toBe("");
    expect(
      providerKey(keys, selectProvider(defaultSettings, "anthropic")),
    ).toBe("");
    expect(providerKey(withProviderKey(keys, openai, ""), openai)).toBe("");
  });
  it("rejects missing, oversized or invalid imports without revealing secrets or modifying existing keys", () => {
    const keys = withProviderKey(
      {},
      selectProvider(defaultSettings, "openai"),
      "original-key",
    );
    expect(() => importEnvCredentials("relative.env", keys)).toThrow(
      "Could not import",
    );
    expect(() =>
      importEnvCredentials(fixture("OTHER_KEY=sensitive-value"), keys),
    ).toThrow("Could not import");
    const invalid = fixture(
      "OPENAI_API_KEY=new-key\nANTHROPIC_API_KEY=" + "x".repeat(1001),
    );
    expect(() => importEnvCredentials(invalid, keys)).toThrow(
      "Could not import",
    );
    expect(providerKey(keys, selectProvider(defaultSettings, "openai"))).toBe(
      "original-key",
    );
    expect(() =>
      importEnvCredentials(fixture("x".repeat(65537)), keys),
    ).toThrow("Could not import");
  });
  it("requires an imported key for an explicitly selected cloud provider", () => {
    const file = fixture("OPENAI_API_KEY=test-openai");
    expect(() =>
      importLaunchCredentials(
        ["--import-env", file, "--provider", "google"],
        defaultSettings,
        {},
      ),
    ).toThrow("no imported API key");
  });
});
describe("tool server secrets", () => {
  it("keeps one server's variables and headers in their own scopes", () => {
    const openai = selectProvider(defaultSettings, "openai");
    let keys = withProviderKey({}, openai, "provider-key");
    keys = withToolSecret(keys, "github", "env", "GITHUB_TOKEN", "ghp_x");
    keys = withToolSecret(
      keys,
      "github",
      "header",
      "Authorization",
      "Bearer t",
    );
    keys = withToolSecret(keys, "slack", "header", "Authorization", "Bearer s");
    expect(
      Object.keys(keys)
        .filter((k) => k.startsWith("mcp:"))
        .sort(),
    ).toEqual([
      "mcp:github:env:GITHUB_TOKEN",
      "mcp:github:header:Authorization",
      "mcp:slack:header:Authorization",
    ]);
    expect(Object.keys(keys)).toHaveLength(4);
    expect(toolSecrets(keys, "github")).toEqual({
      env: { GITHUB_TOKEN: "ghp_x" },
      headers: { Authorization: "Bearer t" },
    });
    expect(toolSecrets(keys, "slack")).toEqual({
      env: {},
      headers: { Authorization: "Bearer s" },
    });
    expect(toolSecrets(keys, "nobody")).toEqual({ env: {}, headers: {} });
    // Never a provider key, never another server's secret.
    expect(JSON.stringify(toolSecrets(keys, "github"))).not.toContain(
      "provider-key",
    );
    expect(providerKey(keys, openai)).toBe("provider-key");
    // An empty value deletes the scope.
    const cleared = withToolSecret(keys, "github", "env", "GITHUB_TOKEN", "");
    expect(toolSecrets(cleared, "github").env).toEqual({});
  });
  it("forgets every scope of one server and nothing else", () => {
    let keys = withToolSecret({}, "github", "env", "A", "1");
    keys = withToolSecret(keys, "github", "header", "B", "2");
    keys = withToolSecret(keys, "github-2", "env", "A", "3");
    keys = withProviderKey(
      keys,
      selectProvider(defaultSettings, "openai"),
      "k",
    );
    const left = forgetToolSecrets(keys, "github");
    expect(Object.keys(left).filter((k) => k.startsWith("mcp:"))).toEqual([
      "mcp:github-2:env:A",
    ]);
    expect(providerKey(left, selectProvider(defaultSettings, "openai"))).toBe(
      "k",
    );
  });
});
