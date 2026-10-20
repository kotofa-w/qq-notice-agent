// Deliberately bounded to explicit Chinese notice dates/clocks and ISO timestamps.
// Unsupported or ambiguous wording is reported to the reader instead of guessed.
const DAY = 86400000;
const DATE = /(?:(\d{4})年)?(\d{1,2})月(\d{1,2})[日号]|(\d{4})-(\d{2})-(\d{2})|今天|今日|明天|后天/g;
const CLOCK = /(上午|早上|凌晨|中午|下午|晚上)?\s*(\d{1,2}|[零一二两三四五六七八九十]{1,3})(?:(?:[:：](\d{2})(?::(\d{2}))?)|(?:[点时](?:(\d{1,2}|[零一二两三四五六七八九十]{1,3})分?|半)?))/g;
const ITEM_BOUNDARY = /[，,；;。\n]|(?<!\d)[：:]|[：:](?!\d)/g;

export function validateSourceTime(action, contexts) {
  const context = contexts.find((item) => String(item.sourceGroupId) === action.sourceGroupId);
  const message = context?.messages?.find((item) => !item.contextOnly && String(item.messageId) === action.sourceMessageId);
  if (!message || !action.sourceMessageId) return null;
  const sourceText = String(message.text || "");
  const itemQuote = action.sourceItemQuote;
  if (typeof itemQuote !== "string" || !itemQuote.trim()) return null;
  const itemAt = sourceText.indexOf(itemQuote);
  if (itemAt < 0 || sourceText.indexOf(itemQuote, itemAt + 1) >= 0) return null;
  const itemEnd = itemAt + itemQuote.replace(/[；;。\n\s]+$/, "").length;
  const fields = action.type === "calendar" ? ["start", ...(action.end != null ? ["end"] : [])] : ["due"];
  const result = { ...action };
  const instances = [];
  for (const field of fields) {
    const quote = action.timeEvidence?.[field];
    const raw = action[field];
    if (typeof quote !== "string" || !quote.trim() || typeof raw !== "string") return null;
    const text = String(message.text || "");
    const quoteAt = text.indexOf(quote);
    if (quoteAt < 0 || text.indexOf(quote, quoteAt + 1) >= 0) return null;
    const allDay = action.type === "calendar" && action.allDay;
    const candidate = parseIso(raw, allDay);
    if (!candidate) return null;
    // Parse the complete source first: a model-selected substring cannot erase an
    // explicit year, period, seconds, or a newer date belonging to another item.
    const matches = extractTimes(sourceText, message.timestamp, allDay).filter((item) =>
      quoteAt <= item.tokenStart && quoteAt + quote.length >= item.tokenEnd &&
      itemAt >= item.scopeStart && itemEnd <= item.scopeEnd &&
      (allDay ? item.day === candidate.day : item.iso === candidate.iso)
    );
    if (matches.length !== 1) return null;
    result[field] = candidate.iso;
    instances.push(`${field}:${allDay ? candidate.day : candidate.iso}:${matches[0].at}`);
  }
  if (action.type === "calendar" && result.end && result.end <= result.start) return null;
  return { action: result, instance: `${itemAt}|${instances.join("|")}` };
}

function parseIso(value, allDay) {
  if (allDay && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(+date) && date.toISOString().slice(0, 10) === value ? { day: value, iso: date.toISOString() } : null;
  }
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || +match[2] > 23 || +match[3] > 59 || +(match[4] || 0) > 59) return null;
  const date = new Date(value);
  if (Number.isNaN(+date) || !validDay(match[1])) return null;
  const local = new Date(+date + 8 * 3600000);
  if (allDay && local.toISOString().slice(11, 23) !== "00:00:00.000") return null;
  return { day: local.toISOString().slice(0, 10), iso: date.toISOString() };
}

