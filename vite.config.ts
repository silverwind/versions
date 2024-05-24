import {defineConfig} from "vite";
import {nodeCli} from "vite-config-silverwind";

export default defineConfig(nodeCli({
  url: import.meta.url,
  noDts: true,
  build: {
    target: "node18",
  },
}));
