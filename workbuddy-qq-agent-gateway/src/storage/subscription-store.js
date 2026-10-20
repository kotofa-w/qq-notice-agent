import { createHash, randomUUID } from "node:crypto";
import { recentNotificationReceipts } from "../security/subscription-input.js";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { rateLimitResumeAt } from "./session-store.js";
import { dirname } from "node:path";
import { normalizeNoticeRoles, publicNoticeRoles, recordNoticeDecision, setNoticeRole, validId } from "./notice-roles.js";

export const SUBSCRIPTION_MODE = Object.freeze({ AUTO: "AUTO" });
export const SUBSCRIPTION_INTAKE = Object.freeze({ ALL: "ALL", ADMIN_ONLY: "ADMIN_ONLY", RESPONSIBLE_ONLY: "RESPONSIBLE_ONLY" });

export class SubscriptionStore {
  constructor({ filePath, clock = () => new Date(), accountId = "" } = {}) {
    this.filePath = filePath;
    this.clock = clock;
    this.accountId = String(accountId);
    this.state = createState();
    this.saveChain = Promise.resolve();
    this.transientRetryAt = new Map();
    this.nextLedgerPruneAt = new Map();
  }

  async init() {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      this.state = normalizeState(JSON.parse(await readFile(this.filePath, "utf8")), this.clock());
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    for (const subscription of Object.values(this.state.subscriptions)) {
      subscription.state.processingUntilSequence = null;
      subscription.state.processingUntilMessageId = null;
      if (isTransientTurnCollision(subscription.state.lastError)) subscription.state.lastError = null;
      for (const collection of subscription.state.collections) {
        if (collection.status === "processing") collection.status = "collecting";
      }
    }
    for (const sourceId of Object.keys(this.state.sources)) {
      const source = this.ensureSource(sourceId);
      for (const message of [...source.messages, ...source.recentMessages]) {
        if (this.messageReceipt(source, message, false, false)) continue;
        const receipt = this.messageReceipt(source, message, true);
        for (const sub of Object.values(this.state.subscriptions).filter(s => s.sourceGroupId === sourceId)) {
          if (sub.state.pendingSequences.includes(message.sequence)) receipt.targets[sub.id] ||= 'queued';
          else if (Date.parse(message.timestamp) >= Date.parse(sub.createdAt) && Number(message.sequence) <= sub.state.lastConsumedSequence) receipt.targets[sub.id] ||= 'completed';
        }
      }
      this.garbageCollectSource(sourceId);
    }
    await this.save();
  }

  snapshot() {
    return structuredClone(this.state);
  }

  listSubscriptions({ targetType = null, targetId = null, sourceGroupId = null, enabled = null } = {}) {
    return Object.values(this.state.subscriptions)
      .filter((item) => targetType == null || item.targetType === targetType)
      .filter((item) => targetId == null || item.targetId === String(targetId))
      .filter((item) => sourceGroupId == null || item.sourceGroupId === String(sourceGroupId))
      .filter((item) => enabled == null || item.enabled === Boolean(enabled))
      .map((item) => this.publicSubscription(item));
  }

  sourceGroupIds() {
    return [...new Set(Object.values(this.state.subscriptions).filter((item) => item.enabled).map((item) => item.sourceGroupId))];
  }

  privateTargetIds() {
    return [...new Set(Object.values(this.state.subscriptions).filter((item) => item.enabled && item.targetType === "private").map((item) => item.targetId))];
  }

  referencedImages() {
    return Object.values(this.state.sources).flatMap((source) => source.messages.flatMap((message) => message.images || []));
  }

  isSourceRecalled(groupId, messageId) {
    return this.ensureSource(groupId).recalledMessageIds.includes(String(messageId));
  }

  noticeRolesForSource(groupId) {
    return publicNoticeRoles(this.ensureSource(groupId).noticeRoles, this.clock());
  }

  async setNoticeRole(input) {
    const sourceGroupId = String(input.sourceGroupId || "");
    if (!validId(sourceGroupId) || !this.sourceGroupIds().includes(sourceGroupId)) throw new Error("Notice source must be an enabled subscription source");
    const result = setNoticeRole(this.ensureSource(sourceGroupId).noticeRoles, input, this.clock());
    await this.save();
    return result;
  }

  async resolveNoticeReview({ sourceGroupId, sourceMessageId }) {
    const groupId = String(sourceGroupId || "");
    if (!validId(groupId) || !this.sourceGroupIds().includes(groupId)) throw new Error("Notice source must be an enabled subscription source");
    const roles = this.ensureSource(groupId).noticeRoles;
    const review = roles.records.find((record) => record.sourceMessageId === String(sourceMessageId) && record.classification === "uncertain");
    if (!review) throw new Error("Notice review does not exist");
    review.reviewedAt ||= this.clock().toISOString();
    await this.save();
    return structuredClone(review);
  }

  isNoticeContextCurrent(context) {
    if (context.intakeMode !== SUBSCRIPTION_INTAKE.RESPONSIBLE_ONLY) return true;
    const subscription = this.state.subscriptions[context.subscriptionId];
    return Boolean(subscription?.enabled && subscription.intakeMode === SUBSCRIPTION_INTAKE.RESPONSIBLE_ONLY &&
      subscription.targetType === context.targetType && subscription.targetId === String(context.targetId) &&
      subscription.sourceGroupId === String(context.sourceGroupId) &&
      this.ensureSource(context.sourceGroupId).noticeRoles.revision === context.noticeRoleRevision);
  }

  isHistoryContextCurrent(context) {
    if (!context.historyRecovery) return true;
    const sub = this.state.subscriptions[context.subscriptionId];
    return Boolean(sub?.enabled && sub.targetType === context.targetType && sub.targetId === String(context.targetId)
      && sub.sourceGroupId === String(context.sourceGroupId) && sub.intakeMode === context.intakeMode
      && sub.updatedAt === context.historyRecovery.subscriptionUpdatedAt);
  }

  async recordNoticeDecisions(contexts = [], decisions = []) {
    const changed = new Set();
    for (const decision of decisions) {
      const groupId = String(decision.sourceGroupId);
      const context = contexts.find((item) => String(item.sourceGroupId) === groupId &&
        item.messages?.some((message) => !message.contextOnly && String(message.messageId) === String(decision.sourceMessageId)));
      if (!context) throw new Error("Notice decision does not reference this source collection");
      const source = this.ensureSource(groupId);
      if (source.recalledMessageIds.includes(String(decision.sourceMessageId))) continue;
      const message = context.messages.find((item) => String(item.messageId) === String(decision.sourceMessageId));
      recordNoticeDecision(source.noticeRoles, decision, message, this.clock());
      changed.add(groupId);
    }
    if (changed.size) await this.save();
    return [...changed].map((groupId) => ({ sourceGroupId: groupId, ...this.noticeRolesForSource(groupId) }));
  }

