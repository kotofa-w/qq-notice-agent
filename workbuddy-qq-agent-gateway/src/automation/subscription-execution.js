import { normalizeCalendarRemindersEnabled } from '../security/runtime-config.js';
import { formatAutomationConfirmations } from '../security/subscription-policy.js';
import { sanitizeGroupReply, THREAD_INSTRUCTIONS_REVISION } from '../security/policy.js';
import { historyActionSkipReason } from '../security/history-action-policy.js';

// Persist the decision and each external result separately from QQ delivery.
export async function deliverSubscriptionAutomation(worker, targetId, plan) {
  try {
    return await executeAndDeliver(worker, targetId, plan);
  } catch (error) {
    if (!error.deliveryCancelled && !plan.summaryDelivered && !worker.store.snapshot(targetId).failedDelivery && worker.subscriptionStore && plan.contexts.length) {
      if (["REPLY_DISABLED", "RECALLED_INPUT"].includes(error.code)) await worker.subscriptionStore.releaseClaims(plan.contexts).catch(() => {});
      else await worker.subscriptionStore.failClaims(plan.contexts, error).catch(() => {});
    }
    throw error;
  }
}

async function executeAndDeliver(worker, targetId, plan) {
  const { store, automationClient, subscriptionStore } = worker;
  // A previous failed save must succeed before any further external effects.
  await store.save();
  const assertSourceActive = async () => {
    const recalled = plan.contexts.some(context => context.messages?.some(message =>
      subscriptionStore?.isSourceRecalled?.(context.sourceGroupId, message.messageId)));
    const changed = plan.contexts.some(context => (context.intakeMode === 'RESPONSIBLE_ONLY'
      && subscriptionStore?.isNoticeContextCurrent?.(context) !== true)
      || (context.historyRecovery && subscriptionStore?.isHistoryContextCurrent?.(context) === false));
    if (recalled || changed) {
      await store.cancelSubscriptionAutomation(targetId, plan.id);
      const error = new Error(changed ? '通知负责人或订阅配置已变化，停止本轮自动化' : '订阅来源消息已撤回，停止本轮自动化'); error.code = 'RECALLED_INPUT'; throw error;
    }
  };
  await assertSourceActive();
  // Record only after the frozen result is durable, so retries reuse its evidence.
  await subscriptionStore?.recordNoticeDecisions?.(plan.contexts, plan.autoResult.noticeDecisions || []);
  if (worker.calendarFilter) {
    store.assertReplyEnabled(targetId);
    if (!worker.canRun(targetId)) { const error = new Error('Agent 总开关已关闭'); error.code = 'REPLY_DISABLED'; throw error; }
    const candidates = await worker.calendarFilter.stage({ targetType: worker.targetType, targetId, plan });
    const combined = [plan.autoResult.reply, candidates.text].filter(Boolean).join('\n\n');
    const calendarNoticeText = combined.length > 12000 ? candidates.text : '';
    if (calendarNoticeText.length > 12000) throw new Error('日程候选确认说明过长，未发送或开始计时');
    const reply = sanitizeGroupReply(calendarNoticeText ? plan.autoResult.reply : combined);
    await store.prepareDeliveryWork(targetId, {
      reply, displayReply: reply, turnId: plan.result.turnId, trigger: 'subscription_auto',
      subscriptionConsumptions: plan.contexts, automationPlanId: plan.id, calendarCandidateIds: candidates.ids, calendarFilterManaged: true,
      calendarNoticeText,
      bootstrapComplete: !plan.result.compacted, bootstrapRevision: THREAD_INSTRUCTIONS_REVISION
    });
    await assertSubscriptionDeliveryActive(worker, targetId, worker.store.snapshot(targetId).failedDelivery);
    await worker.deliverPrepared(targetId);
    return plan;
  }
  const newlyCompleted = [];
  for (let index = 0; index < plan.autoResult.actions.length; index++) {
    if (['succeeded', 'skipped'].includes(plan.outcomes[index]?.status)) continue;
    await store.save();
    store.assertReplyEnabled(targetId);
    await assertSourceActive();
    if (!worker.canRun(targetId)) {
      const error = new Error('Agent 总开关已关闭，保留计划待重试'); error.code = 'REPLY_DISABLED'; throw error;
    }
    const action = plan.autoResult.actions[index];
    let outcome;
    const skipReason = historyActionSkipReason(action, plan.contexts);
    if (skipReason) {
      outcome = { status: 'skipped', reason: skipReason };
    } else if (!normalizeCalendarRemindersEnabled(
      store.snapshot(targetId).codexConfig?.calendarRemindersEnabled, Boolean(automationClient))) {
      outcome = { status: 'failed', error: '日历/提醒事项开关已关闭或服务不可用' };
    } else {
      const context = plan.contexts.find(item => item.sourceGroupId === action.sourceGroupId);
      try {
        const result = await automationClient.execute(action, { sourceGroupId: action.sourceGroupId, sourceGroupName: context?.sourceGroupName });
        outcome = { status: 'succeeded', result };
        newlyCompleted.push(index);
      } catch (error) {
        outcome = { status: 'failed', error: String(error?.message || error).slice(0, 1000) };
      }
    }
    plan = await store.recordSubscriptionAutomationResult(targetId, plan.id, index, outcome);
  }
  await assertSourceActive();
  store.assertReplyEnabled(targetId);
  if (!worker.canRun(targetId)) { const error = new Error('Agent 总开关已关闭'); error.code = 'REPLY_DISABLED'; throw error; }
  const indices = plan.summaryDelivered ? newlyCompleted : plan.autoResult.actions.map((_, index) => index);
  const confirmations = indices.map(index => {
    const action = plan.autoResult.actions[index]; const outcome = plan.outcomes[index];
    return outcome.status === 'succeeded'
      ? formatAutomationConfirmations([action], [outcome.result])
      : outcome.status === 'skipped'
      ? `未写入：${action.title || '未命名事项'}（${outcome.reason}）`
      : `未写入（可发送“/重试”重试）：${action.title || '未命名事项'}（${outcome.error}）`;
  });
  // A retry with no new success still reports its current failure instead of claiming completion.
  if (plan.summaryDelivered && !newlyCompleted.length && plan.outcomes.some(outcome => outcome.status === 'failed')) confirmations.push('日历/提醒事项仍未写入，可发送“/重试”重试。');
  const reply = sanitizeGroupReply([!plan.summaryDelivered && plan.autoResult.reply, ...confirmations].filter(Boolean).join('\n\n'));
  await store.prepareDeliveryWork(targetId, {
    reply, displayReply: reply, turnId: plan.result.turnId, trigger: 'subscription_auto',
    subscriptionConsumptions: plan.summaryDelivered ? [] : plan.contexts, automationPlanId: plan.id,
    bootstrapComplete: !plan.result.compacted, bootstrapRevision: THREAD_INSTRUCTIONS_REVISION
  });
  await assertSubscriptionDeliveryActive(worker, targetId, worker.store.snapshot(targetId).failedDelivery);
  await worker.deliverPrepared(targetId);
  return plan;
}

