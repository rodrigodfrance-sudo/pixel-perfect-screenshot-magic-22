// Motor de sangria: geometria e composição do PDF (pdf-lib, preserva vetores).
import {
  PDFDocument,
  PDFPage,
  PDFName,
  cmyk,
  rgb,
  pushGraphicsState,
  popGraphicsState,
  rectangle,
  clip,
  endPath,
} from "pdf-lib";

export const MM_TO_PT = 72 / 25.4;
export const mmToPt = (mm: number) => mm * MM_TO_PT;
export const ptToMm = (pt: number) => pt / MM_TO_PT;

export type Side = "top" | "right" | "bottom" | "left";
export const SIDES: Side[] = ["top", "right", "bottom", "left"];
export type Bleed = Record<Side, number>; // mm
export type Method = "auto" | "mirror" | "solid" | "stretch" | "none";
export type SideStrategy = "mirror" | "solid" | "stretch" | "none";

export interface Box { x: number; y: number; w: number; h: number } // pt

export interface PageAnalysis {
  index: number;
  rotation: number;
  media: Box;
  crop: Box;
  trim: Box | null;
  bleedBox: Box | null;
  /** Sangria existente declarada pela BleedBox (mm, por lado), limitada à MediaBox. */
  declaredBleed: Bleed;
  warnings: string[];
}

/** Dados de borda amostrados na renderização (fornecidos pelo cliente). */
export interface EdgeSample {
  /** cor média RGB 0..1 por lado */
  color: Record<Side, [number, number, number]>;
  /** desvio padrão (0..1) da borda — baixo = fundo uniforme */
  variance: Record<Side, number>;
  /** borda totalmente branca */
  white: Record<Side, boolean>;
  /** tiras PNG de 1px da borda (para extensão por estiramento) */
  strips?: Partial<Record<Side, Uint8Array>>;
}

export interface PageJob {
  index: number;
  bleed: Bleed;
  method: Method;
  /** linha de corte (pt, coordenadas da página original). */
  trim: Box;
  skip?: boolean; // já possui sangria válida
  edges?: EdgeSample;
}

export interface PageResult {
  index: number;
  strategies: Record<Side, SideStrategy>;
  trim: Box; // na página de saída
  bleedBox: Box;
  media: Box;
  skipped: boolean;
  notes: string[];
}

export interface BuildOptions { cropMarks: boolean; markOffsetMm?: number; markLengthMm?: number }

const boxFrom = (r: { x: number; y: number; width: number; height: number }): Box => ({
  x: r.x, y: r.y, w: r.width, h: r.height,
});
const eq = (a: number, b: number, tol = 0.5) => Math.abs(a - b) <= tol;
const sameBox = (a: Box, b: Box) => eq(a.x, b.x) && eq(a.y, b.y) && eq(a.w, b.w) && eq(a.h, b.h);

export function uniformBleed(mm: number): Bleed {
  return { top: mm, right: mm, bottom: mm, left: mm };
}

/** Análise geométrica de cada página: valida as caixas e a relação entre elas. */
export async function analyzePdf(bytes: Uint8Array): Promise<PageAnalysis[]> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false });
  return doc.getPages().map((p, index) => analyzePage(p, index));
}

