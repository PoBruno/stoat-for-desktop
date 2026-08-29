/**
 * Copia de for-web/packages/client/components/rtc/traco.ts.
 *
 * DUPLICADO DE PROPOSITO. Os dois lados precisam desenhar o traco identico --
 * quem assiste ve no canvas sobre o <video>, quem compartilha ve aqui, na
 * sobreposicao. Sao repos separados e sem pacote comum; publicar um npm para
 * 70 linhas de canvas seria pior que a duplicacao. Se mexer la, mexa aqui.
 */

/** Quanto tempo o traco fica opaco antes de comecar a sumir, em ms */
export const SEGURAR_MS = 1500;

/** Quanto tempo o traco leva para sumir depois de segurar, em ms */
export const ESMAECER_MS = 1000;

/** Espessura do traco em pixels de CSS */
export const ESPESSURA = 4;

/**
 * Opacidade de um traco pela idade.
 *
 * @param idadeMs idade do traco em milissegundos
 * @returns opacidade entre 0 e 1
 */
export function opacidadePelaIdade(idadeMs: number): number {
  if (idadeMs <= SEGURAR_MS) return 1;
  const decorrido = idadeMs - SEGURAR_MS;
  if (decorrido >= ESMAECER_MS) return 0;
  return 1 - decorrido / ESMAECER_MS;
}

/**
 * Desenha um traco no contexto.
 *
 * @param ctx contexto 2d
 * @param pontos coordenadas achatadas, em pixels
 * @param cor cor em qualquer notacao aceita pelo canvas
 * @param alfa opacidade de 0 a 1
 * @param espessura largura da linha em pixels
 */
export function desenharTraco(
  ctx: CanvasRenderingContext2D,
  pontos: number[],
  cor: string,
  alfa: number,
  espessura: number = ESPESSURA,
): void {
  const n = pontos.length >> 1;
  if (n === 0 || alfa <= 0) return;

  ctx.save();
  ctx.globalAlpha = alfa;
  ctx.strokeStyle = cor;
  ctx.fillStyle = cor;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = espessura;
  ctx.shadowColor = cor;
  ctx.shadowBlur = espessura * 2.5;

  if (n === 1) {
    ctx.beginPath();
    ctx.arc(pontos[0], pontos[1], espessura / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  ctx.beginPath();
  ctx.moveTo(pontos[0], pontos[1]);

  if (n === 2) {
    ctx.lineTo(pontos[2], pontos[3]);
  } else {
    for (let i = 1; i < n - 1; i++) {
      const x = pontos[i * 2];
      const y = pontos[i * 2 + 1];
      const mx = (x + pontos[(i + 1) * 2]) / 2;
      const my = (y + pontos[(i + 1) * 2 + 1]) / 2;
      ctx.quadraticCurveTo(x, y, mx, my);
    }
    ctx.lineTo(pontos[(n - 1) * 2], pontos[(n - 1) * 2 + 1]);
  }

  ctx.stroke();
  ctx.restore();
}

/**
 * Escreve o nome de quem desenhou junto ao inicio do traco.
 *
 * @param ctx contexto 2d
 * @param x posicao horizontal em pixels
 * @param y posicao vertical em pixels
 * @param nome texto
 * @param cor cor de fundo da etiqueta
 * @param alfa opacidade de 0 a 1
 */
export function desenharEtiqueta(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  nome: string,
  cor: string,
  alfa: number,
): void {
  if (alfa <= 0 || !nome) return;

  ctx.save();
  ctx.globalAlpha = alfa;
  ctx.font =
    "600 12px Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  ctx.textBaseline = "middle";

  const largura = ctx.measureText(nome).width;
  const px = 6;
  const alturaCaixa = 18;
  const cx = x + 10;
  const cy = y - 14;

  ctx.fillStyle = cor;
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(cx, cy - alturaCaixa / 2, largura + px * 2, alturaCaixa, 4);
  } else {
    ctx.rect(cx, cy - alturaCaixa / 2, largura + px * 2, alturaCaixa);
  }
  ctx.fill();

  ctx.fillStyle = "#ffffff";
  ctx.fillText(nome, cx + px, cy);
  ctx.restore();
}
