export type Role = "导播" | "主编" | "字幕" | "演播室";
export type ItemType = "新闻片" | "连线" | "嘉宾" | "口播" | "广告";
export type ItemStatus = "待播" | "已播出" | "已跳过" | "草稿";
export type ApplicationStatus = "待审" | "已批准" | "已驳回";

export interface RundownItem {
  id: string;
  title: string;
  type: ItemType;
  duration: number;
  hardStart?: string;
  status: ItemStatus;
  presenter: string;
  source: string;
  /** 确认时间，用于断网恢复后的冲突判定 */
  confirmedAt?: string;
}

export interface BreakingChange {
  id: string;
  headline: string;
  duration: number;
  insertAfter: string;
  reason: string;
  createdAt: string;
}

/** 待审插播申请：未确认前留在待审，不进入串联单 */
export interface BreakingApplication {
  id: string;
  headline: string;
  duration: number;
  insertAfter: string;
  reason: string;
  createdAt: string;
  submittedBy: Role;
  status: ApplicationStatus;
  reviewedBy?: Role;
  reviewedAt?: string;
}

/** 离线队列条目：保留原岗位归属与确认时间 */
export interface PendingChange {
  id: string;
  action: string;
  detail: string;
  queuedAt: string;
  role: Role;
  confirmedAt: string;
  /** 目标串联单条目，用于逐条对账与冲突判定；null 表示全局性改动 */
  targetId?: string | null;
}

/** 冲突箱条目：双方同时修改同一条目时，确认较晚的版本保留，另一版进入冲突箱 */
export interface ConflictEntry {
  id: string;
  itemId: string;
  itemTitle: string;
  localVersion: RundownItem;
  remoteVersion: RundownItem;
  kept: "local" | "remote";
  reason: string;
  detectedAt: string;
}

/** 岗位接管：主编离岗后由导播接管审批，30 秒心跳窗口 */
export interface TakeoverState {
  by: Role;
  from: Role;
  startedAt: string;
  deadline: string;
  /** 心跳窗口已过，导播继续审批 */
  continued: boolean;
}

export interface HistoryEntry {
  id: string;
  label: string;
  detail: string;
  time: string;
  snapshot: RundownItem[];
}
