// `*.sh` files are imported as their raw text (wrangler `Text` module rule).
declare module '*.sh' {
  const content: string
  export default content
}
