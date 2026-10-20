import { createHash } from 'node:crypto';

export class CaldavActionClient {
  #calendarUrl;
  #authorization;
  #fetch;

  constructor({ calendarUrl, username, password, calendarDisplayName = "fruux", reminderMinutes = 30, fetchImpl = globalThis.fetch, timeoutMs = 20_000 } = {}) {
    let url;
    try { url = new URL(calendarUrl); } catch { throw new Error("CalDAV calendar URL is invalid"); }
    if (url.protocol !== "https:" || url.port || url.username || url.password || url.search || url.hash) {
      throw new Error("CalDAV requires an HTTPS calendar URL on port 443 without credentials, query or fragment");
    }
    if (typeof username !== "string" || !username || username.includes(":") || typeof password !== "string" || !password) {
      throw new Error("CalDAV username and password are required");
    }
    if (!Number.isInteger(reminderMinutes) || reminderMinutes < 0 || !Number.isInteger(timeoutMs) || timeoutMs <= 0 || typeof fetchImpl !== "function") {
      throw new Error("CalDAV reminder minutes, timeout or fetch implementation is invalid");
    }
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
    this.#calendarUrl = url.href;
    this.#authorization = `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
    this.#fetch = fetchImpl;
    this.calendarDisplayName = String(calendarDisplayName || "fruux");
    this.reminderMinutes = reminderMinutes;
    this.timeoutMs = timeoutMs;
  }

  #resource(actionId) {
    if (!/^[a-f0-9]{24}$/.test(actionId || '')) throw new Error('CalDAV actionId is invalid');
    return { uid: `codex-remote-contact-${actionId}@qq-agent-gateway`, url: `${this.#calendarUrl}codex-remote-contact-${actionId}.ics` };
  }

  async #readState(actionId) {
    const { uid, url } = this.#resource(actionId);
    const response = await this.#request(url, { method: 'GET' });
    if (response.status === 404) return { exists: false, owned: false, externalItemId: url, etag: null, contentHash: null, body: '' };
    if (response.status !== 200) throw httpError('read', response.status);
    return { exists: true, owned: ownsEvent(response.body, uid, actionId), externalItemId: url,
      etag: response.etag, contentHash: calendarHash(response.body), body: response.body };
  }

  async read(actionId) {
    const { body, ...version } = await this.#readState(actionId);
    return version;
  }

  async #writtenVersion(actionId, body, response) {
    if (strongEtag(response.etag)) return { etag: response.etag, contentHash: calendarHash(body) };
    const current = await this.#readState(actionId);
    if (!current.exists || !current.owned || current.contentHash !== calendarHash(body)) throw conflictError('CalDAV written version could not be verified');
    if (!strongEtag(current.etag)) throw new Error('CalDAV requires a strong ETag; written version is unavailable');
    return { etag: current.etag, contentHash: current.contentHash };
  }

  async execute(action, { sourceGroupId, sourceGroupName, expectedEtag, expectedContentHash, protectExisting = false, existingOnly = false } = {}) {
    if (!/^[a-f0-9]{24}$/.test(action?.actionId || "") || !["calendar", "reminder"].includes(action?.type)) {
      throw new Error("CalDAV action type or actionId is invalid");
    }
    validateBaseline(expectedEtag, expectedContentHash);
    const result = (message, externalItemId = null, version = {}) => ({ externalItemId, result: message, targetList: this.calendarDisplayName, itemType: "calendar", etag: null, contentHash: null, ...version });
    if (action.type === "reminder" && !action.due) {
      return { ...result("未写入日历：待办缺少明确截止时间，请查看来源群原消息"), skipped: true };
    }
    const { uid, url } = this.#resource(action.actionId);
    const body = buildCalendar(action, {
      uid, sourceGroupId, sourceGroupName, reminderMinutes: this.reminderMinutes
    });
    const hasBaseline = expectedEtag != null || expectedContentHash != null;
    if (!hasBaseline && !existingOnly) {
      const created = await this.#request(url, { method: "PUT", body, headers: { "If-None-Match": "*" } });
      if ([201, 204].includes(created.status)) return result("日历已写入", url, await this.#writtenVersion(action.actionId, body, created));
      if (created.status !== 412) throw httpError("create", created.status);
    }
    const existing = await this.#readState(action.actionId);
    if (!existing.exists) throw conflictError('CalDAV version conflict; existing event was removed');
    if (!existing.owned) throw conflictError("CalDAV ownership check failed; existing event was not modified");
    if (!strongEtag(existing.etag)) throw new Error("CalDAV requires a strong ETag; existing event was not modified");
    if (existing.contentHash === calendarHash(body)) return result("日历已存在", url, { etag: existing.etag, contentHash: existing.contentHash });
    if (protectExisting && !hasBaseline) throw conflictError('CalDAV trusted baseline is required; existing event was not modified');
    if (hasBaseline) assertBaseline(existing, expectedEtag, expectedContentHash);
    const updated = await this.#request(url, { method: "PUT", body, headers: { "If-Match": existing.etag } });
    if (updated.status !== 204) throw httpError("update", updated.status);
    return result("日历已更新", url, await this.#writtenVersion(action.actionId, body, updated));
  }

  async delete(actionId, { expectedEtag, expectedContentHash } = {}) {
    validateBaseline(expectedEtag, expectedContentHash);
    const existing = await this.#readState(actionId);
    if (!existing.exists) return { deleted: true, externalItemId: existing.externalItemId };
    if (!existing.owned) throw conflictError('CalDAV ownership check failed; existing event was not deleted');
    if (expectedEtag == null && expectedContentHash == null) throw conflictError('CalDAV trusted baseline is required; existing event was not deleted');
    if (!strongEtag(existing.etag)) throw new Error('CalDAV requires a strong ETag; existing event was not deleted');
    assertBaseline(existing, expectedEtag, expectedContentHash);
    const removed = await this.#request(existing.externalItemId, { method: 'DELETE', headers: { 'If-Match': existing.etag } });
    if (![200, 204, 404].includes(removed.status)) throw httpError('delete', removed.status);
    return { deleted: true, externalItemId: existing.externalItemId };
  }

  async #request(url, { method, body, headers = {} }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.#fetch(url, {
        method, body, redirect: "error", signal: controller.signal,
        headers: {
          Authorization: this.#authorization,
          Accept: "text/calendar",
          ...(body ? { "Content-Type": "text/calendar; charset=utf-8" } : {}),
          ...headers
        }
      });
      return {
        status: response.status,
        etag: response.headers.get("etag"),
        body: method === "GET" && response.status === 200 ? await response.text() : ""
      };
    } catch {
      // Remote bodies and fetch errors may contain credentials; keep them out of queue logs.
      throw new Error(controller.signal.aborted ? "CalDAV request timed out" : "CalDAV network request failed");
    } finally {
      clearTimeout(timer);
    }
  }
}

