
import { BrowserWindow, app, shell } from "electron";
import started from "electron-squirrel-startup";

import { config } from "./native/config";
import { initDiscordRpc } from "./native/discordRpc";
import { initTray } from "./native/tray";
import { initVirtualMic } from "./native/virtualMic";
import { BUILD_URL, createMainWindow, mainWindow } from "./native/window";

// Squirrel-specific logic
// create/remove shortcuts on Windows when installing / uninstalling
// we just need to close out of the app immediately
if (started) {
  app.quit();
}

// disable hw-accel if so requested
if (!config.hardwareAcceleration) {
  app.disableHardwareAcceleration();
}

// Wayland: rodar nativo e capturar tela pelo portal.
//
// Sem estas duas coisas o Electron cai no XWayland, e ali o compartilhamento
// de tela ou nao lista nada ou entrega uma janela preta — o compositor nao
// deixa um cliente X enxergar as janelas dos outros. O sintoma parece defeito
// do aplicativo e e o servidor grafico fazendo o que deve.
//
// - `ozone-platform-hint=auto` usa Wayland quando ha sessao Wayland, e X11
//   quando nao ha. Nao quebra quem esta em X11.
// - `WebRTCPipeWireCapturer` faz o Chromium pedir a tela ao
//   `xdg-desktop-portal`, que e quem mostra o seletor do sistema e devolve o
//   fluxo pelo PipeWire. E o mesmo caminho que o Discord usa.
//
// Fica antes de `app.whenReady()` de proposito: switches lidos depois disso
// sao ignorados sem aviso.
if (process.platform === "linux") {
  app.commandLine.appendSwitch("ozone-platform-hint", "auto");
  app.commandLine.appendSwitch(
    "enable-features",
    "WebRTCPipeWireCapturer,WaylandWindowDecorations",
  );
}

// ensure only one copy of the application can run
const acquiredLock = app.requestSingleInstanceLock();

// Auto-update desativado neste fork.
//
// O `update-electron-app` deriva o feed de `package.json.repository`, que
// apontava para o repositorio oficial do Stoat. Mantido ligado, o app se
// atualizaria para o binario oficial e perderia o dominio padrao configurado
// em src/native/window.ts. Para religar, aponte `repository` para o seu
// proprio fork e publique releases la.

if (acquiredLock) {
  // create and configure the app when electron is ready
  app.on("ready", () => {
    // create window and application contexts
    createMainWindow();

    // save first launch state
    if (config.firstLaunch) {
      // Doesn't do anything right now. Used to enable auto start, but that behaviour was removed.
      // Left in case it gets used in the future.
      config.firstLaunch = false;
    }

    initTray();
    initDiscordRpc();
    initVirtualMic();

    // Windows specific fix for notifications
    if (process.platform === "win32") {
      app.setAppUserModelId("chat.stoat.StoatDesktop");
    }
  });

  // focus the window if we try to launch again
  app.on("second-instance", () => {
    mainWindow.show();
    mainWindow.restore();
    mainWindow.focus();
  });

  // macOS specific behaviour to keep app active in dock:
  // (irrespective of the minimise-to-tray option)

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // ensure URLs launch in external context
  app.on("web-contents-created", (_, contents) => {
    // prevent navigation out of build URL origin
    contents.on("will-navigate", (event, navigationUrl) => {
      if (new URL(navigationUrl).origin !== BUILD_URL.origin) {
        event.preventDefault();
      }
    });

    // handle links externally
    contents.setWindowOpenHandler(({ url }) => {
      if (
        url.startsWith("http:") ||
        url.startsWith("https:") ||
        url.startsWith("mailto:")
      ) {
        setImmediate(() => {
          shell.openExternal(url);
        });
      }

      return { action: "deny" };
    });
  });
} else {
  app.quit();
}
