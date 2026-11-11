import { contextBridge, ipcRenderer } from "electron";

// Pega a config ja na carga do preload, antes de qualquer script da pagina:
// o web le `desktopConfig.get()` na primeira renderizacao e nao trata
// undefined. O evento abaixo continua trazendo as atualizacoes.
let config: DesktopConfig = ipcRenderer.sendSync("config:get");

ipcRenderer.on("config", (_, data) => (config = data));

contextBridge.exposeInMainWorld("desktopConfig", {
  get: () => config,
  set: (config: DesktopConfig) => ipcRenderer.send("config", config),
  getAutostart() {
    return ipcRenderer.invoke("getAutostart") as Promise<boolean>;
  },
  setAutostart(value: boolean) {
    return ipcRenderer.invoke("setAutostart", value) as Promise<boolean>;
  },
});