  async recallSourceMessage(groupId, messageId) {
    const source = this.ensureSource(groupId);
    const id = String(messageId);
    if (!id || source.recalledMessageIds.includes(id)) return { removedMessages: [], removedImages: [], activeTargets: [] };
    for (const [key, receipt] of Object.entries(source.messageLedger)) if (key.endsWith(`:${id}`)) receipt.recalled = true;
    source.recalledMessageIds = [...source.recalledMessageIds, id].slice(-512);
    source.noticeRoles.records = source.noticeRoles.records.filter((record) => record.sourceMessageId !== id);
    const removedMessages = [...source.messages, ...source.recentMessages].filter((message) => String(message.messageId) === id);
    const recalledSequences = new Set(removedMessages
      .map((message) => Number(message.sequence)));
    source.messages = source.messages.filter((message) => String(message.messageId) !== id);
    source.recentMessages = source.recentMessages.filter((message) => String(message.messageId) !== id);
    const removedImages = [];
    const redactedSequences = new Set();
    for (const message of [...source.messages, ...source.recentMessages]) {
      if (String(message.replyToMessageId || "") !== id && String(message.quotedMessage?.messageId || "") !== id) continue;
      message.quotedMessage = null;
      message.quoteError = "被引用消息已撤回";
      removedImages.push(...(message.images || []).filter((image) => image.context === "quoted"));
      message.images = (message.images || []).filter((image) => image.context !== "quoted");
      redactedSequences.add(Number(message.sequence));
    }
    const affectedSequences = new Set([...recalledSequences, ...redactedSequences]);
    const activeTargets = new Set();
    for (const subscription of Object.values(this.state.subscriptions)) {
      if (subscription.sourceGroupId !== String(groupId)) continue;
      const relevant = subscription.state.pendingSequences.some((sequence) => affectedSequences.has(Number(sequence)))
        || Object.values(subscription.state.contextByTrigger).some((sequences) => sequences.some((sequence) => affectedSequences.has(Number(sequence))));
      if (relevant && subscription.state.processingUntilSequence != null) activeTargets.add(targetKey(subscription.targetType, subscription.targetId));
      subscription.state.pendingSequences = subscription.state.pendingSequences.filter((sequence) => !recalledSequences.has(Number(sequence)));
      for (const [trigger, context] of Object.entries(subscription.state.contextByTrigger)) {
        if (recalledSequences.has(Number(trigger))) delete subscription.state.contextByTrigger[trigger];
        else subscription.state.contextByTrigger[trigger] = context.filter((sequence) => !recalledSequences.has(Number(sequence)));
      }
    }
    removedMessages.push(...this.garbageCollectSource(groupId));
    await this.save();
    return { removedMessages, removedImages, activeTargets: [...activeTargets] };
  }

  async upsertSubscription(input) {
    if (input.mode != null && input.mode !== SUBSCRIPTION_MODE.AUTO) {
      throw new Error("通知订阅仅支持自动处理，静默模式已移除");
    }
    const normalized = normalizeSubscription(input);
    const existing = normalized.id ? this.state.subscriptions[normalized.id] : null;
    if (normalized.id && !existing) throw new Error("Subscription does not exist");
    if (existing?.state.processingUntilSequence != null) throw new Error("Subscription is currently processing and cannot be edited");
    const duplicate = Object.values(this.state.subscriptions).find((item) =>
      item.id !== normalized.id && item.targetType === normalized.targetType && item.targetId === normalized.targetId && item.sourceGroupId === normalized.sourceGroupId
    );
    if (duplicate) throw new Error("This conversation already subscribes to that source group");

    const previousSourceGroupId = existing?.sourceGroupId || null;
    const settingsChanged = !existing || Object.entries(normalized).some(([key, value]) => key !== 'id' && existing[key] !== value);
    if (existing && settingsChanged) {
      const previousSource = this.ensureSource(existing.sourceGroupId);
      for (const collection of existing.state.collections.filter(c => c.historyRecovery && !['completed', 'cancelled'].includes(c.status))) {
        const sequences = new Set(collection.sequences || []);
        existing.state.pendingSequences = existing.state.pendingSequences.filter(sequence => !sequences.has(sequence));
        for (const message of previousSource.messages.filter(m => sequences.has(m.sequence))) {
          this.messageReceipt(previousSource, message, true).targets[existing.id] = 'requires-confirmation';
          delete existing.state.contextByTrigger[String(message.sequence)];
        }
        collection.status = 'cancelled';
        const scan = this.state.historyScans[collection.historyRecovery.batchId];
        if (scan) scan.deliveryStatus = 'needs-confirmation';
      }
      trimCompletedCollections(existing);
    }
    const source = this.ensureSource(normalized.sourceGroupId);
    const latestSequence = maxSourceSequence(source);
    const subscription = existing || {
      id: normalized.id || randomUUID(),
      createdAt: this.clock().toISOString(),
      state: createSubscriptionState(latestSequence)
    };
    const wasEnabled = subscription.enabled !== false;
    const previousIntakeMode = subscription.intakeMode || normalized.intakeMode;
    Object.assign(subscription, normalized, { id: subscription.id, updatedAt: settingsChanged ? this.clock().toISOString() : subscription.updatedAt });
    if (previousSourceGroupId && previousSourceGroupId !== normalized.sourceGroupId) resetSubscriptionAt(subscription, latestSequence);
    if (wasEnabled && !subscription.enabled) resetSubscriptionAt(subscription, latestSequence);
    if (!wasEnabled && subscription.enabled) resetSubscriptionAt(subscription, latestSequence);
    if (previousIntakeMode !== normalized.intakeMode && normalized.intakeMode === SUBSCRIPTION_INTAKE.ADMIN_ONLY) {
      const accepted = new Set(source.messages.filter((message) => acceptsMessage(subscription, message)).map((message) => message.sequence));
      subscription.state.pendingSequences = subscription.state.pendingSequences.filter((sequence) => accepted.has(sequence));
    }
    if (!usesAdminContext(subscription)) subscription.state.contextByTrigger = {};
    this.state.subscriptions[subscription.id] = subscription;
    if (subscription.enabled && subscription.intakeMode === SUBSCRIPTION_INTAKE.RESPONSIBLE_ONLY) source.noticeRoles.observationStartedAt ||= this.clock().toISOString();
    if (usesAdminContext(subscription)) rebuildMissingContexts(subscription, source);
    const removedMessages = [
      ...this.garbageCollectSource(normalized.sourceGroupId),
      ...(previousSourceGroupId && previousSourceGroupId !== normalized.sourceGroupId ? this.garbageCollectSource(previousSourceGroupId) : [])
    ];
    await this.save();
    return { subscription: this.publicSubscription(subscription), removedMessages };
  }

