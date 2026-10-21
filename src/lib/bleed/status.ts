export type FileKind = "pdf" | "png" | "jpg" | "tiff" | "unknown";
export type Status = "Aprovado" | "Aprovado com avisos" | "Revisão necessária" | "Falha";

/** Detecta o tipo real pelo conteúdo (assinatura), não pela extensão. */
export function detectKind(b: Uint8Array): FileKind {
  const s = (n: number) => String.fromCharCode(...b.slice(0, n));
  if (s(5) === "%PDF-") return "pdf";
  if (b[0] === 0x89 && s(4).slice(1) === "PNG") return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) || (b[0] === 0x4d && b[1] === 0x4d && b[3] === 0x2a)) return "tiff";
  return "unknown";
}

export function statusOf(
  geo: { level: string }[],
  visual: { level: string }[],
  warnings: string[],
): Status {
  if (geo.some((x) => x.level === "error") || visual.some((x) => x.level === "error")) return "Falha";
  if (visual.some((x) => x.level === "review")) return "Revisão necessária";
  if (geo.length || visual.length || warnings.length) return "Aprovado com avisos";
  return "Aprovado";
}
