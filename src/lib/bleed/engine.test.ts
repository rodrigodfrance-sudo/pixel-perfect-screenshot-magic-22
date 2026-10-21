import { describe, it, expect } from "vitest";
import { PDFDocument, rgb } from "pdf-lib";
import {
  analyzePdf, buildBleedPdf, defaultTrim, hasEnoughBleed, mmToPt, ptToMm, uniformBleed, validateGeometry,
  imageToPdf, type PageJob,
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
    expect(hasEnoughBleed(a.declaredBleed, uniformBleed(3))).toBe(false);
  });

  it("flags TrimBox outside MediaBox as inconsistent", async () => {
    const d = await PDFDocument.create();
    const p = d.addPage([300, 300]);
    p.setTrimBox(-50, 0, 400, 300);
    const [a] = await analyzePdf(await d.save());
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