  async deleteSubscription(id) {
    const subscription = this.state.subscriptions[String(id)];
    if (!subscription) return { deleted: false, removedMessages: [] };
    if (subscription.state.processingUntilSequence != null) throw new Error("Subscription is currently processing and cannot be deleted");
    delete this.state.subscriptions[subscription.id];
    const removedMessages = this.garbageCollectSource(subscription.sourceGroupId);
    await this.save();
    return { deleted: true, removedMessages };
  }

  // Called only after the target is blocked and has no active worker. An
  // archived failed-delivery claim may also be discarded by this explicit removal.
  async removeTarget(targetType, targetId) {
    const subscriptions = Object.values(this.state.subscriptions)
      .filter((item) => item.targetType === targetType && item.targetId === String(targetId));
    for (const item of subscriptions) delete this.state.subscriptions[item.id];
    const removedMessages = [...new Set(subscriptions.map((item) => item.sourceGroupId))]
      .flatMap((id) => this.garbageCollectSource(id));
    if (subscriptions.length) await this.save();
    return { count: subscriptions.length, removedMessages };
  }

  async setSourceMetadata(groupId, metadata = {}) {
    const source = this.ensureSource(groupId);
    source.groupName = String(metadata.groupName || "").trim() || source.groupName;
    await this.save();
  }

  async appendSourceMessage(message) {
    const source = this.ensureSource(message.groupId);
    if (source.recalledMessageIds.includes(String(message.messageId))) {
      return { duplicate: true, recalled: true, message: null, affectedTargets: [], removedMessages: [] };
    }
    const priorReceipt = this.messageReceipt(source, message, false, false);
    if (priorReceipt?.recalled) { await this.save(); return { duplicate: true, recalled: true, message: null, affectedTargets: [], removedMessages: [] }; }
    const subscribers = Object.values(this.state.subscriptions).filter(s => s.enabled && s.sourceGroupId === source.groupId);
    if (priorReceipt) {
      for (const sub of subscribers) {
        if (Date.parse(sub.createdAt) > Date.parse(priorReceipt.retainedAt)) priorReceipt.targets[sub.id] ||= 'ignored';
      }
    }
    if (priorReceipt ? subscribers.every(sub => priorReceipt.targets[sub.id]) : [...source.messages, ...source.recentMessages].some((item) => item.messageId === String(message.messageId) && String(item.accountId || this.accountId) === String(message.accountId || this.accountId))) {
      // A previous append may have changed memory before its write failed.
      // Confirm durability before acknowledging that redelivery as a duplicate.
      await this.save();
      return { duplicate: true, message: null, affectedTargets: [], removedMessages: [] };
    }
    const stored = { ...structuredClone(message), sequence: this.state.nextSequence++ };
    stored.accountId ||= this.accountId;
    const receipt = priorReceipt || this.messageReceipt(source, stored, true);
    delete stored.imageRefs;
    delete stored.attachmentRefs;
    const recentBefore = source.recentMessages.slice(-10);
    source.messages.push(stored);
    source.lastActivityAt = stored.timestamp || this.clock().toISOString();
    const now = this.clock();
    const affectedTargets = new Set();

    for (const subscription of Object.values(this.state.subscriptions)) {
      if (!subscription.enabled || subscription.sourceGroupId !== source.groupId) continue;
      if (receipt.targets[subscription.id]) continue;
      subscription.state.lastSeenSequence = stored.sequence;
      const openAutoAdminCollection = isOpenAutoAdminCollection(subscription, now);
      const accepted = acceptsMessage(subscription, stored) || openAutoAdminCollection;
      receipt.targets[subscription.id] = accepted ? 'queued' : 'ignored';
      if (!accepted) continue;
      subscription.state.pendingSequences.push(stored.sequence);
      affectedTargets.add(targetKey(subscription.targetType, subscription.targetId));
      if (subscription.mode === SUBSCRIPTION_MODE.AUTO) appendToDebouncedCollection(subscription, stored.sequence, now);
      if (usesAdminContext(subscription) && isAdminMessage(stored) && !openAutoAdminCollection) {
        subscription.state.contextByTrigger[String(stored.sequence)] = recentBefore.map((item) => Number(item.sequence));
        for (const recent of recentBefore) ensureActiveMessage(source, recent);
      }
    }
    source.recentMessages = this.sourceNeedsRecentContext(source.groupId)
      ? [...recentBefore, toRecentMessage(stored)].slice(-10)
      : [];
    source.messages.sort((a, b) => Number(a.sequence) - Number(b.sequence));
    const removedMessages = this.garbageCollectSource(source.groupId);
    await this.save();
    return { duplicate: false, message: structuredClone(stored), affectedTargets: [...affectedTargets], removedMessages };
  }

  messageReceipt(source, message, create = false, strict = true) {
    const key = `${message.accountId || this.accountId}:${message.messageId}`;
    const signature = createHash('sha256').update(JSON.stringify([String(message.senderId), message.timestamp, message.text || ''])).digest('hex');
    let receipt = source.messageLedger[key];
    if (strict && receipt && (receipt.signature !== signature || (receipt.realSeq && message.realSeq && receipt.realSeq !== String(message.realSeq)))) {
      throw new Error('历史消息身份冲突，请人工核对原消息');
    }
    if (!receipt && create) {
      receipt = source.messageLedger[key] = { signature, realSeq: message.realSeq ? String(message.realSeq) : null,
        retainedAt: this.clock().toISOString(), targets: {} };
    }
    return receipt || null;
  }

  historyMessageStatus(subscriptionId, message) {
    const subscription = this.state.subscriptions[String(subscriptionId)];
    if (!subscription || !subscription.enabled || subscription.sourceGroupId !== String(message.groupId)) throw new Error('通知订阅已停用或不存在');
    const source = this.ensureSource(message.groupId);
    if (source.recalledMessageIds.includes(String(message.messageId))) return { duplicate: true, reason: '消息已撤回' };
    const receipt = this.messageReceipt(source, message);
    if (receipt?.recalled) return { duplicate: true, reason: '消息已撤回' };
    const received = receipt?.targets[subscription.id] && receipt.targets[subscription.id] !== 'requires-confirmation';
    return { duplicate: Boolean(received), reason: received ? '已接收、处理或按订阅规则忽略' : null };
  }

  getHistoryScan(id) {
    const scan = this.state.historyScans[String(id)];
    return scan ? structuredClone(scan) : null;
  }

  getConnectionRecovery(accountId) {
    return structuredClone(this.state.connectionRecovery[String(accountId)] || null);
  }

  async saveConnectionRecovery(accountId, value) {
    this.state.connectionRecovery[String(accountId)] = structuredClone(value);
    await this.save();
  }

