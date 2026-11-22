import { Menu, Tray, nativeImage } from "electron";

import trayIconAsset from "../../assets/desktop/icon.png?asset";
import macOsTrayIconAsset from "../../assets/desktop/iconTemplate.png?asset";
import { version } from "../../package.json";

import {
  estadoDaAtualizacao,
  procurarAtualizacao,
  reiniciarEAtualizar,
} from "./atualizacao";
import { mainWindow, quitApp } from "./window";

// internal tray state
let tray: Tray = null;

// Create and resize tray icon for macOS
function createTrayIcon() {
  if (process.platform === "darwin") {
    const image = nativeImage.createFromDataURL(macOsTrayIconAsset);
    const resized = image.resize({ width: 20, height: 20 });
    resized.setTemplateImage(true);
    return resized;
  } else {
    return nativeImage.createFromDataURL(trayIconAsset);
  }
}

export function initTray() {
  const trayIcon = createTrayIcon();
  tray = new Tray(trayIcon);
  updateTrayMenu();
  tray.setToolTip("Stoat");
  tray.setImage(trayIcon);
  tray.on("click", () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

/** Itens do menu que dependem do estado da atualizacao automatica. */
function itensDeAtualizacao(): Electron.MenuItemConstructorOptions[] {
  const estado = estadoDaAtualizacao();
  switch (estado.fase) {
    case "pronta":
      return [
        {
          label: `Reiniciar para atualizar (v${estado.versao})`,
          type: "normal",
          click: reiniciarEAtualizar,
        },
      ];
    case "baixando":
      return [
        {
          label: `Baixando atualização v${estado.versao}… ${estado.progresso}%`,
          type: "normal",
          enabled: false,
        },
      ];
    case "procurando":
      return [
        { label: "Procurando atualizações…", type: "normal", enabled: false },
      ];
    default:
      return [
        {
          label: "Procurar atualizações",
          type: "normal",
          click: () => void procurarAtualizacao(true),
        },
      ];
  }
}

export function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Stoat", type: "normal", enabled: false },
      {
        label: "Version",
        type: "submenu",
        submenu: Menu.buildFromTemplate([
          {
            label: version,
            type: "normal",
            enabled: false,
          },
        ]),
      },
      ...itensDeAtualizacao(),
      { type: "separator" },
      {
        label: mainWindow.isVisible() ? "Hide App" : "Show App",
        type: "normal",
        click() {
          if (mainWindow.isVisible()) {
            mainWindow.hide();
          } else {
            mainWindow.show();
          }
        },
      },
      {
        label: "Quit App",
        type: "normal",
        click: quitApp,
      },
    ]),
  );
}
