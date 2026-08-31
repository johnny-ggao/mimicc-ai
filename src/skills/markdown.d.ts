/**
 * Bun's `import ... with { type: "text" }` hands back the file as a string, at
 * runtime and through `bun build`. The compiler does not know that on its own —
 * this declaration is the one line that tells it.
 */
declare module "*.md" {
  const text: string;
  export default text;
}
