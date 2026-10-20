import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { validateSourceTime } from '../security/source-time-evidence.js';
import { historyActionSkipReason } from '../security/history-action-policy.js';

const CATEGORIES = ['exam', 'deadline', 'class', 'activity', 'other'];
const ACTIVE = new Set(['awaiting_notification', 'pending', 'manual', 'approved', 'paused']);
const REPLYABLE = new Set([...ACTIVE, 'failed', 'conflict', 'synced']);
const defaults = () => ({ enabled: true, groupType: 'other', categories: [...CATEGORIES], confirmationMinutes: 10, timeoutPolicy: 'manual' });
const sameTarget = (item, type, id) => item.targetType === type && item.targetId === String(id);
const normalizeTitle = action => String(action.normalizedTitle || action.title || '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');

export class CalendarFilter {
  constructor({ filePath, subscriptionStore, automationClient, clock = () => new Date(), canWrite = async () => true } = {}) {
    this.filePath = filePath;
    this.subscriptionStore = subscriptionStore;
    this.automationClient = automationClient;
    this.clock = clock;
    this.canWrite = canWrite;
    this.state = { version: 1, nextId: 1, settings: {}, candidates: [], replyReceipts: {} };
    // ponytail: one durable ledger lock; split by target only if throughput requires it.
    this.chain = Promise.resolve();
  }

  async init() {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const state = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (state.version !== 1 || !Array.isArray(state.candidates) || !state.settings || !Number.isInteger(state.nextId)) throw new Error('Calendar filter ledger is invalid');
      this.state = state;
      this.state.replyReceipts ||= {};
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    for (const candidate of this.state.candidates) {
      if (candidate.status !== 'writing') continue;
      candidate.status = 'approved';
      candidate.reason = '上次写入结果未知，将使用同一编号恢复';
      candidate.recovering = true;
    }
    await this._save();
    return this;
  }

  snapshot({ targetType, targetId } = {}) {
    const subscriptions = this._subscriptions().filter(sub => (!targetType || sub.targetType === targetType) && (targetId == null || sub.targetId === String(targetId)));
    const candidates = this.state.candidates.filter(item => (!targetType || item.targetType === targetType) && (targetId == null || item.targetId === String(targetId)));
    // Only calendar metadata is public; frozen input contexts remain in the ledger.
    return structuredClone({
      settings: subscriptions.map(sub => ({ subscriptionId: sub.id, ...this.getSettings(sub.id) })),
      candidates: candidates.map(({ contexts, subscriptionSnapshot, ...item }) => item)
    });
  }

  getSettings(subscriptionId) {
    return structuredClone({ ...defaults(), ...this.state.settings[String(subscriptionId)] });
  }

  setSettings(subscriptionId, patch = {}) {
    return this._run(async () => {
      const id = String(subscriptionId || '');
      if (!this._subscriptions().some(sub => sub.id === id)) throw new Error('Subscription does not exist');
      const allowed = ['enabled', 'groupType', 'categories', 'confirmationMinutes', 'timeoutPolicy'];
      if (Object.keys(patch).some(key => !allowed.includes(key))) throw new Error('Calendar filter setting is invalid');
      const policy = { ...this.getSettings(id), ...patch };
      if (patch.groupType === 'course' && patch.timeoutPolicy == null) policy.timeoutPolicy = 'auto';
      if (typeof policy.enabled !== 'boolean' || !['course', 'class', 'other'].includes(policy.groupType)
        || !Array.isArray(policy.categories) || policy.categories.some(value => !CATEGORIES.includes(value))
        || !Number.isInteger(policy.confirmationMinutes) || policy.confirmationMinutes < 1 || policy.confirmationMinutes > 1440
        || !['auto', 'manual'].includes(policy.timeoutPolicy)) throw new Error('Calendar filter setting is invalid');
      policy.categories = [...new Set(policy.categories)];
      this.state.settings[id] = policy;
      await this._save();
      return this.getSettings(id);
    });
  }

