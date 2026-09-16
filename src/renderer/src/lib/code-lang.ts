/**
 * 文件预览的「按格式渲染」判据：由路径推出 highlight.js 的语言名。
 *
 * 两条纪律：
 * 1. **只给 `highlight.js/lib/common` 里确实注册过的名字**。common 包只带 38 门语言
 *    （见该文件的 `registerLanguage` 调用），给出包内没有的名字，调用方只能回落成纯文本，
 *    等于白识别一场。所以这里不列 scala / groovy / dockerfile 这些「应该有」的语言。
 * 2. **认不出就返回 `null`，不猜**。猜错（比如把 `.log` 当某种语言）会把阅读者的注意力
 *    引到错误的着色上，与内容层「不做半截渲染」是同一条理由。
 *
 * Markdown 不在表里：`.md / .mdx` 由上游（`FilePreview`）直接交给 Markdown 渲染器，
 * 不会走到代码着色这一支。
 */

/** 扩展名 → 语言名（全部是 common 包里有的）。导出是为了让单测能逐条核对这一点 */
export const LANG_BY_EXT: Record<string, string> = {
  // web / 前端
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  json5: "json",
  css: "css",
  scss: "scss",
  sass: "scss",
  less: "less",
  html: "xml",
  htm: "xml",
  xml: "xml",
  xsl: "xml",
  svg: "xml",
  vue: "xml",
  yml: "yaml",
  yaml: "yaml",
  graphql: "graphql",
  gql: "graphql",
  // 后端 / 系统
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  py: "python",
  pyw: "python",
  rb: "ruby",
  rake: "ruby",
  go: "go",
  rs: "rust",
  php: "php",
  c: "c",
  h: "c",
  cpp: "cpp",
  cxx: "cpp",
  cc: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  ino: "cpp",
  cs: "csharp",
  vb: "vbnet",
  swift: "swift",
  m: "objectivec",
  mm: "objectivec",
  lua: "lua",
  pl: "perl",
  pm: "perl",
  r: "r",
  sql: "sql",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  ksh: "bash",
  // 配置 / 数据 / 补丁
  ini: "ini",
  toml: "ini",
  cfg: "ini",
  conf: "ini",
  diff: "diff",
  patch: "diff",
  wasm: "wasm",
  wat: "wasm",
};

/** 无扩展名的文件按**整个文件名**认（小写后比对） */
export const LANG_BY_NAME: Record<string, string> = {
  makefile: "makefile",
  gnumakefile: "makefile",
};

/**
 * 路径 → highlight.js 语言名；认不出返回 `null`。
 *
 * 只看最后一段路径，故 `docs/a/b/x.TS` 与 `x.ts` 同解；盘符与反斜杠不影响判定
 * （入参可能是绝对路径，见 `file-read.ts` 的说明）。
 */
export function detectLanguage(path: string): string | null {
  const normalized = path.replaceAll("\\", "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();

  const byName = LANG_BY_NAME[base];
  if (byName !== undefined) return byName;

  const dot = base.lastIndexOf(".");
  // `dot <= 0` 一并挡掉「整名就是 .xxx」的隐藏文件（`.gitignore` 的扩展名是空串，不是 `gitignore`）
  if (dot <= 0) return null;
  return LANG_BY_EXT[base.slice(dot + 1)] ?? null;
}
