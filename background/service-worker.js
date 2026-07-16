(function installOpenVideoCatcherBackground() {
  "use strict";

  if (typeof importScripts === "function") {
    if (!globalThis.OpenVideoCatcherUtils) importScripts("../src/media-utils.js");
    if (!globalThis.OpenVideoCatcherBackgroundCore) importScripts("core.js");
  }

  if (globalThis.__openVideoCatcherBackgroundInstalled) return;
  const core = globalThis.OpenVideoCatcherBackgroundCore;
  const utils = globalThis.OpenVideoCatcherUtils;
  const api = globalThis.browser || globalThis.chrome;
  const apiMode = globalThis.browser ? "promise" : "callback";
  if (!core || !utils || !api) return;

  globalThis.__openVideoCatcherBackgroundInstalled = true;
  globalThis.__openVideoCatcherBackgroundCore = core.installBackground({ api, apiMode, utils });
})();
