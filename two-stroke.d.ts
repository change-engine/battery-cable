// The two-stroke package ships these configs without declarations.
declare module "two-stroke/oxfmt.config.mjs" {
  import type { OxfmtConfig } from "oxfmt";

  const config: OxfmtConfig;
  export default config;
}

declare module "two-stroke/oxlint.config.mjs" {
  import type { OxlintConfig } from "oxlint";

  const config: OxlintConfig;
  export default config;
}
