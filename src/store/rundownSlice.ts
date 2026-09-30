import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type {
  BreakingChange,
  ConflictEntry,
  HistoryEntry,
  InsertRequest,
  ItemVersion,
  PendingChange,
  Presence,
  ReconciliationEntry,
  Role,
  RundownItem,
  TakeoverState
} from "../types";
import { approverRole, reconcileQueue, resolveItemConflict, tickTakeover } from "./takeover";

const seed: RundownItem[] = [
  { id: "r1", title: "早间新闻提要", type: "新闻片", duration: 4, hardStart: "08:00", status: "已播出", presenter: "陈默", source: "主控" },
  { id: "r2", title: "城市更新现场连线", type: "连线", duration: 8, hardStart: "08:06", status: "待播", presenter: "陈默", source: "记者周岚" },
  { id: "r3", title: "政策发布会解读", type: "嘉宾", duration: 12, status: "待播", presenter: "陈默", source: "演播室A" },
  { id: "r4", title: "整点广告", type: "广告", duration: 3, hardStart: "08:30", status: "待播", presenter: "系统", source: "广告串" }
];

const seedRequests: InsertRequest[] = [
  { id: "b1", headline: "突发：地震速报", duration: 2, insertAfter: "r2", reason: "突发新闻速报", ownerRole: "字幕", status: "待审", submittedAt: new Date(Date.now() - 4 * 60_000).toISOString() },
  { id: "b2", headline: "快讯：气象橙色预警", duration: 1, insertAfter: "r3", reason: "气象预警插播", ownerRole: "演播室", status: "待审", submittedAt: new Date(Date.now() - 2 * 60_000).toISOString() }
];

const ROLES: Role[] = ["导播", "主编", "字幕", "演播室"];
const nowIso = () => new Date().toISOString();

function initialPresence(): Record<Role, Presence> {
  const beat = nowIso();
  return Object.fromEntries(ROLES.map((role) => [role, { role, online: true, lastHeartbeatAt: beat }])) as Record<Role, Presence>;
}

interface State {
  initialized: boolean;
  items: RundownItem[];
  history: HistoryEntry[];
  queue: PendingChange[];
  changes: BreakingChange[];
  requests: InsertRequest[];
  conflictBox: ConflictEntry[];
  reconciliations: ReconciliationEntry[];
  presences: Record<Role, Presence>;
  takeover: TakeoverState;
  role: Role;
  online: boolean;
}

const initialState: State = {
  initialized: false,
  items: seed,
  history: [],
  queue: [],
  changes: [],
  requests: seedRequests,
  conflictBox: [],
  reconciliations: [],
  presences: initialPresence(),
  takeover: { active: false, startedAt: null, windowStartedAt: null, windowDeadlineAt: null, revokedAt: null },
  role: "导播",
  online: true
};

function snapshot(items: RundownItem[], label: string, detail: string): HistoryEntry {
  // state.items 是 Immer draft，structuredClone 无法克隆 Proxy，用 JSON 做深拷贝
  return { id: crypto.randomUUID(), label, detail, time: nowIso(), snapshot: JSON.parse(JSON.stringify(items)) as RundownItem[] };
}