  async saveHistoryScan(scan) {
    // Keep a bounded number of previews; pending confirmations remain restartable.
    const cutoff = this.clock().getTime() - 8 * 86400000;
    for (const [id, item] of Object.entries(this.state.historyScans)) {
      if (Date.parse(item.createdAt) < cutoff && item.status !== 'confirming') delete this.state.historyScans[id];
    }
    if (!this.state.historyScans[scan.id] && Object.keys(this.state.historyScans).length >= 30) throw new Error('补漏预览已达30批，请等待旧批次过期');
    const previous = this.state.historyScans[scan.id];
    this.state.historyScans[scan.id] = structuredClone({ ...scan,
      ...(previous?.deliveryStatus ? { deliveryStatus: previous.deliveryStatus } : {}),
      ...(previous?.queuedMessageIds ? { queuedMessageIds: previous.queuedMessageIds } : {}) });
    await this.save();
  }

  async enqueueHistoryBatch({ subscriptionId, batchId, messages, allowFutureActions = false }) {
    const subscription = this.state.subscriptions[String(subscriptionId)];
    if (!subscription?.enabled) throw new Error('通知订阅已停用或不存在');
    if (subscription.state.processingUntilSequence != null) throw new Error('该订阅正在处理，请稍后确认补漏');
    const source = this.ensureSource(subscription.sourceGroupId);
    // Validate the whole batch before mutating, including identity conflicts.
    const unique = [...new Map(messages.map(m => [String(m.messageId), m])).values()]
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || String(a.realSeq || '').localeCompare(String(b.realSeq || ''), 'en', { numeric: true }));
    for (const message of unique) {
      if (String(message.accountId || this.accountId) !== this.accountId || !Number.isFinite(Date.parse(message.timestamp))) throw new Error('历史账号或原时间无效');
      this.historyMessageStatus(subscription.id, message);
    }
    const existingBatch = subscription.state.collections.find(c => c.historyRecovery?.batchId === batchId);
    const savedScan = this.state.historyScans[batchId];
    if (existingBatch || savedScan?.queuedMessageIds) { await this.save(); return { queued: 0, alreadyQueued: true }; }
    const sequences = [];
    const queuedMessageIds = [];
    for (const message of unique) {
      if (this.historyMessageStatus(subscription.id, message).duplicate) continue;
      const receipt = this.messageReceipt(source, message, true);
      // Historical administrator roles are not verified at send time. Manual
      // selection still uses the subscription's sender filter.
      if (!acceptsMessage(subscription, message)) { receipt.targets[subscription.id] = 'ignored'; continue; }
      const stored = { ...structuredClone(message), accountId: this.accountId, sequence: this.state.nextSequence++ };
      delete stored.imageRefs; delete stored.attachmentRefs;
      source.messages.push(stored);
      receipt.targets[subscription.id] = 'queued';
      receipt.retainedAt = this.clock().toISOString();
      if (!subscription.state.pendingSequences.includes(stored.sequence)) subscription.state.pendingSequences.push(stored.sequence);
      sequences.push(stored.sequence);
      queuedMessageIds.push(stored.messageId);
    }
    if (sequences.length) {
      subscription.state.pendingSequences.sort((a, b) => a - b);
      subscription.state.collections.push({ id: randomUUID(), fromSequence: Math.min(...sequences), cutoffSequence: Math.max(...sequences),
        sequences, status: 'collecting', startedAt: this.clock().toISOString(), deadline: this.clock().toISOString(), completedAt: null,
        historyRecovery: { batchId, allowFutureActions: allowFutureActions === true, subscriptionUpdatedAt: subscription.updatedAt } });
    }
    if (savedScan) {
      savedScan.queuedMessageIds = queuedMessageIds;
      savedScan.deliveryStatus = sequences.length ? 'pending' : 'nothing-to-queue';
    }
    await this.save();
    return { queued: sequences.length };
  }

  dueAutoTargets(now = this.clock()) {
    const timestamp = now.getTime();
    return [...new Set(Object.values(this.state.subscriptions)
      .filter((item) => item.enabled && item.mode === SUBSCRIPTION_MODE.AUTO && !item.state.lastError)
      .filter((item) => item.state.collections.some((collection) => collection.status === "collecting" && new Date(collection.deadline).getTime() <= timestamp))
      .filter((item) => (this.transientRetryAt.get(targetKey(item.targetType, item.targetId)) || 0) <= timestamp)
      .map((item) => targetKey(item.targetType, item.targetId)))];
  }

  async claimForTarget(targetType, targetId, { mode = SUBSCRIPTION_MODE.AUTO } = {}) {
    if (mode !== SUBSCRIPTION_MODE.AUTO) return [];
    const contexts = [];
    const now = this.clock().getTime();
    let changed = false;
    const subscriptions = Object.values(this.state.subscriptions)
      .filter((item) => item.enabled && item.targetType === targetType && item.targetId === String(targetId))
      .filter((item) => !mode || item.mode === mode);
    if (mode === SUBSCRIPTION_MODE.AUTO) subscriptions.sort((left, right) => {
      const dueAt = (item) => Math.min(...item.state.collections
        .filter((collection) => collection.status === "collecting" && new Date(collection.deadline).getTime() <= now)
        .map((collection) => new Date(collection.deadline).getTime()), Infinity);
      return dueAt(left) - dueAt(right) || String(left.createdAt || "").localeCompare(String(right.createdAt || "")) || left.id.localeCompare(right.id);
    });
    for (const subscription of subscriptions) {
      if (!subscription.enabled || subscription.targetType !== targetType || subscription.targetId !== String(targetId)) continue;
      if (mode && subscription.mode !== mode) continue;
      let sequences = [];
      let collectionId = null;
      let collectionIds = [];
      {
        const due = subscription.state.collections.filter((item) =>
          item.status === "collecting" && new Date(item.deadline).getTime() <= now
        );
        const first = due[0];
        const collections = due.filter(item => first && (first.historyRecovery
          ? item.historyRecovery?.batchId === first.historyRecovery.batchId : !item.historyRecovery));
        if (!collections.length) continue;
        for (const collection of collections) collection.status = "processing";
        for (const collection of collections) {
          const scan = this.state.historyScans[collection.historyRecovery?.batchId];
          if (scan) scan.deliveryStatus = 'pending';
        }
        changed = true;
        collectionIds = collections.map((collection) => collection.id);
        collectionId = collectionIds[0];
        sequences = subscription.state.pendingSequences.filter((sequence) =>
          collections.some((collection) => collection.sequences ? collection.sequences.includes(sequence) : sequence >= collection.fromSequence && sequence <= collection.cutoffSequence
            && !subscription.state.collections.some(other => other.historyRecovery && other.sequences?.includes(sequence)))
        );
      }
      if (!sequences.length) {
        if (collectionId) {
          for (const collection of subscription.state.collections.filter((item) => collectionIds.includes(item.id))) {
            collection.status = "completed";
            collection.completedAt = this.clock().toISOString();
          }
          trimCompletedCollections(subscription);
        }
        subscription.state.processingUntilSequence = null;
        subscription.state.processingUntilMessageId = null;
        continue;
      }
      const cutoffSequence = sequences.at(-1);
      subscription.state.processingUntilSequence = cutoffSequence;
      const source = this.ensureSource(subscription.sourceGroupId);
      const messages = claimMessages(source, sequences, subscription);
      subscription.state.processingUntilMessageId = lastMessageId(messages);
      contexts.push({
        subscriptionId: subscription.id,
        targetType,
        targetId: String(targetId),
        sourceGroupId: subscription.sourceGroupId,
        sourceGroupName: source.groupName,
        mode: subscription.mode,
        intakeMode: subscription.intakeMode,
        responsibleSenderIds: source.noticeRoles.members.filter((member) => member.status === "confirmed").map((member) => member.senderId),
        noticeRoleRevision: source.noticeRoles.revision,
        collectionId,
        collectionIds,
        ...(subscription.state.collections.find(c => c.id === collectionId)?.historyRecovery
          ? { historyRecovery: structuredClone(subscription.state.collections.find(c => c.id === collectionId).historyRecovery) } : {}),
        cutoffSequence,
        messages,
        notifiedFingerprints: recentNotificationReceipts(subscription.state.notifiedFingerprints, now)
      });
      // One AUTO turn is one source group. Other due sources remain collecting.
      if (mode === SUBSCRIPTION_MODE.AUTO) break;
    }
    if (contexts.length || changed) await this.save();
    return contexts;
  }

  async releaseClaims(contexts = []) {
    for (const context of contexts) {
      const subscription = this.state.subscriptions[context.subscriptionId];
      if (!subscription) continue;
      subscription.state.processingUntilSequence = null;
      subscription.state.processingUntilMessageId = null;
      for (const collection of subscription.state.collections.filter((item) => claimCollectionIds(context).includes(item.id))) {
        if (collection.status === "processing") collection.status = "collecting";
      }
    }
    if (contexts.length) await this.save();
  }

  async completeClaims(contexts = []) {
    const sourceIds = new Set();
    for (const context of contexts) {
      const subscription = this.state.subscriptions[context.subscriptionId];
      if (!subscription) continue;
      const cutoff = Number(context.cutoffSequence || 0);
      const explicit = context.messages?.filter(m => !m.contextOnly).map(m => Number(m.sequence)).filter(Number.isFinite) || [];
      const consumed = new Set(explicit.length ? explicit : subscription.state.pendingSequences.filter(sequence => sequence <= cutoff));
      subscription.state.pendingSequences = subscription.state.pendingSequences.filter((sequence) => !consumed.has(sequence));
      for (const sequence of Object.keys(subscription.state.contextByTrigger)) {
        if (consumed.has(Number(sequence))) delete subscription.state.contextByTrigger[sequence];
      }
      const source = this.ensureSource(subscription.sourceGroupId);
      for (const message of source.messages.filter(m => consumed.has(Number(m.sequence)))) this.messageReceipt(source, message, true).targets[subscription.id] = 'completed';
      subscription.state.lastConsumedSequence = Math.max(subscription.state.lastConsumedSequence, cutoff);
      subscription.state.lastConsumedMessageId = lastMessageId(context.messages) || subscription.state.lastConsumedMessageId;
      subscription.state.lastCompletedAt = this.clock().toISOString();
      subscription.state.processingUntilSequence = null;
      subscription.state.processingUntilMessageId = null;
      subscription.state.lastError = null;
      const now = this.clock();
      subscription.state.notifiedFingerprints = recentNotificationReceipts([
        ...(subscription.state.notifiedFingerprints || []),
        ...(context.notificationFingerprints || []).map((fingerprint) => ({ fingerprint, notifiedAt: now.toISOString() }))
      ], now.getTime());
      for (const collection of subscription.state.collections.filter((item) => claimCollectionIds(context).includes(item.id))) {
        collection.status = "completed";
        collection.completedAt = now.toISOString();
        const scan = this.state.historyScans[collection.historyRecovery?.batchId];
        if (scan) scan.deliveryStatus = 'completed';
      }
      trimCompletedCollections(subscription);
      sourceIds.add(subscription.sourceGroupId);
    }
    const removedMessages = [...sourceIds].flatMap((sourceId) => this.garbageCollectSource(sourceId));
    if (contexts.length) await this.save();
    return removedMessages;
  }

  async failClaims(contexts, error) {
    const transientCollision = isTransientTurnCollision(error?.message || error);
    for (const context of contexts || []) {
      const subscription = this.state.subscriptions[context.subscriptionId];
      if (!subscription) continue;
      subscription.state.lastError = transientCollision ? null : String(error?.message || error).slice(0, 2000);
      if (!transientCollision) for (const collection of subscription.state.collections.filter(c => claimCollectionIds(context).includes(c.id))) {
        const scan = this.state.historyScans[collection.historyRecovery?.batchId];
        if (scan) scan.deliveryStatus = 'failed';
      }
      if (transientCollision) {
        this.transientRetryAt.set(targetKey(subscription.targetType, subscription.targetId), this.clock().getTime() + 10_000);
      }
    }
    await this.releaseClaims(contexts);
  }

  async retryFailedForTarget(targetType, targetId) {
    let count = 0;
    for (const subscription of Object.values(this.state.subscriptions)) {
      if (!subscription.enabled || subscription.targetType !== targetType || subscription.targetId !== String(targetId)) continue;
      if (!subscription.state.lastError) continue;
      subscription.state.lastError = null;
      count += 1;
    }
    if (count) await this.save();
    return count;
  }

  async retryRateLimitedForTarget(targetType, targetId) {
    let count = 0;
    for (const subscription of Object.values(this.state.subscriptions)) {
      if (!subscription.enabled || subscription.targetType !== targetType || subscription.targetId !== String(targetId)) continue;
      if (!rateLimitResumeAt(subscription.state.lastError)) continue;
      subscription.state.lastError = null;
      count += 1;
    }
    if (count) await this.save();
    return count;
  }

  publicSources(metadata = {}, targetViews = {}, { dispatchEnabled = true } = {}) {
    return Object.fromEntries(this.sourceGroupIds().map((groupId) => {
      const source = this.ensureSource(groupId);
      const subscriptions = Object.values(this.state.subscriptions)
        .filter((item) => item.enabled && item.sourceGroupId === groupId);
      const referenceCounts = new Map();
      for (const subscription of subscriptions) {
        for (const sequence of neededSourceSequences(subscription)) {
          referenceCounts.set(sequence, (referenceCounts.get(sequence) || 0) + 1);
        }
      }
      const subscriberProgress = subscriptions.map((subscription) => subscriptionProgress(
        subscription, source, targetViews[targetKey(subscription.targetType, subscription.targetId)],
        { dispatchEnabled, now: this.clock().getTime() }
      ));
      const retainedSequences = new Set(source.messages.map((message) => Number(message.sequence)));
      const visibleBySequence = new Map(source.recentMessages.map((message) => [Number(message.sequence), message]));
      for (const message of source.messages) visibleBySequence.set(Number(message.sequence), message);
      const visibleMessages = [...visibleBySequence.values()]
        .sort((a, b) => Number(a.sequence) - Number(b.sequence))
        .slice(-100)
        .map((message) => ({
          ...structuredClone(message),
          retainedBySubscription: retainedSequences.has(Number(message.sequence)),
          pendingSubscriberCount: referenceCounts.get(Number(message.sequence)) || 0
        }));
      return [groupId, {
        groupId,
        groupName: metadata[groupId]?.groupName || source.groupName || null,
        lastActivityAt: source.lastActivityAt,
        noticeRoles: this.noticeRolesForSource(groupId),
        retainedMessages: source.messages.slice(-100),
        retainedCount: source.messages.length,
        recentCount: source.recentMessages.length,
        visibleMessages,
        visibleCount: visibleBySequence.size,
        subscriptionCount: subscriptions.length,
        subscriberProgress,
        pendingSubscriberCount: subscriberProgress.filter((item) => item.pendingCount > 0).length,
        failedSubscriberCount: subscriberProgress.filter((item) => item.status === "failed").length,
        neverReplies: true
      }];
    }));
  }

  publicSubscription(subscription) {
    const source = this.state.sources[subscription.sourceGroupId];
    const pendingSet = new Set(subscription.state.pendingSequences);
    return {
      id: subscription.id,
      targetType: subscription.targetType,
      targetId: subscription.targetId,
      sourceGroupId: subscription.sourceGroupId,
      sourceGroupName: source?.groupName || null,
      mode: subscription.mode,
      intakeMode: subscription.intakeMode,
      collectionDelayMinutes: subscription.collectionDelayMinutes,
      enabled: subscription.enabled,
      ...(subscription.migrationWarning ? { migrationWarning: subscription.migrationWarning } : {}),
      createdAt: subscription.createdAt,
      updatedAt: subscription.updatedAt,
      state: {
        pendingMessages: (source?.messages || []).filter((message) => pendingSet.has(message.sequence)),
        pendingCount: subscription.state.pendingSequences.length,
        collectionStartedAt: activeCollection(subscription)?.startedAt || null,
        collectionDeadline: activeCollection(subscription)?.deadline || null,
        processingUntilMessageId: subscription.state.processingUntilMessageId,
        lastConsumedMessageId: subscription.state.lastConsumedMessageId,
        lastCompletedAt: subscription.state.lastCompletedAt,
        lastError: subscription.state.lastError
      }
    };
  }

  ensureSource(groupId) {
    const id = String(groupId || "");
    if (!id) throw new Error("Source group id is required");
    this.state.sources[id] ||= { groupId: id, groupName: null, lastActivityAt: null, messages: [], recentMessages: [], recalledMessageIds: [] };
    this.state.sources[id].recentMessages ||= [];
    this.state.sources[id].recalledMessageIds ||= [];
    this.state.sources[id].noticeRoles ||= normalizeNoticeRoles(null, this.clock());
    this.state.sources[id].messageLedger ||= {};
    this.state.sources[id].ledgerStartedAt ||= this.clock().toISOString();
    if (this.clock().getTime() >= (this.nextLedgerPruneAt.get(id) || 0)) {
      const cutoff = this.clock().getTime() - 8 * 86400000;
      for (const [key, receipt] of Object.entries(this.state.sources[id].messageLedger)) {
        if (Date.parse(receipt.retainedAt) < cutoff && !Object.entries(receipt.targets).some(([subId, status]) => status === 'queued' && this.state.subscriptions[subId]?.enabled)) delete this.state.sources[id].messageLedger[key];
      }
      this.nextLedgerPruneAt.set(id, this.clock().getTime() + 60000);
    }
    return this.state.sources[id];
  }

  sourceNeedsRecentContext(groupId) {
    return Object.values(this.state.subscriptions).some((subscription) =>
      subscription.enabled && subscription.sourceGroupId === String(groupId) && usesAdminContext(subscription)
    );
  }

  garbageCollectSource(groupId) {
    const source = this.state.sources[String(groupId)];
    if (!source) return [];
    const subscriptions = Object.values(this.state.subscriptions).filter((item) => item.enabled && item.sourceGroupId === String(groupId));
    const neededSequences = new Set();
    for (const subscription of subscriptions) {
      const pending = new Set(subscription.state.pendingSequences.map(Number));
      for (const sequence of Object.keys(subscription.state.contextByTrigger)) {
        if (!pending.has(Number(sequence))) {
          delete subscription.state.contextByTrigger[sequence];
        }
      }
      for (const sequence of neededSourceSequences(subscription)) neededSequences.add(sequence);
    }
    const removed = source.messages.filter((message) => !neededSequences.has(Number(message.sequence)));
    source.messages = source.messages.filter((message) => neededSequences.has(Number(message.sequence)));
    if (!this.sourceNeedsRecentContext(groupId)) source.recentMessages = [];
    return removed;
  }

  async save() {
    this.state.updatedAt = this.clock().toISOString();
    const body = JSON.stringify(this.state, null, 2);
    const tempPath = `${this.filePath}.tmp-${process.pid}`;
    const operation = this.saveChain.then(async () => {
      await writeFile(tempPath, body, { mode: 0o600 });
      await rename(tempPath, this.filePath);
    });
    // Keep dirty memory for retry, reject this caller, and unblock later writes.
    this.saveChain = operation.then(() => {}, () => {});
    return operation.catch(error => { error.storageWriteFailed = true; throw error; });
  }
}