export function analyzePage(p: PDFPage, index: number): PageAnalysis {
  const warnings: string[] = [];
  const media = boxFrom(p.getMediaBox());
  const crop = boxFrom(p.getCropBox());
  const trimRaw = boxFrom(p.getTrimBox());
  const bleedRaw = boxFrom(p.getBleedBox());
  // pdf-lib devolve a CropBox quando Trim/Bleed não existem
  const hasTrim = !!p.node.get(PDFName.of("TrimBox")) || !!p.node.get(PDFName.of("ArtBox"));
  const hasBleed = !!p.node.get(PDFName.of("BleedBox"));
  let trim: Box | null = hasTrim ? trimRaw : null;
  let bleedBox: Box | null = hasBleed ? bleedRaw : null;

  const inside = (a: Box, b: Box) =>
    a.x >= b.x - 0.5 && a.y >= b.y - 0.5 && a.x + a.w <= b.x + b.w + 0.5 && a.y + a.h <= b.y + b.h + 0.5;

  if (trim && !inside(trim, media)) {
    warnings.push("TrimBox ultrapassa a MediaBox — caixa ignorada, confirme a linha de corte.");
    trim = null;
  }
  if (trim && (trim.w < 10 || trim.h < 10)) {
    warnings.push("TrimBox com dimensões inválidas — caixa ignorada.");
    trim = null;
  }
  if (bleedBox && trim && !inside(trim, bleedBox)) {
    warnings.push("BleedBox menor que a TrimBox — inconsistência ignorada.");
    bleedBox = null;
  }
  if (!sameBox(crop, media) && !inside(crop, media)) warnings.push("CropBox fora da MediaBox.");

  const declaredBleed: Bleed = uniformBleed(0);
  if (trim) {
    const outer = bleedBox ?? media;
    const ob = intersect(outer, media);
    declaredBleed.left = Math.max(0, ptToMm(trim.x - ob.x));
    declaredBleed.bottom = Math.max(0, ptToMm(trim.y - ob.y));
    declaredBleed.right = Math.max(0, ptToMm(ob.x + ob.w - (trim.x + trim.w)));
    declaredBleed.top = Math.max(0, ptToMm(ob.y + ob.h - (trim.y + trim.h)));
  } else {
    warnings.push("Sem TrimBox: a página visível (CropBox) foi assumida como linha de corte.");
  }
  return { index, rotation: p.getRotation().angle, media, crop, trim, bleedBox, declaredBleed, warnings };
}

function intersect(a: Box, b: Box): Box {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  return { x, y, w: Math.max(0, x2 - x), h: Math.max(0, y2 - y) };
}

export function defaultTrim(a: PageAnalysis): Box {
  return a.trim ?? intersect(a.crop, a.media);
}

export function hasEnoughBleed(declared: Bleed, wanted: Bleed) {
  return SIDES.every((s) => declared[s] + 0.05 >= wanted[s]);
}

/** Escolhe a estratégia por lado a partir da análise da borda. */
export function chooseStrategy(method: Method, side: Side, edges?: EdgeSample): SideStrategy {
  if (method === "none") return "none";
  if (method !== "auto") return method;
  if (!edges) return "mirror";
  if (edges.white[side]) return "solid"; // fundo branco: continua branco (sinalizado p/ revisão)
  if (edges.variance[side] < 0.02) return "solid";
  return "mirror";
}

/** Margem reservada para marcas de corte (mm). */
export const markMarginMm = (o: BuildOptions) => (o.cropMarks ? (o.markOffsetMm ?? 2) + (o.markLengthMm ?? 5) + 1 : 0);

export function outputGeometry(trim: Box, bleed: Bleed, o: BuildOptions) {
  const m = mmToPt(markMarginMm(o));
  const b = { top: mmToPt(bleed.top), right: mmToPt(bleed.right), bottom: mmToPt(bleed.bottom), left: mmToPt(bleed.left) };
  const W = trim.w + b.left + b.right + 2 * m;
  const H = trim.h + b.top + b.bottom + 2 * m;
  const outTrim: Box = { x: m + b.left, y: m + b.bottom, w: trim.w, h: trim.h };
  const outBleed: Box = { x: m, y: m, w: trim.w + b.left + b.right, h: trim.h + b.top + b.bottom };
  return { W, H, m, b, outTrim, outBleed };
}

