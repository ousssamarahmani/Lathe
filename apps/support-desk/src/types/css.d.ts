// CSS Modules, for `tsc` runs before `next build` has generated next-env.d.ts.
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}
