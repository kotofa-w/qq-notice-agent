import { randomUUID } from 'node:crypto';

const PROBE_MS = 30000;
const OVERLAP_MS = 120000;
const LOOKBACK_MS = 48 * 3600000;

// Only observes connectivity and prepares existing history previews. Human
// confirmation is the sole path from these previews to the subscription queue.
export class ConnectionRecovery {
  constructor({ store, recovery, accountId, probe, clock = () => new Date() }) {
    Object.assign(this, { store, recovery, accountId: String(accountId), probe, clock });
    this.state = store.getConnectionRecovery(this.accountId) || { observedAt: null, onlineAt: null, online: null, intervals: [], eligible: {} };
    this.started = false;
    this.busy = false;
    this.nextProbeAt = 0;
  }

  eligible() {
    return Object.fromEntries(this.store.listSubscriptions({ enabled: true }).map(sub => [sub.id, {
      sourceGroupId: sub.sourceGroupId, updatedAt: sub.updatedAt, createdAt: sub.createdAt,
      status: 'pending', scanId: null
    }]));
  }

  interval(reason, from, to, targets, confirmedFrom = null) {
    // Bound retained observations just as the existing preview store is bounded.
    if (this.state.intervals.length >= 32) {
      this.state.intervals.shift();
      this.state.discardedIntervals = (this.state.discardedIntervals || 0) + 1;
      this.state.warning = '已超过32段连接记录，旧区间请结合已有预览或手动补漏核查';
    }
    const item = { id: randomUUID(), reason, from, to, confirmedFrom, targets: structuredClone(targets) };
    this.state.intervals.push(item);
    return item;
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = this.clock(), at = now.toISOString();
      if (!this.started || now.getTime() >= this.nextProbeAt) {
        let result;
        try { result = await this.probe(); }
        catch { result = { ok: false, state: 'bridge_unavailable' }; }
        const online = result.ok === true;
        let active = this.state.intervals.find(item => !item.to);
        if (!this.started || now.getTime() - Date.parse(this.state.observedAt) > 2 * PROBE_MS) {
          if (this.state.observedAt && Date.parse(this.state.observedAt) < now.getTime()) {
            if (active) {
              active.unobservedFrom ||= this.state.observedAt;
              active.unobservedTo = at;
            } else {
              const gap = this.interval('hub-unobserved', this.state.observedAt, online ? at : null, this.state.eligible);
              if (!online) active = gap;
            }
          } else if (!this.state.observedAt) {
            this.interval('startup-baseline', new Date(now.getTime() - OVERLAP_MS).toISOString(), at, this.eligible());
          }
          this.started = true;
        }
        if (online && active) active.to = at;
        if (!online) {
          active ||= this.interval('qq-disconnected', this.state.onlineAt || at, null,
            this.state.observedAt ? this.state.eligible : this.eligible(), at);
          active.confirmedFrom ||= at;
          active.lastFailureAt = at;
          active.failureObservations = (active.failureObservations || 0) + 1;
          active.connectionState = result.state;
        }
        this.state.online = online;
        this.state.observedAt = at;
        this.state.connectionState = result.state;
        if (online) this.state.onlineAt = at;
        this.state.eligible = this.eligible();
        // Always persist observation/trigger before any history request. A failed
        // save keeps dirty memory for retry but never advances into scanning.
        await this.store.saveConnectionRecovery(this.accountId, this.state);
        this.nextProbeAt = now.getTime() + PROBE_MS;
      }
      if (this.state.online) await this.scanNextSource();
    } finally { this.busy = false; }
  }

  async scanNextSource() {
    const gap = this.state.intervals.find(item => item.to && Object.values(item.targets).some(target => target.status === 'pending'));
    if (!gap) return;
    const source = Object.values(gap.targets).find(target => target.status === 'pending').sourceGroupId;
    const pageCache = new Map();
    for (const [subscriptionId, target] of Object.entries(gap.targets).filter(([, value]) => value.status === 'pending' && value.sourceGroupId === source)) {
      const sub = this.store.listSubscriptions().find(item => item.id === subscriptionId);
      if (!sub?.enabled || sub.updatedAt !== target.updatedAt || sub.sourceGroupId !== source) {
        target.status = 'skipped'; target.stopReason = '订阅已停用、删除或变更，请人工选择时段重新扫描';
        continue;
      }
      if (this.recovery.locks.has(subscriptionId)) continue;
      try {
        // Reuse a scan saved just before a process/persistence interruption.
        let scan = Object.values(this.store.snapshot().historyScans).find(item => item.subscriptionId === subscriptionId
          && item.accountId === this.accountId && item.automatic?.intervalId === gap.id);
        if (!scan) {
          const earliest = this.clock().getTime() - LOOKBACK_MS;
          const baseline = Date.parse(this.store.snapshot().sources[source]?.ledgerStartedAt || this.clock().toISOString());
          const start = Math.max(Date.parse(gap.from) - (gap.reason === 'startup-baseline' ? 0 : OVERLAP_MS), earliest, baseline, Date.parse(sub.createdAt));
          const end = Date.parse(gap.to);
          if (start >= end) {
            target.status = 'partial'; target.stopReason = '区间已超出48小时自动回看或早于可靠基线，请手动核查'; continue;
          }
          const warnings = [];
          if (gap.reason === 'hub-unobserved' || gap.unobservedFrom) warnings.push('Hub未运行期间无法确认QQ是否持续离线，请人工核查缺口');
          if (gap.reason === 'startup-baseline') warnings.push('首次启用仅扫描可靠基线后的有限重叠，不代表已覆盖此前离线历史');
          const intervalCoverageComplete = start <= Date.parse(gap.from);
          if (!intervalCoverageComplete) warnings.push('区间超出48小时自动回看或可靠订阅基线，只扫描有界部分，请手动核查其余时段');
          scan = await this.recovery.create({ subscriptionId, from: new Date(start).toISOString(), to: gap.to }, {
            defer: true, automatic: { intervalId: gap.id, reason: gap.reason, intervalCoverageComplete, warnings }
          });
        }
        target.scanId = scan.id;
        await this.store.saveConnectionRecovery(this.accountId, this.state);
        if (scan.status === 'scanning' && !scan.coverageComplete) scan = await this.recovery.resume(scan.id, { pageCache, maxTotalPages: 3 });
        const saved = this.store.getHistoryScan(scan.id);
        if ((saved.coverageComplete && saved.automatic?.intervalCoverageComplete !== false) || ['confirmed', 'confirming'].includes(saved.status)) target.status = 'scanned';
        else target.status = 'partial';
        target.stopReason = saved.stopReason;
      } catch (error) {
        if (error.storageWriteFailed) throw error;
        target.status = 'partial'; target.stopReason = `自动扫描停止：${String(error.message).slice(0, 300)}；请人工核查或继续扫描`;
      }
    }
    await this.store.saveConnectionRecovery(this.accountId, this.state);
  }
}
