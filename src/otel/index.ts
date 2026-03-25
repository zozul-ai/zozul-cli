export {
  generateOtelEnvVars,
  generateOtelShellExports,
  installOtelToSettings,
  uninstallOtelFromSettings,
} from "./config.js";
export type { OtelConfig } from "./config.js";
export { handleOtlpMetrics, handleOtlpLogs } from "./receiver.js";