function buildCalendar(action, { uid, sourceGroupId, sourceGroupName, reminderMinutes }) {
  const start = parseDate(action.type === "reminder" ? action.due : action.start, "start/due");
  const end = action.type === "calendar" && action.end != null ? parseDate(action.end, "end") : null;
  const allDay = action.type === "calendar" && action.allDay;
  if (end && (end <= start || (allDay && calendarDate(end) <= calendarDate(start)))) {
    throw new Error("CalDAV action end date must be after start");
  }
  const title = `${action.type === "reminder" ? "【待办】" : ""}${String(action.title || "").trim()}`;
  if (!String(action.title || "").trim()) throw new Error("CalDAV action title is required");
  const category = action.type === "reminder" ? "待办" : String(action.calendarName || "活动");
  const source = `${String(sourceGroupName || "通知群")} (${String(sourceGroupId || action.sourceGroupId || "未知")})`;
  const notes = [String(action.notes || ""), `来源：${source}`, `类别：${category}`, `[CodexRemoteContact:${action.actionId}]`].filter(Boolean).join("\n");
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//CodexRemoteContact//QQ Agent Gateway//ZH", "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT", `UID:${uid}`, `DTSTAMP:${utcDate(new Date())}`,
    allDay ? `DTSTART;VALUE=DATE:${calendarDate(start)}` : `DTSTART:${utcDate(start)}`,
    ...(end ? [allDay ? `DTEND;VALUE=DATE:${calendarDate(end)}` : `DTEND:${utcDate(end)}`] : []),
    `SUMMARY:${escapeText(title)}`, `DESCRIPTION:${escapeText(notes)}`, `CATEGORIES:${escapeText(category)}`,
    ...(action.location ? [`LOCATION:${escapeText(action.location)}`] : []),
    `X-CODEX-REMOTE-CONTACT-ACTION-ID:${action.actionId}`,
    "BEGIN:VALARM", "ACTION:DISPLAY", `TRIGGER:-PT${reminderMinutes}M`, `DESCRIPTION:${escapeText(title)}`,
    "END:VALARM", "END:VEVENT", "END:VCALENDAR"
  ];
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}