const slice = createSlice({
  name: "rundown",
  initialState,
  reducers: {
    initialize(state, action: PayloadAction<RundownItem[]>) {
      if (!state.initialized) {
        state.items = action.payload.length ? action.payload : seed;
        state.initialized = true;
      }
    },
    setRole(state, action: PayloadAction<Role>) { state.role = action.payload; },
    setOnline(state, action: PayloadAction<boolean>) { state.online = action.payload; },

    /** 岗位心跳上报 */
    heartbeat(state, action: PayloadAction<{ role: Role; at?: string }>) {
      const at = action.payload.at ?? nowIso();
      const presence = state.presences[action.payload.role];
      presence.lastHeartbeatAt = at;
      presence.online = true;
    },

    /** 岗位上/下线；主编离岗触发导播接管，主编重新上线开启 30 秒心跳窗口 */
    setPresenceOnline(state, action: PayloadAction<{ role: Role; online: boolean; at?: string }>) {
      const { role, online } = action.payload;
      const at = action.payload.at ?? nowIso();
      state.presences[role].online = online;
      // 注意：重新上线不等于恢复心跳——心跳由 heartbeat 单独上报，两者共同决定 30 秒窗口
      if (role !== "主编") return;

      if (!online) {
        // 主编临时离岗：旧心跳随即失效，重新上线后必须重新上报心跳
        state.presences[role].lastHeartbeatAt = null;
        // 导播接管审批；未确认的插播申请保持"待审"，不动归属
        state.takeover.active = true;
        state.takeover.startedAt = at;
        state.takeover.windowStartedAt = null;
        state.takeover.windowDeadlineAt = null;
        state.takeover.revokedAt = null;
      } else if (state.takeover.active) {
        // 主编重新上线：开始 30 秒心跳恢复窗口
        state.takeover.windowStartedAt = at;
        state.takeover.windowDeadlineAt = new Date(new Date(at).getTime() + 30_000).toISOString();
      }
    },

    /** 每秒驱动：30 秒内心跳恢复则撤销接管，否则导播继续审批 */
    takeoverTick(state, action: PayloadAction<string | undefined>) {
      const now = new Date(action.payload ?? nowIso()).getTime();
      const editor = state.presences["主编"];
      const result = tickTakeover({ active: state.takeover.active, windowStartedAt: state.takeover.windowStartedAt, lastHeartbeatAt: editor.lastHeartbeatAt, now });
      if (result.kind === "revoke") {
        state.takeover.active = false;
        state.takeover.revokedAt = result.at;
        state.takeover.windowStartedAt = null;
        state.takeover.windowDeadlineAt = null;
      } else if (result.kind === "continue") {
        // 超过 30 秒未恢复心跳：关闭窗口，导播继续审批
        state.takeover.windowStartedAt = null;
        state.takeover.windowDeadlineAt = null;
      }
    },

    /** 字幕等岗位提交插播申请：进入待审，携带原岗位归属 */
    submitInsert(state, action: PayloadAction<Omit<InsertRequest, "id" | "ownerRole" | "status" | "submittedAt"> & Partial<Pick<InsertRequest, "ownerRole">>>) {
      const request: InsertRequest = {
        ...action.payload,
        id: crypto.randomUUID(),
        ownerRole: action.payload.ownerRole ?? state.role,
        status: "待审",
        submittedAt: nowIso()
      };
      state.requests.unshift(request);
    },

    /** 审批插播：接管期间导播批，撤销接管后主编批；断网批准进入离线队列，归属仍是提交岗位 */
    decideInsert(state, action: PayloadAction<{ id: string; approved: boolean; at?: string }>) {
      const request = state.requests.find((entry) => entry.id === action.payload.id);
      if (!request || request.status !== "待审") return;
      const at = action.payload.at ?? nowIso();
      const approver = approverRole(state.takeover.active);
      request.status = action.payload.approved ? "已批准" : "已驳回";
      request.decidedBy = approver;
      request.decidedAt = at;
      if (!action.payload.approved) return;

      const index = state.items.findIndex((item) => item.id === request.insertAfter);
      const itemId = crypto.randomUUID();
      state.history.unshift(snapshot(state.items, "批准插播", request.headline));
      state.items.splice(index + 1, 0, {
        id: itemId,
        title: request.headline,
        type: "新闻片",
        duration: request.duration,
        status: "待播",
        presenter: "值班主播",
        source: `插播：${request.reason}`,
        confirmedBy: approver,
        confirmedAt: at
      });
      request.rundownItemId = itemId;
      const change: BreakingChange = { id: crypto.randomUUID(), headline: request.headline, duration: request.duration, insertAfter: request.insertAfter, reason: request.reason, createdAt: at, ownerRole: request.ownerRole, decidedBy: approver };
      state.changes.unshift(change);
      if (!state.online) {
        request.offlineApproved = true;
        // 队列保留原岗位归属（提交的字幕岗），而不是审批的导播
        state.queue.unshift({ id: crypto.randomUUID(), action: "批准插播", detail: request.headline, queuedAt: at, ownerRole: request.ownerRole, requestId: request.id });
      }
    },

    /** 双方同时修改同一串联单条目：确认时间较晚者生效，另一版进冲突箱 */
    commitVersions(state, action: PayloadAction<{ itemId: string; a: ItemVersion; b: ItemVersion }>) {
      const item = state.items.find((entry) => entry.id === action.payload.itemId);
      if (!item) return;
      const { winner, conflict } = resolveItemConflict({ itemId: item.id, title: item.title, a: action.payload.a, b: action.payload.b });
      state.history.unshift(snapshot(state.items, "同条修改裁决", `${item.title}：${winner.confirmedBy} 版本生效`));
      item.title = winner.title;
      item.duration = winner.duration;
      item.confirmedBy = winner.confirmedBy;
      item.confirmedAt = winner.confirmedAt;
      state.conflictBox.unshift({ ...conflict, id: crypto.randomUUID(), createdAt: nowIso() });
    },

    /** 从冲突箱取回落败版本重新编辑（仅移除记录，不改串联单） */
    dismissConflict(state, action: PayloadAction<string>) {
      state.conflictBox = state.conflictBox.filter((entry) => entry.id !== action.payload);
    },

    addItem(state, action: PayloadAction<Omit<RundownItem, "id" | "status">>) {
      state.history.unshift(snapshot(state.items, "新增条目", action.payload.title));
      state.items.push({ ...action.payload, id: crypto.randomUUID(), status: "草稿" });
    },
    updateStatus(state, action: PayloadAction<{ id: string; status: RundownItem["status"] }>) {
      const item = state.items.find((entry) => entry.id === action.payload.id);
      if (!item) return;
      state.history.unshift(snapshot(state.items, "播出状态", `${item.title} → ${action.payload.status}`));
      item.status = action.payload.status;
    },
    reorder(state, action: PayloadAction<RundownItem[]>) {
      state.history.unshift(snapshot(state.items, "调整顺序", "直播串联单顺序变化"));
      state.items = action.payload;
    },
    adjustDuration(state, action: PayloadAction<{ id: string; delta: number; at?: string }>) {
      const item = state.items.find((entry) => entry.id === action.payload.id);
      if (!item) return;
      state.history.unshift(snapshot(state.items, "调整时长", `${item.title} ${action.payload.delta > 0 ? "增加" : "减少"} ${Math.abs(action.payload.delta)} 分钟`));
      item.duration = Math.max(1, item.duration + action.payload.delta);
      item.confirmedBy = state.role;
      item.confirmedAt = action.payload.at ?? nowIso();
    },
    skipItem(state, action: PayloadAction<string>) {
      const item = state.items.find((entry) => entry.id === action.payload);
      if (!item) return;
      state.history.unshift(snapshot(state.items, "取消条目", item.title));
      item.status = "已跳过";
      if (!state.online) state.queue.unshift({ id: crypto.randomUUID(), action: "取消条目", detail: item.title, queuedAt: nowIso(), ownerRole: state.role });
    },
    undo(state) {
      const last = state.history.shift();
      if (!last) return;
      state.items = JSON.parse(JSON.stringify(last.snapshot)) as RundownItem[];
    },
    /** 离线通用操作入队：始终盖上当前岗位（原岗位归属） */
    queueChange(state, action: PayloadAction<{ action: string; detail: string; requestId?: string }>) {
      state.queue.unshift({ id: crypto.randomUUID(), action: action.payload.action, detail: action.payload.detail, queuedAt: nowIso(), ownerRole: state.role, requestId: action.payload.requestId });
    },

    /** 断网审批恢复后逐条对账 */
    reconcile(state, action: PayloadAction<string | undefined>) {
      const now = new Date(action.payload ?? nowIso());
      const result = reconcileQueue({ queue: state.queue, requests: state.requests, items: state.items, now });
      if (result.rollbackItemIds.length) {
        state.history.unshift(snapshot(state.items, "对账保留原排期", `撤下离线插播 ${result.rollbackItemIds.length} 条`));
        state.items = state.items.filter((item) => !result.rollbackItemIds.includes(item.id));
      }
      for (const conflict of result.conflicts) {
        state.conflictBox.unshift({ ...conflict, id: crypto.randomUUID(), createdAt: now.toISOString() });
      }
      state.reconciliations.unshift(...result.entries);
      // 已逐条核对：队列清空，对账记录永久保留
      state.queue = [];
      state.online = true;
    }
  }
});

export const {
  initialize,
  setRole,
  setOnline,
  heartbeat,
  setPresenceOnline,
  takeoverTick,
  submitInsert,
  decideInsert,
  commitVersions,
  dismissConflict,
  addItem,
  updateStatus,
  reorder,
  adjustDuration,
  skipItem,
  undo,
  queueChange,
  reconcile
} = slice.actions;
export default slice.reducer;