// A long summary and its complete confirmation instructions have separate receipts.
export async function activateCalendarCandidates(worker, targetId, delivery) {
  if (!delivery.textSent || !delivery.calendarCandidateIds?.length || !worker.calendarFilter) return delivery;
  if (delivery.calendarNoticeText && !delivery.calendarNoticeSent) {
    worker.store.assertReplyEnabled(targetId);
    if (!worker.canRun(targetId)) { const error = new Error('Agent 总开关已关闭'); error.code = 'REPLY_DISABLED'; throw error; }
    await assertSubscriptionDeliveryActive(worker, targetId, delivery);
    const sent = worker.targetType === 'private'
      ? await worker.oneBot.sendPrivateMessage(targetId, delivery.calendarNoticeText)
      : await worker.oneBot.sendGroupMessage(targetId, delivery.calendarNoticeText);
    if (!sent.ok) throw new Error(`QQ calendar confirmation delivery failed with HTTP ${sent.status}`);
    delivery = await worker.store.markDeliveryCalendarNoticeSent(targetId, {
      messageId: sent.messageId ?? sent.data?.message_id ?? sent.body?.data?.message_id ?? null
    });
  }
  await worker.calendarFilter.markNotified(delivery.calendarCandidateIds, {
    messageId: delivery.calendarNoticeText ? delivery.calendarNoticeMessageId : delivery.notificationMessageId,
    sentAt: delivery.calendarNoticeText ? delivery.calendarNoticeSentAt : delivery.notificationSentAt
  });
  return delivery;
}

// Prepared QQ retries must recheck the source even though calendar work is done.
export async function assertSubscriptionDeliveryActive(worker, targetId, delivery) {
  if (!delivery.automationPlanId && !delivery.subscriptionConsumptions?.length) return;
  const plan = worker.store.snapshot(targetId).subscriptionAutomationPlans
    .find(item => item.id === delivery.automationPlanId);
  const contexts = plan?.contexts || delivery.subscriptionConsumptions || [];
  const recalled = contexts.some(context => context.messages?.some(message =>
    worker.subscriptionStore?.isSourceRecalled?.(context.sourceGroupId, message.messageId)));
  const changed = contexts.some(context => (context.intakeMode === 'RESPONSIBLE_ONLY'
    && worker.subscriptionStore?.isNoticeContextCurrent?.(context) !== true)
    || (context.historyRecovery && worker.subscriptionStore?.isHistoryContextCurrent?.(context) === false));
  if (!recalled && !changed) return;
  // Release before discarding the prepared state so a failed release remains retryable.
  await worker.subscriptionStore.releaseClaims(delivery.subscriptionConsumptions || []);
  await worker.store.cancelSubscriptionAutomation(targetId, delivery.automationPlanId, { cancelDelivery: true });
  const error = new Error(changed ? '通知负责人或订阅配置已变化，取消已准备的 QQ 摘要' : '订阅来源消息已撤回，取消已准备的 QQ 摘要');
  error.code = 'RECALLED_INPUT';
  error.deliveryCancelled = true;
  throw error;
}