function extractTimes(quote, timestamp, allDay) {
  const sourceDate = new Date(timestamp);
  const sourceDay = Number.isNaN(+sourceDate) ? null : new Date(+sourceDate + 8 * 3600000).toISOString().slice(0, 10);
  const dates = [...quote.matchAll(new RegExp(DATE))];
  const values = [];
  for (let index = 0; index < dates.length; index += 1) {
    const match = dates[index];
    let day;
    if (match[2]) {
      if (!match[1] && !sourceDay) continue;
      day = `${match[1] || sourceDay.slice(0, 4)}-${String(match[2]).padStart(2, "0")}-${String(match[3]).padStart(2, "0")}`;
    } else if (match[4]) day = `${match[4]}-${match[5]}-${match[6]}`;
    else if (sourceDay) {
      const offset = { 今天: 0, 今日: 0, 明天: 1, 后天: 2 }[match[0]];
      day = new Date(+new Date(`${sourceDay}T00:00:00Z`) + offset * DAY).toISOString().slice(0, 10);
    }
    if (!day || !validDay(day)) continue;
    const start = match.index + match[0].length;
    // Each clock belongs only to its preceding date, never another date in the quote.
    const tail = quote.slice(start, dates[index + 1]?.index ?? quote.length);
    const clause = tail.split(new RegExp(ITEM_BOUNDARY), 1)[0];
    if (allDay) {
      const wholeDay = /^\s*(?:[（(][^）)]{0,12}[）)]\s*)?全天/.exec(clause);
      if (wholeDay) values.push({ day, at: match.index, dateIndex: index, tokenStart: match.index, tokenEnd: start + wholeDay[0].length });
      continue;
    }
    const iso = /^(T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))/.exec(clause);
    if (iso) {
      const parsed = parseIso(`${day}${iso[1]}`, false);
      if (parsed) values.push({ ...parsed, at: match.index, dateIndex: index, tokenStart: match.index, tokenEnd: start + iso[1].length });
      continue;
    }
    const clocks = [...clause.matchAll(new RegExp(CLOCK))];
    if (clocks.some((clock, clockIndex) => clockIndex && !/^\s*(?:至|到|[-—~～])\s*$/.test(clause.slice(clocks[clockIndex - 1].index + clocks[clockIndex - 1][0].length, clock.index)))) continue;
    for (let clockIndex = 0; clockIndex < clocks.length; clockIndex += 1) {
      const clock = clocks[clockIndex];
      // Date and first clock must be adjacent except whitespace/weekday/period.
      const between = clause.slice(clockIndex ? clocks[clockIndex - 1].index + clocks[clockIndex - 1][0].length : 0, clock.index);
      if (clockIndex ? !/^\s*(?:至|到|[-—~～])\s*$/.test(between) : !/^\s*(?:[（(](?:周|星期)[一二三四五六日天][）)]\s*)?$/.test(between)) continue;
      let hour = number(clock[2]);
      const minute = clock[0].endsWith("半") ? 30 : number(clock[3] || clock[5] || "0");
      const second = +(clock[4] || 0);
      if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59 || second > 59) continue;
      let period = clock[1];
      if (!period && clockIndex && /至|到|[-—~～]/.test(between)) period = clocks[clockIndex - 1][1];
      if (period) {
        if (period === "凌晨") { if (hour > 6) continue; }
        else if (/上午|早上/.test(period)) { if (hour < 1 || hour >= 12) continue; }
        else if (period === "中午") { if (hour < 11 || hour > 12) continue; }
        else {
          // Midnight and early-night labels do not establish which calendar day
          // is meant. Accept only unambiguous afternoon/evening clock ranges.
          if (hour < (period === "晚上" ? 6 : 1) || hour >= 12) continue;
          hour += 12;
        }
      } else if (!clock[3] && hour > 0 && hour < 12) continue;
      const value = `${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}+08:00`;
      values.push({ day, iso: new Date(value).toISOString(), at: match.index + (clockIndex ? match[0].length + clock.index : 0), dateIndex: index, tokenStart: match.index, tokenEnd: start + clock.index + clock[0].length });
    }
  }
  const boundaries = [...quote.matchAll(new RegExp(ITEM_BOUNDARY))].map((match) => match.index);
  const scopes = dates.map((date, index) => {
    const clauseStart = (boundaries.filter((at) => at < date.index).at(-1) ?? -1) + 1;
    const clauseEnd = boundaries.find((at) => at >= date.index) ?? quote.length;
    return {
      start: index && dates[index - 1].index >= clauseStart ? date.index : clauseStart,
      end: Math.min(dates[index + 1]?.index ?? quote.length, clauseEnd)
    };
  });
  const ranges = [];
  for (let index = 0; index < dates.length; index += 1) {
    const previous = values.filter((item) => item.dateIndex === index - 1).at(-1);
    // Only an explicit range connector joins two date scopes. A comma, prose,
    // or an adjacent new date always starts a separate item attribution scope.
    if (index && previous && /^\s*(?:至|到|[-—~～])\s*$/.test(quote.slice(previous.tokenEnd, dates[index].index))) ranges.at(-1).last = index;
    else ranges.push({ first: index, last: index });
  }
  return values.flatMap((item) => {
    const range = ranges.find((value) => item.dateIndex >= value.first && item.dateIndex <= value.last);
    const clauseStart = (boundaries.filter((at) => at < item.at).at(-1) ?? -1) + 1;
    const clauseEnd = boundaries.find((at) => at >= item.at) ?? quote.length;
    // Multiple unconnected dates inside one local item clause are ambiguous;
    // requiring a range prevents both forward and reverse wording from borrowing.
    if (dates.some((date, index) => date.index >= clauseStart && date.index < clauseEnd && (index < range.first || index > range.last))) return [];
    return [{ ...item, scopeStart: scopes[range.first].start, scopeEnd: scopes[range.last].end }];
  });
}

function validDay(day) {
  const value = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(+value) && value.toISOString().slice(0, 10) === day;
}

function number(value) {
  if (/^\d+$/.test(value)) return +value;
  const digits = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value.includes("十")) { const [tens, ones] = value.split("十"); return (tens ? digits[tens] : 1) * 10 + (ones ? digits[ones] : 0); }
  return digits[value];
}