function neededSourceSequences(subscription) {
  const pending = new Set(subscription.state.pendingSequences.map(Number));
  const needed = new Set(pending);
  for (const sequence of pending) {
    for (const contextSequence of subscription.state.contextByTrigger[String(sequence)] || []) {
      needed.add(Number(contextSequence));
    }
  }
  return needed;
}

function subscriptionProgress(subscription, source, target, { dispatchEnabled, now }) {
  const pendingCount = subscription.state.pendingSequences.length;
  const delivery = (target?.failedDelivery?.subscriptionIds || [])
    .includes(subscription.id);
  const collectionDeadline = activeCollection(subscription)?.deadline || null;
  const hasCurrentReceipt = source.messages.some((message) =>
    Number(message.sequence) <= Number(subscription.state.lastConsumedSequence || 0)
  );
  let status = "idle";
  if (subscription.state.lastError || (delivery && !target?.activeReply?.running)) status = "failed";
  else if (delivery) status = "sending";
  else if (subscription.state.processingUntilSequence != null) status = "running";
  else if (pendingCount && (!dispatchEnabled || target?.replyEnabled === false)) status = "paused";
  else if (pendingCount && collectionDeadline && new Date(collectionDeadline).getTime() > now) status = "collecting";
  else if (pendingCount) status = "queued";
  else if (subscription.state.lastCompletedAt && (hasCurrentReceipt || source.messages.length === 0)) status = "complete";
  return {
    subscriptionId: subscription.id,
    targetType: subscription.targetType,
    targetId: subscription.targetId,
    targetName: target?.displayName || target?.groupName || null,
    mode: subscription.mode,
    status,
    pendingCount,
    collectionDeadline,
    lastCompletedAt: subscription.state.lastCompletedAt || null,
    lastError: subscription.state.lastError || (delivery && !target?.activeReply?.running ? target?.lastError || "QQ 发送尚未完成" : null)
  };
}

