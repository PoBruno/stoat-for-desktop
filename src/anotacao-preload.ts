import { ipcRenderer } from "electron";

import { desenharEtiqueta, desenharTraco, opacidadePelaIdade } from "./traco";

/**
 * Preload da janela de SOBREPOSICAO de anotacao.
 *
 * Este arquivo e a janela inteira: ele monta o DOM, recebe os tracos e desenha.
 * Nao ha HTML nem bundle de renderer.
 *
 * ## Por que assim
 *
 * O `VitePlugin` do forge.config.ts tem `renderer: []` -- o app carrega uma URL
 * remota, entao nao existe pipeline de renderer local. Criar um so para uma
 * pagina de canvas exigiria configurar entradas de renderer, globais
 * `*_VITE_DEV_SERVER_URL` e copia de assets para dentro do asar.
 *
 * Um preload, ao contrario, ja tem entrada declarada (basta somar uma linha no
 * array de `build`), roda com TypeScript verificado, e tem acesso ao
 * `document` de uma janela `about:blank`. Entao ele monta o canvas e pronto:
 * zero asset, zero HTML, funciona empacotado e em dev do mesmo jeito.
 *
 * Nao ha `contextBridge` aqui porque nao ha pagina para conversar: o preload E
 * a pagina.
 */

/** Um traco recebido do processo principal */
type Traco = {
  /** Identificador do traco */
  id: string;
  /** Nome de quem desenhou */
  nome: string;
  /** Cor do traco */
  cor: string;
  /** Coordenadas achatadas em 0..1 sobre o quadro capturado */
  pts: number[];
  /** Momento em que este lado viu o traco pela primeira vez */
  nascidoEm: number;
};

const tracos = new Map<string, Traco>();
let moldura = false;
let canvas: HTMLCanvasElement | undefined;
let ctx: CanvasRenderingContext2D | null = null;
let laco: number | undefined;

/**
 * Monta o canvas que cobre a janela inteira.
 */
function montar() {
  document.title = "Stoat — anotação";

  const estilo = document.createElement("style");
  estilo.textContent = `
    html, body { margin: 0; padding: 0; overflow: hidden; background: transparent; }
    canvas { display: block; width: 100vw; height: 100vh; }
  `;
  document.head.appendChild(estilo);

  canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  ctx = canvas.getContext("2d");

  window.addEventListener("resize", () => agendar());
  agendar();
}

/**
 * Ajusta o canvas ao tamanho e ao DPI da janela.
 *
 * @returns o `devicePixelRatio` em vigor
 */
function ajustar(): number {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(window.innerWidth * dpr));
  const h = Math.max(1, Math.round(window.innerHeight * dpr));
  if (canvas && (canvas.width !== w || canvas.height !== h)) {
    canvas.width = w;
    canvas.height = h;
  }
  return dpr;
}

/**
 * Desenha um quadro e reagenda enquanto houver o que mostrar.
 *
 * O laco PARA quando nao ha traco nem moldura. Uma janela transparente sempre
 * no topo repintando a 60 fps custaria GPU o tempo todo, e o requisito era
 * custo zero fora de uso.
 */
function quadro() {
  laco = undefined;
  if (!canvas || !ctx) return;

  const dpr = ajustar();
  const larguraCss = window.innerWidth;
  const alturaCss = window.innerHeight;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, larguraCss, alturaCss);

  const agora = Date.now();
  let vivos = 0;

  for (const [id, t] of tracos) {
    const alfa = opacidadePelaIdade(agora - t.nascidoEm);
    if (alfa <= 0) {
      tracos.delete(id);
      continue;
    }
    vivos++;

    // 0..1 -> pixel de CSS. E aqui que o DPI deixa de importar: a janela
    // cobre o display em DIP, e 1 px de CSS == 1 DIP.
    const pixels = new Array<number>(t.pts.length);
    for (let i = 0; i < t.pts.length; i += 2) {
      pixels[i] = t.pts[i] * larguraCss;
      pixels[i + 1] = t.pts[i + 1] * alturaCss;
    }

    desenharTraco(ctx, pixels, t.cor, alfa);
    desenharEtiqueta(ctx, pixels[0], pixels[1], t.nome, t.cor, alfa * 0.9);
  }

  if (moldura) {
    // Lembrete de que outras pessoas podem desenhar nesta tela agora.
    // Fica dentro da sobreposicao, logo e excluido da captura junto com ela:
    // e um aviso privado, quem assiste nao ve.
    ctx.save();
    ctx.strokeStyle = "rgba(255, 149, 0, 0.85)";
    ctx.lineWidth = 3;
    ctx.strokeRect(1.5, 1.5, larguraCss - 3, alturaCss - 3);
    ctx.restore();
  }

  if (vivos > 0) agendar();
}

/**
 * Agenda um quadro sem empilhar dois.
 */
function agendar() {
  if (laco === undefined) laco = requestAnimationFrame(quadro);
}

ipcRenderer.on(
  "anotacao:tracos",
  (
    _evento,
    lista: { id: string; nome: string; cor: string; pts: number[] }[],
  ) => {
    const vistos = new Set<string>();
    for (const t of lista) {
      vistos.add(t.id);
      const existente = tracos.get(t.id);
      if (existente) {
        // O traco cresce; renova a idade para nao sumir enquanto desenham.
        existente.pts = t.pts;
        existente.nascidoEm = Date.now();
        existente.cor = t.cor;
        existente.nome = t.nome;
      } else {
        tracos.set(t.id, { ...t, nascidoEm: Date.now() });
      }
    }
    agendar();
  },
);

ipcRenderer.on("anotacao:moldura", (_evento, ligada: boolean) => {
  moldura = !!ligada;
  agendar();
});

ipcRenderer.on("anotacao:limpar", () => {
  tracos.clear();
  agendar();
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", montar);
} else {
  montar();
}
