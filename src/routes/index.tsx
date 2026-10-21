import { createFileRoute, ClientOnly } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const BleedStudio = lazy(() => import("@/components/bleed/BleedStudio"));

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Gerador Inteligente de Sangria — Pré-impressão" },
      { name: "description", content: "Gere sangria real em PDFs, PNG e JPG, confira na pré-visualização e exporte com TrimBox, BleedBox e marcas de corte validadas." },
      { property: "og:title", content: "Gerador Inteligente de Sangria" },
      { property: "og:description", content: "Sangria automática e validada para arquivos de pré-impressão." },
    ],
  }),
  component: Index,
});

function Loading() {
  return <div className="flex min-h-screen items-center justify-center font-mono text-sm text-muted-foreground">Carregando motor de sangria…</div>;
}

function Index() {
  return (
    <ClientOnly fallback={<Loading />}>
      <Suspense fallback={<Loading />}>
        <BleedStudio />
      </Suspense>
    </ClientOnly>
  );
}
