import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PDFDocument } from "pdf-lib";
import {
  analyzePdf,
  buildBleedPdf,
  defaultTrim,
  hasEnoughBleed,
  imageToPdf,
  ptToMm,
  mmToPt,
  uniformBleed,
  validateGeometry,
  validateTrim,
  cropMarkLines,
  sideLabel,
  SIDES,
  uniformSampleOffset,
  type Bleed,
  type Box,
  type Method,
  type PageAnalysis,
  type PageJob,
  type PageResult,
  type Side,
  type SampleOffset,
} from "@/lib/bleed/engine";
import {
  openPdf,
  renderPage,
  sampleEdges,
  validateVisual,
  type PdfDoc,
  type VisualCheck,
} from "@/lib/bleed/render";
import { detectKind, statusOf, type FileKind, type Status } from "@/lib/bleed/status";
import { ThemeToggle } from "@/components/ThemeToggle";

interface PageCfg {
  bleed: Bleed;
  method: Method;
  trim: Box;
  skip: boolean;
  sampleOffset: SampleOffset;
}
interface Output {
  bytes: Uint8Array;
  results: PageResult[];
  jobs: PageJob[];
  issues: { index: number; level: string; msg: string }[];
  visual: VisualCheck[];
  status: Status;
  stale: boolean;
}
interface Item {
  id: string;
  name: string;
  kind: FileKind;
  size: number;
  src: Uint8Array;
  analyses: PageAnalysis[];
  cfg: PageCfg[];
  past: PageCfg[][];
  future: PageCfg[][];
  output?: Output;
  approved: boolean;
  warnings: string[];
}

const MAX_MB = 80,
  MAX_PAGES = 200;
const METHODS: { v: Method; l: string }[] = [
  { v: "auto", l: "Automático (analisa cada borda)" },
  { v: "mirror", l: "Espelhamento vetorial" },
  { v: "stretch", l: "Extrapolação de borda (pixel)" },
  { v: "solid", l: "Cor sólida amostrada" },
  { v: "none", l: "Sem extensão" },
];
const STRAT: Record<string, string> = {
  mirror: "espelho",
  solid: "cor sólida",
  stretch: "extrapolação",
  none: "—",
};
const STATUS_STYLE: Record<Status, string> = {
  Aprovado: "bg-ok text-primary-foreground",
  "Aprovado com avisos": "bg-warn text-primary-foreground",
  "Revisão necessária": "bg-review text-primary-foreground",
  Falha: "bg-destructive text-destructive-foreground",
};
const fmt = (n: number, d = 1) => n.toFixed(d).replace(".", ",");
const download = (bytes: Uint8Array | string, name: string, type = "application/pdf") => {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
};