function createState() {
  return { version: 4, updatedAt: null, nextSequence: 1, sources: {}, subscriptions: {}, historyScans: {}, connectionRecovery: {} };
}

function createSubscriptionState(latestSequence = 0) {
  return {
    pendingSequences: [],
    collections: [],
    lastSeenSequence: Number(latestSequence || 0),
    lastConsumedSequence: Number(latestSequence || 0),
    lastConsumedMessageId: null,
    lastCompletedAt: null,
    processingUntilSequence: null,
    processingUntilMessageId: null,
    contextByTrigger: {},
    notifiedFingerprints: [],
    lastError: null
  };
}

function normalizeState(value, now) {
  const state = { ...createState(), ...value, sources: {}, subscriptions: {} };
  state.version = 4;
  const migrationHistory = {};
  for (const [groupId, raw] of Object.entries(value?.sources || {})) {
    const messages = Array.isArray(raw.messages) ? raw.messages : [];
    const history = Array.isArray(raw.history)
      ? raw.history
      : Array.isArray(raw.recentMessages) ? raw.recentMessages : messages;
    migrationHistory[groupId] = history.map(toRecentMessage);
    state.sources[groupId] = {
      groupId,
      groupName: raw.groupName || null,
      lastActivityAt: raw.lastActivityAt || null,
      messages,
      recentMessages: (Array.isArray(raw.recentMessages) ? raw.recentMessages : history).map(toRecentMessage).slice(-10),
      recalledMessageIds: Array.isArray(raw.recalledMessageIds) ? raw.recalledMessageIds.map(String).slice(-512) : [],
      noticeRoles: normalizeNoticeRoles(raw.noticeRoles, now),
      messageLedger: raw.messageLedger || {}, ledgerStartedAt: raw.ledgerStartedAt || now.toISOString()
    };
    for (const message of [...messages, ...history]) state.nextSequence = Math.max(state.nextSequence, Number(message.sequence || 0) + 1);
  }
  for (const [id, raw] of Object.entries(value?.subscriptions || {})) {
    const unknownIntake = raw.intakeMode != null && !Object.values(SUBSCRIPTION_INTAKE).includes(raw.intakeMode);
    const normalized = normalizeSubscription({ ...raw, id, ...(unknownIntake ? { intakeMode: SUBSCRIPTION_INTAKE.RESPONSIBLE_ONLY, enabled: false } : {}) });
    state.subscriptions[id] = {
      ...normalized,
      id,
      createdAt: raw.createdAt || null,
      updatedAt: raw.updatedAt || null,
      ...(unknownIntake ? { migrationWarning: `Unknown persisted intake mode ${String(raw.intakeMode).slice(0, 100)}; disabled for manual review` } : raw.migrationWarning ? { migrationWarning: raw.migrationWarning } : {}),
      state: {
        ...createSubscriptionState(),
        ...(raw.state || {}),
        pendingSequences: Array.isArray(raw.state?.pendingSequences) ? raw.state.pendingSequences.map(Number).filter(Number.isFinite).sort((a, b) => a - b) : [],
        collections: Array.isArray(raw.state?.collections) ? raw.state.collections : [],
        lastCompletedAt: raw.state?.lastCompletedAt || (raw.state?.collections || [])
          .filter((item) => item.status === "completed" && item.completedAt)
          .map((item) => item.completedAt).sort().at(-1) || null,
        contextByTrigger: normalizeContextMap(raw.state?.contextByTrigger)
      }
    };
    // Migrate legacy background subscriptions without resetting notices,
    // cursors, context, receipts, errors or enabled state. Start a normal wait.
    if (raw.mode === "SILENT") appendCollectionForPending(state.subscriptions[id], now);
  }
  for (const subscription of Object.values(state.subscriptions)) {
    if (!usesAdminContext(subscription)) {
      subscription.state.contextByTrigger = {};
      continue;
    }
    const source = state.sources[subscription.sourceGroupId];
    if (!source) continue;
    const history = migrationHistory[subscription.sourceGroupId] || [];
    for (const triggerSequence of subscription.state.pendingSequences) {
      const triggerMessage = history.find((message) => Number(message.sequence) === Number(triggerSequence));
      if (!isAdminMessage(triggerMessage)) continue;
      const key = String(triggerSequence);
      if (!subscription.state.contextByTrigger[key]) {
        subscription.state.contextByTrigger[key] = history
          .filter((message) => Number(message.sequence) < Number(triggerSequence))
          .slice(-10)
          .map((message) => Number(message.sequence));
      }
      for (const contextSequence of subscription.state.contextByTrigger[key]) {
        const message = history.find((candidate) => Number(candidate.sequence) === Number(contextSequence));
        if (message) ensureActiveMessage(source, message);
      }
    }
    source.messages.sort((a, b) => Number(a.sequence) - Number(b.sequence));
  }
  return state;
}

