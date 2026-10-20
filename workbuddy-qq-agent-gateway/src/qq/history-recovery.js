import { randomUUID } from 'node:crypto';

const DAY = 86400000;
const MAX_MESSAGES = 500;
const configKey = sub => JSON.stringify([sub.sourceGroupId, sub.targetType, sub.targetId, sub.intakeMode, sub.updatedAt]);

// A bounded reader and confirmation coordinator. Execution stays in the existing
// subscription queue; a preview cannot trigger a model call or external write.
export class HistoryRecovery {
  constructor({ store, reader, accountId, hydrate = async () => {}, assertReady = async () => {}, clock = () => new Date() }) {
    Object.assign(this, { store, reader, accountId: String(accountId), hydrate, assertReady, clock });
    this.locks = new Set();
  }

  subscription(id) {
    const sub = this.store.listSubscriptions().find(item => item.id === String(id));
    if (!sub?.enabled) throw new Error('通知订阅已停用或不存在');
    return sub;
  }

  checkedScan(id) {
    const scan = this.store.getHistoryScan(id);
    if (!scan) throw new Error('补漏预览不存在或已过期');
    const sub = this.subscription(scan.subscriptionId);
    if (scan.accountId !== this.accountId || scan.configKey !== configKey(sub)) throw new Error('账号或订阅配置已变化，请重新扫描');
    if (this.clock().getTime() - Date.parse(scan.createdAt) > 7 * DAY) throw new Error('补漏预览已过期，请重新扫描');
    if (Date.parse(scan.from) < this.clock().getTime() - 7 * DAY) throw new Error('补漏时段已超出7天回看范围，请重新扫描');
    return scan;
  }

  async locked(subscriptionId, fn) {
    if (this.locks.has(subscriptionId)) throw new Error('该订阅正在扫描或确认，请稍后重试');
    this.locks.add(subscriptionId);
    try { return await fn(); } finally { this.locks.delete(subscriptionId); }
  }

  list(subscriptionId) {
    this.subscription(subscriptionId);
    return Object.values(this.store.snapshot().historyScans).filter(scan => scan.subscriptionId === String(subscriptionId))
      .flatMap(scan => {
        try { const { messages, ...summary } = this.get(scan.id); return [summary]; } catch { return []; }
      })
      .sort((a, b) => b.to.localeCompare(a.to));
  }

  async create({ subscriptionId, from, to }, { automatic = null, defer = false } = {}) {
    const sub = this.subscription(subscriptionId);
    const start = Date.parse(from), end = Date.parse(to), now = this.clock().getTime();
    if (typeof from !== 'string' || typeof to !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(from) || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(to)
      || !Number.isFinite(start) || !Number.isFinite(end) || start >= end || start < now - 7 * DAY || end > now) throw new Error('请选择过去7天内有效的起止时间');
    await this.assertReady(sub);
    const scan = { id: randomUUID(), subscriptionId: sub.id, sourceGroupId: sub.sourceGroupId, accountId: this.accountId,
      from: new Date(start).toISOString(), to: new Date(end).toISOString(), createdAt: this.clock().toISOString(),
      configKey: configKey(sub), status: 'scanning', coverageComplete: false,
      uncertainBaseline: !this.store.snapshot().sources[sub.sourceGroupId]?.ledgerStartedAt
        || start < Date.parse(this.store.snapshot().sources[sub.sourceGroupId].ledgerStartedAt)
        || start < Date.parse(sub.createdAt) || sub.intakeMode === 'ADMIN_ONLY',
      ...(automatic ? { automatic } : {}),
      cursor: null, entries: [], warnings: [], pages: 0, fetched: 0, seenCursors: [] };
    await this.store.saveHistoryScan(scan);
    return defer ? this.publicScan(scan) : this.resume(scan.id);
  }