/** Composição do PDF final com sangria real no conteúdo gráfico. */
export async function buildBleedPdf(
  srcBytes: Uint8Array,
  jobs: PageJob[],
  opts: BuildOptions,
): Promise<{ bytes: Uint8Array; results: PageResult[] }> {
  const src = await PDFDocument.load(srcBytes);
  const out = await PDFDocument.create();
  out.setProducer("Gerador Inteligente de Sangria");
  const results: PageResult[] = [];

  for (const job of jobs) {
    const srcPage = src.getPage(job.index);
    if (job.skip) {
      const [copied] = await out.copyPages(src, [job.index]);
      out.addPage(copied);
      const a = analyzePage(srcPage, job.index);
      results.push({
        index: job.index,
        strategies: { top: "none", right: "none", bottom: "none", left: "none" },
        trim: a.trim ?? job.trim,
        bleedBox: a.bleedBox ?? a.media,
        media: a.media,
        skipped: true,
        notes: ["Sangria existente reaproveitada — página não alterada."],
      });
      continue;
    }

    const t = job.trim;
    const emb = await out.embedPage(srcPage, { left: t.x, bottom: t.y, right: t.x + t.w, top: t.y + t.h });
    const g = outputGeometry(t, job.bleed, opts);
    const page = out.addPage([g.W, g.H]);
    const X = g.outTrim.x, Y = g.outTrim.y, w = t.w, h = t.h;
    const strategies = {} as Record<Side, SideStrategy>;
    const notes: string[] = [];
    for (const s of SIDES) strategies[s] = job.bleed[s] > 0 ? chooseStrategy(job.method, s, job.edges) : "none";

    const clipRect = (x: number, y: number, cw: number, ch: number, draw: () => void) => {
      page.pushOperators(pushGraphicsState(), rectangle(x, y, cw, ch), clip(), endPath());
      draw();
      page.pushOperators(popGraphicsState());
    };
    const { b } = g;
    // regiões de cada lado (incluindo cantos para top/bottom)
    const regions: Record<Side, Box> = {
      left: { x: X - b.left, y: Y, w: b.left, h },
      right: { x: X + w, y: Y, w: b.right, h },
      bottom: { x: X - b.left, y: Y - b.bottom, w: w + b.left + b.right, h: b.bottom },
      top: { x: X - b.left, y: Y + h, w: w + b.left + b.right, h: b.top },
    };

    for (const s of SIDES) {
      const st = strategies[s];
      const r = regions[s];
      if (st === "none" || r.w <= 0 || r.h <= 0) continue;
      if (st === "solid") {
        const c = job.edges?.color[s] ?? [1, 1, 1];
        page.drawRectangle({ x: r.x, y: r.y, width: r.w, height: r.h, color: rgb(c[0], c[1], c[2]) });
        if (job.edges?.white[s]) notes.push(`Borda ${sideLabel(s)} branca: confirme se o fundo branco é intencional.`);
      } else if (st === "stretch") {
        const strip = job.edges?.strips?.[s];
        if (!strip) {
          strategies[s] = "mirror";
          notes.push(`Estiramento indisponível na borda ${sideLabel(s)} — espelhamento usado.`);
        } else {
          const img = await out.embedPng(strip);
          const horiz = s === "top" || s === "bottom";
          // tira cobre o comprimento da arte; cantos via espelhamento
          const sr = horiz ? { x: X, y: r.y, w, h: r.h } : r;
          page.drawImage(img, { x: sr.x, y: sr.y, width: sr.w, height: sr.h });
          if (horiz) mirrorCorners(s);
          continue;
        }
      }
      if (strategies[s] === "mirror") {
        clipRect(r.x, r.y, r.w, r.h, () => {
          if (s === "left") page.drawPage(emb, { x: X, y: Y, xScale: -1, yScale: 1 });
          if (s === "right") page.drawPage(emb, { x: X + 2 * w, y: Y, xScale: -1, yScale: 1 });
          if (s === "bottom" || s === "top") {
            const yy = s === "bottom" ? Y : Y + 2 * h;
            page.drawPage(emb, { x: X, y: yy, xScale: 1, yScale: -1 });
            page.drawPage(emb, { x: X, y: yy, xScale: -1, yScale: -1 });
            page.drawPage(emb, { x: X + 2 * w, y: yy, xScale: -1, yScale: -1 });
          }
        });
      }
    }

    function mirrorCorners(s: Side) {
      const yy = s === "bottom" ? Y : Y + 2 * h;
      const ry = s === "bottom" ? Y - b.bottom : Y + h;
      const rh = s === "bottom" ? b.bottom : b.top;
      clipRect(X - b.left, ry, b.left, rh, () => page.drawPage(emb, { x: X, y: yy, xScale: -1, yScale: -1 }));
      clipRect(X + w, ry, b.right, rh, () => page.drawPage(emb, { x: X + 2 * w, y: yy, xScale: -1, yScale: -1 }));
    }

    // arte original por cima, em posição e escala 1:1
    page.drawPage(emb, { x: X, y: Y });

    page.setMediaBox(0, 0, g.W, g.H);
    page.setCropBox(0, 0, g.W, g.H);
    page.setBleedBox(g.outBleed.x, g.outBleed.y, g.outBleed.w, g.outBleed.h);
    page.setTrimBox(X, Y, w, h);
    if (opts.cropMarks) drawCropMarks(page, g.outTrim, job.bleed, opts);

    results.push({
      index: job.index,
      strategies,
      trim: g.outTrim,
      bleedBox: g.outBleed,
      media: { x: 0, y: 0, w: g.W, h: g.H },
      skipped: false,
      notes,
    });
  }
  const bytes = await out.save();
  return { bytes, results };
}

