import type { ConflictEntry, InsertRequest, ItemVersion, PendingChange, ReconciliationEntry, RundownItem } from "../types";

/** 主编重新上线后的心跳宽限期 */
export const TAKEOVER_GRACE_MS = 30_000;

/** 心跳判定：在宽限窗口内收到有效心跳即视为恢复 */
export function isHeartbeatRecovered(lastHeartbeatAt: string | null, windowStartedAt: string | null, now: number): boolean {
  if (!lastHeartbeatAt || !windowStartedAt) return false;
  const beat = new Date(lastHeartbeatAt).getTime();
  const windowStart = new Date(windowStartedAt).getTime();
  return Number.isFinite(beat) && beat >= windowStart && beat - windowStart <= TAKEOVER_GRACE_MS && beat <= now;
}

export type TakeoverTickResult =
  | { kind: "revoke"; at: string }
  | { kind: "continue" }
  | { kind: "none" };

/**
 * 每秒驱动一次接管状态：
 * - 窗口内主编心跳恢复 -> 撤销接管
 * - 超过 30 秒仍无心跳 -> 关闭窗口，导播继续审批
 */
export function tickTakeover(args: { active: boolean; windowStartedAt: string | null; lastHeartbeatAt: string | null; now: number }): TakeoverTickResult {
  const { active, windowStartedAt, lastHeartbeatAt, now } = args;
  if (!active || !windowStartedAt) return { kind: "none" };
  const windowStart = new Date(windowStartedAt).getTime();
  if (isHeartbeatRecovered(lastHeartbeatAt, windowStartedAt, now)) return { kind: "revoke", at: new Date(lastHeartbeatAt!).toISOString() };
  if (now - windowStart > TAKEOVER_GRACE_MS) return { kind: "continue" };
  return { kind: "none" };
}

/** 审批岗位：接管期间为导播，否则为主编 */
export function approverRole(active: boolean): "导播" | "主编" {
  return active ? "导播" : "主编";
}

/**
 * 同一串联单条目双方同时修改：保留确认时间较晚的版本，另一版进入冲突箱。
 */
export function resolveItemConflict(args: {
  itemId: string;
  title: string;
  a: ItemVersion;
  b: ItemVersion;
}): { winner: ItemVersion; loser: ItemVersion; conflict: Omit<ConflictEntry, "id" | "createdAt"> } {
  const ta = new Date(args.a.confirmedAt).getTime();
  const tb = new Date(args.b.confirmedAt).getTime();
  const winner = tb > ta ? args.b : args.a;
  const loser = winner === args.a ? args.b : args.a;
  return {
    winner,
    loser,
    conflict: {
      itemId: args.itemId,
      title: args.title,
      reason: "同条同时修改",
      winner,
      loser
    }
  };
}

/** 把 "HH:mm" 解析为基于基准日期同一天的本地时间 */
export function hardStartToDate(hardStart: string, base: Date): Date {
  const [hh, mm] = hardStart.split(":").map(Number);
  const d = new Date(base);
  d.setHours(hh, mm, 0, 0);
  return d;
}

/** 硬时间判定：硬时间已过（HH:mm 相对对账基准时间）而内容尚未播出 */
export function isHardTimeOverdue(item: RundownItem, now: Date): boolean {
  if (!item.hardStart || item.status === "已播出") return false;
  return hardStartToDate(item.hardStart, now).getTime() < now.getTime();
}

export interface ReconcileInput {
  queue: PendingChange[];
  /** 与队列关联的插播申请（离线批准的申请携带 rundownItemId） */
  requests: InsertRequest[];
  items: RundownItem[];
  now: Date;
}

export interface ReconcileOutput {
  entries: ReconciliationEntry[];
  conflicts: Omit<ConflictEntry, "id" | "createdAt">[];
  /** 需要从串联单撤下的离线插播条目 id（硬时间已过、内容未播 -> 保留原排期） */
  rollbackItemIds: string[];
}

/**
 * 断网期间的审批恢复后逐条对账：
 * 1. 逐条核对离线队列；
 * 2. 离线批准的插播，若其硬时间已过而被它推迟的内容尚未播出 -> 撤下插播、保留原排期，
 *    插播版本与保留版本一同进入冲突箱，注明"硬时间已过内容未播"；
 * 3. 其余离线操作与本地应急播出一致，核对通过。
 */
export function reconcileQueue(input: ReconcileInput): ReconcileOutput {
  const { queue, requests, items, now } = input;
  const nowIso = now.toISOString();
  const entries: ReconciliationEntry[] = [];
  const conflicts: Omit<ConflictEntry, "id" | "createdAt">[] = [];
  const rollbackItemIds: string[] = [];

  for (const change of queue) {
    const id = crypto.randomUUID();
    const request = change.requestId ? requests.find((candidate) => candidate.id === change.requestId) : undefined;
    const inserted = request?.rundownItemId ? items.find((item) => item.id === request.rundownItemId) : undefined;
    const overdueInserted = inserted ? isHardTimeOverdue(inserted, now) : false;
    // 插播之后、被它推迟且硬时间已过仍未播出的原排期内容
    const blocked = inserted
      ? items.filter((item) => item.id !== inserted.id && item.hardStart && item.status !== "已播出" && isHardTimeOverdue(item, now))
      : [];

    if (request && inserted && (overdueInserted || blocked.length > 0)) {
      rollbackItemIds.push(inserted.id);
      const retained = blocked[0];
      const winner: ItemVersion = retained
        ? { itemId: retained.id, title: retained.title, duration: retained.duration, confirmedBy: "主编", confirmedAt: nowIso }
        : { itemId: inserted.id, title: inserted.title, duration: inserted.duration, confirmedBy: "主编", confirmedAt: nowIso };
      const loser: ItemVersion = {
        itemId: inserted.id,
        title: inserted.title,
        duration: inserted.duration,
        confirmedBy: request.decidedBy ?? change.ownerRole,
        confirmedAt: request.decidedAt ?? change.queuedAt
      };
      const reasonText = blocked.length
        ? `硬时间已过而内容尚未播出（${blocked.map((b) => `${b.title} ${b.hardStart}`).join("、")}）`
        : `插播硬时间 ${inserted.hardStart ?? ""} 已过而内容尚未播出`;
      conflicts.push({ itemId: inserted.id, title: inserted.title, reason: "硬时间已过内容未播", winner, loser });
      entries.push({
        id,
        queuedId: change.id,
        action: change.action,
        detail: change.detail,
        ownerRole: change.ownerRole,
        outcome: "保留原排期",
        reason: `${reasonText}，撤下离线插播「${inserted.title}」，保留原排期，冲突原因已入冲突箱`,
        at: nowIso
      });
      continue;
    }

    entries.push({
      id,
      queuedId: change.id,
      action: change.action,
      detail: change.detail,
      ownerRole: change.ownerRole,
      outcome: "一致",
      reason: "离线审批与本地应急播出一致，逐条核对通过",
      at: nowIso
    });
  }

  return { entries, conflicts, rollbackItemIds };
}
