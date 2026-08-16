import {nodeCli} from "tsdown-config-silverwind";
import {defineConfig} from "tsdown";

export default defineConfig(nodeCli({
  url: import.meta.url,
  dts: false, // nothing imports this package, the emitted `export {}` is dead weight
}));
