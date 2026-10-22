<!-- LOVABLE:BEGIN -->

> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.

<!-- LOVABLE:END -->

## Architecture

- Bleed engine lives in `src/lib/bleed/`: `engine.ts` (pdf-lib, pure, unit-tested) composes PDFs and boxes; `render.ts` (pdf.js, browser-only) samples edges and validates rendered output. Why: geometry stays testable in Node, rendering needs a canvas.
- Processing runs in the browser, not server functions. Why: the Worker runtime cannot run PyMuPDF/OpenCV and has tight CPU limits.
- Pin pdfjs-dist to v4. Why: v5+ uses JS APIs missing in many current browsers.