  async resume(id, { pageCache = null, maxTotalPages = 40 } = {}) {
    const initial = this.checkedScan(id);
    return this.locked(initial.subscriptionId, async () => {
      const scan = this.checkedScan(id);
      if (['confirmed', 'confirming'].includes(scan.status) || scan.coverageComplete) return this.publicScan(scan);
      await this.assertReady(this.subscription(scan.subscriptionId));
      scan.status = 'scanning';
      const started = Date.now();
      for (let pageIndex = 0; pageIndex < 3; pageIndex++) {
        if (maxTotalPages < 40 && scan.pages >= maxTotalPages) { scan.stopReason = '已达到自动扫描3页总上限，可人工继续扫描'; break; }
        if (scan.entries.length >= MAX_MESSAGES || scan.pages >= 40) { scan.stopReason = '已达到本批500条或40页上限，请缩小时间范围'; break; }
        if (Date.now() - started > 20000) { scan.stopReason = '本轮读取时间已到上限，可继续扫描'; break; }
        try {
          const request = { sourceGroupId: scan.sourceGroupId, accountId: this.accountId, cursor: scan.cursor, count: 50 };
          const key = JSON.stringify(request);
          if (pageCache && !pageCache.has(key)) pageCache.set(key, this.reader.readPage(request));
          const page = await (pageCache ? pageCache.get(key) : this.reader.readPage(request));
          scan.pages++;
          scan.fetched += page.entries.length;
          scan.warnings = [...new Set([...scan.warnings, ...page.warnings])].slice(0, 100);
          const byId = new Map(scan.entries.map(entry => [entry.message.messageId, entry]));
          for (const entry of page.entries) {
            const { message } = entry;
            const sent = Date.parse(message.timestamp);
            if (sent < Date.parse(scan.from) || sent > Date.parse(scan.to)) continue;
            if (message.senderId === this.accountId) continue;
            if (JSON.stringify(entry).length > 128000) { scan.warnings.push('一条历史消息超出预览大小限制，请人工查看原群'); continue; }
            const prior = byId.get(message.messageId);
            if (prior && (prior.message.realSeq !== message.realSeq || prior.message.timestamp !== message.timestamp || prior.message.text !== message.text)) throw new Error('分页消息身份冲突，请人工核对');
            if (!prior) {
              if (byId.size < MAX_MESSAGES) byId.set(message.messageId, entry);
              else if (!scan.warnings.includes('本页超过500条总上限，结果已截断，请缩小时间范围')) scan.warnings.push('本页超过500条总上限，结果已截断，请缩小时间范围');
            }
          }
          scan.entries = [...byId.values()].sort((a, b) => Date.parse(a.message.timestamp) - Date.parse(b.message.timestamp)
            || (BigInt(a.message.realSeq) < BigInt(b.message.realSeq) ? -1 : 1));
          this.checkedScan(id); // A config edit during HTTP reading invalidates this preview.
          if (page.oldestAt && Date.parse(page.oldestAt) <= Date.parse(scan.from)) {
            scan.coverageComplete = !scan.warnings.length;
            scan.stopReason = scan.coverageComplete ? '已扫描至所选时间起点' : '已读取至起点，但有元数据或媒体缺口，无法确认完整覆盖';
            await this.store.saveHistoryScan(scan); break;
          }
          if (page.empty) { scan.stopReason = '历史接口返回空页，无法确认已覆盖所选时间'; await this.store.saveHistoryScan(scan); break; }
          if (!page.nextCursor || page.nextCursor === scan.cursor || scan.seenCursors.includes(page.nextCursor)) {
            scan.stopReason = '历史游标未前进或出现重复页，无法确认完整覆盖'; await this.store.saveHistoryScan(scan); break;
          }
          scan.seenCursors.push(page.nextCursor);
          scan.cursor = page.nextCursor;
          scan.stopReason = '本轮页数已到上限，可继续扫描';
          await this.store.saveHistoryScan(scan);
        } catch (error) {
          scan.stopReason = `扫描中断：${String(error.message).slice(0, 300)}；可重试或核对部分结果`;
          break;
        }
      }
      scan.status = scan.coverageComplete ? 'preview' : 'partial';
      await this.store.saveHistoryScan(scan);
      return this.publicScan(scan);
    });
  }

  get(id) { return this.publicScan(this.checkedScan(id)); }

