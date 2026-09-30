import { describe, expect, it } from "vitest";
import type { InsertRequest, ItemVersion, PendingChange, RundownItem } from "../src/types";
import {
  TAKEOVER_GRACE_MS,
  approverRole,
  isHardTimeOverdue,
  isHeartbeatRecovered,
  reconcileQueue,
  resolveItemConflict,
  tickTakeover
} from "../src/store/takeover";

const base = new Date("2026-10-08T09:00:00.000Z").getTime();
const iso = (offsetMs = 0) => new Date(base + offsetMs).toISOString();

describe("岗位接管与 30 秒心跳窗口", () => {
  it("窗口内（≤30s）收到心跳即撤销接管", () => {
    const result = tickTakeover({ active: true, windowStartedAt: iso(0), lastHeartbeatAt: iso(29_999), now: base + 30_000 });
    expect(result.kind).toBe("revoke");
  });

  it("恰好 30 秒仍撤销（30 秒内恢复）", () => {
    const result = tickTakeover({ active: true, windowStartedAt: iso(0), lastHeartbeatAt: iso(TAKEOVER_GRACE_MS), now: base + 31_000 });
    expect(result.kind).toBe("revoke");
  });

  it("超过 30 秒仍无心跳，导播继续审批", () => {
    const result = tickTakeover({ active: true, windowStartedAt: iso(0), lastHeartbeatAt: iso(-60_000), now: base + 30_001 });
    expect(result.kind).toBe("continue");
  });

  it("窗口内无心跳但时间未到，维持接管", () => {
    const result = tickTakeover({ active: true, windowStartedAt: iso(0), lastHeartbeatAt: iso(-60_000), now: base + 10_000 });
    expect(result.kind).toBe("none");
  });

  it("窗口关闭后的迟到心跳不能撤销接管", () => {
    const tick = tickTakeover({ active: true, windowStartedAt: iso(0), lastHeartbeatAt: null, now: base + 31_000 });
    expect(tick.kind).toBe("continue");
    const late = isHeartbeatRecovered(iso(40_000), null, base + 40_000);
    expect(late).toBe(false);
  });

  it("未接管时不产生窗口事件", () => {
    expect(tickTakeover({ active: false, windowStartedAt: null, lastHeartbeatAt: iso(0), now: base }).kind).toBe("none");
  });

  it("审批岗位随接管切换", () => {
    expect(approverRole(false)).toBe("主编");
    expect(approverRole(true)).toBe("导播");
  });
});

describe("同一串联单条目双方同时修改", () => {
  const a: ItemVersion = { itemId: "r3", title: "政策解读（导播版）", duration: 10, confirmedBy: "导播", confirmedAt: iso(0) };
  const b: ItemVersion = { itemId: "r3", title: "政策解读（主编版）", duration: 14, confirmedBy: "主编", confirmedAt: iso(5_000) };

  it("保留确认时间较晚的版本，另一版进入冲突箱", () => {
    const { winner, loser, conflict } = resolveItemConflict({ itemId: "r3", title: "政策发布会解读", a, b });
    expect(winner).toBe(b);
    expect(loser).toBe(a);
    expect(conflict.reason).toBe("同条同时修改");
    expect(conflict.winner.confirmedBy).toBe("主编");
    expect(conflict.loser.confirmedBy).toBe("导播");
  });

  it("先确认的版本不会生效", () => {
    const { winner } = resolveItemConflict({ itemId: "r3", title: "x", a: { ...b }, b: { ...a } });
    expect(winner.duration).toBe(14);
  });
});

describe("硬时间判定", () => {
  it("硬时间已过且未播出即为风险", () => {
    const item: RundownItem = { id: "r2", title: "连线", type: "连线", duration: 8, hardStart: "08:06", status: "待播", presenter: "x", source: "y" };
    expect(isHardTimeOverdue(item, new Date("2026-10-08T08:30:00"))).toBe(true);
  });
  it("已播出不再判定", () => {
    const item: RundownItem = { id: "r1", title: "提要", type: "新闻片", duration: 4, hardStart: "08:00", status: "已播出", presenter: "x", source: "y" };
    expect(isHardTimeOverdue(item, new Date("2026-10-08T08:30:00"))).toBe(false);
  });
});

describe("断网审批恢复后逐条对账", () => {
  const items: RundownItem[] = [
    { id: "r1", title: "提要", type: "新闻片", duration: 4, hardStart: "08:00", status: "已播出", presenter: "x", source: "y" },
    { id: "r2", title: "整点连线", type: "连线", duration: 8, hardStart: "08:06", status: "待播", presenter: "x", source: "y" },
    { id: "b-x", title: "离线插播：地震速报", type: "新闻片", duration: 2, status: "待播", presenter: "主播", source: "插播：地震" },
    { id: "r4", title: "取消测试", type: "广告", duration: 3, status: "待播", presenter: "x", source: "y" }
  ];

  const queue: PendingChange[] = [
    { id: "q1", action: "批准插播", detail: "离线插播：地震速报", queuedAt: iso(-120_000), ownerRole: "字幕", requestId: "req-1" },
    { id: "q2", action: "取消条目", detail: "取消测试", queuedAt: iso(-60_000), ownerRole: "导播" }
  ];

  const requests: InsertRequest[] = [
    { id: "req-1", headline: "离线插播：地震速报", duration: 2, insertAfter: "r1", reason: "地震", ownerRole: "字幕", status: "已批准", submittedAt: iso(-130_000), decidedBy: "导播", decidedAt: iso(-120_000), rundownItemId: "b-x", offlineApproved: true }
  ];

  it("逐条产生对账记录，队列归属保留原岗位", () => {
    const out = reconcileQueue({ queue, requests, items, now: new Date("2026-10-08T08:30:00") });
    expect(out.entries).toHaveLength(2);
    expect(out.entries[0].ownerRole).toBe("字幕");
    expect(out.entries[1].ownerRole).toBe("导播");
  });

  it("硬时间已过而内容尚未播出：撤下插播、保留原排期，冲突原因入冲突箱", () => {
    const out = reconcileQueue({ queue, requests, items, now: new Date("2026-10-08T08:30:00") });
    const insertEntry = out.entries.find((e) => e.queuedId === "q1")!;
    expect(insertEntry.outcome).toBe("保留原排期");
    expect(out.rollbackItemIds).toEqual(["b-x"]);
    expect(out.conflicts).toHaveLength(1);
    expect(out.conflicts[0].reason).toBe("硬时间已过内容未播");
    expect(out.conflicts[0].winner.title).toBe("整点连线");
    expect(out.conflicts[0].loser.title).toBe("离线插播：地震速报");
    expect(insertEntry.reason).toContain("保留原排期");
  });

  it("硬时间未过时插播对账一致，不撤条目", () => {
    const early: RundownItem[] = [
      { id: "r1", title: "提要", type: "新闻片", duration: 4, hardStart: "08:00", status: "已播出", presenter: "x", source: "y" },
      { id: "r2", title: "整点连线", type: "连线", duration: 8, hardStart: "08:30", status: "待播", presenter: "x", source: "y" },
      { id: "b-x", title: "离线插播：地震速报", type: "新闻片", duration: 2, status: "待播", presenter: "主播", source: "插播：地震" }
    ];
    const out = reconcileQueue({ queue: [queue[0]], requests, items: early, now: new Date("2026-10-08T08:10:00") });
    expect(out.entries[0].outcome).toBe("一致");
    expect(out.rollbackItemIds).toHaveLength(0);
    expect(out.conflicts).toHaveLength(0);
  });
});