  stage({ targetType, targetId, plan } = {}) {
    return this._run(async () => {
      if (!['private', 'group'].includes(targetType) || !String(targetId || '') || !plan?.id || !Array.isArray(plan.contexts)) throw new Error('Calendar candidate target or plan is invalid');
      targetId = String(targetId);
      const ids = [];
      const values = [...(plan.autoResult?.actions || []), ...(plan.autoResult?.uncertainActions || []).map(action => ({ ...action, timeUncertain: true }))];
      for (const raw of values) {
        if (!raw || !['calendar', 'reminder'].includes(raw.type) || !String(raw.title || '').trim()) continue;
        const action = structuredClone({ ...raw, sourceGroupId: String(raw.sourceGroupId || ''), sourceMessageId: String(raw.sourceMessageId || '') });
        const operation = action.operation || 'create';
        if (!['create', 'update', 'cancel'].includes(operation)) continue;
        const context = plan.contexts.find(item => String(item.sourceGroupId) === action.sourceGroupId && item.messages?.some(message => !message.contextOnly && String(message.messageId) === action.sourceMessageId));
        const subscription = context && this._subscriptions().find(sub => sub.id === String(context.subscriptionId) && sameTarget(sub, targetType, targetId) && sub.sourceGroupId === action.sourceGroupId);
        const evidence = !action.timeUncertain && action.writable !== false ? validateSourceTime(action, plan.contexts) : null;
        if (evidence && operation !== 'cancel') Object.assign(action, evidence.action);
        const related = this.state.candidates.find(item => item.id === String(action.relatedCandidateId || ''));
        const relationValid = operation === 'create' || Boolean(related && sameTarget(related, targetType, targetId)
          && (related.sourceGroupId === action.sourceGroupId || related.sourceRelations?.some(source => source.sourceGroupId === action.sourceGroupId))
          && related.external?.etag && related.external?.contentHash && related.status === 'synced');
        const cancelQuote = operation === 'cancel' && validItemQuote(action, context) && /取消|撤销|作废|停课|不再举行|停止举办/.test(action.sourceItemQuote);
        const writable = Boolean(subscription && context && relationValid && (operation === 'cancel' ? cancelQuote : evidence));
        const dedupeKey = operation === 'create' ? itemKey(action, targetType, targetId) : null;
        const duplicate = this.state.candidates.find(item => (dedupeKey && item.dedupeKey === dedupeKey)
          || (item.planId === String(plan.id) && item.sourceGroupId === action.sourceGroupId && item.sourceMessageId === action.sourceMessageId
            && item.operation === operation && normalizeTitle(item.action) === normalizeTitle(action) && item.action.start === action.start && item.action.due === action.due));
        if (duplicate) {
          if (!duplicate.sourceRelations.some(source => source.sourceGroupId === action.sourceGroupId && source.sourceMessageId === action.sourceMessageId)) {
            duplicate.sourceRelations.push({ sourceGroupId: action.sourceGroupId, sourceMessageId: action.sourceMessageId });
          }
          if (duplicate.planId === String(plan.id) && !duplicate.notification?.sentAt && ACTIVE.has(duplicate.status)) ids.push(duplicate.id);
          continue;
        }
        const id = `C${String(this.state.nextId++).padStart(6, '0')}`;
        action.actionId = operation === 'create'
          ? (/^[a-f0-9]{24}$/.test(action.actionId || '') ? action.actionId : createHash('sha256').update(`${targetType}:${targetId}:${id}`).digest('hex').slice(0, 24))
          : related?.action.actionId;
        const category = classify(action);
        const candidate = {
          id, targetType, targetId, planId: String(plan.id), subscriptionId: subscription?.id || String(context?.subscriptionId || ''),
          sourceGroupId: action.sourceGroupId, sourceMessageId: action.sourceMessageId, sourceGroupName: context?.sourceGroupName || '',
          action, operation, relatedCandidateId: operation === 'create' ? null : String(action.relatedCandidateId || ''),
          status: 'awaiting_notification', category, writable, reason: writable ? '等待QQ通知成功后确认' : !relationValid ? '更正或取消未关联到本会话同来源的已同步事项' : '时间或来源证据未明确，请查看原消息',
          notification: null, external: operation === 'create' ? null : structuredClone(related?.external || null),
          contexts: structuredClone(plan.contexts), subscriptionSnapshot: subscription ? freezeSubscription(subscription) : null,
          policySnapshot: this.getSettings(subscription?.id || ''),
          sourceRelations: [{ sourceGroupId: action.sourceGroupId, sourceMessageId: action.sourceMessageId }],
          dedupeKey, createdAt: this._now(), updatedAt: this._now(), errors: []
        };
        this.state.candidates.push(candidate);
        ids.push(id);
      }
      await this._save();
      const unique = [...new Set(ids)];
      const text = unique.map(id => this._notice(this.state.candidates.find(item => item.id === id))).join('\n');
      return { ids: unique, text };
    });
  }

