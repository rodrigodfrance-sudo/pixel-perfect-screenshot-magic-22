// Renderização e análise de imagem no navegador (pdf.js). Importar somente no cliente.
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { SIDES, type Box, type EdgeSample, type Side, type PageResult, type PageJob, type SampleOffset, sideLabel } from "./engine";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type PdfDoc = pdfjs.PDFDocumentProxy;

export async function openPdf(bytes: Uint8Array): Promise<PdfDoc> {
  return pdfjs.getDocument({ data: bytes.slice() }).promise;
}

export interface Rendered {
  canvas: HTMLCanvasElement;
  scale: number;
  /** converte ponto PDF -> pixel */
  toPx: (x: number, y: number) => [number, number];
}

// Limites do canvas: navegadores falham (ou travam) com bitmaps muito grandes, comuns em grande formato.
const MAX_CANVAS_SIDE = 8192;
const MAX_CANVAS_PIXELS = 50_000_000;

/** Renderiza a página (sem rotação) e devolve a escala realmente usada, limitada ao tamanho máximo do canvas. */
export async function renderPage(doc: PdfDoc, index: number, scale: number): Promise<Rendered> {
  const page = await doc.getPage(index + 1);
  const base = page.getViewport({ scale: 1, rotation: 0 });
  const w1 = Math.max(1, base.width), h1 = Math.max(1, base.height);
  const limit = Math.min(MAX_CANVAS_SIDE / Math.max(w1, h1), Math.sqrt(MAX_CANVAS_PIXELS / (w1 * h1)));
  scale = Math.min(scale, limit);
  const viewport = page.getViewport({ scale, rotation: 0 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  await page.render({ canvasContext: ctx, viewport, canvas, background: "rgba(0,0,0,0)" } as never).promise;
  return {
    canvas,
    scale,
    toPx: (x, y) => {
      const [px, py] = viewport.convertToViewportPoint(x, y);
      return [px, py];
    },
  };
}

function boxPx(r: Rendered, b: Box) {
  const [x1, y1] = r.toPx(b.x, b.y + b.h);
  const [x2, y2] = r.toPx(b.x + b.w, b.y);
  return { x: Math.round(x1), y: Math.round(y1), w: Math.round(x2 - x1), h: Math.round(y2 - y1) };
}

function stats(data: Uint8ClampedArray) {
  let r = 0, g = 0, b = 0, n = 0, alpha = 0;
  const px: number[][] = [];
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    // composição sobre branco (papel)
    const cr = (data[i] / 255) * a + (1 - a), cg = (data[i + 1] / 255) * a + (1 - a), cb = (data[i + 2] / 255) * a + (1 - a);
    r += cr; g += cg; b += cb; n++; alpha += a;
    px.push([cr, cg, cb]);
  }
  const m: [number, number, number] = [r / n, g / n, b / n];
  let v = 0;
  for (const p of px) v += ((p[0] - m[0]) ** 2 + (p[1] - m[1]) ** 2 + (p[2] - m[2]) ** 2) / 3;
  return { mean: m, std: Math.sqrt(v / n), alpha: alpha / n, px };
}

function band(r: Rendered, t: { x: number; y: number; w: number; h: number }, side: Side, offset: number, thick: number) {
  const ctx = r.canvas.getContext("2d", { willReadFrequently: true })!;
  let x = t.x, y = t.y, w = t.w, h = t.h;
  if (side === "left") { x = t.x + offset; w = thick; }
  if (side === "right") { x = t.x + t.w - offset - thick; w = thick; }
  if (side === "top") { y = t.y + offset; h = thick; }
  if (side === "bottom") { y = t.y + t.h - offset - thick; h = thick; }
  x = Math.max(0, Math.min(r.canvas.width - 1, x)); y = Math.max(0, Math.min(r.canvas.height - 1, y));
  w = Math.max(1, Math.min(r.canvas.width - x, w)); h = Math.max(1, Math.min(r.canvas.height - y, h));
  return { img: ctx.getImageData(x, y, w, h), x, y, w, h };
}

/** Amostra as bordas internas da linha de corte e gera tiras de 1px para extensão.
 * @param sampleOffset Recuo interno (mm, por lado) do ponto de início da amostragem.
 *   0 = borda da TrimBox; valores positivos deslocam a amostragem para dentro da arte.
 */
export async function sampleEdges(
  doc: PdfDoc,
  index: number,
  trim: Box,
  dpi = 200,
  sampleOffset?: SampleOffset,
): Promise<EdgeSample> {
  const r = await renderPage(doc, index, dpi / 72);
  const t = boxPx(r, trim);
  const color = {} as EdgeSample["color"], variance = {} as EdgeSample["variance"], white = {} as EdgeSample["white"];
  const strips: EdgeSample["strips"] = {};
  for (const s of SIDES) {
    // Converte o recuo mm -> px usando a escala de renderização real.
    const offMm = sampleOffset?.[s] ?? 0;
    const offPx = Math.round(offMm * (dpi / 25.4));
    const bd = band(r, t, s, offPx, 3);
    const st = stats(bd.img.data);
    color[s] = st.mean; variance[s] = st.std;
    white[s] = st.mean.every((c) => c > 0.985) && st.std < 0.01;
    const one = band(r, t, s, offPx, 1);
    strips[s] = await toPng(one.img);
  }
  return { color, variance, white, strips };
}

async function toPng(img: ImageData): Promise<Uint8Array> {
  const c = document.createElement("canvas");
  c.width = img.width; c.height = img.height;
  c.getContext("2d")!.putImageData(img, 0, 0);
  const blob: Blob = await new Promise((res) => c.toBlob((b) => res(b!), "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}

export interface VisualCheck { index: number; level: "ok" | "warn" | "review" | "error"; msg: string }

/** Renderiza o PDF exportado e verifica se a sangria existe no conteúdo e é contínua. */
export async function validateVisual(bytes: Uint8Array, results: PageResult[], jobs: PageJob[]): Promise<VisualCheck[]> {
  const doc = await openPdf(bytes);
  const out: VisualCheck[] = [];
  for (let i = 0; i < results.length; i++) {
    const res = results[i], job = jobs[i];
    const r = await renderPage(doc, i, 100 / 72);
    const t = boxPx(r, res.trim);
    const bpx = boxPx(r, res.bleedBox);
    for (const s of SIDES) {
      const depth = s === "left" ? t.x - bpx.x : s === "right" ? bpx.x + bpx.w - t.x - t.w : s === "top" ? t.y - bpx.y : bpx.y + bpx.h - t.y - t.h;
      if (depth < 2) continue;
      // faixa dentro da sangria, logo fora do corte
      const outer = { ...t };
      if (s === "left") outer.x = t.x - depth;
      if (s === "right") outer.x = t.x + depth;
      if (s === "top") outer.y = t.y - depth;
      if (s === "bottom") outer.y = t.y + depth;
      const thick = Math.max(1, Math.floor(depth / 2));
      const inner = stats(band(r, t, s, 0, thick).img.data);
      const outerB = band(r, outer, s, depth - thick, thick); // lado da sangria encostado ao corte
      const ext = stats(outerB.img.data);
      const diff = Math.sqrt(inner.mean.reduce((a, c, k) => a + (c - ext.mean[k]) ** 2, 0) / 3);
      const label = `Pág. ${i + 1}, ${sideLabel(s)}`;
      if (ext.alpha < 0.5 && inner.alpha > 0.5) {
        out.push({ index: i, level: "error", msg: `${label}: sangria vazia/transparente.` });
      } else if (job.edges?.white[s]) {
        out.push({ index: i, level: "review", msg: `${label}: borda branca — confirme se é intencional.` });
      } else if (diff > 0.12) {
        out.push({ index: i, level: "review", msg: `${label}: descontinuidade de cor (${(diff * 100).toFixed(0)}%).` });
      } else if (diff > 0.05) {
        out.push({ index: i, level: "warn", msg: `${label}: pequena variação na transição (${(diff * 100).toFixed(0)}%).` });
      }
    }
  }
  await doc.destroy();
  return out;
}
