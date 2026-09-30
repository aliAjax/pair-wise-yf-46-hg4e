import { describe, expect, it } from "vitest";
import reducer, {
  commitVersions,
  decideInsert,
  heartbeat,
  queueChange,
  reconcile,
  setOnline,
  setPresenceOnline,
  submitInsert,
  takeoverTick
} from "../src/store/rundownSlice";
import { TAKEOVER_GRACE_MS } from "../src/store/takeover";

function testState() {
  // 重置 seed 中随时间生成的字段不影响断言；直接拿初始 state
  return reducer(undefined, { type: "noop" });
}

const iso = (offset = 0) => new Date(Date.now() + offset).toISOString();

describe("接管审批流转", () => {
  it("主编离岗：导播接管，未确认插播留在待审且归属不变", () => {
    let state = testState();
    expect(state.requests.every((r) => r.status === "待审")).toBe(true);
    const ownersBefore = state.requests.map((r) => r.ownerRole);
    state = reducer(state, setPresenceOnline({ role: "主编", online: false }));
    expect(state.takeover.active).toBe(true);
    expect(state.requests.map((r) => r.ownerRole)).toEqual(ownersBefore);
    expect(state.requests.every((r) => r.status === "待审")).toBe(true);
  });

  it("接管期间由导播批准；断网队列仍保留字幕岗归属", () => {
    let state = testState();
    state = reducer(state, setPresenceOnline({ role: "主编", online: false }));
    state = reducer(state, setOnline(false));
    const target = state.requests.find((r) => r.id === "b1")!;
    state = reducer(state, decideInsert({ id: target.id, approved: true }));
    const decided = state.requests.find((r) => r.id === target.id)!;
    expect(decided.status).toBe("已批准");
    expect(decided.decidedBy).toBe("导播");
    const queued = state.queue.find((q) => q.requestId === target.id)!;
    expect(queued.ownerRole).toBe("字幕");
  });

  it("主编 30 秒内恢复心跳：撤销接管，后续审批回归主编", () => {
    let state = testState();
    const t0 = Date.now();
    state = reducer(state, setPresenceOnline({ role: "主编", online: false, at: new Date(t0).toISOString() }));
    state = reducer(state, setPresenceOnline({ role: "主编", online: true, at: new Date(t0 + 1_000).toISOString() }));
    expect(state.takeover.windowStartedAt).not.toBeNull();
    state = reducer(state, heartbeat({ role: "主编", at: new Date(t0 + 20_000).toISOString() }));
    state = reducer(state, takeoverTick(new Date(t0 + 20_500).toISOString()));
    expect(state.takeover.active).toBe(false);
    expect(state.takeover.revokedAt).not.toBeNull();
  });

  it("超过 30 秒无心跳：窗口关闭，导播继续审批", () => {
    let state = testState();
    const t0 = Date.now();
    state = reducer(state, setPresenceOnline({ role: "主编", online: false, at: new Date(t0).toISOString() }));
    expect(state.presences["主编"].lastHeartbeatAt).toBeNull();
    state = reducer(state, setPresenceOnline({ role: "主编", online: true, at: new Date(t0 + 1_000).toISOString() }));
    state = reducer(state, takeoverTick(new Date(t0 + 1_000 + TAKEOVER_GRACE_MS + 50).toISOString()));
    expect(state.takeover.active).toBe(true);
    expect(state.takeover.windowStartedAt).toBeNull();
    // 迟到的心跳不再撤销
    state = reducer(state, heartbeat({ role: "主编", at: new Date(t0 + 40_000).toISOString() }));
    state = reducer(state, takeoverTick(new Date(t0 + 40_100).toISOString()));
    expect(state.takeover.active).toBe(true);
  });

  it("窗口开始前遗留的旧心跳不能撤销接管", () => {
    let state = testState();
    const t0 = Date.now();
    state = reducer(state, setPresenceOnline({ role: "主编", online: false, at: new Date(t0).toISOString() }));
    state = reducer(state, setPresenceOnline({ role: "主编", online: true, at: new Date(t0 + 1_000).toISOString() }));
    // 心跳时间早于窗口开始 -> 不撤销
    state = reducer(state, heartbeat({ role: "主编", at: new Date(t0 - 5_000).toISOString() }));
    state = reducer(state, takeoverTick(new Date(t0 + 5_000).toISOString()));
    expect(state.takeover.active).toBe(true);
  });

  it("字幕提交的离线改动始终带字幕岗归属", () => {
    let state = testState();
    state = reducer(state, { type: "rundown/setRole", payload: "字幕" });
    state = reducer(state, setOnline(false));
    state = reducer(state, submitInsert({ headline: "离线字幕修正", duration: 1, insertAfter: "r1", reason: "字幕校核" }));
    state = reducer(state, setPresenceOnline({ role: "主编", online: false }));
    state = reducer(state, decideInsert({ id: state.requests[0].id, approved: true }));
    expect(state.queue[0].ownerRole).toBe("字幕");
    expect(state.requests[0].ownerRole).toBe("字幕");
  });
});

