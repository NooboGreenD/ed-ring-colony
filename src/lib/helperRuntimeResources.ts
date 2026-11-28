/** Required root data per Helper module. Never include pilot configuration. */
export const HELPER_RUNTIME_RESOURCE_DEPENDENCIES: Readonly<Record<string, string>> = {
  'loading_goods.py': 'loading_goods.json',
  'commodity_names.py': 'commodity_names.json',
};

/** Shared by server-source collection, directory upload and release packaging. */
export const HELPER_RUNTIME_RESOURCES: readonly string[] = Object.values(HELPER_RUNTIME_RESOURCE_DEPENDENCIES);

export function missingHelperRuntimeResource(paths: Iterable<string>): string | undefined {
  const present = new Set(paths);
  return Object.entries(HELPER_RUNTIME_RESOURCE_DEPENDENCIES)
    .find(([module, resource]) => present.has(module) && !present.has(resource))?.[1];
}
