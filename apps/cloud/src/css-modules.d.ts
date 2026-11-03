// CSS modules' class maps, for tsc runs that happen before Next generates next-env.d.ts (CI).
declare module "*.module.css" {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}
