import { describe, it, expect } from "vitest";
import { PDFDocument, rgb, degrees } from "pdf-lib";
import {
  analyzePdf, buildBleedPdf, chooseStrategy, cropMarkLines, defaultTrim, hasEnoughBleed, mmToPt, ptToMm,
  uniformBleed, validateGeometry, validateTrim, imageToPdf, type EdgeSample, type PageJob,
} from "./engine";
import { detectKind, statusOf } from "./status";

const A4 = [595.28, 841.89] as const;

async function solidPdf(sizes: [number, number][] = [[A4[0], A4[1]]]) {
  const d = await PDFDocument.create();
  for (const [w, h] of sizes) {
    const p = d.addPage([w, h]);
    p.drawRectangle({ x: 0, y: 0, width: w, height: h, color: rgb(0.1, 0.4, 0.8) });
  }
  return d.save();
}
const jobsFor = async (bytes: Uint8Array, mm = 3, method: PageJob["method"] = "mirror") =>
  (await analyzePdf(bytes)).map((a) => ({ index: a.index, bleed: uniformBleed(mm), method, trim: defaultTrim(a) }));

describe("bleed engine", () => {
  it("3 mm equals 8.5039 pt", () => {
    expect(mmToPt(3)).toBeCloseTo(8.5039, 4);
  });

  it("output adds 6 mm to width and height while TrimBox keeps the cut size", async () => {
    const src = await solidPdf();
    const jobs = await jobsFor(src);
    const { bytes } = await buildBleedPdf(src, jobs, { cropMarks: false });
    const p = (await PDFDocument.load(bytes)).getPage(0);
    const t = p.getTrimBox(), b = p.getBleedBox(), m = p.getMediaBox();
    expect(ptToMm(t.width)).toBeCloseTo(210, 1);
    expect(ptToMm(t.height)).toBeCloseTo(297, 1);
    expect(ptToMm(b.width)).toBeCloseTo(216, 1);
    expect(ptToMm(b.height)).toBeCloseTo(303, 1);
    expect(ptToMm(m.width)).toBeCloseTo(216, 1);
  });

  it("crop marks enlarge MediaBox beyond the BleedBox", async () => {
    const src = await solidPdf();
    const { bytes } = await buildBleedPdf(src, await jobsFor(src), { cropMarks: true });
    const p = (await PDFDocument.load(bytes)).getPage(0);
    expect(p.getMediaBox().width).toBeGreaterThan(p.getBleedBox().width + mmToPt(10));
  });

  it("geometry validation passes for a correct build", async () => {
    const src = await solidPdf();
    const jobs = await jobsFor(src);
    const { bytes, results } = await buildBleedPdf(src, jobs, { cropMarks: true });
    const v = await validateGeometry(bytes, results, jobs);
    expect(v.ok).toBe(true);
  });

  it("detects existing 3 mm bleed and skips regeneration", async () => {
    const src = await solidPdf();
    const { bytes } = await buildBleedPdf(src, await jobsFor(src), { cropMarks: false });
    const [a] = await analyzePdf(bytes);
    if (!a) throw new Error("sem página");
    expect(a.trim).not.toBeNull();
    expect(hasEnoughBleed(a.declaredBleed, uniformBleed(3))).toBe(true);
    expect(hasEnoughBleed(a.declaredBleed, uniformBleed(5))).toBe(false);
  });

  it("BleedBox larger than MediaBox does not count as bleed", async () => {
    const d = await PDFDocument.create();
    const p = d.addPage([300, 300]);
    p.setTrimBox(0, 0, 300, 300);
    p.setBleedBox(-10, -10, 320, 320);
    const [a] = await analyzePdf(await d.save());
    if (!a) throw new Error("sem página");
    expect(hasEnoughBleed(a.declaredBleed, uniformBleed(3))).toBe(false);
  });

  it("flags TrimBox outside MediaBox as inconsistent", async () => {
    const d = await PDFDocument.create();
    const p = d.addPage([300, 300]);
    p.setTrimBox(-50, 0, 400, 300);
    const [a] = await analyzePdf(await d.save());
    if (!a) throw new Error("sem página");
    expect(a.trim).toBeNull();
    expect(a.warnings.length).toBeGreaterThan(0);
  });

  it("handles multi-page documents with portrait and landscape sizes", async () => {
    const src = await solidPdf([[A4[0], A4[1]], [A4[1], A4[0]], [252, 144]]);
    const jobs = await jobsFor(src);
    const { bytes, results } = await buildBleedPdf(src, jobs, { cropMarks: false });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(3);
    expect(ptToMm(doc.getPage(1).getTrimBox().width)).toBeCloseTo(297, 1);
    expect((await validateGeometry(bytes, results, jobs)).ok).toBe(true);
  });

  it("converts an image to PDF at the given DPI", async () => {
    // PNG 1x1 vermelho
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const pdf = await imageToPdf(png, "png", 300);
    const p = (await PDFDocument.load(pdf)).getPage(0);
    expect(p.getWidth()).toBeCloseTo(72 / 300, 3);
  });

  it("detects real file types and rejects unknown data", () => {
    expect(detectKind(new TextEncoder().encode("%PDF-1.7"))).toBe("pdf");
    expect(detectKind(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpg");
    expect(detectKind(Uint8Array.from([0x49, 0x49, 0x2a, 0]))).toBe("tiff");
    expect(detectKind(new TextEncoder().encode("hello"))).toBe("unknown");
  });

  it("status is Falha on errors and Revisão when review is needed", () => {
    expect(statusOf([{ level: "error" }], [], [])).toBe("Falha");
    expect(statusOf([], [{ level: "review" }], [])).toBe("Revisão necessária");
    expect(statusOf([], [], ["x"])).toBe("Aprovado com avisos");
    expect(statusOf([], [], [])).toBe("Aprovado");
  });
});

describe("bleed engine — regressões e cobertura extra", () => {
  const edges = (over: Partial<EdgeSample> = {}): EdgeSample => ({
    color: { top: [0.2, 0.2, 0.2], right: [0.2, 0.2, 0.2], bottom: [0.2, 0.2, 0.2], left: [0.2, 0.2, 0.2] },
    variance: { top: 0.5, right: 0.5, bottom: 0.5, left: 0.5 },
    white: { top: false, right: false, bottom: false, left: false },
    ...over,
  });

  it("TrimBox sem BleedBox não trata a margem como sangria existente", async () => {
    const d = await PDFDocument.create();
    const p = d.addPage([300, 300]);
    p.setTrimBox(30, 30, 240, 240); // margem de ~10,6 mm em branco, sem BleedBox
    const [a] = await analyzePdf(await d.save());
    if (!a) throw new Error("sem página");
    expect(hasEnoughBleed(a.declaredBleed, uniformBleed(3))).toBe(false);
    expect(a.warnings.length).toBeGreaterThan(0);
  });

  it("página rotacionada gera aviso", async () => {
    const d = await PDFDocument.create();
    d.addPage([400, 200]).setRotation(degrees(90));
    const [a] = await analyzePdf(await d.save());
    if (!a) throw new Error("sem página");
    expect(a.rotation).toBe(90);
    expect(a.warnings.some((w) => w.includes("rotação"))).toBe(true);
  });

  it("validateTrim recusa corte zerado, não numérico e fora da página", () => {
    const media = { x: 0, y: 0, w: 300, h: 300 };
    expect(validateTrim({ x: 0, y: 0, w: 300, h: 300 }, media)).toBeNull();
    expect(validateTrim({ x: 0, y: 0, w: 0, h: 300 }, media)).not.toBeNull();
    expect(validateTrim({ x: 0, y: 0, w: Number.NaN, h: 300 }, media)).not.toBeNull();
    expect(validateTrim({ x: 0, y: 0, w: 500, h: 300 }, media)).not.toBeNull();
    expect(validateTrim({ x: -40, y: 0, w: 300, h: 300 }, media)).not.toBeNull();
  });

  it("buildBleedPdf rejeita linha de corte inválida em vez de gerar PDF errado", async () => {
    const src = await solidPdf([[300, 300]]);
    const job: PageJob = { index: 0, bleed: uniformBleed(3), method: "mirror", trim: { x: 0, y: 0, w: 0, h: 300 } };
    await expect(buildBleedPdf(src, [job], { cropMarks: false })).rejects.toThrow(/Página 1/);
  });

  it("página em branco não derruba o documento", async () => {
    const d = await PDFDocument.create();
    d.addPage([300, 300]).drawRectangle({ x: 0, y: 0, width: 300, height: 300, color: rgb(1, 0, 0) });
    d.addPage([300, 300]); // sem conteúdo
    const src = await d.save();
    const jobs = await jobsFor(src);
    const { bytes, results } = await buildBleedPdf(src, jobs, { cropMarks: true });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(2);
    expect(results[1]?.notes[0] ?? "").toMatch(/em branco/);
    expect((await validateGeometry(bytes, results, jobs)).ok).toBe(true);
  });

  it("avisa quando a sangria é maior que a arte no espelhamento", async () => {
    const src = await solidPdf([[20, 20]]);
    const { results } = await buildBleedPdf(src, await jobsFor(src, 20), { cropMarks: false });
    expect(results[0]?.notes.some((n) => n.includes("maior que a arte"))).toBe(true);
  });

  it("sangria assimétrica e TrimBox com origem diferente de zero", async () => {
    const d = await PDFDocument.create();
    const p = d.addPage([400, 400]);
    p.drawRectangle({ x: 0, y: 0, width: 400, height: 400, color: rgb(0.5, 0.2, 0.2) });
    const src = await d.save();
    const trim = { x: 50, y: 60, w: 200, h: 150 };
    const bleed = { top: 1, right: 2, bottom: 3, left: 4 };
    const jobs: PageJob[] = [{ index: 0, bleed, method: "mirror", trim }];
    const { bytes, results } = await buildBleedPdf(src, jobs, { cropMarks: false });
    const out = (await PDFDocument.load(bytes)).getPage(0);
    expect(out.getTrimBox().width).toBeCloseTo(200, 1);
    expect(out.getTrimBox().height).toBeCloseTo(150, 1);
    expect(ptToMm(out.getWidth())).toBeCloseTo(ptToMm(200) + 4 + 2, 1);
    expect(ptToMm(out.getHeight())).toBeCloseTo(ptToMm(150) + 1 + 3, 1);
    expect(ptToMm(out.getTrimBox().x)).toBeCloseTo(4, 1); // esquerda
    expect(ptToMm(out.getTrimBox().y)).toBeCloseTo(3, 1); // inferior
    expect((await validateGeometry(bytes, results, jobs)).ok).toBe(true);
  });

  it("chooseStrategy: manual vence; auto usa cor sólida em fundo uniforme/branco e espelho em arte variada", () => {
    expect(chooseStrategy("none", "top", edges())).toBe("none");
    expect(chooseStrategy("stretch", "top", edges())).toBe("stretch");
    expect(chooseStrategy("auto", "top")).toBe("mirror");
    expect(chooseStrategy("auto", "top", edges())).toBe("mirror");
    expect(chooseStrategy("auto", "left", edges({ variance: { top: 0.5, right: 0.5, bottom: 0.5, left: 0.005 } }))).toBe("solid");
    expect(chooseStrategy("auto", "right", edges({ white: { top: false, right: true, bottom: false, left: false } }))).toBe("solid");
  });

  it("marcas de corte ficam fora da sangria e dentro da MediaBox", async () => {
    const src = await solidPdf();
    const jobs = await jobsFor(src);
    const { bytes, results } = await buildBleedPdf(src, jobs, { cropMarks: true });
    const media = (await PDFDocument.load(bytes)).getPage(0).getMediaBox();
    const r = results[0];
    if (!r) throw new Error("sem resultado");
    const lines = cropMarkLines(r.trim, uniformBleed(3), { cropMarks: true });
    expect(lines.length).toBe(8);
    for (const [x1, y1, x2, y2] of lines) {
      for (const v of [x1, x2]) { expect(v).toBeGreaterThan(-0.001); expect(v).toBeLessThan(media.width + 0.001); }
      for (const v of [y1, y2]) { expect(v).toBeGreaterThan(-0.001); expect(v).toBeLessThan(media.height + 0.001); }
    }
  });

  it("buildBleedPdf funciona com sampleOffset (início de referência recuado para dentro da TrimBox)", async () => {
    const src = await solidPdf();
    const jobs = (await jobsFor(src)).map((j) => ({
      ...j,
      sampleOffset: { top: 0.5, right: 0.5, bottom: 0.5, left: 0.5 },
    }));
    const { bytes, results } = await buildBleedPdf(src, jobs, { cropMarks: false });
    expect(bytes.length).toBeGreaterThan(0);
    const v = await validateGeometry(bytes, results, jobs);
    expect(v.ok).toBe(true);
  });
});