function normalizeSubscription(input) {
  if (input.intakeMode != null && !Object.values(SUBSCRIPTION_INTAKE).includes(input.intakeMode)) throw new Error("Subscription intake mode is invalid");
  const targetType = input.targetType === "private" ? "private" : "group";
  const targetId = String(input.targetId || "").trim();
  const sourceGroupId = String(input.sourceGroupId || "").trim();
  if (!/^\d{5,14}$/.test(targetId)) throw new Error("Target QQ id is invalid");
  if (!/^\d{5,14}$/.test(sourceGroupId)) throw new Error("Source QQ group id is invalid");
  if (targetType === "group" && targetId === sourceGroupId) throw new Error("A source group cannot subscribe to itself");
  return {
    id: input.id ? String(input.id) : null,
    targetType,
    targetId,
    sourceGroupId,
    mode: SUBSCRIPTION_MODE.AUTO,
    intakeMode: input.intakeMode || SUBSCRIPTION_INTAKE.ALL,
    collectionDelayMinutes: Math.min(1440, Math.max(0.1, Number(input.collectionDelayMinutes || input.delayMinutes || 10))),
    enabled: input.enabled !== false
  };
}

function appendToDebouncedCollection(subscription, sequence, now) {
  let collection = subscription.state.collections.findLast(item => !item.historyRecovery) || null;
  if (!collection || collection.historyRecovery || collection.status !== "collecting" || now.getTime() >= new Date(collection.deadline).getTime()) {
    collection = {
      id: randomUUID(),
      startedAt: now.toISOString(),
      deadline: new Date(now.getTime() + subscription.collectionDelayMinutes * 60 * 1000).toISOString(),
      fromSequence: sequence,
      cutoffSequence: sequence,
      sequences: [sequence],
      status: "collecting",
      completedAt: null
    };
    subscription.state.collections.push(collection);
  } else {
    collection.sequences ||= subscription.state.pendingSequences.filter(item => item >= collection.fromSequence && item <= collection.cutoffSequence);
    collection.sequences.push(sequence);
    collection.cutoffSequence = sequence;
    collection.deadline = new Date(now.getTime() + subscription.collectionDelayMinutes * 60 * 1000).toISOString();
  }
}

