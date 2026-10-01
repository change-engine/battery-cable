import { defineConfig } from "oxlint";
import config from "two-stroke/oxlint.config.mjs";

export default defineConfig({
  ...config,
  ignorePatterns: [...(config.ignorePatterns ?? []), "**/__definitions__/**"],
});