function parseDate(value, field) {
  // The upstream action normalizer supplies ISO instants; reject ambiguous local dates here.
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw new Error(`CalDAV action ${field} date is invalid`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) throw new Error(`CalDAV action ${field} date is invalid`);
  return date;
}

function utcDate(date) {
  return date.toISOString().slice(0, 19).replace(/[-:]/g, "") + "Z";
}

function calendarDate(date) {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
}

function escapeText(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/\r\n|\r|\n/g, "\\n").replace(/;/g, "\\;").replace(/,/g, "\\,");
}

function foldLine(line) {
  let output = "";
  let bytes = 0;
  for (const character of line) {
    const length = Buffer.byteLength(character, "utf8");
    if (bytes + length > 75) { output += "\r\n "; bytes = 1; }
    output += character;
    bytes += length;
  }
  return output;
}

function calendarLines(body) {
  return String(body).replace(/\r?\n[ \t]/g, "").split(/\r?\n/).filter(Boolean);
}

function comparableCalendar(body) {
  const lines = calendarLines(body).filter((line) => !/^DTSTAMP:/i.test(line));
  const root = { type: '', properties: [], components: [] };
  const stack = [root];
  // Properties have no order within a component. Keep child component order,
  // boundaries, duplicate properties and exact values in the version fingerprint.
  for (const line of lines) {
    if (line.startsWith('BEGIN:')) {
      const component = { type: line.slice(6), properties: [], components: [] };
      stack.at(-1).components.push(component);
      stack.push(component);
    } else if (line.startsWith('END:')) {
      if (stack.length === 1 || stack.at(-1).type !== line.slice(4)) return JSON.stringify(lines);
      stack.pop().properties.sort();
    } else {
      stack.at(-1).properties.push(line);
    }
  }
  if (stack.length !== 1) return JSON.stringify(lines);
  root.properties.sort();
  return JSON.stringify(root);
}

function calendarHash(body) {
  return createHash('sha256').update(comparableCalendar(body)).digest('hex');
}

function strongEtag(value) {
  return /^"[^"\r\n]+"$/.test(value || '');
}

function validateBaseline(etag, hash) {
  if (etag != null && !strongEtag(etag)) throw new Error('CalDAV expected ETag is invalid');
  if (hash != null && !/^[a-f0-9]{64}$/.test(hash)) throw new Error('CalDAV expected content hash is invalid');
}

function assertBaseline(existing, etag, hash) {
  if ((etag != null && etag !== existing.etag) || (hash != null && hash !== existing.contentHash)) {
    throw conflictError('CalDAV version conflict; event was externally modified');
  }
}

function ownsEvent(body, uid, actionId) {
  const stack = [];
  const properties = [];
  let events = 0;
  let calendars = 0;
  for (const line of calendarLines(body)) {
    if (line.startsWith("BEGIN:")) {
      const type = line.slice(6);
      if (type === "VCALENDAR") { if (stack.length) return false; calendars++; }
      else if (type === "VEVENT") { if (stack.join("/") !== "VCALENDAR") return false; events++; }
      else if (type !== "VALARM" || stack.join("/") !== "VCALENDAR/VEVENT") return false;
      stack.push(type);
    } else if (line.startsWith("END:")) {
      if (stack.pop() !== line.slice(4)) return false;
    } else if (stack.join("/") === "VCALENDAR/VEVENT") {
      properties.push(line);
    } else if (!stack.length) return false;
  }
  return stack.length === 0 && calendars === 1 && events === 1
    && properties.filter((line) => /^UID[;:]/i.test(line)).length === 1
    && properties.includes(`UID:${uid}`)
    && properties.filter((line) => /^X-CODEX-REMOTE-CONTACT-ACTION-ID[;:]/i.test(line)).length === 1
    && properties.includes(`X-CODEX-REMOTE-CONTACT-ACTION-ID:${actionId}`);
}

function httpError(operation, status) {
  const error = new Error(`CalDAV ${operation} failed (HTTP ${status})`);
  if (status === 412) error.code = 'CALDAV_CONFLICT';
  return error;
}

function conflictError(message) {
  const error = new Error(message);
  error.code = 'CALDAV_CONFLICT';
  return error;
}