  publicScan(scan) {
    const messages = scan.entries.map(({ message }) => {
      let status;
      try { status = this.store.historyMessageStatus(scan.subscriptionId, message); }
      catch (error) { status = { duplicate: true, reason: error.message }; }
      return { messageId: message.messageId, timestamp: message.timestamp, senderName: message.senderName,
        text: message.text, hasMedia: Boolean(message.imageRefs?.length || message.attachments?.length), ...status };
    });
    const sub = this.store.snapshot().subscriptions[scan.subscriptionId];
    const collection = sub?.state.collections.find(item => item.historyRecovery?.batchId === scan.id);
    return { id: scan.id, subscriptionId: scan.subscriptionId, sourceGroupId: scan.sourceGroupId, from: scan.from, to: scan.to,
      status: scan.status, stopReason: scan.stopReason,
      coverageComplete: scan.coverageComplete && scan.automatic?.intervalCoverageComplete !== false, uncertainBaseline: scan.uncertainBaseline,
      automatic: scan.automatic || null,
      warnings: [...scan.warnings, ...(scan.automatic?.warnings || []), ...(this.subscription(scan.subscriptionId).intakeMode === 'ADMIN_ONLY'
        ? ['历史管理员身份未验证为发送当时权限，请核对所选发送人；仍按当前订阅筛选。'] : [])], messages,
      counts: { fetched: scan.fetched, duplicates: messages.filter(m => m.duplicate).length, available: messages.filter(m => !m.duplicate).length },
      confirmedCount: scan.confirmedCount || 0,
      confirmationIntent: scan.intent ? { messageIds: JSON.parse(scan.intent)[0], allowFutureActions: JSON.parse(scan.intent)[1] } : null,
      deliveryStatus: scan.deliveryStatus || (scan.status !== 'confirmed' ? 'not-queued' : collection?.status === 'completed' ? 'completed'
        : scan.confirmedCount ? 'pending' : 'nothing-to-queue') };
  }

  async confirm(id, { messageIds, allowFutureActions = false, acknowledgeUncertain = false, acknowledgePartial = false } = {}) {
    const initial = this.checkedScan(id);
    return this.locked(initial.subscriptionId, async () => {
      let scan = this.checkedScan(id);
      if (scan.status === 'confirmed') { await this.store.save(); return { scan: this.publicScan(scan), result: { queued: 0, alreadyConfirmed: true } }; }
      if (!Array.isArray(messageIds) || !messageIds.length || messageIds.length > MAX_MESSAGES || messageIds.some(id => typeof id !== 'string') || new Set(messageIds).size !== messageIds.length) throw new Error('请选择有效的所选消息');
      if (scan.uncertainBaseline && acknowledgeUncertain !== true) throw new Error('请先核对可能已经处理过的历史消息');
      if ((!scan.coverageComplete || scan.automatic?.intervalCoverageComplete === false) && acknowledgePartial !== true) throw new Error('请先确认本批只有部分结果');
      const selected = scan.entries.filter(entry => messageIds.includes(entry.message.messageId));
      if (selected.length !== messageIds.length) throw new Error('所选消息不属于本批预览');
      const intent = JSON.stringify([messageIds.slice().sort(), allowFutureActions === true]);
      if (scan.intent && scan.intent !== intent) throw new Error('本批已确认的所选消息不可更改，请重试原选择');
      await this.assertReady(this.subscription(scan.subscriptionId));
      scan.intent = intent;
      scan.status = 'confirming';
      await this.store.saveHistoryScan(scan);
      let mediaFailed = false;
      const messages = [];
      for (const { message, payload } of selected) {
        if (this.store.historyMessageStatus(scan.subscriptionId, message).duplicate) continue;
        try { await this.hydrate(payload, message); }
        catch (error) {
          mediaFailed = true;
          message.quoteError = `历史附件或引用读取失败：${String(error.message).slice(0, 200)}`;
          scan.warnings.push('历史附件或引用未能读取，本批仅补摘要，请查看原群消息');
        }
        if ([...(message.images || []), ...(message.attachments || [])].some(media => media.error || !media.localPath)) mediaFailed = true;
        messages.push(message);
      }
      await this.assertReady(this.subscription(scan.subscriptionId));
      this.checkedScan(id);
      // A real-time copy may have arrived during hydration; the Store checks it
      // again synchronously while building one durable, target-specific batch.
      const result = await this.store.enqueueHistoryBatch({ subscriptionId: scan.subscriptionId, batchId: scan.id,
        messages, allowFutureActions: allowFutureActions === true && !mediaFailed });
      const durable = this.store.getHistoryScan(id);
      scan.queuedMessageIds = durable.queuedMessageIds;
      scan.confirmedCount = durable.queuedMessageIds?.length || 0;
      scan.status = 'confirmed';
      await this.store.saveHistoryScan(scan);
      return { scan: this.publicScan(scan), result };
    });
  }
}
