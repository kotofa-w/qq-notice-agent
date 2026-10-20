import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function resolveCalendarAutomationConfig(env = process.env) {
  const provider = String(env.CODEX_REMOTE_CONTACT_CALENDAR_PROVIDER || "").trim().toLowerCase()
    || "none";
  if (!["caldav", "none"].includes(provider)) {
    throw new Error("CODEX_REMOTE_CONTACT_CALENDAR_PROVIDER must be caldav or none");
  }
  if (provider !== "caldav") {
    return { provider, providerLabel: "未启用", available: false };
  }
  const calendarUrl = String(env.CODEX_REMOTE_CONTACT_CALDAV_URL || "").trim();
  const username = String(env.CODEX_REMOTE_CONTACT_CALDAV_USERNAME || "").trim();
  const password = String(env.CODEX_REMOTE_CONTACT_CALDAV_PASSWORD || "");
  if (!calendarUrl || !username || !password.trim()) {
    throw new Error("CalDAV requires CODEX_REMOTE_CONTACT_CALDAV_URL, CODEX_REMOTE_CONTACT_CALDAV_USERNAME and CODEX_REMOTE_CONTACT_CALDAV_PASSWORD");
  }
  let url;
  try { url = new URL(calendarUrl); } catch {
    throw new Error("CODEX_REMOTE_CONTACT_CALDAV_URL must be a valid HTTPS calendar URL");
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error("CODEX_REMOTE_CONTACT_CALDAV_URL must use HTTPS without embedded credentials, query or fragment");
  }
  if (/[:\r\n]/.test(username) || /[\r\n]/.test(password)) {
    throw new Error("CODEX_REMOTE_CONTACT_CALDAV_USERNAME or CODEX_REMOTE_CONTACT_CALDAV_PASSWORD has invalid characters");
  }
  const reminderValue = String(env.CODEX_REMOTE_CONTACT_CALDAV_REMINDER_MINUTES ?? "").trim();
  const reminderMinutes = reminderValue ? Number(reminderValue) : 30;
  if (!Number.isSafeInteger(reminderMinutes) || reminderMinutes < 0) {
    throw new Error("CODEX_REMOTE_CONTACT_CALDAV_REMINDER_MINUTES must be a non-negative integer");
  }
  const calendarDisplayName = String(env.CODEX_REMOTE_CONTACT_CALDAV_CALENDAR_NAME || "").trim() || "fruux";
  return { provider, providerLabel: `${calendarDisplayName}（CalDAV）`, available: true,
    caldav: { calendarUrl: url.href, username, password, calendarDisplayName, reminderMinutes } };
}

export function publicCalendarAutomationConfig(config = calendarAutomationConfig) {
  return {
    calendarRemindersAvailable: config.available,
    calendarRemindersProvider: config.provider,
    calendarRemindersProviderLabel: config.providerLabel,
    calendarRemindersMinutes: config.provider === "caldav" ? config.caldav.reminderMinutes : null
  };
}

export const calendarAutomationConfig = resolveCalendarAutomationConfig();
export const calendarRemindersAvailable = calendarAutomationConfig.available;

export function normalizeCalendarRemindersEnabled(value, available = calendarRemindersAvailable) {
  return available && value !== false;
}

// Templates are public; deployments may keep their private personality elsewhere.
// An explicit override must never silently fall back to a generic personality.
export function resolvePersonaFiles(projectDir, configuredDir = "") {
  const directory = resolve(projectDir, String(configuredDir || "").trim() || "persona");
  const corePath = join(directory, "core.json");
  const examplesPath = join(directory, "examples.json");
  try {
    const core = JSON.parse(readFileSync(corePath, "utf8"));
    const examples = JSON.parse(readFileSync(examplesPath, "utf8"));
    if (!core || Array.isArray(core) || typeof core.name !== "string" || !core.name.trim()) {
      throw new Error("core.json requires a named personality object");
    }
    if (!examples || !Array.isArray(examples.examples)) {
      throw new Error("examples.json requires an examples array");
    }
  } catch {
    throw new Error("Personality configuration is missing or invalid; check CODEX_REMOTE_CONTACT_PERSONA_DIR/core.json and examples.json");
  }
  return { corePath, examplesPath };
}

export function validateRuntimeConfig({ ownerId, botId, host, authDisabled, apiToken, oneBotToken }) {
  for (const [label, value] of [["OWNER QQ", ownerId], ["bot QQ", botId]]) {
    if (!/^[1-9][0-9]{4,11}$/.test(String(value || ""))) throw new Error("Configure a valid " + label + " ID in config/qq-only.env");
  }
  if (ownerId === botId) throw new Error("OWNER and bot must be different QQ accounts");
  if (authDisabled && !["127.0.0.1", "::1", "localhost"].includes(host)) throw new Error("Unauthenticated Hub access is only allowed on loopback");
  if (!authDisabled && !apiToken) throw new Error("Hub authentication token is missing");
  if (!oneBotToken) throw new Error("OneBot authentication token is missing");
}
