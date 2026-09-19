import type { BuiltinServer } from "../../core/tools";
import { APPLE } from "./apple";

/**
 * What the tool registry (src/tools/registry.ts) can offer before the user
 * adds anything: the first-party servers the app ships, and the recipes the
 * Settings pane connects community servers and the coding agent with.
 */
export const BUILTIN_SERVERS: readonly BuiltinServer[] = [APPLE];
export { APPLE } from "./apple";
export { RECIPES, FOLDER, consentText, serverFromRecipe } from "./recipes";
