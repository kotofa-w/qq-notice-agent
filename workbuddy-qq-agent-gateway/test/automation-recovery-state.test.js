import test from "node:test";
import assert from "node:assert/strict";
import { toPublicGroupState } from "../src/groups/group-state.js";

test("panel exposes incomplete calendar work without exposing stored decisions or source messages", () => {
  const view = toPublicGroupState({
    groupId: "12345", pendingMessages: [],
    subscriptionAutomationPlans: [{
      autoResult: { reply: "private-source-content" },
      contexts: [{ messages: [{ text: "private-source-content" }] }],
      outcomes: [{ status: "succeeded" }, { status: "failed", error: "private-action-detail" }]
    }]
  });
  assert.deepEqual(view.automationRecovery, { pendingPlans: 1, failedActions: 1 });
  assert.ok(!JSON.stringify(view).includes("private-source-content"));
  assert.ok(!JSON.stringify(view).includes("private-action-detail"));
  assert.deepEqual(toPublicGroupState({ groupId: "12345" }).automationRecovery, { pendingPlans: 0, failedActions: 0 });
});