  markNotified(ids, { messageId, sentAt } = {}) {
    return this._run(async () => {
      const sent = new Date(sentAt || this.clock());
      if (!String(messageId || '') || !Number.isFinite(+sent)) throw new Error('Calendar notification receipt is invalid');
      for (const id of new Set(ids || [])) {
        const candidate = this.state.candidates.find(item => item.id === String(id));
        if (!candidate || candidate.notification?.sentAt || !ACTIVE.has(candidate.status)) continue;
        const policy = this._policy(candidate);
        candidate.notification = { messageId: String(messageId), sentAt: sent.toISOString(), deadlineAt: new Date(+sent + policy.confirmationMinutes * 60000).toISOString() };
        if (candidate.status === 'awaiting_notification') {
          const manual = this._manualReason(candidate, policy);
          candidate.status = manual ? 'manual' : 'pending';
          candidate.reason = manual || `等待确认，${policy.confirmationMinutes}分钟后按设置处理`;
        }
        candidate.updatedAt = this._now();
      }
      await this._save();
    });
  }

  tick() {
    return this._run(async () => {
      // Persist any previous failed result save before another external action.
      await this._save();
      for (const candidate of this.state.candidates) await this._process(candidate);
      await this._save();
      return this.snapshot();
    });
  }

  decide(id, decision, scope = {}) {
    return this._run(async () => {
      const candidate = this._candidate(id, scope);
      this._decision(candidate, decision);
      await this._save();
      await this._process(candidate);
      await this._save();
      return this._public(candidate);
    });
  }

