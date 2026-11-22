/**
 * Atualizacao automatica do app, no estilo do Discord.
 *
 * Fluxo: o app procura versao nova ao abrir e de tempos em tempos, baixa em
 * segundo plano sem perguntar nada e, quando o download termina, AVISA e
 * pergunta se pode reiniciar. Quem escolhe "Depois" recebe a atualizacao na
 * proxima vez que fechar o app -- ninguem fica para tras.
 *
 * Quem faz o trabalho pesado e o `electron-updater` (do electron-builder):
 *
 * - le o `latest.yml` / `latest-linux.yml` do release mais recente em
 *   github.com/PoBruno/stoat-for-desktop (feed em `resources/app-update.yml`,
 *   gravado no empacotamento: forge.config.ts no Windows, electron-builder no
 *   Linux);
 * - baixa so os blocos que mudaram (blockmap) e confere o sha512;
 * - no Windows roda o instalador NSIS em silencio e reabre o app; no Linux
 *   troca o AppImage, ou instala o .deb/.pacman pedindo a senha (pkexec).
 *
 * Fica DESLIGADO onde nao ha como atualizar sozinho: rodando do codigo
 * (`pnpm start`), no Flatpak (atualiza pela loja), no macOS (sem build
 * assinado) e com `--no-auto-update`.
 *
 * Para testar sem publicar nada, `STOAT_UPDATE_FEED=<url>` aponta o app para
 * uma pasta servida por HTTP com o `latest.yml` e o instalador (ver
 * .claude/scripts/teste-auto-update/).
 */

