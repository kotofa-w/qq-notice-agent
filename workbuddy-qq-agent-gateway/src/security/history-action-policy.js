// History permissions belong to the referenced message, not every action in a mixed batch.
export function historyActionSkipReason(action, contexts, { now = new Date() } = {}) {
  const groupContexts = (contexts || []).filter(context => String(context.sourceGroupId) === String(action.sourceGroupId));
  // Older frozen plans may predate the source-message validation at model parsing.
  if (!action.sourceMessageId && groupContexts.some(context => context.historyRecovery)) return '历史补漏仅生成摘要';
  const sources = groupContexts.filter(context => context.messages?.some(message => String(message.messageId) === String(action.sourceMessageId)));
  const histories = sources.filter(context => context.historyRecovery);
  if (!histories.length) return null;
  if (histories.some(context => context.historyRecovery.allowFutureActions !== true)) return '历史补漏仅生成摘要';
  const value = action.type === 'calendar' ? action.start : action.type === 'reminder' ? action.due : null;
  const allDay = action.type === 'calendar' && action.allDay;
  const instant = historyInstant(value, allDay);
  if (!Number.isFinite(instant)) return '历史补漏事项时间无效或未明确，仅生成摘要';
  if (!(instant > +now)) return '历史补漏事项已开始或已到期，仅生成摘要';
  return null;
}

function historyInstant(value, allDay) {
  if (typeof value !== 'string') return NaN;
  if (allDay && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const day = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(+day) && day.toISOString().slice(0, 10) === value ? +day - 8 * 3600000 : NaN;
  }
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/i.exec(value);
  if (!match || +match[2] > 23 || +match[3] > 59 || +(match[4] || 0) > 59) return NaN;
  const day = new Date(`${match[1]}T00:00:00Z`);
  if (!Number.isFinite(+day) || day.toISOString().slice(0, 10) !== match[1]) return NaN;
  const instant = Date.parse(value);
  if (!Number.isFinite(instant) || !allDay) return instant;
  // CalDAV also uses the UTC+8 calendar date; its start is that day's midnight.
  const localDay = new Date(instant + 8 * 3600000).toISOString().slice(0, 10);
  return Date.parse(`${localDay}T00:00:00+08:00`);
}
