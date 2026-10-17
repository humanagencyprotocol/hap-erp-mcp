/**
 * pdfmake 0.3.x ships no type declarations for its new (rewritten) API, and
 * @types/pdfmake only covers the old pre-0.3 API — so this connector treats
 * the module as untyped and narrows what it needs itself in pdf-render.ts.
 */
declare module "pdfmake";
