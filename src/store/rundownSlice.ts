import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { BreakingApplication, BreakingChange, ConflictEntry, HistoryEntry, PendingChange, Role, RundownItem, TakeoverState } from "../types";

export const BROADCAST_DATE = "2026-10-08";
const TAKEOVER_WINDOW_MS = 30_000;

const seed: RundownItem[] = [
  { id: "r1", title: "早间新闻提要", type: "新闻片", duration: 4, hardStart: "08:00", status: "已播出", presenter: "陈默", source: "主控", confirmedAt: "2026-10-08T07:00:00" },
  { id: "r2", title: "城市更新现场连线", type: "连线", duration: 8, hardStart: "08:06", status: "待播", presenter: "陈默", source: "记者周岚", confirmedAt: "2026-10-08T07:00:00" },
  { id: "r3", title: "政策发布会解读", type: "嘉宾", duration: 12, status: "待播", presenter: "陈默", source: "演播室A", confirmedAt: "2026-10-08T07:00:00" },
  { id: "r4", title: "整点广告", type: "广告", duration: 3, hardStart: "08:30", status: "待播", presenter: "系统", source: "广告串", confirmedAt: "2026-10-08T07:00:00" }
];

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
/** 兼容 Immer 草稿的深拷贝（structuredClone 无法克隆 Proxy） */
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function touch(item: RundownItem) { item.confirmedAt = now(); }
function snapshot(items: RundownItem[], label: string, detail: string): HistoryEntry {
  return { id: uuid(), label, detail, time: now(), snapshot: clone(items) };
}

/** 审批权限：主编本人，或接管期间的导播 */
function canApprove(role: Role, takeover: TakeoverState | null): boolean {
  return role === "主编" || (role === "导播" && !!takeover);
}

/** 硬时间已过而内容尚未播出 */
function hardTimePassed(hardStart?: string, status?: string): boolean {
  if (!hardStart || status === "已播出") return false;
  return new Date(`${BROADCAST_DATE}T${hardStart}:00`).getTime() < Date.now();
}

/** 离线入队：保留岗位归属与确认时间 */
function enqueue(state: State, action: string, detail: string, confirmedAt: string, targetId?: string | null) {
  state.queue.unshift({ id: uuid(), action, detail, queuedAt: confirmedAt, role: state.role, confirmedAt, targetId: targetId ?? null });
}

interface State {
  initialized: boolean;
  items: RundownItem[];
  history: HistoryEntry[];
  queue: PendingChange[];
  changes: BreakingChange[];
  applications: BreakingApplication[];
  conflicts: ConflictEntry[];
  takeover: TakeoverState | null;
  heartbeats: Partial<Record<Role, string>>;
  /** 远端（主链路）最新状态 */
  lastSynced: RundownItem[];
  /** 上次共同同步点基线，用于判断双方是否同时修改 */
  baseSnapshot: RundownItem[];
  role: Role;
  online: boolean;
}

const initialState: State = {
  initialized: false,
  items: seed,
  history: [],
  queue: [],
  changes: [],
  applications: [],
  conflicts: [],
  takeover: null,
  heartbeats: {},
  lastSynced: clone(seed),
  baseSnapshot: clone(seed),
  role: "导播",
  online: true
};