describe("同条修改冲突", () => {
  it("确认时间晚的生效，早的进入冲突箱", () => {
    let state = testState();
    const itemId = state.items.find((i) => i.title === "政策发布会解读")!.id;
    const t0 = Date.now();
    state = reducer(state, commitVersions({
      itemId,
      a: { itemId, title: "政策解读（导播）", duration: 10, confirmedBy: "导播", confirmedAt: new Date(t0).toISOString() },
      b: { itemId, title: "政策解读（主编）", duration: 14, confirmedBy: "主编", confirmedAt: new Date(t0 + 8_000).toISOString() }
    }));
    const item = state.items.find((i) => i.id === itemId)!;
    expect(item.title).toBe("政策解读（主编）");
    expect(item.duration).toBe(14);
    expect(state.conflictBox).toHaveLength(1);
    expect(state.conflictBox[0].loser.confirmedBy).toBe("导播");
  });
});

describe("恢复后逐条对账", () => {
  it("硬时间已过内容未播：撤下离线插播、保留原排期、记冲突原因、队列清空并回到在线", () => {
    let state = testState();
    // 构造：断网 + 接管，批准一条插播，使其成为当前待播并使 08:06 连线过期
    state = reducer(state, setOnline(false));
    state = reducer(state, setPresenceOnline({ role: "主编", online: false }));
    state = reducer(state, decideInsert({ id: "b1", approved: true }));
    expect(state.queue.length).toBeGreaterThan(0);
    // 再加一条普通离线操作，验证逐条
    state = reducer(state, queueChange({ action: "取消条目", detail: "整点广告" }));

    const beforeCount = state.items.length;
    const queuedCount = state.queue.length;
    state = reducer(state, reconcile("2026-10-08T08:31:00"));
    expect(state.reconciliations).toHaveLength(queuedCount);
    expect(state.online).toBe(true);
    expect(state.queue).toHaveLength(0);
    expect(state.items.length).toBeLessThan(beforeCount);
    const rollback = state.reconciliations.find((r) => r.action === "批准插播")!;
    expect(rollback.outcome).toBe("保留原排期");
    expect(state.conflictBox.some((c) => c.reason === "硬时间已过内容未播")).toBe(true);
  });

  it("硬时间未过：对账一致，串联单不动", () => {
    let state = testState();
    state = reducer(state, setOnline(false));
    state = reducer(state, setPresenceOnline({ role: "主编", online: false }));
    state = reducer(state, decideInsert({ id: "b1", approved: true }));
    const beforeCount = state.items.length;
    state = reducer(state, reconcile("2026-10-08T08:01:00"));
    expect(state.items.length).toBe(beforeCount);
    expect(state.reconciliations.every((r) => r.outcome === "一致")).toBe(true);
    expect(state.conflictBox).toHaveLength(0);
  });
});
