import { BrowserWindow, ipcMain, screen } from "electron";
import { join } from "node:path";

/**
 * Sobreposicao de anotacao sobre a tela compartilhada.
 *
 * Uma janela transparente, sempre no topo, que cobre exatamente o display que
 * esta sendo capturado, e desenha os tracos que os outros participantes fazem.
 *
 * ## O pilar: setContentProtection
 *
 * Se o traco aparece na tela real E a tela esta sendo capturada, ele volta
 * assado dentro do video para quem assiste -- que ja esta desenhando o mesmo
 * traco localmente. Ficaria duplicado e defasado.
 *
 * `setContentProtection(true)` chama `SetWindowDisplayAffinity` com
 * `WDA_EXCLUDEFROMCAPTURE`: no Windows 10 2004+ a janela some da captura por
 * completo. E o que permite o desenho ser vetorial e instantaneo dos dois
 * lados, em vez de um round-trip pelo video.
 *
 * So existe em Windows e macOS. E por isso que a feature e de Windows.
 */

/** A sobreposicao viva, se houver */
let janela: BrowserWindow | undefined;

/** Id do display que ela esta cobrindo */
let displayAtual: string | undefined;

/**
 * Acha o display do Electron correspondente a uma fonte do desktopCapturer.
 *
 * O `display_id` da fonte e string; o `id` do display e number. Comparar como
 * string e o que o DrawPen faz, e e o unico jeito que funciona nas duas pontas.
 *
 * @param displayId id vindo do desktopCapturer
 * @returns o display, ou undefined se nao casar
 */
function acharDisplay(displayId: string) {
  return screen
    .getAllDisplays()
    .find((d) => String(d.id) === String(displayId));
}

/**
 * Cria (ou reposiciona) a sobreposicao sobre um display.
 *
 * @param displayId id do display capturado
 */
function abrir(displayId: string) {
  const display = acharDisplay(displayId);
  if (!display) {
    console.warn(`[anotacao] display ${displayId} nao encontrado`);
    return;
  }

  // `bounds`, NAO `workArea`. A captura de tela inclui a barra de tarefas,
  // entao v=1 corresponde a borda fisica de baixo. Usar workArea encolheria o
  // eixo Y e deslocaria todo o traco -- erro que some no meio da tela e
  // aparece nas bordas.
  const { x, y, width, height } = display.bounds;

  if (janela && !janela.isDestroyed()) {
    janela.setBounds({ x, y, width, height });
    displayAtual = displayId;
    return;
  }

  janela = new BrowserWindow({
    x,
    y,
    width,
    height,
    transparent: true,
    backgroundColor: "#00000000",
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    show: false,
    // Corrige artefato de renderizacao em janela transparente; truque
    // conhecido, usado tambem pelo DrawPen.
    opacity: 0.9999999,
    webPreferences: {
      preload: join(__dirname, "anotacao-preload.js"),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      // OBRIGATORIO. A janela nunca tem foco; com throttling o Electron
      // estrangula o render para ~1 fps e o traco fica aos solavancos --
      // sintoma que se atribui a rede e nao a isto.
      backgroundThrottling: false,
    },
  });

  janela.loadURL("about:blank");

  // Nunca rouba input: quem compartilha continua trabalhando normalmente.
  janela.setIgnoreMouseEvents(true);
  janela.setContentProtection(true);
  janela.setAlwaysOnTop(true, "screen-saver");
  janela.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // `showInactive` para nao roubar o foco de quem esta compartilhando.
  janela.once("ready-to-show", () => janela?.showInactive());

  janela.on("closed", () => {
    janela = undefined;
    displayAtual = undefined;
  });

  displayAtual = displayId;
}

/**
 * Destroi a sobreposicao.
 *
 * Destruir, e nao esconder: desligado tem que ser custo zero, e uma janela
 * viva ainda ocupa processo de renderizacao.
 */
function fechar() {
  if (janela && !janela.isDestroyed()) {
    // `closable: false` impede `close()`; `destroy()` e o caminho.
    janela.destroy();
  }
  janela = undefined;
  displayAtual = undefined;
}

/**
 * Registra os canais de IPC da sobreposicao.
 *
 * Chamado uma vez no boot. Enquanto ninguem liga a feature, nada e criado --
 * apenas os handlers ficam registrados, que custa nada.
 */
export function registrarAnotacao() {
  ipcMain.on("anotacaoAbrir", (_evento, displayId: string) => {
    if (process.platform !== "win32") return;
    if (typeof displayId !== "string" || !displayId) return;
    abrir(displayId);
  });

  ipcMain.on("anotacaoFechar", () => fechar());

  ipcMain.on(
    "anotacaoTracos",
    (
      _evento,
      lista: { id: string; nome: string; cor: string; pts: number[] }[],
    ) => {
      if (!janela || janela.isDestroyed()) return;
      janela.webContents.send("anotacao:tracos", lista);
    },
  );

  ipcMain.on("anotacaoMoldura", (_evento, ligada: boolean) => {
    if (!janela || janela.isDestroyed()) return;
    janela.webContents.send("anotacao:moldura", !!ligada);
  });

  // Monitor desligado, resolucao trocada ou display removido: reposiciona,
  // senao a sobreposicao fica sobre coordenadas que nao existem mais.
  const reposicionar = () => {
    if (displayAtual && janela && !janela.isDestroyed()) {
      const d = acharDisplay(displayAtual);
      if (d) janela.setBounds(d.bounds);
      else fechar();
    }
  };
  screen.on("display-metrics-changed", reposicionar);
  screen.on("display-removed", reposicionar);
  screen.on("display-added", reposicionar);
}

/**
 * Fecha a sobreposicao ao sair do app.
 */
export function encerrarAnotacao() {
  fechar();
}
