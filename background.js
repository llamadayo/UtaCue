const extension = globalThis.browser ?? globalThis.chrome;

async function configureSidePanel() {
  if (extension?.sidePanel?.setPanelBehavior) {
    await extension.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }
}

extension?.runtime?.onInstalled.addListener(configureSidePanel);
extension?.runtime?.onStartup.addListener(configureSidePanel);
