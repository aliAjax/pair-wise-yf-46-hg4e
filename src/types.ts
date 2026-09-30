export type Role = "导播" | "主编" | "字幕" | "演播室";
export type ItemType = "新闻片" | "连线" | "嘉宾" | "口播" | "广告";
export type ItemStatus = "待播" | "已播出" | "已跳过" | "草稿";

/** 岗位心跳/在岗状态 */
export interface Presence {
  role: Role;
  online: boolean;
  /** 最近一次心跳时间（ISO），从未上报时为 null */
  lastHeartbeatAt: string | null;
}

export interface RundownItem {
  id: string;
  title: string;
  type: ItemType;
  duration: number;
  hardStart?: string;
  status: ItemStatus;
  presenter: string;
  source: string;
  /** 最后确认（保存）该条目版本的岗位与时间 */
  confirmedBy?: Role;
  confirmedAt?: string;
}

/** 插播申请的审批状态：未确认的申请留在"待审" */
export type InsertRequestStatus = "待审" | "已批准" | "已驳回";

export interface InsertRequest {
  id: string;
  headline: string;
  duration: number;
  insertAfter: string;
  reason: string;
  /** 队列归属：哪个岗位提交的，接管期间也不改变 */
  ownerRole: Role;
  status: InsertRequestStatus;
  submittedAt: string;
  /** 审批岗位：撤销接管后应为"主编"，接管期间为"导播" */
  decidedBy?: Role;
  decidedAt?: string;
  /** 批准后在串联单中生成的条目 id（断网对账回滚用） */
  rundownItemId?: string;
  /** 审批时是否处于本地应急（断网）模式 */
  offlineApproved?: boolean;
}

export interface BreakingChange {
  id: string;
  headline: string;
  duration: number;
  insertAfter: string;
  reason: string;
  createdAt: string;
  ownerRole?: Role;
  decidedBy?: Role;
}

/** 离线（断网应急）队列条目，始终保留原岗位归属 */
export interface PendingChange {
  id: string;
  action: string;
  detail: string;
  queuedAt: string;
  ownerRole: Role;
  /** 与插播申请关联时携带，便于逐条对账 */
  requestId?: string;
  reconciled?: boolean;
}

/** 同一条目的一个修改版本 */
export interface ItemVersion {
  itemId: string;
  title: string;
  duration: number;
  confirmedBy: Role;
  /** 确认时间：同一串联单条目冲突时，较晚者生效 */
  confirmedAt: string;
}

export type ConflictReason = "同条同时修改" | "硬时间已过内容未播";

export interface ConflictEntry {
  id: string;
  itemId: string;
  title: string;
  reason: ConflictReason;
  /** 生效版本（确认时间较晚 / 保留的原排期） */
  winner: ItemVersion;
  /** 落败版本（双人修改时的另一版；硬时间对账时为被撤下的插播） */
  loser: ItemVersion;
  createdAt: string;
  /** 关联的对账记录 id */
  reconciliationId?: string;
}

/** 断网审批恢复后的逐条对账记录 */
export interface ReconciliationEntry {
  id: string;
  queuedId: string;
  action: string;
  detail: string;
  ownerRole: Role;
  outcome: "一致" | "保留原排期" | "已重放";
  reason: string;
  at: string;
}

/** 岗位接管状态：主编离岗后由导播接管审批 */
export interface TakeoverState {
  active: boolean;
  startedAt: string | null;
  /** 主编重新上线的时刻；30 秒内心跳恢复则撤销接管，否则导播继续 */
  windowStartedAt: string | null;
  windowDeadlineAt: string | null;
  revokedAt: string | null;
}

export interface HistoryEntry {
  id: string;
  label: string;
  detail: string;
  time: string;
  snapshot: RundownItem[];
}
