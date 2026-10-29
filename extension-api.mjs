// Both Safari and current Chromium expose Promise-based WebExtension APIs.
// Keep this adapter free of native-app or background-worker dependencies.
export function getExtensionApi() {
  return globalThis.browser ?? globalThis.chrome ?? null;
}

export const extensionApi = getExtensionApi();
export const isExtensionContext = Boolean(extensionApi?.storage?.local && extensionApi?.tabs);
