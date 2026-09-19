// Types for scripts/local-app.mjs, which plain-node launch scripts import.
export declare const LEGACY_PRODUCT_NAME: string;
export interface LocalApp {
  name: string;
  app: string;
  binary: string;
  resources: string;
  legacy: string;
}
export declare function productName(project: string): string;
export declare function localApp(project: string, name?: string): LocalApp;
export declare function staleBuild(
  paths: LocalApp,
  exists?: (path: string) => boolean,
): string | undefined;