  handleReply({ targetType, targetId, senderId, text, replyToMessageId, messageId, ownerId } = {}) {
    return this._run(async () => {
      if (!ownerId || String(senderId) !== String(ownerId)) return { handled: false, reply: '' };
      const match = /^(是|否|同意|拒绝|确认|取消|yes|no)(?:\s*[:：#]?\s*(C\d+))?\s*$/i.exec(String(text || '').trim());
      if (!match) return { handled: false, reply: '' };
      const receiptKey = messageId ? `${targetType}:${targetId}:${messageId}` : null;
      if (receiptKey && this.state.replyReceipts[receiptKey]) return structuredClone(this.state.replyReceipts[receiptKey]);
      const scoped = this.state.candidates.filter(item => sameTarget(item, targetType, targetId) && REPLYABLE.has(item.status));
      let choices;
      if (match[2]) choices = scoped.filter(item => item.id.toUpperCase() === match[2].toUpperCase());
      else if (replyToMessageId) choices = scoped.filter(item => item.notification?.messageId === String(replyToMessageId));
      else choices = scoped.filter(item => ['pending', 'manual', 'approved', 'paused'].includes(item.status) && item.notification?.sentAt);
      if (!choices.length) return { handled: false, reply: '' };
      let result;
      let chosen = null;
      if (choices.length > 1) result = { handled: true, reply: `存在多个日程候选，请回复“是 编号”或“否 编号”：${choices.map(item => item.id).join('、')}` };
      else {
        const candidate = choices[0];
        chosen = candidate;
        const decision = /^(是|同意|确认|yes)$/i.test(match[1]) ? 'approve' : 'reject';
        this._decision(candidate, decision);
        result = { handled: true, reply: `${candidate.id} ${candidate.reason}` };
      }
      if (receiptKey) this.state.replyReceipts[receiptKey] = result;
      await this._save();
      if (chosen) {
        await this._process(chosen);
        result = { handled: true, reply: `${chosen.id} ${chosen.reason}` };
        if (receiptKey) this.state.replyReceipts[receiptKey] = result;
        await this._save();
      }
      return structuredClone(result);
    });
  }

  contextFor(targetType, targetId, sourceGroupId) {
    return this.state.candidates.filter(item => sameTarget(item, targetType, targetId)
      && (item.sourceGroupId === String(sourceGroupId) || item.sourceRelations?.some(source => source.sourceGroupId === String(sourceGroupId))))
      .map(item => ({ id: item.id, title: item.action.title, start: item.action.start || null, due: item.action.due || null, status: item.status }));
  }

  flush() { return this._run(() => this._save()); }
  idle() { return this.chain; }

  _decision(candidate, decision) {
    if (!['approve', 'reject', 'retry'].includes(decision)) throw new Error('Calendar decision is invalid');
    if (decision === 'reject') {
      if (candidate.status === 'cancelled' || candidate.status === 'rejected') return;
      if (candidate.recovering && candidate.operation !== 'cancel' && candidate.status !== 'synced') {
        candidate.rejectUnknown = true;
        candidate.status = 'approved';
        candidate.reason = '已请求拒绝，先核对未知写入结果后安全撤销';
      } else if (candidate.status === 'synced' || (candidate.recovering && candidate.operation === 'cancel')) {
        candidate.operation = 'cancel';
        candidate.relatedCandidateId = candidate.id;
        candidate.status = 'approved';
        candidate.reason = '已确认撤销，等待条件删除';
        candidate.ownerCancellation = true;
      } else {
        candidate.status = 'rejected';
        candidate.reason = '已拒绝，不再写入此事项';
      }
    } else if (decision === 'retry') {
      if (!['failed', 'conflict'].includes(candidate.status)) throw new Error('Calendar candidate is not retryable');
      candidate.status = 'approved';
      candidate.reason = '已请求重试，将重新校验后写入';
    } else {
      delete candidate.rejectUnknown;
      if (['synced', 'cancelled'].includes(candidate.status)) return;
      if (['rejected', 'expired', 'skipped'].includes(candidate.status)) throw new Error('Calendar candidate is no longer actionable');
      if (!candidate.writable) {
        candidate.status = 'manual';
        candidate.reason = '时间或来源证据未明确，无法写入，请查看原消息';
      } else {
        candidate.status = 'approved';
        candidate.reason = '已确认，等待校验后写入';
      }
    }
    candidate.updatedAt = this._now();
  }

  async _process(candidate) {
    if (!ACTIVE.has(candidate.status)) return;
    const policy = this._policy(candidate);
    const invalid = this._invalidContext(candidate);
    if (invalid) {
      candidate.status = 'skipped'; candidate.reason = invalid; candidate.updatedAt = this._now();
      return;
    }
    let allowed = false;
    try { allowed = Boolean(this.automationClient && policy.enabled && await this.canWrite(candidate.targetType, candidate.targetId)); } catch { /* unavailable gates pause, never approve */ }
    if (!allowed) {
      if (candidate.status !== 'paused') candidate.resumeStatus = candidate.status;
      candidate.status = 'paused'; candidate.reason = '日程写入已关闭或服务不可用，恢复后重新校验';
      return;
    }
    if (candidate.status === 'paused') {
      candidate.status = candidate.resumeStatus || (candidate.notification?.sentAt ? 'pending' : 'awaiting_notification');
      delete candidate.resumeStatus;
    }
    if (!candidate.notification?.sentAt) return;
    if (candidate.status === 'awaiting_notification') return;
    if (candidate.status !== 'approved') {
      const manual = this._manualReason(candidate, policy);
      if (manual) { candidate.status = 'manual'; candidate.reason = manual; return; }
      candidate.status = 'pending';
      if (+this.clock() < Date.parse(candidate.notification.deadlineAt)) return;
      candidate.status = 'approved'; candidate.reason = '确认时间已到，按订阅设置自动写入';
    }
    if (!candidate.writable) { candidate.status = 'manual'; candidate.reason = '时间或来源证据未明确，无法写入'; return; }
    if (candidate.rejectUnknown) {
      const ready = await this._rejectUnknown(candidate);
      if (ready) await this._process(candidate);
      return;
    }
    let recoveryExisting = false;
    if (candidate.recovering && candidate.operation !== 'cancel' && typeof this.automationClient.read === 'function') {
      try {
        const existing = await this.automationClient.read(candidate.action.actionId);
        if (existing.exists && !existing.owned) {
          candidate.status = 'conflict'; candidate.reason = '外部日程归属冲突，停止恢复'; return;
        }
        // An already committed event may have passed its start while offline.
        // Protected execute can only reconcile identical content or the old baseline.
        recoveryExisting = Boolean(existing.exists && existing.owned && (candidate.operation === 'create'
          || existing.etag !== candidate.external?.etag || existing.contentHash !== candidate.external?.contentHash));
      } catch {
        candidate.status = 'failed'; candidate.reason = '无法查询上次写入结果，可手动重试';
        candidate.errors.push({ at: this._now(), code: 'CALENDAR_READ_FAILED', message: candidate.reason });
        return;
      }
    }
    if (candidate.operation !== 'cancel') {
      const validTime = validateSourceTime(candidate.action, candidate.contexts);
      if (!validTime) { candidate.status = 'manual'; candidate.writable = false; candidate.reason = '时间证据校验失败，请查看原消息'; return; }
      const historyReason = historyActionSkipReason(candidate.action, candidate.contexts, { now: this.clock() });
      if (historyReason && !recoveryExisting) { candidate.status = 'skipped'; candidate.reason = historyReason; return; }
      const at = actionInstant(candidate.action);
      if ((!Number.isFinite(at) || at <= +this.clock()) && !recoveryExisting) { candidate.status = 'expired'; candidate.reason = '事项已开始或已到期，不再写入'; return; }
    }
    if (candidate.operation !== 'create' && (!candidate.external?.etag || !candidate.external?.contentHash)) {
      candidate.status = 'conflict'; candidate.reason = '缺少上次写入版本，无法安全更改日历'; return;
    }
    candidate.status = 'writing'; candidate.updatedAt = this._now();
    await this._save();
    // The disk write yields to subscription edits and runtime switch changes.
    const lastInvalid = this._invalidContext(candidate);
    if (lastInvalid) { candidate.status = 'skipped'; candidate.reason = lastInvalid; await this._save(); return; }
    let stillAllowed = false;
    try { stillAllowed = Boolean(this.automationClient && this.getSettings(candidate.subscriptionId).enabled && await this.canWrite(candidate.targetType, candidate.targetId)); } catch { /* keep the approval paused */ }
    if (!stillAllowed) {
      candidate.status = 'paused'; candidate.resumeStatus = 'approved'; candidate.reason = '日程写入已关闭或服务不可用，恢复后重新校验';
      await this._save(); return;
    }
    try {
      const options = { protectExisting: true, ...(recoveryExisting ? { existingOnly: true } : {}), sourceGroupId: candidate.sourceGroupId, sourceGroupName: candidate.sourceGroupName,
        ...(candidate.operation !== 'create' ? { expectedEtag: candidate.external.etag, expectedContentHash: candidate.external.contentHash } : {}) };
      const result = candidate.operation === 'cancel'
        ? await this.automationClient.delete(candidate.action.actionId, options)
        : await this.automationClient.execute(candidate.action, options);
      if (result?.skipped) { candidate.status = 'skipped'; candidate.reason = '日历服务未写入该事项'; }
      else {
        candidate.status = candidate.operation === 'cancel' ? 'cancelled' : 'synced';
        candidate.reason = candidate.operation === 'cancel' ? '日程已撤销' : '已同步到日历';
        candidate.external = publicExternal(result, candidate.external);
        candidate.recovering = false;
        for (const related of this.state.candidates) {
          if (related.id === candidate.id || related.action.actionId !== candidate.action.actionId || related.status !== 'synced') continue;
          related.external = structuredClone(candidate.external);
          if (candidate.operation === 'cancel') { related.status = 'cancelled'; related.reason = '关联日程已撤销'; }
        }
      }
    } catch (error) {
      const conflict = /CONFLICT/.test(error?.code || '') || /conflict|ownership|baseline|etag|modified|412/i.test(String(error?.message || ''));
      candidate.status = conflict ? 'conflict' : 'failed';
      // A transport failure can arrive after the remote side committed the write.
      // Keep the unknown-result marker for an explicit retry, including after expiry.
      if (!conflict) candidate.recovering = true;
      candidate.reason = conflict ? '外部日程版本或归属冲突，未覆盖或删除，请人工检查' : '日历写入失败，可手动重试';
      candidate.errors.push({ at: this._now(), code: conflict ? 'CALENDAR_CONFLICT' : 'CALENDAR_WRITE_FAILED', message: candidate.reason });
    }
    candidate.updatedAt = this._now();
    await this._save();
  }

  _invalidContext(candidate) {
    const frozen = candidate.subscriptionSnapshot;
    const current = this._subscriptions().find(sub => sub.id === candidate.subscriptionId);
    if (!frozen || !current?.enabled || JSON.stringify(freezeSubscription(current)) !== JSON.stringify(frozen)) return '订阅已停用、删除或配置变化，停止写入';
    for (const context of candidate.contexts || []) {
      if (context.messages?.some(message => this.subscriptionStore?.isSourceRecalled?.(context.sourceGroupId, message.messageId))) return '来源消息已撤回，停止写入';
      if ((context.intakeMode === 'RESPONSIBLE_ONLY' && this.subscriptionStore?.isNoticeContextCurrent?.(context) !== true)
        || (context.historyRecovery && this.subscriptionStore?.isHistoryContextCurrent?.(context) !== true)) return '来源角色或历史导入配置已变化，停止写入';
    }
    return null;
  }

  async _rejectUnknown(candidate) {
    candidate.status = 'writing'; candidate.updatedAt = this._now();
    await this._save();
    try {
      const existing = await this.automationClient.read(candidate.action.actionId);
      if (!existing.exists) {
        candidate.status = 'rejected'; candidate.reason = '已拒绝，确认外部日历中不存在该事项';
        candidate.recovering = false; delete candidate.rejectUnknown;
        await this._save(); return false;
      }
      if (!existing.owned) { const error = new Error('Calendar ownership conflict'); error.code = 'CALDAV_CONFLICT'; throw error; }
      // Do not trust a fresh read as a write baseline: only identical payloads
      // may reconcile here, and existingOnly prevents a new event being created.
      const result = await this.automationClient.execute(candidate.action, {
        protectExisting: true, existingOnly: true, sourceGroupId: candidate.sourceGroupId, sourceGroupName: candidate.sourceGroupName
      });
      if (!result?.etag || !result?.contentHash || result.skipped) { const error = new Error('Calendar baseline conflict'); error.code = 'CALDAV_CONFLICT'; throw error; }
      candidate.external = publicExternal(result, null);
      candidate.operation = 'cancel'; candidate.relatedCandidateId = candidate.id;
      candidate.ownerCancellation = true; candidate.status = 'approved';
      candidate.reason = '已核对上次写入，等待条件撤销';
      delete candidate.rejectUnknown;
      await this._save(); return true;
    } catch (error) {
      const conflict = /CONFLICT/.test(error?.code || '');
      candidate.status = conflict ? 'conflict' : 'failed';
      candidate.reason = conflict ? '未知写入与外部日程归属或内容冲突，未删除，请人工检查' : '无法核对未知写入结果，尚未完成撤销，可手动重试';
      candidate.errors.push({ at: this._now(), code: conflict ? 'CALENDAR_CONFLICT' : 'CALENDAR_READ_FAILED', message: candidate.reason });
      await this._save(); return false;
    }
  }

  _manualReason(candidate, policy) {
    if (!candidate.writable) return '时间或来源证据未明确，请查看原消息，暂不写入';
    if (candidate.operation !== 'create') return '更正或取消需要人工确认';
    if (/自愿|自选|选修|有兴趣|感兴趣|如有需要|如需|若需|若有|如果|符合条件|满足条件|愿意|可自行|可报名|可以报名|视情况|if\b|optional\b|voluntar/i.test([candidate.action.title, candidate.action.sourceItemQuote, candidate.action.notes].join(' '))) return '自愿或条件性事项需要人工确认';
    if (!policy.categories.includes(candidate.category)) return '该事项类别未启用自动写入，需要人工确认';
    if (policy.timeoutPolicy !== 'auto') return '当前订阅超时策略为人工确认';
    if (['course', 'class'].includes(policy.groupType) && !['exam', 'deadline', 'class'].includes(candidate.category)) return '非学业事项需要人工确认';
    return null;
  }

  _notice(candidate) {
    const policy = this._policy(candidate);
    const reason = this._manualReason(candidate, policy);
    return `日程候选 ${candidate.id}：${String(candidate.action.title).replace(/[\r\n]/g, ' ')}（${reason || `QQ通知成功后${policy.confirmationMinutes}分钟内可确认，超时自动写入`}）。回复“是 ${candidate.id}”或“否 ${candidate.id}”。`;
  }

  _candidate(id, scope = {}) {
    const candidate = this.state.candidates.find(item => item.id === String(id));
    if (!candidate || (scope.targetType != null && scope.targetType !== candidate.targetType) || (scope.targetId != null && String(scope.targetId) !== candidate.targetId)) throw new Error('Calendar candidate does not exist in this conversation');
    return candidate;
  }

  _public(candidate) { const { contexts, subscriptionSnapshot, ...item } = candidate; return structuredClone(item); }
  _policy(candidate) { return { ...(candidate.policySnapshot || defaults()), enabled: this.getSettings(candidate.subscriptionId).enabled }; }
  _subscriptions() { return this.subscriptionStore?.listSubscriptions?.() || []; }
  _now() { return this.clock().toISOString(); }
  _run(operation) { const next = this.chain.then(operation); this.chain = next.catch(() => {}); return next; }
  async _save() {
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, JSON.stringify(this.state, null, 2), 'utf8');
    await rename(temporary, this.filePath);
  }
}

function freezeSubscription(sub) {
  return { id: sub.id, enabled: Boolean(sub.enabled), updatedAt: sub.updatedAt || null, targetType: sub.targetType, targetId: String(sub.targetId), sourceGroupId: String(sub.sourceGroupId), intakeMode: sub.intakeMode || 'ALL' };
}

function classify(action) {
  const text = [action.title, action.sourceItemQuote, action.notes].join(' ');
  if (/考试|测验|期中|期末|补考|考核|\bexam\b|\bquiz\b/i.test(text)) return 'exam';
  if (action.type === 'reminder' || /截止|作业|提交|交卷|缴费|报名截止|\bdeadline\b|\bdue\b/i.test(text)) return 'deadline';
  if (/上课|课程|调课|停课|补课|讲课|实验课|课表|教学|课堂|\bclass\b|\blecture\b/i.test(text)) return 'class';
  if (/活动|竞赛|讲座|比赛|运动会|社团|志愿|晚会|\bactivity\b|\bevent\b/i.test(text)) return 'activity';
  return 'other';
}

function itemKey(action, targetType, targetId) {
  const instant = value => value == null ? null : Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : String(value);
  return JSON.stringify([targetType, String(targetId), normalizeTitle(action), instant(action.start || action.due), instant(action.end), Boolean(action.allDay)]);
}

function validItemQuote(action, context) {
  const text = String(context?.messages?.find(message => String(message.messageId) === action.sourceMessageId)?.text || '');
  const quote = action.sourceItemQuote;
  if (typeof quote !== 'string' || !quote.trim()) return false;
  const at = text.indexOf(quote);
  return at >= 0 && text.indexOf(quote, at + 1) < 0;
}

function actionInstant(action) {
  const value = action.type === 'calendar' ? action.start : action.due;
  const instant = Date.parse(value);
  if (!action.allDay || !Number.isFinite(instant)) return instant;
  const day = new Date(instant + 8 * 3600000).toISOString().slice(0, 10);
  return Date.parse(`${day}T00:00:00+08:00`);
}

function publicExternal(result, previous) {
  if (!result || typeof result !== 'object') return previous || null;
  return { externalItemId: result.externalItemId || previous?.externalItemId || null, etag: result.etag || previous?.etag || null, contentHash: result.contentHash || previous?.contentHash || null };
}
