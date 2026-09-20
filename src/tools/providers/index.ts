import type { BuiltinServer } from "../../core/tools";
import type { LocalServer } from "../local";
import { APPLE } from "./apple";
import { FILES } from "./files";
import { WEB } from "./web";

/**
 * What the tool registry (src/tools/registry.ts) can offer before the user
 * adds anything: the first-party servers the app ships (the Apple bridge, a
 * Swift MCP binary), the tools it runs in its own process (the files tool,
 * then the web tool), and the recipes the Settings pane connects community
 * servers and the coding agent with.
 */
export const BUILTIN_SERVERS: readonly BuiltinServer[] = [APPLE];
export const LOCAL_SERVERS: readonly LocalServer[] = [FILES, WEB];
export { APPLE } from "./apple";
export { FILES } from "./files";
export { WEB } from "./web";
export { RECIPES, FOLDER, consentText, serverFromRecipe } from "./recipes";