export function cropMarkLines(trim: Box, bleed: Bleed, o: BuildOptions) {
  const off = mmToPt(o.markOffsetMm ?? 2);
  const len = mmToPt(o.markLengthMm ?? 5);
  const { x, y, w, h } = trim;
  const L = x - mmToPt(bleed.left) - off, R = x + w + mmToPt(bleed.right) + off;
  const B = y - mmToPt(bleed.bottom) - off, T = y + h + mmToPt(bleed.top) + off;
  return [
    // horizontais (indicam y do corte), fora da sangria
    [L - len, y, L, y], [R, y, R + len, y], [L - len, y + h, L, y + h], [R, y + h, R + len, y + h],
    // verticais (indicam x do corte)
    [x, B - len, x, B], [x + w, B - len, x + w, B], [x, T, x, T + len], [x + w, T, x + w, T + len],
  ] as [number, number, number, number][];
}

function drawCropMarks(page: PDFPage, trim: Box, bleed: Bleed, o: BuildOptions) {
  for (const [x1, y1, x2, y2] of cropMarkLines(trim, bleed, o)) {
    // cor de registro (100% CMYK)
    page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.25, color: cmyk(1, 1, 1, 1) });
  }
}

export const sideLabel = (s: Side) => ({ top: "superior", right: "direita", bottom: "inferior", left: "esquerda" })[s];

/** Converte imagem raster em PDF com dimensões físicas (DPI). */
export async function imageToPdf(bytes: Uint8Array, kind: "png" | "jpg", dpi: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const img = kind === "png" ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  const w = (img.width / dpi) * 72, h = (img.height / dpi) * 72;
  const p = doc.addPage([w, h]);
  p.drawImage(img, { x: 0, y: 0, width: w, height: h });
  return doc.save();
}

/** Verificações geométricas do PDF exportado. */
export async function validateGeometry(bytes: Uint8Array, results: PageResult[], jobs: PageJob[]) {
  const issues: { index: number; level: "error" | "warn"; msg: string }[] = [];
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes);
  } catch {
    return { ok: false, issues: [{ index: -1, level: "error" as const, msg: "O arquivo final não pôde ser aberto." }] };
  }
  if (doc.getPageCount() !== jobs.length)
    issues.push({ index: -1, level: "error", msg: "Número de páginas diferente do esperado." });
  doc.getPages().forEach((p, i) => {
    const r = results[i], j = jobs[i];
    if (!r || !j) return;
    const trim = boxFrom(p.getTrimBox()), bleed = boxFrom(p.getBleedBox()), media = boxFrom(p.getMediaBox());
    if (!eq(trim.w, j.trim.w) || !eq(trim.h, j.trim.h))
      issues.push({ index: i, level: "error", msg: "TrimBox não corresponde ao formato final de corte." });
    if (!r.skipped) {
      const exp = {
        left: trim.x - bleed.x, bottom: trim.y - bleed.y,
        right: bleed.x + bleed.w - trim.x - trim.w, top: bleed.y + bleed.h - trim.y - trim.h,
      };
      for (const s of SIDES)
        if (!eq(exp[s], mmToPt(j.bleed[s])))
          issues.push({ index: i, level: "error", msg: `BleedBox ${sideLabel(s)} difere da sangria configurada.` });
    }
    if (bleed.x < media.x - 0.5 || bleed.y < media.y - 0.5 || bleed.x + bleed.w > media.x + media.w + 0.5 || bleed.y + bleed.h > media.y + media.h + 0.5)
      issues.push({ index: i, level: "error", msg: "MediaBox não comporta a sangria." });
  });
  return { ok: !issues.some((x) => x.level === "error"), issues };
}