export default function BleedStudio() {
  const [items, setItems] = useState<Item[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pageIdx, setPageIdx] = useState(0);
  const [link, setLink] = useState(true);
  const [linkOffset, setLinkOffset] = useState(true);
  const [settingsTab, setSettingsTab] = useState<"basic" | "advanced">("advanced");
  const [scope, setScope] = useState<"page" | "all">("all");
  const [cropMarks, setCropMarks] = useState(true);
  const [reuseExisting, setReuseExisting] = useState(true);
  const [dpi, setDpi] = useState(300);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const cancelRef = useRef(false);

  const item = items.find((i) => i.id === activeId) ?? null;
  const cfg = item?.cfg[pageIdx];
  const trimProblems = item
    ? item.cfg.flatMap((c, i) => {
        const media = item.analyses[i]?.media;
        const msg = !c.skip && media ? validateTrim(c.trim, media) : null;
        return msg ? [`Pág. ${i + 1}: ${msg}`] : [];
      })
    : [];
  const update = (id: string, fn: (i: Item) => Item) =>
    setItems((xs) => xs.map((x) => (x.id === id ? fn(x) : x)));

  // ---------- importação ----------
  const onFiles = async (files: FileList | File[]) => {
    const errs: string[] = [];
    // DPI é validado aqui (e não no onChange) para o campo poder ser apagado e redigitado sem saltos.
    const useDpi = Math.min(1200, Math.max(72, Number.isFinite(dpi) ? dpi : 300));
    for (const f of Array.from(files)) {
      try {
        if (f.size > MAX_MB * 1024 * 1024) throw new Error(`excede o limite de ${MAX_MB} MB`);
        const raw = new Uint8Array(await f.arrayBuffer());
        const kind = detectKind(raw);
        if (kind === "tiff")
          throw new Error(
            "TIFF ainda não tem conversor testado neste módulo — envie PDF, PNG ou JPG",
          );
        if (kind === "unknown") throw new Error("formato não reconhecido ou arquivo corrompido");
        const warnings: string[] = [];
        let src = raw;
        if (kind === "png" || kind === "jpg") {
          src = await imageToPdf(raw, kind, useDpi);
          warnings.push(`Imagem convertida para PDF a ${useDpi} DPI.`);
          if (useDpi < 250)
            warnings.push(
              "Resolução abaixo de 250 DPI: qualidade de impressão pode ser insuficiente.",
            );
        }
        const analyses = await analyzePdf(src);
        if (analyses.length > MAX_PAGES) throw new Error(`mais de ${MAX_PAGES} páginas`);
        const cfgs = analyses.map((a) => ({
          bleed: uniformBleed(3),
          method: "auto" as Method,
          trim: defaultTrim(a),
          sampleOffset: uniformSampleOffset(0),
          skip: reuseExisting && hasEnoughBleed(a.declaredBleed, uniformBleed(3)),
        }));
        const it: Item = {
          id: crypto.randomUUID(),
          name: f.name,
          kind,
          size: f.size,
          src,
          analyses,
          cfg: cfgs,
          past: [],
          future: [],
          approved: false,
          warnings,
        };
        setItems((xs) => [...xs, it]);
        setActiveId(it.id);
        setPageIdx(0);
      } catch (e) {
        errs.push(
          `${f.name}: ${(e as Error).message.includes("encrypt") ? "PDF protegido por senha" : (e as Error).message}`,
        );
      }
    }
    setErrors(errs);
  };

  // ---------- configuração com desfazer/refazer ----------
  // `onlyCurrent`: a linha de corte é sempre por página — nunca replicar em "Todas as páginas".
  const setCfg = (fn: (c: PageCfg, i: number) => PageCfg, onlyCurrent = false) => {
    if (!item) return;
    update(item.id, (it) => ({
      ...it,
      past: [...it.past.slice(-50), it.cfg],
      future: [],
      cfg: it.cfg.map((c, i) =>
        (scope === "all" && !onlyCurrent) || i === pageIdx ? fn(c, i) : c,
      ),
      output: it.output ? { ...it.output, stale: true } : undefined,
      approved: false,
    }));
  };
  const setSide = (s: Side, v: number) =>
    setCfg((c) => ({ ...c, skip: false, bleed: link ? uniformBleed(v) : { ...c.bleed, [s]: v } }));
  const undo = () =>
    item &&
    item.past.length &&
    update(item.id, (it) => ({
      ...it,
      cfg: it.past[it.past.length - 1],
      past: it.past.slice(0, -1),
      future: [it.cfg, ...it.future],
      output: it.output && { ...it.output, stale: true },
    }));
  const redo = () =>
    item &&
    item.future.length &&
    update(item.id, (it) => ({
      ...it,
      cfg: it.future[0],
      future: it.future.slice(1),
      past: [...it.past, it.cfg],
      output: it.output && { ...it.output, stale: true },
    }));
  const restore = () =>
    item &&
    update(item.id, (it) => ({
      ...it,
      past: [...it.past, it.cfg],
      future: [],
      output: undefined,
      approved: false,
      cfg: it.analyses.map((a) => ({
        bleed: uniformBleed(3),
        method: "auto",
        trim: defaultTrim(a),
        sampleOffset: uniformSampleOffset(0),
        skip: reuseExisting && hasEnoughBleed(a.declaredBleed, uniformBleed(3)),
      })),
    }));

  // ---------- processamento ----------
  const process = async () => {
    if (!item) return;
    cancelRef.current = false;
    const cfgAtStart = item.cfg; // se a configuração mudar durante o processamento, o resultado já nasce desatualizado
    try {
      const srcDoc = await openPdf(item.src);
      const jobs: PageJob[] = [];
      for (let i = 0; i < item.cfg.length; i++) {
        if (cancelRef.current) {
          await srcDoc.destroy();
          setBusy(null);
          return;
        }
        setBusy(`Analisando bordas — página ${i + 1}/${item.cfg.length}`);
        const c = item.cfg[i];
        const edges =
          c.skip || c.method === "mirror" || c.method === "none"
            ? undefined
            : await sampleEdges(srcDoc, i, c.trim, undefined, c.sampleOffset);
        jobs.push({
          index: i,
          bleed: c.bleed,
          method: c.method,
          trim: c.trim,
          skip: c.skip,
          edges,
          sampleOffset: c.sampleOffset,
        });
      }
      await srcDoc.destroy();
      setBusy("Compondo PDF final");
      const { bytes, results } = await buildBleedPdf(item.src, jobs, { cropMarks });
      setBusy("Validando geometria e conteúdo renderizado");
      const geo = await validateGeometry(bytes, results, jobs);
      const visual = await validateVisual(bytes, results, jobs);
      const notes = results.flatMap((r) => r.notes);
      const status = statusOf(geo.issues, visual, [
        ...notes,
        ...item.warnings,
        ...item.analyses.flatMap((a) => a.warnings),
      ]);
      update(item.id, (it) => ({
        ...it,
        approved: false,
        output: {
          bytes,
          results,
          jobs,
          issues: geo.issues,
          visual,
          status,
          stale: it.cfg !== cfgAtStart,
        },
      }));
    } catch (e) {
      setErrors([`Falha no processamento: ${(e as Error).message}`]);
    }
    setBusy(null);
  };

  const exportPage = async (i: number) => {
    if (!item?.output) return;
    const src = await PDFDocument.load(item.output.bytes);
    const d = await PDFDocument.create();
    const [p] = await d.copyPages(src, [i]);
    d.addPage(p);
    download(await d.save(), item.name.replace(/\.[^.]+$/, "") + `_p${i + 1}_sangria.pdf`);
  };
  const report = () => {
    if (!item?.output) return;
    const o = item.output;
    const lines = [
      `RELATÓRIO DE SANGRIA — ${item.name}`,
      `Gerado em: ${new Date().toLocaleString("pt-BR")}`,
      `Status: ${o.status}`,
      `Marcas de corte: ${cropMarks ? "sim" : "não"}`,
      "",
      ...o.results.map((r) => {
        const j = o.jobs[r.index];
        return (
          `Página ${r.index + 1}: ${r.skipped ? "não alterada (sangria existente)" : "modificada"} | corte ${fmt(ptToMm(j.trim.w))}×${fmt(ptToMm(j.trim.h))} mm | sangria S${fmt(j.bleed.top)} D${fmt(j.bleed.right)} I${fmt(j.bleed.bottom)} E${fmt(j.bleed.left)} mm | ` +
          SIDES.map((s) => `${sideLabel(s)}: ${STRAT[r.strategies[s]]}`).join(", ") +
          (r.notes.length ? `\n   Notas: ${r.notes.join(" ")}` : "")
        );
      }),
      "",
      "Verificações geométricas:",
      ...(o.issues.length ? o.issues.map((x) => ` [${x.level}] ${x.msg}`) : [" todas aprovadas"]),
      "",
      "Verificações visuais:",
      ...(o.visual.length
        ? o.visual.map((x) => ` [${x.level}] ${x.msg}`)
        : [" continuidade confirmada em todas as bordas"]),
      "",
      "Avisos de análise:",
      ...item.warnings,
      ...item.analyses.flatMap((a) => a.warnings.map((w) => `Pág. ${a.index + 1}: ${w}`)),
    ];
    download(
      lines.join("\n"),
      item.name.replace(/\.[^.]+$/, "") + "_relatorio.txt",
      "text/plain;charset=utf-8",
    );
  };

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="flex items-center justify-between border-b border-border px-5 py-3">
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-xs tracking-widest text-primary">PRÉ-IMPRESSÃO</span>
          <h1 className="text-lg font-semibold">Gerador Inteligente de Sangria</h1>
        </div>
        <div className="flex items-center gap-3 font-mono text-xs text-muted-foreground">
          {busy && (
            <>
              <span className="animate-pulse text-primary">●</span>
              {busy}
              <button
                className="ml-2 rounded border border-border px-2 py-0.5 hover:bg-accent"
                onClick={() => (cancelRef.current = true)}
              >
                cancelar
              </button>
            </>
          )}
          <ThemeToggle />
        </div>
      </header>

      <div className="grid flex-1 grid-cols-1 lg:grid-cols-[300px_1fr_320px]">
        {/* ---------- arquivos ---------- */}
        <aside className="space-y-4 border-r border-border bg-sidebar p-4">
          <DropZone onFiles={onFiles} />
          <label className="flex items-center justify-between text-xs text-muted-foreground">
            DPI para PNG/JPG
            <input
              type="number"
              min={72}
              max={1200}
              value={dpi}
              onChange={(e) => setDpi(+e.target.value || 300)}
              className="w-20 rounded border border-input bg-background px-2 py-1 font-mono text-foreground"
            />
          </label>
          {errors.map((e, i) => (
            <p
              key={`${i}-${e}`}
              className="rounded border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive"
            >
              {e}
            </p>
          ))}
          <ul className="space-y-1">
            {items.map((it) => (
              <li key={it.id}>
                <button
                  onClick={() => {
                    setActiveId(it.id);
                    setPageIdx(0);
                  }}
                  className={`w-full rounded border p-2 text-left text-xs transition-colors ${it.id === activeId ? "border-primary bg-accent" : "border-border hover:bg-accent/60"}`}
                >
                  <div className="truncate font-medium text-foreground">{it.name}</div>
                  <div className="mt-1 flex justify-between font-mono text-muted-foreground">
                    <span>
                      {it.kind.toUpperCase()} · {(it.size / 1024).toFixed(0)} KB ·{" "}
                      {it.analyses.length} pág.
                    </span>
                    {it.output && (
                      <span className={it.output.stale ? "text-warn" : "text-ok"}>
                        {it.approved
                          ? "aprovado"
                          : it.output.stale
                            ? "desatualizado"
                            : "processado"}
                      </span>
                    )}
                  </div>
                </button>
              </li>
            ))}
          </ul>
          {item && (
            <div className="space-y-1">
              <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                Páginas
              </div>
              <div className="max-h-72 space-y-1 overflow-auto">
                {item.analyses.map((a) => {
                  const c = item.cfg[a.index];
                  return (
                    <button
                      key={a.index}
                      onClick={() => setPageIdx(a.index)}
                      className={`w-full rounded px-2 py-1.5 text-left font-mono text-[11px] ${a.index === pageIdx ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
                    >
                      <div>
                        p{a.index + 1} · {fmt(ptToMm(c.trim.w))}×{fmt(ptToMm(c.trim.h))} mm{" "}
                        {c.trim.w > c.trim.h ? "▭" : "▯"}
                        {a.rotation ? ` ↻${a.rotation}°` : ""}
                      </div>
                      <div className="opacity-75">
                        sangria existente:{" "}
                        {SIDES.some((s) => a.declaredBleed[s] > 0.05)
                          ? SIDES.map((s) => fmt(a.declaredBleed[s])).join("/") + " mm"
                          : "nenhuma"}
                        {c.skip ? " · reaproveitada" : ""}
                        {a.warnings.length ? " · ⚠" : ""}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </aside>

        {/* ---------- pré-visualização ---------- */}
        <main className="min-w-0">
          {item ? (
            <Preview item={item} pageIdx={pageIdx} cropMarks={cropMarks} />
          ) : (
            <div className="checker flex h-full min-h-[60vh] items-center justify-center p-8 text-center text-sm text-muted-foreground">
              Importe um PDF, PNG ou JPG para começar.
              <br />A sangria é gerada no conteúdo da arte e validada no arquivo final.
            </div>
          )}
        </main>

        {/* ---------- configurações ---------- */}
        <aside className="space-y-4 border-l border-border bg-sidebar p-4 text-sm">
          {item && cfg ? (
            <>
              {/* Header card similar to callas pdfToolbox */}
              <div className="rounded border border-border bg-card/60 p-3">
                <div className="text-xs font-semibold text-foreground">
                  Create Bleed by Mirroring / Generative
                </div>
                <div className="mt-1 text-[11px] leading-tight text-muted-foreground">
                  Gera sangria nas bordas selecionadas espelhando ou estirando o conteúdo a partir
                  do ponto de referência configurado.
                </div>
              </div>

              {/* Tabs: Basic Settings / Advanced */}
              <div className="flex border-b border-border text-xs">
                <button
                  onClick={() => setSettingsTab("basic")}
                  className={`flex-1 pb-2 font-medium transition-colors ${
                    settingsTab === "basic"
                      ? "border-b-2 border-primary text-primary"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Configurações Básicas
                </button>
                <button
                  onClick={() => setSettingsTab("advanced")}
                  className={`flex-1 pb-2 font-medium transition-colors ${
                    settingsTab === "advanced"
                      ? "border-b-2 border-primary text-primary"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Avançado
                </button>
              </div>

              <Section title="Aplicar em">
                <div className="grid grid-cols-2 gap-1 rounded border border-border p-1 text-xs">
                  {(["page", "all"] as const).map((v) => (
                    <button
                      key={v}
                      onClick={() => setScope(v)}
                      className={`rounded py-1 ${scope === v ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
                    >
                      {v === "page" ? `Página ${pageIdx + 1}` : "Todas as páginas"}
                    </button>
                  ))}
                </div>
              </Section>

              {settingsTab === "basic" ? (
                <>
                  <Section title="Sangria (mm)">
                    <label className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={link}
                        onChange={(e) => setLink(e.target.checked)}
                        className="accent-primary"
                      />{" "}
                      mesmo valor nos quatro lados
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      {SIDES.map((s) => (
                        <label key={s} className="text-xs text-muted-foreground">
                          {sideLabel(s)}
                          <input
                            type="number"
                            step={0.5}
                            min={0}
                            max={20}
                            value={cfg.bleed[s]}
                            onChange={(e) =>
                              setSide(s, Math.max(0, Math.min(20, +e.target.value || 0)))
                            }
                            className="mt-1 w-full rounded border border-input bg-background px-2 py-1 font-mono text-foreground"
                          />
                        </label>
                      ))}
                    </div>
                  </Section>
                  <Section title="Método de extensão">
                    <select
                      value={cfg.method}
                      onChange={(e) =>
                        setCfg((c) => ({ ...c, method: e.target.value as Method, skip: false }))
                      }
                      className="w-full rounded border border-input bg-background px-2 py-1.5 text-foreground"
                    >
                      {METHODS.map((m) => (
                        <option key={m.v} value={m.v}>
                          {m.l}
                        </option>
                      ))}
                    </select>
                  </Section>
                  <Section title="Linha de corte (mm)">
                    <p className="mb-2 text-[11px] text-muted-foreground">
                      {item.analyses[pageIdx].trim
                        ? "Lida da TrimBox."
                        : "Sem TrimBox — confirme ou corrija."}
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                      {(["x", "y", "w", "h"] as const).map((k) => (
                        <label key={k} className="text-xs text-muted-foreground">
                          {
                            { x: "origem X", y: "origem Y", w: "largura final", h: "altura final" }[
                              k
                            ]
                          }
                          <input
                            type="number"
                            step={0.1}
                            value={+ptToMm(cfg.trim[k]).toFixed(2)}
                            onChange={(e) =>
                              setCfg(
                                (c) => ({
                                  ...c,
                                  skip: false,
                                  trim: { ...c.trim, [k]: mmToPt(+e.target.value || 0) },
                                }),
                                true,
                              )
                            }
                            className="mt-1 w-full rounded border border-input bg-background px-2 py-1 font-mono text-foreground"
                          />
                        </label>
                      ))}
                    </div>
                    {trimProblems.map((m) => (
                      <p key={m} className="mt-2 text-[11px] text-destructive">
                        {m}
                      </p>
                    ))}
                  </Section>
                  <Section title="Opções">
                    <Toggle
                      checked={cropMarks}
                      onChange={(v) => {
                        setCropMarks(v);
                        if (item.output) {
                          update(item.id, (it) => ({
                            ...it,
                            output: it.output && { ...it.output, stale: true },
                          }));
                        }
                      }}
                      label="Marcas de corte"
                    />
                    <Toggle
                      checked={reuseExisting}
                      onChange={setReuseExisting}
                      label="Reaproveitar sangria existente (novas importações)"
                    />
                    <Toggle
                      checked={cfg.skip}
                      onChange={(v) => setCfg((c) => ({ ...c, skip: v }))}
                      label="Manter página como está"
                    />
                  </Section>
                </>
              ) : (
                <>
                  {/* Advanced Tab - Matching user reference image */}
                  <Section title="Auto Bleed Detection and Creation">
                    <Toggle
                      checked={cfg.method === "auto"}
                      onChange={(v) =>
                        setCfg((c) => ({ ...c, method: v ? "auto" : "mirror", skip: false }))
                      }
                      label="Auto Bleed Detection and Creation"
                    />
                  </Section>

                  <Section title="Stretch factor">
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min={1}
                        max={10}
                        step={1}
                        defaultValue={1}
                        className="w-full rounded border border-input bg-background px-2 py-1 font-mono text-foreground"
                      />
                      <span className="font-mono text-xs text-muted-foreground select-none">
                        |||||
                      </span>
                    </div>
                  </Section>

                  <Section title='Start Point for "Stretch border area as Image"'>
                    <p className="mb-2 text-[11px] text-muted-foreground">
                      Início da referência para a sangria (recuo para dentro da TrimBox). Valores
                      positivos (ex: 0.5 mm) evitam bordas com moldura fina, linha branca ou degradê
                      da borda.
                    </p>

                    <div className="relative rounded border border-border/80 bg-card/30 p-3">
                      {/* Central Lock Button */}
                      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-10">
                        <button
                          type="button"
                          onClick={() => setLinkOffset(!linkOffset)}
                          title={
                            linkOffset
                              ? "Lados vinculados (clique para desvincular)"
                              : "Lados independentes (clique para vincular)"
                          }
                          className={`flex h-7 w-7 items-center justify-center rounded-full border shadow-sm transition-colors ${
                            linkOffset
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-border bg-background text-muted-foreground hover:bg-accent"
                          }`}
                        >
                          {linkOffset ? "🔒" : "🔓"}
                        </button>
                      </div>

                      <div className="grid grid-cols-2 gap-x-6 gap-y-3">
                        {/* Top */}
                        <div>
                          <label className="text-[11px] text-muted-foreground">Top</label>
                          <div className="mt-0.5 flex items-center rounded border border-input bg-background px-2 py-1 focus-within:ring-1 focus-within:ring-primary">
                            <input
                              type="number"
                              step={0.1}
                              min={0}
                              max={10}
                              value={+cfg.sampleOffset.top.toFixed(2)}
                              onChange={(e) => {
                                const v = Math.max(0, Math.min(10, +e.target.value || 0));
                                setCfg((c) => ({
                                  ...c,
                                  skip: false,
                                  sampleOffset: linkOffset
                                    ? uniformSampleOffset(v)
                                    : { ...c.sampleOffset, top: v },
                                }));
                              }}
                              className="w-full bg-transparent font-mono text-xs text-foreground outline-none"
                            />
                            <span className="font-mono text-[10px] text-muted-foreground">mm</span>
                          </div>
                        </div>

                        {/* Left */}
                        <div>
                          <label className="text-[11px] text-muted-foreground">Left</label>
                          <div className="mt-0.5 flex items-center rounded border border-input bg-background px-2 py-1 focus-within:ring-1 focus-within:ring-primary">
                            <input
                              type="number"
                              step={0.1}
                              min={0}
                              max={10}
                              value={+cfg.sampleOffset.left.toFixed(2)}
                              onChange={(e) => {
                                const v = Math.max(0, Math.min(10, +e.target.value || 0));
                                setCfg((c) => ({
                                  ...c,
                                  skip: false,
                                  sampleOffset: linkOffset
                                    ? uniformSampleOffset(v)
                                    : { ...c.sampleOffset, left: v },
                                }));
                              }}
                              className="w-full bg-transparent font-mono text-xs text-foreground outline-none"
                            />
                            <span className="font-mono text-[10px] text-muted-foreground">mm</span>
                          </div>
                        </div>

                        {/* Bottom */}
                        <div>
                          <label className="text-[11px] text-muted-foreground">Bottom</label>
                          <div className="mt-0.5 flex items-center rounded border border-input bg-background px-2 py-1 focus-within:ring-1 focus-within:ring-primary">
                            <input
                              type="number"
                              step={0.1}
                              min={0}
                              max={10}
                              value={+cfg.sampleOffset.bottom.toFixed(2)}
                              onChange={(e) => {
                                const v = Math.max(0, Math.min(10, +e.target.value || 0));
                                setCfg((c) => ({
                                  ...c,
                                  skip: false,
                                  sampleOffset: linkOffset
                                    ? uniformSampleOffset(v)
                                    : { ...c.sampleOffset, bottom: v },
                                }));
                              }}
                              className="w-full bg-transparent font-mono text-xs text-foreground outline-none"
                            />
                            <span className="font-mono text-[10px] text-muted-foreground">mm</span>
                          </div>
                        </div>

                        {/* Right */}
                        <div>
                          <label className="text-[11px] text-muted-foreground">Right</label>
                          <div className="mt-0.5 flex items-center rounded border border-input bg-background px-2 py-1 focus-within:ring-1 focus-within:ring-primary">
                            <input
                              type="number"
                              step={0.1}
                              min={0}
                              max={10}
                              value={+cfg.sampleOffset.right.toFixed(2)}
                              onChange={(e) => {
                                const v = Math.max(0, Math.min(10, +e.target.value || 0));
                                setCfg((c) => ({
                                  ...c,
                                  skip: false,
                                  sampleOffset: linkOffset
                                    ? uniformSampleOffset(v)
                                    : { ...c.sampleOffset, right: v },
                                }));
                              }}
                              className="w-full bg-transparent font-mono text-xs text-foreground outline-none"
                            />
                            <span className="font-mono text-[10px] text-muted-foreground">mm</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </Section>

                  <Section title="Método ativo">
                    <select
                      value={cfg.method}
                      onChange={(e) =>
                        setCfg((c) => ({ ...c, method: e.target.value as Method, skip: false }))
                      }
                      className="w-full rounded border border-input bg-background px-2 py-1.5 text-foreground"
                    >
                      {METHODS.map((m) => (
                        <option key={m.v} value={m.v}>
                          {m.l}
                        </option>
                      ))}
                    </select>
                  </Section>
                </>
              )}

              <div className="flex gap-1 text-xs">
                <button
                  onClick={undo}
                  disabled={!item.past.length}
                  className="flex-1 rounded border border-border py-1.5 hover:bg-accent disabled:opacity-40"
                >
                  ↶ Desfazer
                </button>
                <button
                  onClick={redo}
                  disabled={!item.future.length}
                  className="flex-1 rounded border border-border py-1.5 hover:bg-accent disabled:opacity-40"
                >
                  ↷ Refazer
                </button>
                <button
                  onClick={restore}
                  className="flex-1 rounded border border-border py-1.5 hover:bg-accent"
                >
                  Restaurar
                </button>
              </div>
              <button
                onClick={process}
                disabled={!!busy || trimProblems.length > 0}
                className="w-full rounded bg-primary py-2.5 font-semibold text-primary-foreground transition hover:brightness-110 disabled:opacity-50"
              >
                {item.output ? "Reprocessar sangria" : "Gerar sangria"}
              </button>

              {item.output && (
                <Results
                  item={item}
                  onApprove={() => update(item.id, (it) => ({ ...it, approved: true }))}
                  onPage={exportPage}
                  onReport={report}
                />
              )}
            </>
          ) : (
            <p className="text-xs text-muted-foreground">Nenhum arquivo selecionado.</p>
          )}
        </aside>
      </div>
    </div>
  );
}

function Results({
  item,
  onApprove,
  onPage,
  onReport,
}: {
  item: Item;
  onApprove: () => void;
  onPage: (i: number) => void;
  onReport: () => void;
}) {
  const o = item.output!;
  const all = [
    ...o.issues.map((x) => ({ level: x.level, msg: x.msg })),
    ...o.visual,
    ...o.results.flatMap((r) =>
      r.notes.map((n) => ({ level: "warn", msg: `Pág. ${r.index + 1}: ${n}` })),
    ),
  ];
  return (
    <div className="space-y-3 border-t border-border pt-4">
      {o.stale ? (
        <p className="rounded border border-warn/50 bg-warn/10 p-2 text-xs text-warn">
          Configurações alteradas — reprocesse para atualizar o arquivo final.
        </p>
      ) : (
        <div
          className={`rounded px-3 py-2 text-center text-sm font-semibold ${STATUS_STYLE[o.status]}`}
        >
          {o.status}
        </div>
      )}
      {all.length > 0 && (
        <ul className="max-h-48 space-y-1 overflow-auto text-[11px]">
          {all.map((x, i) => (
            <li
              key={i}
              className={
                x.level === "error"
                  ? "text-destructive"
                  : x.level === "review"
                    ? "text-review"
                    : "text-warn"
              }
            >
              • {x.msg}
            </li>
          ))}
        </ul>
      )}
      {!o.stale && (
        <div className="grid grid-cols-2 gap-1 text-xs">
          <button
            disabled={o.status === "Falha" || item.approved}
            onClick={onApprove}
            className="col-span-2 rounded border border-ok py-1.5 text-ok hover:bg-ok/10 disabled:opacity-40"
          >
            {item.approved ? "✓ Sangria aprovada" : "Aprovar sangria"}
          </button>
          <button
            onClick={() => download(o.bytes, item.name.replace(/\.[^.]+$/, "") + "_sangria.pdf")}
            className="rounded bg-secondary py-1.5 hover:bg-accent"
          >
            Baixar documento
          </button>
          <button onClick={onReport} className="rounded bg-secondary py-1.5 hover:bg-accent">
            Relatório
          </button>
          {o.results.length > 1 &&
            o.results.map((r) => (
              <button
                key={r.index}
                onClick={() => onPage(r.index)}
                className="rounded border border-border py-1 font-mono hover:bg-accent"
              >
                PDF p{r.index + 1}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

function Preview({
  item,
  pageIdx,
  cropMarks,
}: {
  item: Item;
  pageIdx: number;
  cropMarks: boolean;
}) {
  const [view, setView] = useState<"after" | "before">("after");
  const [zoom, setZoom] = useState(1);
  const [img, setImg] = useState<{
    url: string;
    w: number;
    h: number;
    scale: number;
    toPx: (x: number, y: number) => [number, number];
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; l: number; t: number } | null>(null);
  const out = item.output && !item.output.stale ? item.output : null;
  const showAfter = view === "after" && !!out;
  const bytes = showAfter ? out!.bytes : item.src;

  useEffect(() => {
    let alive = true;
    let doc: PdfDoc | null = null;
    setErr(null);
    (async () => {
      const d = await openPdf(bytes);
      if (!alive) {
        void d.destroy();
        return;
      } // o efeito já foi desmontado: não vazar o documento
      doc = d;
      const r = await renderPage(d, pageIdx, 2);
      if (!alive) return;
      setImg({
        url: r.canvas.toDataURL(),
        w: r.canvas.width,
        h: r.canvas.height,
        scale: r.scale,
        toPx: r.toPx,
      });
    })().catch((e) => {
      if (alive) setErr(`Não foi possível renderizar a página: ${(e as Error).message}`);
    });
    return () => {
      alive = false;
      void doc?.destroy();
    };
  }, [bytes, pageIdx]);

  const fit = () => {
    const el = scrollRef.current;
    if (!el || !img) return;
    const pw = img.w / img.scale,
      ph = img.h / img.scale;
    setZoom(
      Math.min(
        8,
        Math.max(0.25, Math.min((el.clientWidth - 80) / pw, (el.clientHeight - 80) / ph)),
      ),
    );
  };

  const res = out?.results[pageIdx];
  const cfg = item.cfg[pageIdx];
  const rect = useCallback(
    (b: Box) => {
      if (!img) return { x: 0, y: 0, width: 0, height: 0 };
      const [x1, y1] = img.toPx(b.x, b.y + b.h);
      const [x2, y2] = img.toPx(b.x + b.w, b.y);
      return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
    },
    [img],
  );
  const trim = showAfter && res ? res.trim : cfg.trim;
  const safe = useMemo(
    () => ({
      x: trim.x + mmToPt(3),
      y: trim.y + mmToPt(3),
      w: trim.w - mmToPt(6),
      h: trim.h - mmToPt(6),
    }),
    [trim],
  );
  const hasOffset = SIDES.some((s) => (cfg.sampleOffset?.[s] ?? 0) > 0.05);
  const startPointBox = useMemo(() => {
    const off = cfg.sampleOffset ?? uniformSampleOffset(0);
    return {
      x: trim.x + mmToPt(off.left),
      y: trim.y + mmToPt(off.bottom),
      w: Math.max(1, trim.w - mmToPt(off.left + off.right)),
      h: Math.max(1, trim.h - mmToPt(off.top + off.bottom)),
    };
  }, [trim, cfg.sampleOffset]);
  const job = out?.jobs[pageIdx];

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2 text-xs">
        <div className="grid grid-cols-2 gap-1 rounded border border-border p-0.5">
          <button
            onClick={() => setView("before")}
            className={`rounded px-3 py-1 ${!showAfter ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
          >
            Original
          </button>
          <button
            disabled={!out}
            onClick={() => setView("after")}
            className={`rounded px-3 py-1 disabled:opacity-40 ${showAfter ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
          >
            Resultado final
          </button>
        </div>
        <div className="flex items-center gap-1 font-mono">
          <button
            onClick={() => setZoom((z) => Math.max(0.25, z / 1.25))}
            className="rounded border border-border px-2 hover:bg-accent"
          >
            −
          </button>
          <span className="w-12 text-center">{Math.round(zoom * 100)}%</span>
          <button
            onClick={() => setZoom((z) => Math.min(8, z * 1.25))}
            className="rounded border border-border px-2 hover:bg-accent"
          >
            +
          </button>
          <button
            onClick={() => setZoom(1)}
            className="rounded border border-border px-2 hover:bg-accent"
          >
            100%
          </button>
          <button
            onClick={fit}
            disabled={!img}
            className="rounded border border-border px-2 hover:bg-accent disabled:opacity-40"
          >
            ajustar
          </button>
        </div>
        <div className="ml-auto flex flex-wrap gap-3 text-muted-foreground">
          <Legend c="bg-trim" l="Linha de corte" />
          <Legend c="bg-bleed" l="Área de sangria" />
          <Legend c="bg-safe" l="Segurança 3 mm" />
          {hasOffset && (
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm border border-purple-400 bg-purple-500/30" />
              Início ref. (Start Point)
            </span>
          )}
          {cropMarks && <Legend c="bg-marks" l="Marcas de corte" />}
        </div>
      </div>
      <div
        ref={scrollRef}
        className="checker relative flex-1 cursor-grab overflow-auto active:cursor-grabbing"
        style={{ minHeight: "60vh" }}
        onMouseDown={(e) => {
          const el = scrollRef.current!;
          drag.current = { x: e.clientX, y: e.clientY, l: el.scrollLeft, t: el.scrollTop };
        }}
        onMouseMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const el = scrollRef.current!;
          el.scrollLeft = d.l - (e.clientX - d.x);
          el.scrollTop = d.t - (e.clientY - d.y);
        }}
        onMouseUp={() => (drag.current = null)}
        onMouseLeave={() => (drag.current = null)}
      >
        {err && (
          <p className="m-4 rounded border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
            {err}
          </p>
        )}
        {img && (
          <div className="p-10" style={{ width: "max-content" }}>
            <div
              className="relative shadow-2xl"
              style={{ width: (img.w / img.scale) * zoom, height: (img.h / img.scale) * zoom }}
            >
              <img
                src={img.url}
                alt={`Página ${pageIdx + 1}`}
                className="absolute inset-0 h-full w-full select-none"
                draggable={false}
              />
              <svg
                viewBox={`0 0 ${img.w} ${img.h}`}
                className="pointer-events-none absolute inset-0 h-full w-full"
              >
                {showAfter && res && !res.skipped && (
                  <path
                    fillRule="evenodd"
                    className="fill-bleed"
                    fillOpacity={0.18}
                    d={(() => {
                      const a = rect(res.bleedBox),
                        b = rect(res.trim);
                      return `M${a.x} ${a.y}h${a.width}v${a.height}h${-a.width}Z M${b.x} ${b.y}h${b.width}v${b.height}h${-b.width}Z`;
                    })()}
                  />
                )}
                {showAfter && res && (
                  <rect
                    {...rect(res.bleedBox)}
                    fill="none"
                    className="stroke-bleed"
                    strokeWidth={2}
                    strokeDasharray="8 5"
                  />
                )}
                <rect
                  {...rect(safe)}
                  fill="none"
                  className="stroke-safe"
                  strokeWidth={1.5}
                  strokeDasharray="3 4"
                />
                <rect {...rect(trim)} fill="none" className="stroke-trim" strokeWidth={2} />
                {hasOffset && (
                  <rect
                    {...rect(startPointBox)}
                    fill="none"
                    stroke="#a855f7"
                    strokeWidth={1.5}
                    strokeDasharray="5 3"
                  />
                )}
                {showAfter &&
                  res &&
                  cropMarks &&
                  job &&
                  !res.skipped &&
                  cropMarkLines(res.trim, job.bleed, { cropMarks }).map(([x1, y1, x2, y2], i) => {
                    const [a, b] = img.toPx(x1, y1),
                      [c, d] = img.toPx(x2, y2);
                    return (
                      <line
                        key={i}
                        x1={a}
                        y1={b}
                        x2={c}
                        y2={d}
                        className="stroke-marks"
                        strokeWidth={4}
                        strokeOpacity={0.35}
                      />
                    );
                  })}
              </svg>
            </div>
          </div>
        )}
      </div>
      <div className="grid grid-cols-2 gap-4 border-t border-border px-4 py-2 font-mono text-[11px] text-muted-foreground md:grid-cols-4">
        <span>
          Corte:{" "}
          <b className="text-foreground">
            {fmt(ptToMm(cfg.trim.w))} × {fmt(ptToMm(cfg.trim.h))} mm
          </b>
        </span>
        <span>
          Documento final:{" "}
          <b className="text-foreground">
            {res ? `${fmt(ptToMm(res.media.w))} × ${fmt(ptToMm(res.media.h))} mm` : "—"}
          </b>
        </span>
        <span>
          Sangria S/D/I/E:{" "}
          <b className="text-foreground">{SIDES.map((s) => fmt(cfg.bleed[s])).join(" / ")} mm</b>
        </span>
        <span>
          Estratégia:{" "}
          <b className="text-foreground">
            {res
              ? res.skipped
                ? "página mantida"
                : SIDES.map((s) => STRAT[res.strategies[s]]).join(" · ")
              : "não processado"}
          </b>
        </span>
      </div>
    </div>
  );
}

function DropZone({ onFiles }: { onFiles: (f: FileList | File[]) => void }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onFiles(e.dataTransfer.files);
      }}
      onClick={() => input.current?.click()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          input.current?.click();
        }
      }}
      role="button"
      tabIndex={0}
      aria-label="Selecionar arquivos PDF, PNG ou JPG"
      className={`cursor-pointer rounded border-2 border-dashed p-5 text-center text-xs transition-colors ${over ? "border-primary bg-primary/10" : "border-border hover:border-primary/60"}`}
    >
      <div className="font-medium text-foreground">Arraste arquivos aqui</div>
      <div className="mt-1 text-muted-foreground">ou clique para selecionar · PDF, PNG, JPG</div>
      <input
        ref={input}
        type="file"
        multiple
        accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
        className="hidden"
        onChange={(e) => {
          if (e.target.files) onFiles(Array.from(e.target.files));
          e.target.value = "";
        }}
      />
    </div>
  );
}

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div>
    <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
      {title}
    </div>
    {children}
  </div>
);
const Toggle = ({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) => (
  <label className="mb-1.5 flex items-center gap-2 text-xs">
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      className="accent-primary"
    />
    {label}
  </label>
);
const Legend = ({ c, l }: { c: string; l: string }) => (
  <span className="flex items-center gap-1.5">
    <span className={`h-2.5 w-2.5 rounded-sm ${c}`} />
    {l}
  </span>
);
