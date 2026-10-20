import { CaldavActionClient } from "./caldav-actions.js";
import { calendarAutomationConfig } from "../security/runtime-config.js";

export function createAutomationClient(config = calendarAutomationConfig) {
  if (!config.available) return null;
  if (config.provider === "caldav") return new CaldavActionClient(config.caldav);
  return null;
}