function appendCollectionForPending(subscription, now) {
  const sequences = subscription.state.pendingSequences;
  if (!sequences.length) return;
  const deadline = Math.max(now.getTime() + subscription.collectionDelayMinutes * 60 * 1000,
    ...subscription.state.collections.filter((item) => item.status !== "completed")
      .map((item) => Date.parse(item.deadline)).filter(Number.isFinite));
  // A single cutoff batch includes every retained legacy notice. Separate,
  // out-of-order ranges could consume unseen earlier messages on completion.
  subscription.state.collections = subscription.state.collections.filter((item) => item.status === "completed");
  subscription.state.collections.push({
    id: randomUUID(),
    startedAt: now.toISOString(),
    deadline: new Date(deadline).toISOString(),
    fromSequence: sequences[0],
    cutoffSequence: sequences.at(-1),
    status: "collecting",
    completedAt: null
  });
}

function acceptsMessage(subscription, message) {
  if ([SUBSCRIPTION_INTAKE.ALL, SUBSCRIPTION_INTAKE.RESPONSIBLE_ONLY].includes(subscription.intakeMode)) return true;
  return isAdminMessage(message);
}

function isAdminMessage(message) {
  return ["owner", "admin"].includes(String(message?.senderRole || "member").toLowerCase());
}

function isOpenAutoAdminCollection(subscription, now) {
  if (subscription.mode !== SUBSCRIPTION_MODE.AUTO || subscription.intakeMode !== SUBSCRIPTION_INTAKE.ADMIN_ONLY) return false;
  const collection = subscription.state.collections.findLast(item => !item.historyRecovery);
  return Boolean(collection?.status === "collecting" && now.getTime() < new Date(collection.deadline).getTime());
}

function activeCollection(subscription) {
  return subscription.state.collections.find((item) => ["collecting", "processing"].includes(item.status)) || null;
}

function trimCompletedCollections(subscription) {
  const unfinished = subscription.state.collections.filter((item) => !['completed', 'cancelled'].includes(item.status));
  const completed = subscription.state.collections.filter((item) => ['completed', 'cancelled'].includes(item.status)).slice(-10);
  subscription.state.collections = [...completed, ...unfinished].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
}

function resetSubscriptionAt(subscription, sequence) {
  subscription.state = createSubscriptionState(sequence);
}

function lastMessageId(messages) {
  const trigger = [...(messages || [])].reverse().find((message) => !message.contextOnly);
  return trigger?.messageId || messages?.at(-1)?.messageId || null;
}

function claimCollectionIds(context) {
  return context.collectionIds?.length ? context.collectionIds : (context.collectionId ? [context.collectionId] : []);
}

function targetKey(type, id) {
  return `${type}:${id}`;
}

function isTransientTurnCollision(error) {
  return /目标 [^\s]+ 已有进行中的轮次|WorkBuddy thread [^\s]+ already has a running turn|QQ group [^\s]+ already has a running turn/u.test(String(error || ""));
}

function claimMessages(source, sequences, subscription) {
  const triggerSequences = new Set(sequences.map(Number));
  if (!usesAdminContext(subscription)) {
    return structuredClone(source.messages
      .filter((message) => triggerSequences.has(Number(message.sequence)))
      .map((message) => ({ ...message, contextOnly: false })));
  }

  const included = new Set(triggerSequences);
  for (const sequence of triggerSequences) {
    for (const contextSequence of subscription.state.contextByTrigger[String(sequence)] || []) included.add(Number(contextSequence));
  }
  return structuredClone(source.messages
    .filter((message) => included.has(Number(message.sequence)))
    .map((message) => ({ ...message, contextOnly: !triggerSequences.has(Number(message.sequence)) })));
}

function usesAdminContext(subscription) {
  return subscription.intakeMode === SUBSCRIPTION_INTAKE.ADMIN_ONLY;
}

function ensureActiveMessage(source, message) {
  if (!source.messages.some((candidate) => Number(candidate.sequence) === Number(message.sequence))) {
    source.messages.push(structuredClone(message));
  }
}

function rebuildMissingContexts(subscription, source) {
  for (const triggerSequence of subscription.state.pendingSequences) {
    const triggerMessage = [...source.messages, ...source.recentMessages]
      .find((message) => Number(message.sequence) === Number(triggerSequence));
    if (!isAdminMessage(triggerMessage)) continue;
    const key = String(triggerSequence);
    if (subscription.state.contextByTrigger[key]) continue;
    subscription.state.contextByTrigger[key] = source.recentMessages
      .filter((message) => Number(message.sequence) < Number(triggerSequence))
      .slice(-10)
      .map((message) => Number(message.sequence));
    for (const contextSequence of subscription.state.contextByTrigger[key]) {
      const message = source.recentMessages.find((candidate) => Number(candidate.sequence) === contextSequence);
      if (message) ensureActiveMessage(source, message);
    }
  }
  source.messages.sort((a, b) => Number(a.sequence) - Number(b.sequence));
}

function normalizeContextMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([sequence, context]) => [
    String(Number(sequence)),
    Array.isArray(context) ? [...new Set(context.map(Number).filter(Number.isFinite))].sort((a, b) => a - b) : []
  ]));
}

function maxSourceSequence(source) {
  return Math.max(0, ...source.messages.map((message) => Number(message.sequence || 0)), ...source.recentMessages.map((message) => Number(message.sequence || 0)));
}

function toRecentMessage(message) {
  const recent = structuredClone(message);
  recent.images = (recent.images || []).map((image) => ({ ...image, localPath: null }));
  recent.attachments = (recent.attachments || []).map((attachment) => ({ ...attachment, localPath: null }));
  return recent;
}
