/**
 * Escolhe DE ONDE vem o som de um compartilhamento de tela.
 *
 * O problema que isto resolve: quem assistia a uma transmissao com som ouvia a
 * propria voz de volta. O `loopback` do Electron captura TUDO o que sai no
 * computador de quem transmite, inclusive a chamada do proprio Stoat.
 *
 * A regra copia a do Discord:
 *
 * - **Janela**: so o som do programa dono da janela (`applicationLoopback:<pid>`,
 *   modo INCLUDE da arvore de processos). Nada de voz da chamada, notificacao,
 *   Spotify de fundo, nem som que um roteador de audio (Sonar, Voicemeeter)
 *   reproduz pelo processo dele.
 * - **Tela inteira**: o som do sistema todo MENOS o do Stoat
 *   (`loopbackWithoutChrome`, modo EXCLUDE).
 *
 * Os dois identificadores sao dispositivos do proprio Chromium
 * (media/audio/audio_device_description.cc). O Electron repassa a string que o
 * handler devolve, embora o tipo dele so liste `loopback`/`loopbackWithMute`.
 * Medido no Electron 44.6, Windows 11, com tres tons simultaneos (2026-11-21):
 * o tom tocado pelo app sumiu nos dois modos; no modo janela, o tom de um
 * segundo programa externo tambem sumiu e so ficou o do programa escolhido.
 *
 * Fora do Windows nada muda: no macOS o Electron ja troca `loopback` por
 * `loopbackWithoutChrome` quando a pagina pede `restrictOwnAudio`, e no Linux o
 * microfone virtual (virtualMic.ts) ja ignora os nos de audio do proprio app.
 */

import { createRequire } from "node:module";

/** Dispositivo de audio no formato que o `setDisplayMediaRequestHandler` aceita. */
export type DispositivoDeAudio = "loopback" | "loopbackWithMute";

/** Sistema todo, menos a arvore de processos do proprio app. */
const SISTEMA_SEM_O_APP = "loopbackWithoutChrome";

/** Processo que hospeda janelas de apps UWP; o som sai de outro processo. */
const HOSPEDEIRO_UWP = "applicationframehost.exe";

/** PROCESS_QUERY_LIMITED_INFORMATION */
const CONSULTA_LIMITADA = 0x1000;

interface Win32 {
  pidDaJanela(hwnd: bigint): number;
  executavel(pid: number): string | undefined;
  janelaFilhaUwp(hwnd: bigint): bigint;
}

let win32: Win32 | null | undefined;

/**
 * Carrega as funcoes da user32/kernel32 via koffi, uma vez so. Falha aqui nao
 * pode derrubar o compartilhamento: quem chama cai para "sistema sem o app".
 */
function carregarWin32(): Win32 | null {
  if (win32 !== undefined) return win32;
  if (process.platform !== "win32") return (win32 = null);

  try {
    // `require` em runtime: o koffi fica fora do bundle do Vite
    // (vite.main.config.ts) e e copiado para o pacote em forge.config.ts.
    const koffi = createRequire(__filename)("koffi");
    const user32 = koffi.load("user32.dll");
    const kernel32 = koffi.load("kernel32.dll");

    const GetWindowThreadProcessId = user32.func(
      "uint32 __stdcall GetWindowThreadProcessId(uintptr hWnd, _Out_ uint32 *pid)",
    );
    const FindWindowExW = user32.func(
      "uintptr __stdcall FindWindowExW(uintptr pai, uintptr depois, str16 classe, str16 titulo)",
    );
    const OpenProcess = kernel32.func(
      "uintptr __stdcall OpenProcess(uint32 acesso, bool herdar, uint32 pid)",
    );
    const QueryFullProcessImageNameW = kernel32.func(
      "bool __stdcall QueryFullProcessImageNameW(uintptr h, uint32 flags, _Out_ uint16 *nome, _Inout_ uint32 *tamanho)",
    );
    const CloseHandle = kernel32.func("bool __stdcall CloseHandle(uintptr h)");

    win32 = {
      pidDaJanela(hwnd) {
        const pid = [0];
        GetWindowThreadProcessId(hwnd, pid);
        return pid[0];
      },
      executavel(pid) {
        const h = OpenProcess(CONSULTA_LIMITADA, false, pid);
        if (!h) return undefined;
        try {
          const nome = new Uint16Array(1024);
          const tamanho = [nome.length];
          if (!QueryFullProcessImageNameW(h, 0, nome, tamanho)) return undefined;
          return String.fromCharCode(...nome.subarray(0, tamanho[0]));
        } finally {
          CloseHandle(h);
        }
      },
      janelaFilhaUwp(hwnd) {
        return BigInt(
          FindWindowExW(hwnd, 0, "Windows.UI.Core.CoreWindow", null) || 0,
        );
      },
    };
  } catch (e) {
    console.error("Audio por janela indisponivel (koffi):", e);
    win32 = null;
  }
  return win32;
}

/** PIDs do proprio app (processo principal, renderers, servico de audio...). */
function pidsDoApp(pidsDoElectron: number[]) {
  return new Set([process.pid, ...pidsDoElectron]);
}

/**
 * PID do programa dono de uma fonte `window:<hwnd>:<n>` do desktopCapturer, ou
 * `undefined` quando nao da para saber (fonte de tela, API indisponivel,
 * janela do proprio app).
 */
export function pidDaFonte(
  idDaFonte: string,
  pidsDoElectron: number[],
): number | undefined {
  const [tipo, hwndTexto] = idDaFonte.split(":");
  if (tipo !== "window" || !hwndTexto) return undefined;

  const api = carregarWin32();
  if (!api) return undefined;

  try {
    const hwnd = BigInt(hwndTexto);
    let pid = api.pidDaJanela(hwnd);

    // App UWP (Netflix, Xbox, Spotify da Store): a moldura e do
    // ApplicationFrameHost, mas o som sai do processo da CoreWindow filha.
    const exe = pid ? api.executavel(pid) : undefined;
    if (exe?.toLowerCase().endsWith(HOSPEDEIRO_UWP)) {
      const filha = api.janelaFilhaUwp(hwnd);
      pid = filha ? api.pidDaJanela(filha) : 0;
    }

    // Compartilhar a janela do proprio Stoat com "som do programa" traria a
    // chamada de volta, que e exatamente o eco que isto existe para evitar.
    if (!pid || pidsDoApp(pidsDoElectron).has(pid)) return undefined;
    return pid;
  } catch (e) {
    console.error("Nao foi possivel achar o processo da janela:", e);
    return undefined;
  }
}

/**
 * Dispositivo de audio para o compartilhamento da fonte escolhida.
 *
 * O retorno e tipado como os valores que o Electron documenta, mas no Windows
 * carrega os dispositivos do Chromium descritos no topo deste arquivo.
 */
export function audioDoCompartilhamento(
  idDaFonte: string,
  pidsDoElectron: number[],
): DispositivoDeAudio {
  if (process.platform !== "win32") return "loopback";

  const pid = pidDaFonte(idDaFonte, pidsDoElectron);
  const id = pid ? `applicationLoopback:${pid}` : SISTEMA_SEM_O_APP;
  return id as DispositivoDeAudio;
}
