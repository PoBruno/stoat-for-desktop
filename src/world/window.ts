import { contextBridge, ipcRenderer } from "electron";

import { version } from "../../package.json";

// stoat:// links wait in the main process until the app is ready for them,
// so a reload before then loses nothing
let onNavigate: ((path: string) => void) | undefined;
async function takeNavigation() {
  const pending: { id: number; target: string } | null =
    await ipcRenderer.invoke("takeNavigation");
  if (pending && onNavigate) {
    onNavigate(pending.target);
    ipcRenderer.send("navigationDone", pending.id);
  }
}
ipcRenderer.on("navigate", () => {
  if (onNavigate) void takeNavigation();
});

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
   * Atualizacao automatica (src/native/atualizacao.ts). Existe so a partir da
   * v1.9.0; o web checa a presenca antes de desenhar qualquer indicador.
   */
  atualizacao: {
    estado: () => ipcRenderer.invoke("atualizacao:estado"),
    procurar: () => ipcRenderer.invoke("atualizacao:procurar"),
    instalar: () => ipcRenderer.invoke("atualizacao:instalar"),
    aoMudar: (callback: (estado: unknown) => void) => {
      const ouvinte = (_: unknown, estado: unknown) => callback(estado);
      ipcRenderer.on("atualizacao:estado", ouvinte);
      return () => ipcRenderer.removeListener("atualizacao:estado", ouvinte);
    },
  },

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
  destroyVirtualMic: () => ipcRenderer.invoke("destroyVirtualMic"),

  onNavigate: (callback: (path: string) => void) => {
    onNavigate = callback;
    void takeNavigation();
  },
});