const slice = createSlice({
  name: "rundown",
  initialState,
  reducers: {
    initialize(state, action: PayloadAction<RundownItem[]>) {
      if (!state.initialized) {
        const data = action.payload.length ? action.payload : seed;
        state.items = data;
        state.lastSynced = clone(data);
        state.baseSnapshot = clone(data);
        state.initialized = true;
      }
    },
    setRole(state, action: PayloadAction<Role>) {
      state.role = action.payload;
      // 原岗位重新上线：主编恢复心跳，触发接管判定
      if (action.payload === "主编") {
        state.heartbeats["主编"] = now();
        const takeover = state.takeover;
        if (takeover && !takeover.continued) {
          if (Date.now() <= new Date(takeover.deadline).getTime()) {
            state.history.unshift(snapshot(state.items, "接管撤销", "主编在30秒心跳窗口内恢复心跳，导播接管解除"));
            state.takeover = null;
          } else {
            takeover.continued = true;
            state.history.unshift(snapshot(state.items, "接管延续", "主编恢复心跳已超过30秒，导播继续审批"));
          }
        }
      }
    },
    setOnline(state, action: PayloadAction<boolean>) {
      // 基线为上次共同同步点，不在离线时重置，以保留并发判定
      state.online = action.payload;
    },
    /** 远端写入成功后追平主链路状态 */
    markSynced(state, action: PayloadAction<RundownItem[]>) {
      state.lastSynced = clone(action.payload);
    },
    /** 导播接管主编审批，开启 30 秒心跳窗口 */
    takeOver(state) {
      if (state.role !== "导播" || state.takeover) return;
      state.takeover = { by: "导播", from: "主编", startedAt: now(), deadline: new Date(Date.now() + TAKEOVER_WINDOW_MS).toISOString(), continued: false };
      state.history.unshift(snapshot(state.items, "岗位接管", "主编临时离岗，导播接管审批（30秒心跳窗口）"));
    },
    /** 原岗位主动恢复心跳 */
    heartbeat(state) {
      const role = state.role;
      state.heartbeats[role] = now();
      const takeover = state.takeover;
      if (takeover && takeover.from === role && !takeover.continued) {
        if (Date.now() <= new Date(takeover.deadline).getTime()) {
          state.history.unshift(snapshot(state.items, "接管撤销", `${role}在30秒内恢复心跳，接管解除`));
          state.takeover = null;
        } else {
          takeover.continued = true;
          state.history.unshift(snapshot(state.items, "接管延续", `${role}恢复心跳已超过30秒，导播继续审批`));
        }
      }
    },
    /** 心跳窗口超时检查：窗口过后导播继续审批 */
    tickTakeover(state) {
      const takeover = state.takeover;
      if (takeover && !takeover.continued && Date.now() > new Date(takeover.deadline).getTime()) {
        takeover.continued = true;
        state.history.unshift(snapshot(state.items, "接管延续", "30秒心跳窗口已过，导播继续审批"));
      }
    },
    /** 提交插播申请：未确认前留在待审，不进入串联单 */
    submitApplication(state, action: PayloadAction<Omit<BreakingApplication, "id" | "createdAt" | "status" | "submittedBy">>) {
      const app: BreakingApplication = { ...action.payload, id: uuid(), createdAt: now(), submittedBy: state.role, status: "待审" };
      state.applications.unshift(app);
      state.history.unshift(snapshot(state.items, "插播申请", `${app.headline}（${state.role}提交，待审）`));
      if (!state.online) enqueue(state, "插播申请", app.headline, app.createdAt, null);
    },
    /** 批准插播申请：具备审批权的岗位确认后才插入串联单 */
    approveApplication(state, action: PayloadAction<string>) {
      const app = state.applications.find((entry) => entry.id === action.payload);
      if (!app || app.status !== "待审" || !canApprove(state.role, state.takeover)) return;
      const reviewedAt = now();
      app.status = "已批准";
      app.reviewedBy = state.role;
      app.reviewedAt = reviewedAt;
      const insertAt = state.items.findIndex((item) => item.id === app.insertAfter);
      const newItem: RundownItem = { id: uuid(), title: app.headline, type: "新闻片", duration: app.duration, status: "待播", presenter: "值班主播", source: `插播：${app.reason}`, confirmedAt: reviewedAt };
      state.items.splice(insertAt + 1, 0, newItem);
      state.changes.unshift({ id: uuid(), headline: app.headline, duration: app.duration, insertAfter: app.insertAfter, reason: app.reason, createdAt: app.createdAt });
      state.history.unshift(snapshot(state.items, "插播批准", `${app.headline} 由 ${state.role} 批准播出`));
    },
    rejectApplication(state, action: PayloadAction<string>) {
      const app = state.applications.find((entry) => entry.id === action.payload);
      if (!app || app.status !== "待审" || !canApprove(state.role, state.takeover)) return;
      app.status = "已驳回";
      app.reviewedBy = state.role;
      app.reviewedAt = now();
      state.history.unshift(snapshot(state.items, "插播驳回", `${app.headline} 由 ${state.role} 驳回`));
    },
    addItem(state, action: PayloadAction<Omit<RundownItem, "id" | "status" | "confirmedAt">>) {
      const id = uuid();
      const confirmedAt = now();
      state.history.unshift(snapshot(state.items, "新增条目", action.payload.title));
      state.items.push({ ...action.payload, id, status: "草稿", confirmedAt });
      if (!state.online) enqueue(state, "新增条目", action.payload.title, confirmedAt, id);
    },
    updateStatus(state, action: PayloadAction<{ id: string; status: RundownItem["status"] }>) {
      const item = state.items.find((entry) => entry.id === action.payload.id);
      if (!item) return;
      state.history.unshift(snapshot(state.items, "播出状态", `${item.title} → ${action.payload.status}`));
      item.status = action.payload.status;
      touch(item);
      if (!state.online) enqueue(state, "播出状态", `${item.title} → ${action.payload.status}`, item.confirmedAt!, item.id);
    },
    reorder(state, action: PayloadAction<RundownItem[]>) {
      state.history.unshift(snapshot(state.items, "调整顺序", "直播串联单顺序变化"));
      state.items = action.payload.map((item) => ({ ...item, confirmedAt: now() }));
      if (!state.online) enqueue(state, "调整顺序", "直播串联单顺序变化", now(), null);
    },
    adjustDuration(state, action: PayloadAction<{ id: string; delta: number }>) {
      const item = state.items.find((entry) => entry.id === action.payload.id);
      if (!item) return;
      const detail = `${item.title} ${action.payload.delta > 0 ? "增加" : "减少"} ${Math.abs(action.payload.delta)} 分钟`;
      state.history.unshift(snapshot(state.items, "调整时长", detail));
      item.duration = Math.max(1, item.duration + action.payload.delta);
      touch(item);
      if (!state.online) enqueue(state, "调整时长", detail, item.confirmedAt!, item.id);
    },
    skipItem(state, action: PayloadAction<string>) {
      const item = state.items.find((entry) => entry.id === action.payload);
      if (!item) return;
      state.history.unshift(snapshot(state.items, "取消条目", item.title));
      item.status = "已跳过";
      touch(item);
      if (!state.online) enqueue(state, "取消条目", item.title, item.confirmedAt!, item.id);
    },
    undo(state) {
      const last = state.history.shift();
      if (!last) return;
      state.items = clone(last.snapshot);
    },
    /**
     * 断网恢复后逐条对账：
     * - 双方同时修改同一条目时，保留确认时间较晚的版本，另一版进入冲突箱
     * - 硬时间已过而内容尚未播出的，保留原排期与冲突原因
     */
    syncQueue(state) {
      const base = state.baseSnapshot;
      const remote = state.lastSynced;
      const local = state.items;
      const detectedAt = now();

      const byTarget = new Map<string, PendingChange[]>();
      for (const change of state.queue) {
        if (!change.targetId) continue;
        const list = byTarget.get(change.targetId) ?? [];
        list.push(change);
        byTarget.set(change.targetId, list);
      }

      const ids = [...new Set([...base, ...remote, ...local].map((item) => item.id))];
      const merged: RundownItem[] = [];
      const conflicts: ConflictEntry[] = [];

      for (const id of ids) {
        const b = base.find((item) => item.id === id);
        const r = remote.find((item) => item.id === id);
        const l = local.find((item) => item.id === id);
        const changes = (byTarget.get(id) ?? []).sort((a, c) => +new Date(c.confirmedAt) - +new Date(a.confirmedAt));

        if (!b && r && !l) { merged.push(clone(r)); continue; }
        if (!b && !r && l) { merged.push(clone(l)); continue; }
        if (b && !r && !l) continue;
        if (!b && r && l) { merged.push(clone(l)); continue; }
        if (b && r && !l) { merged.push(clone(r)); continue; }
        if (b && !r && l) { merged.push(clone(l)); continue; }

        // b、r、l 同时存在
        const localChanged = JSON.stringify(l) !== JSON.stringify(b);
        const remoteChanged = JSON.stringify(r) !== JSON.stringify(b);
        const differ = JSON.stringify(l) !== JSON.stringify(r);

        // 硬时间已过而内容尚未播出：排期锁定，保留原排期（远端）并记录冲突原因
        if (hardTimePassed(r!.hardStart, r!.status)) {
          conflicts.push({
            id: uuid(), itemId: id, itemTitle: r!.title,
            localVersion: clone(l!), remoteVersion: clone(r!),
            kept: "remote", reason: "硬时间已过，内容尚未播出，保留原排期与冲突原因", detectedAt
          });
          merged.push(clone(r!));
        } else if (localChanged && remoteChanged && differ) {
          // 双方同时修改同一条目：保留确认时间较晚的版本，另一版进入冲突箱
          const localTime = changes[0]?.confirmedAt ?? l!.confirmedAt ?? detectedAt;
          const remoteTime = r!.confirmedAt ?? b!.confirmedAt ?? localTime;
          if (+new Date(localTime) >= +new Date(remoteTime)) {
            conflicts.push({
              id: uuid(), itemId: id, itemTitle: l!.title,
              localVersion: clone(l!), remoteVersion: clone(r!),
              kept: "local", reason: "双方同时修改同一串联单条目，本地确认时间晚于远端", detectedAt
            });
            merged.push(clone(l!));
          } else {
            conflicts.push({
              id: uuid(), itemId: id, itemTitle: r!.title,
              localVersion: clone(l!), remoteVersion: clone(r!),
              kept: "remote", reason: "双方同时修改同一串联单条目，远端确认时间晚于本地", detectedAt
            });
            merged.push(clone(r!));
          }
        } else if (remoteChanged) {
          merged.push(clone(r!));
        } else {
          merged.push(clone(l!));
        }
      }

      // 顺序以本地为准，远端新增条目追加在后
      const localOrder = local.map((item) => item.id);
      merged.sort((a, c) => (localOrder.indexOf(a.id) === -1 ? 9999 : localOrder.indexOf(a.id)) - (localOrder.indexOf(c.id) === -1 ? 9999 : localOrder.indexOf(c.id)));

      state.conflicts.unshift(...conflicts);
      state.items = merged;
      state.lastSynced = clone(merged);
      state.baseSnapshot = clone(merged);
      state.queue = [];
      state.online = true;
      state.history.unshift(snapshot(merged, "逐条对账", `恢复后对账 ${ids.length} 条，冲突 ${conflicts.length} 条，已保留确认时间较晚版本`));
    }
  }
});

export const {
  initialize, setRole, setOnline, markSynced,
  takeOver, heartbeat, tickTakeover,
  submitApplication, approveApplication, rejectApplication,
  addItem, updateStatus, reorder, adjustDuration, skipItem,
  undo, syncQueue
} = slice.actions;
export default slice.reducer;
