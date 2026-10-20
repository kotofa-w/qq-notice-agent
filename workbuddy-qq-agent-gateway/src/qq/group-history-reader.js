import { normalizeOneBotGroupMessage } from "./message-normalizer.js";

// History metadata is checked before normalizing: the live normalizer may use
// the current time when a timestamp is missing, which cannot prove coverage.
export class GroupHistoryReader {
  constructor({ oneBot }) {
    this.oneBot = oneBot;
  }

  async readPage({ sourceGroupId, accountId, cursor = null, count = 50 }) {
    const groupId = positiveId(sourceGroupId);
    const selfId = positiveId(accountId);
    if (!groupId || !selfId) throw new Error("历史读取需要有效的 sourceGroupId 和 accountId");
    const messages = await this.oneBot.getGroupMessageHistory(groupId, { cursor, count });
    if (!Array.isArray(messages)) throw new Error("QQ 未返回有效的群历史消息数组");
    const warnings = [];
    const entries = [];
    const rows = messages.map((payload, index) => ({ payload, index, seq: decimal(payload?.real_seq) }));
    for (const { payload, index, seq } of rows) {
      const invalid = [];
      const messageId = idValue(payload?.message_id);
      const time = payload?.time;
      const numericTime = typeof time === "number" || (typeof time === "string" && /^\d+(?:\.\d+)?$/.test(time)) ? Number(time) : NaN;
      const date = new Date(numericTime < 10_000_000_000 ? numericTime * 1000 : numericTime);
      if (!Number.isFinite(numericTime) || numericTime <= 0 || !Number.isFinite(date.getTime())) invalid.push("time");
      if (!messageId) invalid.push("message_id");
      if (seq == null) invalid.push("real_seq");
      if (positiveId(payload?.group_id) !== groupId) invalid.push("group_id");
      if (payload?.self_id != null && positiveId(payload.self_id) !== selfId) invalid.push("self_id");
      const senderId = positiveId(payload?.user_id);
      if (!senderId || (payload?.sender?.user_id != null && positiveId(payload.sender.user_id) !== senderId)) invalid.push("user_id/sender.user_id");
      if (payload?.message_type != null && payload.message_type !== "group") invalid.push("message_type");
      if (invalid.length) {
        warnings.push(`历史页第 ${index + 1} 条元数据无效：${invalid.join(", ")}；无法确认完整覆盖`);
        continue;
      }
      // Some history endpoints omit self_id. The caller's account scopes this
      // read, but cannot independently prove the row's account: report the gap.
      if (payload.self_id == null) warnings.push(`历史页第 ${index + 1} 条缺少 self_id，按指定账号读取，账号归属未验证`);
      const message = normalizeOneBotGroupMessage({ ...payload, self_id: selfId }, {
        now: () => { throw new Error("历史消息禁止回退当前时间"); }
      });
      entries.push({ message: { ...message, accountId: selfId, realSeq: seq, historicalRoleUnverified: true }, payload });
    }
    entries.sort((left, right) => compareSequence(left.message.realSeq, right.message.realSeq));
    const orderedRows = rows.every(({ seq }) => seq != null)
      ? [...rows].sort((left, right) => compareSequence(left.seq, right.seq)) : [];
    const nextCursor = idValue(orderedRows[0]?.payload?.message_id);
    return {
      entries,
      nextCursor,
      oldestAt: warnings.length || !entries.length ? null : entries.reduce((oldest, { message }) => message.timestamp < oldest ? message.timestamp : oldest, entries[0].message.timestamp),
      warnings,
      empty: messages.length === 0
    };
  }
}

function decimal(value) {
  if (typeof value === "number" && !Number.isSafeInteger(value)) return null;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value);
  return /^\d+$/.test(text) ? text : null;
}

function positiveId(value) {
  const text = decimal(value);
  return text && BigInt(text) > 0n ? text : null;
}

function idValue(value) {
  if (typeof value === "number" && !Number.isSafeInteger(value)) return null;
  return ["number", "string"].includes(typeof value) && String(value).trim() ? String(value) : null;
}

function compareSequence(left, right) {
  return BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0;
}
