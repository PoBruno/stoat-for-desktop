
import { BrowserWindow, app, ipcMain, shell } from "electron";
import started from "electron-squirrel-startup";
import { join } from "node:path";

import { config } from "./native/config";
import { encerrarAnotacao, registrarAnotacao } from "./native/anotacao";
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
    registrarAnotacao();

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

  // A sobreposicao de anotacao e uma BrowserWindow. Se ela sobreviver ao
  // encerramento, o processo fica pendurado sem nenhuma janela visivel --
  // ela e `focusable: false` e `skipTaskbar`, entao ninguem consegue fecha-la.
  app.on("before-quit", () => encerrarAnotacao());

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
      // A janela DESTACADA de uma tela compartilhada e a unica excecao: ela
      // e do proprio app e precisa da referencia viva ao `opener` para
      // receber o MediaStream sem reconectar no LiveKit.
      //
      // Sem este ramo, ela cairia no `shell.openExternal` abaixo e abriria no
      // navegador padrao do sistema, fora do Stoat e sem sessao -- pior que
      // nao ter a feature.
      if (ehJanelaDestacada(url)) {
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            width: 960,
            height: 560,
            minWidth: 320,
            minHeight: 200,
            resizable: true,
            autoHideMenuBar: true,
            backgroundColor: "#000000",
            webPreferences: {
              preload: join(__dirname, "preload.js"),
              contextIsolation: true,
              nodeIntegration: false,
            },
          },
        };
      }

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

/**
 * Se esta URL e a janela destacada do proprio app.
 *
 * Checa a ORIGEM contra a do app, nao so o caminho: sem isso qualquer site
 * poderia abrir uma janela sem moldura passando `/popout` no fim da URL.
 */
function ehJanelaDestacada(url: string) {
  try {
    const alvo = new URL(url);
    return (
      alvo.origin === BUILD_URL.origin && alvo.pathname.endsWith("/popout")
    );
  } catch {
    return false;
  }
}

/**
 * Fixa a janela destacada sobre as demais.
 *
 * `fromWebContents(event.sender)` resolve QUAL janela pediu, entao nao ha id
 * para rastrear nem mapa para manter em sincronia.
 *
 * Nivel `screen-saver` e o mais alto que o Electron oferece; e o que
 * maximiza a chance de ficar sobre um jogo. **Nao funciona sobre tela cheia
 * exclusiva no Windows** -- ali o jogo assume o compositor. Funciona sobre
 * borderless windowed, que e o padrao da maioria dos jogos modernos.
 */
ipcMain.on("popoutAlwaysOnTop", (event, ligado: boolean) => {
  const janela = BrowserWindow.fromWebContents(event.sender);
  if (!janela || janela === mainWindow) return;
  janela.setAlwaysOnTop(!!ligado, "screen-saver");
});
