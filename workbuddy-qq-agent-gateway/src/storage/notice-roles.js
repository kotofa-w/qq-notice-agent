const WINDOW_MS = 30 * 86400000;
const MAX_EVIDENCE = 256;
const MAX_OBSERVED_SENDERS = 64;
const STATUSES = new Set(["confirmed", "rejected", "revoked"]);
const PUBLICATION_ROLES = new Set(["publisher", "forwarder", "unknown"]);

export function normalizeNoticeRoles(value, now) {
  const roles = {
    revision: Math.max(0, Number.isSafeInteger(value?.revision) ? value.revision : 0),
    members: Array.isArray(value?.members) ? value.members.filter((member) => validId(member.senderId) && STATUSES.has(member.status)) : [],
    records: Array.isArray(value?.records) ? value.records : [],
    observationStartedAt: value?.observationStartedAt || null
  };
  pruneNoticeRoles(roles, now);
  return roles;
}

export function validId(value) {
  return /^\d{5,14}$/.test(String(value || ""));
}

export function setNoticeRole(roles, { senderId, status, displayName }, now) {
  if (!validId(senderId)) throw new Error("Notice sender QQ id is invalid");
  if (!STATUSES.has(status)) throw new Error("Notice role status is invalid");
  const id = String(senderId);
  let member = roles.members.find((item) => item.senderId === id);
  const name = displayName == null ? member?.displayName || id : String(displayName).trim().slice(0, 100) || id;
  if (member?.status === status && member.displayName === name) return structuredClone(member);
  if (!member) {
    member = { senderId: id, createdAt: now.toISOString() };
    roles.members.push(member);
  }
  Object.assign(member, { displayName: name, status, updatedAt: now.toISOString(), [`${status}At`]: now.toISOString() });
  roles.revision += 1;
  return structuredClone(member);
}

export function recordNoticeDecision(roles, decision, message, now) {
  if (!["notice", "chat", "uncertain"].includes(decision.classification)) throw new Error("Notice classification is invalid");
  if (!PUBLICATION_ROLES.has(decision.publicationRole)) throw new Error("Notice publication role is invalid");
  const quote = String(decision.quote || "").trim();
  const reason = String(decision.reason || "").trim();
  if (!reason || (!quote && (decision.classification !== "uncertain" || String(message.text || "").trim())) || !String(message.text || "").includes(quote)) throw new Error("Notice evidence must quote the source message");
  if (!validId(message.senderId)) throw new Error("Notice sender QQ id is invalid");
  const id = String(message.messageId);
  const previous = roles.records.find((record) => record.sourceMessageId === id);
  const timestamp = new Date(message.timestamp || now);
  if (!Number.isFinite(+timestamp)) throw new Error("Notice evidence timestamp is invalid");
  roles.records = roles.records.filter((record) => record.sourceMessageId !== id);
  // Chat records need no retained body: they remove corrected notice evidence.
  if (decision.classification !== "chat") roles.records.push({
    sourceMessageId: id,
    senderId: String(message.senderId),
    displayName: String(message.senderName || message.senderId).slice(0, 100),
    classification: decision.classification,
    publicationRole: decision.publicationRole,
    quote: quote.slice(0, 500),
    reason: reason.slice(0, 500),
    timestamp: timestamp.toISOString(),
    observedAt: previous?.observedAt || now.toISOString(),
    ...(previous?.reviewedAt ? { reviewedAt: previous.reviewedAt } : {})
  });
  roles.observationStartedAt ||= now.toISOString();
  pruneNoticeRoles(roles, now);
}

export function pruneNoticeRoles(roles, now) {
  roles.records = roles.records.filter((record) =>
    record && validId(record.senderId) && record.sourceMessageId &&
    ["notice", "uncertain"].includes(record.classification) &&
    Number.isFinite(Date.parse(record.timestamp)) && Date.parse(record.timestamp) >= +now - WINDOW_MS &&
    Date.parse(record.timestamp) <= +now
  ).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)).slice(-MAX_EVIDENCE);
  const senders = new Set([...roles.records].reverse().map((record) => record.senderId));
  const retained = new Set([...senders].slice(0, MAX_OBSERVED_SENDERS));
  roles.records = roles.records.filter((record) => retained.has(record.senderId));
}

export function publicNoticeRoles(roles, now) {
  pruneNoticeRoles(roles, now);
  const grouped = new Map();
  const memberIds = new Set(roles.members.map((member) => member.senderId));
  for (const record of roles.records) {
    if (record.classification !== "notice" || memberIds.has(record.senderId)) continue;
    const evidence = grouped.get(record.senderId) || [];
    evidence.push(record);
    grouped.set(record.senderId, evidence);
  }
  const candidates = [...grouped].filter(([, evidence]) =>
    evidence.length >= 3 && new Set(evidence.map((record) => new Date(Date.parse(record.timestamp) + 8 * 3600000).toISOString().slice(0, 10))).size >= 2
  ).map(([senderId, evidence]) => ({
    senderId,
    displayName: evidence.at(-1).displayName,
    publicationRole: new Set(evidence.map((record) => record.publicationRole)).size === 1 ? evidence[0].publicationRole : "unknown",
    reason: "近30天至少3条明确通知，覆盖至少2个香港日期；待人工确认",
    evidence: evidence.map(({ sourceMessageId, quote, reason, timestamp, publicationRole }) => ({ sourceMessageId, quote, reason, timestamp, publicationRole })),
    noticeCount: evidence.length,
    firstObservedAt: evidence[0].observedAt,
    lastObservedAt: evidence.at(-1).observedAt
  }));
  return structuredClone({
    revision: roles.revision,
    members: roles.members,
    candidates,
    observationStartedAt: roles.observationStartedAt,
    pendingReviews: roles.records.filter((record) => record.classification === "uncertain" && !record.reviewedAt)
  });
}
