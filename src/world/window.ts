import { contextBridge, ipcRenderer } from "electron";

import { version } from "../../package.json";

contextBridge.exposeInMainWorld("native", {
  versions: {
    node: () => process.versions.node,
    chrome: () => process.versions.chrome,
    electron: () => process.versions.electron,
    desktop: () => version,
  },

  minimise: () => ipcRenderer.send("minimise"),
  maximise: () => ipcRenderer.send("maximise"),
  close: () => ipcRenderer.send("close"),

  setBadgeCount: (count: number) => ipcRenderer.send("setBadgeCount", count),

  onceScreenPicker: (
    onScreenPick: (
      sources: {
        idx: number;
        name: string;
        isFullScreen: boolean;
        image?: string;
        displayId?: string;
      }[],
    ) => void,
  ) => {
    const eventName = "screenPicker";
    ipcRenderer.removeAllListeners(eventName);
    ipcRenderer.once(eventName, (_, sources) => onScreenPick(sources));
  },
  screenPickerCallback: (idx: number, audio: boolean) =>
    ipcRenderer.send("screenPickerCallback", idx, audio),

  isWayland: () => ipcRenderer.invoke("getIsWayland"),

  /**
   * Fixa a janela DESTACADA sobre as demais.
   *
   * Exposto na ponte porque o botao vive dentro da propria janela destacada,
   * e a presenca desta funcao e o que o web usa para decidir se desenha o
   * botao -- em versoes antigas do app ela nao existe e o botao some.
   */
  popoutAlwaysOnTop: (ligado: boolean) =>
    ipcRenderer.send("popoutAlwaysOnTop", ligado),

  /**
   * Abre a sobreposicao de anotacao sobre o display capturado.
   *
   * Como o `popoutAlwaysOnTop`, a presenca desta funcao e o que o web usa para
   * decidir se a feature existe: em app antigo ela nao esta na ponte e o botao
   * some, em vez de aparecer e nao fazer nada.
   */
  anotacaoAbrir: (displayId: string) =>
    ipcRenderer.send("anotacaoAbrir", displayId),

  /** Destroi a sobreposicao de anotacao */
  anotacaoFechar: () => ipcRenderer.send("anotacaoFechar"),

  /** Manda os tracos vivos para a sobreposicao desenhar */
  anotacaoTracos: (
    tracos: { id: string; nome: string; cor: string; pts: number[] }[],
  ) => ipcRenderer.send("anotacaoTracos", tracos),

  /** Liga ou desliga a moldura de aviso na borda da tela */
  anotacaoMoldura: (ligada: boolean) =>
    ipcRenderer.send("anotacaoMoldura", ligada),
});
