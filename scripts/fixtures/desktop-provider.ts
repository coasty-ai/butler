// Loaded only by the opt-in smoke harness inside a real Electron main process.
// Uses the same factory as the application; no renderer IPC or desktop capture.
import { createDesktopProvider } from "../../electron/provider";
import { importEnvCredentials, providerKey } from "../../electron/credentials";
import type {
  Observation,
  ProviderResult,
  Settings,
} from "../../src/core/schema";

export async function next(input: {
  settings: Settings;
  observation: Observation;
  envFile: string;
}): Promise<ProviderResult> {
  // The result (including any problem string) crosses the Playwright boundary
  // as plain JSON; the frame alias is already mapped back to the real id.
  const keys = importEnvCredentials(input.envFile, {});
  return createDesktopProvider(
    input.settings,
    providerKey(keys, input.settings),
  ).next(input.observation, AbortSignal.timeout(65000));
}