import {
  BrowserWindow,
  Notification,
  app,
  dialog,
  ipcMain,
  powerMonitor,
} from "electron";
import { appendFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { autoUpdater } from "electron-updater";

import { updateTrayMenu } from "./tray";
import { mainWindow } from "./window";

/** Primeira checagem: depois que o app terminou de abrir. */
const PRIMEIRA_CHECAGEM_MS = 10_000;

/** Intervalo entre checagens enquanto o app esta aberto. */
const INTERVALO_MS = 30 * 60_000;

/** Estado exposto ao tray e a pagina (window.native.atualizacao). */
export type EstadoDaAtualizacao =
  | { fase: "desligada" }
  | { fase: "ociosa" }
  | { fase: "procurando" }
  | { fase: "baixando"; versao: string; progresso: number }
  | { fase: "pronta"; versao: string }
  | { fase: "erro"; mensagem: string };

let estado: EstadoDaAtualizacao = { fase: "desligada" };

/** Versao para a qual ja perguntamos; nao repetir a pergunta a cada checagem. */
let versaoJaPerguntada: string | undefined;

/** A checagem atual foi pedida pela pessoa (tray)? Ai responde mesmo sem novidade. */
let checagemManual = false;

const arquivoDeLog = () =>
  path.join(app.getPath("userData"), "logs", "atualizacao.log");

function registrar(nivel: string, ...partes: unknown[]) {
  const linha = `${new Date().toISOString()} ${nivel} ${partes
    .map((p) => (p instanceof Error ? p.stack ?? p.message : String(p)))
    .join(" ")}\n`;
  if (nivel === "ERRO") console.error(linha.trim());
  mkdir(path.dirname(arquivoDeLog()), { recursive: true })
    .then(() => appendFile(arquivoDeLog(), linha))
    .catch(() => undefined);
}

function mudarEstado(novo: EstadoDaAtualizacao) {
  estado = novo;
  try {
    updateTrayMenu();
  } catch {
    // tray ainda nao existe
  }
  for (const janela of BrowserWindow.getAllWindows()) {
    if (!janela.isDestroyed()) {
      janela.webContents.send("atualizacao:estado", estado);
    }
  }
}

/** Estado atual (usado pelo tray). */
export function estadoDaAtualizacao(): EstadoDaAtualizacao {
  return estado;
}

/**
 * Se este app consegue se atualizar sozinho. No Linux depende de COMO foi
 * instalado: AppImage (variavel APPIMAGE) ou .deb/.pacman (arquivo
 * `package-type` que o electron-builder grava). Um .tar ou build manual nao.
 */
function podeAtualizar(): boolean {
  if (!app.isPackaged) return false;
  if (app.commandLine.hasSwitch("no-auto-update")) return false;
  if (process.env.STOAT_UPDATE_FEED) return true;
  if (process.platform === "win32") return true;
  if (process.platform === "linux") {
    if (process.env.FLATPAK_ID) return false;
    return (
      !!process.env.APPIMAGE ||
      existsSync(path.join(process.resourcesPath, "package-type"))
    );
  }
  return false;
}

/** Texto simples a partir das notas do release (o GitHub manda HTML). */
function notasEmTexto(notas: unknown): string {
  const bruto = Array.isArray(notas)
    ? notas.map((n) => n?.note ?? "").join("\n")
    : typeof notas === "string"
      ? notas
      : "";
  const texto = bruto
    .replace(/<\/(p|li|h\d)>/gi, "\n")
    .replace(/<li>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return texto.length > 600 ? texto.slice(0, 600).trimEnd() + "…" : texto;
}

let notasDaVersaoPronta = "";

/**
 * Fecha a pergunta "Reiniciar e atualizar?" se ela estiver aberta.
 *
 * Um messageBox modal aberto SEGURA o `app.quit()` no Windows: o instalador
 * ja disparado fica esperando o app sair e nada acontece. Medido ao pedir a
 * instalacao pelo tray/pagina com a pergunta ainda na tela.
 */
let fecharPergunta: AbortController | undefined;

let reiniciando = false;

/** Reinicia ja aplicando a atualizacao baixada. */
export function reiniciarEAtualizar() {
  if (estado.fase !== "pronta" || reiniciando) return;
  reiniciando = true;
  fecharPergunta?.abort();
  registrar("INFO", `reiniciando para instalar ${estado.versao}`);
  // Um respiro para o dialogo abortado sumir antes do quit.
  setTimeout(() => {
    // isSilent: o instalador NSIS nao mostra o assistente de novo.
    // isForceRunAfter: reabre o app no fim (no Windows o NSIS abre
    // `${productName}.exe`; trocar o productName sem o executavel quebra isso).
    autoUpdater.quitAndInstall(true, true);
    // Rede de seguranca: o instalador ja esta rodando e ESPERA o app sair.
    // Se algo segurar o quit (outro dialogo, janela presa), sai a forca.
    setTimeout(() => {
      registrar("AVISO", "quit nao terminou em 8 s; saindo a forca");
      app.exit(0);
    }, 8000).unref();
  }, 300);
}

/** Pergunta se pode reiniciar agora. Uma vez por versao, salvo se pedida. */
async function perguntarSeReinicia(forcar = false) {
  if (estado.fase !== "pronta") return;
  if (!forcar && versaoJaPerguntada === estado.versao) return;
  versaoJaPerguntada = estado.versao;

  const janela =
    mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()
      ? mainWindow
      : undefined;

  const opcoes: Electron.MessageBoxOptions = {
    type: "info",
    title: "Atualização do Stoat",
    message: `A versão ${estado.versao} do Stoat está pronta`,
    detail:
      (notasDaVersaoPronta ? notasDaVersaoPronta + "\n\n" : "") +
      "Reiniciar agora leva poucos segundos. Se escolher Depois, ela é " +
      "instalada quando você fechar o Stoat.",
    buttons: ["Reiniciar e atualizar", "Depois"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };

  const controle = new AbortController();
  fecharPergunta = controle;
  opcoes.signal = controle.signal;

  const { response } = janela
    ? await dialog.showMessageBox(janela, opcoes)
    : await dialog.showMessageBox(opcoes);

  if (fecharPergunta === controle) fecharPergunta = undefined;
  // abortada = ja esta reiniciando por outro caminho
  if (response === 0 && !controle.signal.aborted) reiniciarEAtualizar();
}

/**
 * Avisa que a atualizacao esta pronta. Com a janela aberta, pergunta direto;
 * minimizado na bandeja, manda uma notificacao do sistema (clicar nela abre a
 * pergunta) em vez de jogar um dialogo do nada sobre um jogo.
 */
function avisarQueEstaPronta() {
  if (estado.fase !== "pronta") return;
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
    void perguntarSeReinicia();
    return;
  }
  if (Notification.isSupported()) {
    const aviso = new Notification({
      title: "Atualização do Stoat pronta",
      body: `Versão ${estado.versao}. Clique para reiniciar e atualizar.`,
    });
    aviso.on("click", () => {
      mainWindow?.show();
      mainWindow?.focus();
      void perguntarSeReinicia(true);
    });
    aviso.show();
  }
}

/** Procura atualizacao. `manual` = pedida pelo tray: responde mesmo sem novidade. */
export async function procurarAtualizacao(manual = false) {
  if (estado.fase === "desligada") {
    if (manual) {
      await dialog.showMessageBox({
        type: "info",
        title: "Atualização do Stoat",
        message: "Esta instalação não se atualiza sozinha.",
        detail:
          "Baixe a versão nova em github.com/PoBruno/stoat-for-desktop/releases.",
      });
    }
    return;
  }
  if (estado.fase === "pronta") {
    if (manual) await perguntarSeReinicia(true);
    return;
  }
  if (estado.fase === "procurando" || estado.fase === "baixando") return;

  checagemManual = manual;
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    // o evento "error" ja registra e atualiza o estado
    registrar("ERRO", "checkForUpdates", e);
  }
}

/** Liga o atualizador. Chamar depois de `app.ready`, com a janela criada. */
export function initAtualizacao() {
  ipcMain.handle("atualizacao:estado", () => estado);
  ipcMain.handle("atualizacao:instalar", () => reiniciarEAtualizar());
  ipcMain.handle("atualizacao:procurar", () => procurarAtualizacao(true));

  if (!podeAtualizar()) {
    registrar("INFO", "auto-update desligado nesta instalacao");
    mudarEstado({ fase: "desligada" });
    return;
  }

  autoUpdater.logger = {
    info: (...a: unknown[]) => registrar("INFO", ...a),
    warn: (...a: unknown[]) => registrar("AVISO", ...a),
    error: (...a: unknown[]) => registrar("ERRO", ...a),
    debug: () => undefined,
  };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // So usamos o instalador completo (com blockmap para baixar a diferenca).
  autoUpdater.disableWebInstaller = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;

  if (process.env.STOAT_UPDATE_FEED) {
    autoUpdater.setFeedURL({
      provider: "generic",
      url: process.env.STOAT_UPDATE_FEED,
    });
    registrar("INFO", "feed de teste:", process.env.STOAT_UPDATE_FEED);
  }

  autoUpdater.on("checking-for-update", () =>
    mudarEstado({ fase: "procurando" }),
  );

  autoUpdater.on("update-not-available", (info) => {
    mudarEstado({ fase: "ociosa" });
    if (checagemManual) {
      checagemManual = false;
      void dialog.showMessageBox({
        type: "info",
        title: "Atualização do Stoat",
        message: "Você já está na versão mais recente.",
        detail: `Versão ${app.getVersion()} (última publicada: ${info.version}).`,
      });
    }
  });

  autoUpdater.on("update-available", (info) => {
    registrar("INFO", `versao nova: ${info.version}`);
    mudarEstado({ fase: "baixando", versao: info.version, progresso: 0 });
  });

  let ultimoProgresso = -1;
  autoUpdater.on("download-progress", (p) => {
    const progresso = Math.floor(p.percent);
    // so redesenha o tray a cada 5%
    if (estado.fase !== "baixando" || progresso - ultimoProgresso < 5) return;
    ultimoProgresso = progresso;
    mudarEstado({ ...estado, progresso });
  });

  autoUpdater.on("update-downloaded", (info) => {
    registrar("INFO", `baixada: ${info.version}`);
    checagemManual = false;
    notasDaVersaoPronta = notasEmTexto(info.releaseNotes);
    mudarEstado({ fase: "pronta", versao: info.version });
    avisarQueEstaPronta();
  });

  autoUpdater.on("error", (e) => {
    registrar("ERRO", e);
    const manual = checagemManual;
    checagemManual = false;
    // Falha de rede nao e motivo para incomodar ninguem: tenta de novo na
    // proxima checagem. So responde se a pessoa pediu.
    mudarEstado({ fase: "erro", mensagem: String(e?.message ?? e) });
    if (manual) {
      void dialog.showMessageBox({
        type: "warning",
        title: "Atualização do Stoat",
        message: "Não foi possível procurar atualizações agora.",
        detail: String(e?.message ?? e).slice(0, 300),
      });
    }
  });

  // Estava na bandeja quando a atualizacao ficou pronta e ignorou a
  // notificacao: pergunta quando a janela voltar.
  mainWindow?.on("show", () => {
    if (estado.fase === "pronta" && versaoJaPerguntada !== estado.versao) {
      setTimeout(() => void perguntarSeReinicia(), 800);
    }
  });

  mudarEstado({ fase: "ociosa" });
  registrar("INFO", `auto-update ligado, versao atual ${app.getVersion()}`);

  setTimeout(() => void procurarAtualizacao(), PRIMEIRA_CHECAGEM_MS);
  setInterval(() => void procurarAtualizacao(), INTERVALO_MS);
  // Computador que dormiu a noite inteira: procura assim que acordar.
  powerMonitor.on("resume", () =>
    setTimeout(() => void procurarAtualizacao(), 15_000),
  );
}
