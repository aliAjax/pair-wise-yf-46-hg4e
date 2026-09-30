import { useEffect, useMemo, useState } from "react";
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove, SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Alert, Badge, Button, Card, Form, Input, InputNumber, Select, Switch, Tag, Timeline, message } from "antd";
import { addMinutes, format } from "date-fns";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { NavLink, Route, Routes } from "react-router-dom";
import { SortableItem } from "./components/SortableItem";
import { useGetRundownQuery, useSaveRundownMutation } from "./store/api";
import { useAppDispatch, useAppSelector } from "./store/hooks";
import {
  addItem,
  adjustDuration,
  commitVersions,
  decideInsert,
  dismissConflict,
  heartbeat,
  initialize,
  queueChange,
  reconcile,
  reorder,
  setOnline,
  setPresenceOnline,
  setRole,
  skipItem,
  submitInsert,
  takeoverTick,
  undo,
  updateStatus
} from "./store/rundownSlice";
import { approverRole, TAKEOVER_GRACE_MS } from "./store/takeover";
import type { ItemType, Role, RundownItem } from "./types";

const schema = z.object({ title: z.string().min(2), type: z.enum(["新闻片", "连线", "嘉宾", "口播", "广告"]), duration: z.number().min(1).max(120), presenter: z.string().min(1), source: z.string().min(1) });
type FormValues = z.infer<typeof schema>;

const ALL_ROLES: Role[] = ["导播", "主编", "字幕", "演播室"];
const ROLE_COLOR: Record<Role, string> = { 导播: "volcano", 主编: "purple", 字幕: "cyan", 演播室: "geekblue" };

function useTimeline(items: RundownItem[]) {
  const start = new Date("2026-10-08T08:00:00");
  let cursor = start;
  return items.map((item) => {
    const current = cursor;
    cursor = addMinutes(cursor, item.duration);
    return { item, at: format(current, "HH:mm"), duration: item.duration };
  });
}

/** 每秒驱动 30 秒心跳窗口判定 */
function useTakeoverTicker() {
  const dispatch = useAppDispatch();
  const active = useAppSelector((state) => state.rundown.takeover.active);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => dispatch(takeoverTick()), 1000);
    return () => clearInterval(timer);
  }, [active, dispatch]);
}

function TakeoverBanner() {
  const { takeover, online } = useAppSelector((state) => state.rundown);
  const [, force] = useState(0);
  useEffect(() => {
    if (!takeover.windowDeadlineAt) return;
    const t = setInterval(() => force((n) => n + 1), 250);
    return () => clearInterval(t);
  }, [takeover.windowDeadlineAt]);
  if (!takeover.active) return null;
  const remaining = takeover.windowDeadlineAt ? Math.max(0, new Date(takeover.windowDeadlineAt).getTime() - Date.now()) : null;
  return <Alert
    showIcon
    type={online ? "warning" : "error"}
    className="takeover-banner"
    message={takeover.windowStartedAt ? `主编已重新上线 · ${(remaining! / 1000).toFixed(0)} 秒内恢复心跳将撤销接管，否则导播继续审批` : "主编临时离岗 · 导播已接管审批，未确认插播留待审，队列保留原岗位归属"}
  />;
}

function RundownPage() {
  const dispatch = useAppDispatch();
  const { items, role, online } = useAppSelector((state) => state.rundown);
  const saveMutation = useSaveRundownMutation()[0];
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const timeline = useTimeline(items);
  const total = items.reduce((sum, item) => sum + item.duration, 0);
  const overrun = timeline.filter(({ at, item }) => item.hardStart && at > item.hardStart);
  const { control, handleSubmit, reset } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { title: "", type: "新闻片", duration: 5, presenter: "陈默", source: "主控" } });

  useEffect(() => { const timer = setTimeout(() => { void saveMutation(items); }, 250); return () => clearTimeout(timer); }, [items, saveMutation]);

  const onDragEnd = (event: DragEndEvent) => {
    if (!event.over || event.active.id === event.over.id || role !== "导播") return;
    const oldIndex = items.findIndex((item) => item.id === event.active.id);
    const newIndex = items.findIndex((item) => item.id === event.over!.id);
    dispatch(reorder(arrayMove(items, oldIndex, newIndex)));
  };

  const submit = (values: FormValues) => {
    dispatch(addItem(values));
    if (!online) dispatch(queueChange({ action: "新增条目", detail: values.title }));
    reset();
  };

  return <div className="page-stack">
    <TakeoverBanner />
    <div className="page-grid">
      <Card className="main-card">
        <div className="card-heading"><div><small>2026-10-08 · 08:00 开播</small><h2>直播串联单</h2></div><div className="head-actions"><Tag color={online ? "green" : "red"}>{online ? "主备链路正常" : "本地应急模式"}</Tag><Button onClick={() => dispatch(undo())} disabled={!role || role === "字幕"}>撤回上一步</Button></div></div>
        <div className="summary"><span><b>{items.length}</b> 条内容</span><span><b>{total}</b> 分钟总时长</span><span className={overrun.length ? "danger-text" : ""}><b>{overrun.length}</b> 个硬时间风险</span><span><b>{timeline.at(-1)?.at ?? "--:--"}</b> 预计收播</span></div>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
            <div className="rundown-list">{timeline.map(({ item, at }) => <SortableItem key={item.id} item={item} cumulative={at} onDuration={(delta) => dispatch(adjustDuration({ id: item.id, delta }))} onStatus={() => dispatch(updateStatus({ id: item.id, status: "已播出" }))} onSkip={() => dispatch(skipItem(item.id))} />)}</div>
          </SortableContext>
        </DndContext>
      </Card>
      <aside className="side-stack">
        <Card title="新增播出条目">
          <Form layout="vertical" onFinish={handleSubmit(submit)}>
            <Form.Item label="标题"><Controller name="title" control={control} render={({ field, fieldState }) => <><Input {...field} status={fieldState.error ? "error" : ""} /><small className="error">{fieldState.error?.message}</small></>} /></Form.Item>
            <div className="two-cols"><Form.Item label="类型"><Controller name="type" control={control} render={({ field }) => <Select {...field} options={["新闻片", "连线", "嘉宾", "口播", "广告"].map((v) => ({ value: v, label: v }))} />} /></Form.Item><Form.Item label="时长"><Controller name="duration" control={control} render={({ field }) => <InputNumber {...field} min={1} max={120} addonAfter="分钟" />} /></Form.Item></div>
            <Form.Item label="主播"><Controller name="presenter" control={control} render={({ field }) => <Input {...field} />} /></Form.Item>
            <Form.Item label="来源"><Controller name="source" control={control} render={({ field }) => <Input {...field} />} /></Form.Item>
            <Button htmlType="submit" type="primary" block disabled={role === "字幕"}>加入串联单</Button>
          </Form>
        </Card>
        <BreakingForm />
      </aside>
    </div>
  </div>;
}

/** 插播申请表：所有岗位提交"待审"申请，审批在审批台完成；断网也可提交，恢复后逐条对账 */
function BreakingForm() {
  const dispatch = useAppDispatch();
  const { items, online, role } = useAppSelector((state) => state.rundown);
  const [values, setValues] = useState({ headline: "", duration: 5, insertAfter: items[0]?.id ?? "", reason: "突发新闻" });
  return <Card title="突发插播申请" className="breaking-card">
    <Input value={values.headline} onChange={(event) => setValues({ ...values, headline: event.target.value })} placeholder="插播标题" />
    <div className="two-cols"><InputNumber value={values.duration} onChange={(value) => setValues({ ...values, duration: Number(value ?? 5) })} addonAfter="分钟" /><Select value={values.insertAfter} onChange={(value) => setValues({ ...values, insertAfter: value })} options={items.map((item) => ({ value: item.id, label: `插在「${item.title}」后` }))} /></div>
    <Input value={values.reason} onChange={(event) => setValues({ ...values, reason: event.target.value })} placeholder="插播原因" />
    <Button type="primary" danger block disabled={values.headline.length < 2} onClick={() => {
      dispatch(submitInsert(values));
      if (!online) message.warning("断网提交：已记入本地应急队列，恢复后逐条对账");
      setValues({ ...values, headline: "" });
    }}>提交插播申请（{role} 岗 · 待审）</Button>
    <small>{online ? "申请进入审批台，由主编（接管时为导播）确认。" : "断网期间照常提交，队列保留本岗位归属。"}</small>
  </Card>;
}

/** 审批台：未确认申请留在待审；接管时导播可批，否则仅主编可批 */
function ApprovalsPage() {
  const dispatch = useAppDispatch();
  const { requests, takeover, items, role } = useAppSelector((state) => state.rundown);
  const approver = approverRole(takeover.active);
  const canApprove = role === approver;
  return <Card title={<span>插播审批台 <Tag color={takeover.active ? "volcano" : "purple"}>{takeover.active ? "导播接管中" : "主编审批"}</Tag></span>}>
    <p className="muted-line">未确认的插播申请一律留在待审；接管期间由导播审批，撤销接管后回归主编。批准即写入串联单，断网批准另入应急队列并在恢复后对账。</p>
    <div className="queue-list">
      {requests.map((request) => {
        const target = items.find((item) => item.id === request.insertAfter);
        return <article key={request.id} className="approval-row">
          <div className="approval-main">
            <b>{request.headline} <Tag>{request.duration} 分钟</Tag></b>
            <small>插在「{target?.title ?? request.insertAfter}」后 · {request.reason}</small>
            <small>提交：<Tag color={ROLE_COLOR[request.ownerRole]}>{request.ownerRole}</Tag>{format(new Date(request.submittedAt), "HH:mm:ss")}
              {request.decidedBy ? <> · 审批：<Tag color={ROLE_COLOR[request.decidedBy]}>{request.decidedBy}</Tag></> : null}
              {request.offlineApproved ? <Tag color="red">断网批准·待对账</Tag> : null}
            </small>
          </div>
          {request.status === "待审"
            ? <div className="row-actions"><Button size="small" type="primary" disabled={!canApprove} title={canApprove ? "" : `当前由${approver}审批，请切换岗位`} onClick={() => dispatch(decideInsert({ id: request.id, approved: true }))}>批准（{approver}）</Button><Button size="small" danger disabled={!canApprove} onClick={() => dispatch(decideInsert({ id: request.id, approved: false }))}>驳回</Button></div>
            : <Tag color={request.status === "已批准" ? "green" : "default"}>{request.status}</Tag>}
        </article>;
      })}
      {!canApprove && <small className="hint-line">当前登录岗位为「{role}」，审批权在「{approver}」，请在右上角切换岗位。</small>}
    </div>
  </Card>;
}

/** 岗位接管台：主编离岗/上线、心跳上报、30 秒窗口 */
function TakeoverPage() {
  const dispatch = useAppDispatch();
  const { presences, takeover } = useAppSelector((state) => state.rundown);
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 250);
    return () => clearInterval(t);
  }, []);
  const editor = presences["主编"];
  const remaining = takeover.windowDeadlineAt ? Math.max(0, new Date(takeover.windowDeadlineAt).getTime() - Date.now()) : null;
  return <div className="page-stack">
    <Alert
      showIcon
      type={takeover.active ? "warning" : "success"}
      message={takeover.active
        ? takeover.windowStartedAt
          ? `接管待撤销窗口：主编已上线，${(remaining! / 1000).toFixed(0)} 秒内上报心跳即撤销接管；超时导播继续审批`
          : "导播接管审批中（主编离岗）"
        : "审批权属主编，无接管"}
      description={takeover.revokedAt ? `上次接管已于 ${format(new Date(takeover.revokedAt), "HH:mm:ss")} 因心跳恢复撤销` : undefined}
      style={{ marginBottom: 14 }}
    />
    <div className="presence-grid">
      {ALL_ROLES.map((role) => <Card key={role} size="small" title={<span><Tag color={ROLE_COLOR[role]}>{role}</Tag>{role === "主编" ? "（原审批岗）" : role === "导播" ? "（接管岗）" : ""}</span>}>
        <p className="muted-line">{presences[role].online ? "在线" : "离岗/离线"} · 最近心跳：{presences[role].lastHeartbeatAt ? format(new Date(presences[role].lastHeartbeatAt), "HH:mm:ss") : "无"}</p>
        <div className="row-actions">
          <Switch checked={presences[role].online} checkedChildren="在线" unCheckedChildren="离岗" onChange={(value) => dispatch(setPresenceOnline({ role, online: value }))} />
          <Button size="small" disabled={!presences[role].online} onClick={() => { dispatch(heartbeat({ role })); message.success(`${role} 心跳已上报`); }}>上报心跳</Button>
        </div>
        {role === "主编" && !editor.online && <small className="hint-line">主编离岗后导播立即接管，待审申请与队列归属均不变。</small>}
        {role === "主编" && presences[role].online && takeover.active && <small className="hint-line">上线后请在 30 秒内上报心跳。</small>}
      </Card>)}
    </div>
  </div>;
}

/** 离线应急队列：保留原岗位归属，恢复后逐条对账 */
function QueuePage() {
  const dispatch = useAppDispatch();
  const { queue, online } = useAppSelector((state) => state.rundown);
  return <Card title="本地应急队列" extra={<Tag color={online ? "green" : "red"}>{online ? "链路已恢复" : "断网应急中"}</Tag>}>
    <p className="muted-line">所有离线改动都保留提交岗位归属；链路恢复后逐条对账，硬时间已过而内容尚未播出的插播会撤下并保留原排期。</p>
    <div className="queue-list">{queue.length ? queue.map((item) => <article key={item.id}>
      <Tag color="red">{item.action}</Tag>
      <b>{item.detail}</b>
      <span className="queue-meta"><Tag color={ROLE_COLOR[item.ownerRole]}>{item.ownerRole}</Tag><small>{format(new Date(item.queuedAt), "HH:mm:ss")}</small></span>
    </article>) : <p>当前没有待同步操作。</p>}</div>
    <Button type="primary" disabled={!queue.length} onClick={() => { dispatch(reconcile()); message.success("离线审批已逐条对账完成"); }}>主链路恢复 · 逐条对账</Button>
  </Card>;
}

/** 冲突箱 + 双方同改模拟：确认时间较晚者生效 */
function ConflictsPage() {
  const dispatch = useAppDispatch();
  const { items, conflictBox } = useAppSelector((state) => state.rundown);
  const [itemId, setItemId] = useState(items[1]?.id ?? items[0].id);
  const [aTime, setATime] = useState("09:00:00");
  const [bTime, setBTime] = useState("09:00:05");
  const target = items.find((item) => item.id === itemId) ?? items[0];
  const fire = () => {
    const localIso = (hhmmss: string) => {
      const d = new Date(`2026-10-08T${hhmmss}`);
      return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString();
    };
    dispatch(commitVersions({
      itemId: target.id,
      a: { itemId: target.id, title: `${target.title}（导播改）`, duration: Math.max(1, target.duration - 1), confirmedBy: "导播", confirmedAt: localIso(aTime) },
      b: { itemId: target.id, title: `${target.title}（主编改）`, duration: target.duration + 2, confirmedBy: "主编", confirmedAt: localIso(bTime) }
    }));
    message.info("已按确认时间裁决：较晚版本写入串联单，较早版本进入冲突箱");
  };
  return <div className="page-stack">
    <Card title="双人同改模拟（同一串联单条目）">
      <div className="two-cols">
        <Select value={itemId} onChange={setItemId} options={items.map((item) => ({ value: item.id, label: item.title }))} />
        <div className="row-actions">
          <Input value={aTime} onChange={(e) => setATime(e.target.value)} addonBefore="导播确认" style={{ width: 150 }} />
          <Input value={bTime} onChange={(e) => setBTime(e.target.value)} addonBefore="主编确认" style={{ width: 150 }} />
          <Button type="primary" onClick={fire}>同时提交</Button>
        </div>
      </div>
    </Card>
    <Card title={`冲突箱（${conflictBox.length}）`}>
      <div className="conflict-list">{conflictBox.length ? conflictBox.map((entry) => <article key={entry.id} className="conflict-row">
        <div>
          <b>{entry.title}</b>
          <Tag color={entry.reason === "同条同时修改" ? "orange" : "red"} style={{ marginLeft: 8 }}>{entry.reason}</Tag>
          <small className="muted-line" style={{ display: "block" }}>{format(new Date(entry.createdAt), "HH:mm:ss")}</small>
        </div>
        <div className="version-box"><Tag color="green">保留（较晚）</Tag><b>{entry.winner.title}</b><small>{entry.winner.duration} 分钟 · <Tag color={ROLE_COLOR[entry.winner.confirmedBy]}>{entry.winner.confirmedBy}</Tag> {format(new Date(entry.winner.confirmedAt), "HH:mm:ss")}</small></div>
        <div className="version-box loser"><Tag>冲突箱（较早）</Tag><b>{entry.loser.title}</b><small>{entry.loser.duration} 分钟 · <Tag color={ROLE_COLOR[entry.loser.confirmedBy]}>{entry.loser.confirmedBy}</Tag> {format(new Date(entry.loser.confirmedAt), "HH:mm:ss")}</small></div>
        <Button size="small" onClick={() => dispatch(dismissConflict(entry.id))}>取回处理</Button>
      </article>) : <p className="muted-line">暂无冲突。双方同时编辑同一条目时，确认时间较晚的版本保留，另一版进入此处。</p>}</div>
    </Card>
  </div>;
}

/** 对账记录 */
function ReconciliationPage() {
  const { reconciliations } = useAppSelector((state) => state.rundown);
  return <Card title="断网审批对账记录">
    <p className="muted-line">恢复后逐条对账：一致的放行；硬时间已过而内容尚未播出的保留原排期，并把原因同步到冲突箱。</p>
    <div className="queue-list">{reconciliations.length ? reconciliations.map((entry) => <article key={entry.id}>
      <Tag color={entry.outcome === "保留原排期" ? "red" : "green"}>{entry.outcome}</Tag>
      <b>{entry.action} · {entry.detail}</b>
      <span className="queue-meta"><Tag color={ROLE_COLOR[entry.ownerRole]}>{entry.ownerRole}</Tag><small>{entry.reason}</small></span>
    </article>) : <p className="muted-line">暂无对账记录。</p>}</div>
  </Card>;
}

function ChangesPage() {
  const state = useAppSelector((root) => root.rundown);
  return <Card title="突发变更记录"><Timeline items={state.changes.map((item) => ({ children: <div><b>{item.headline}</b><p>{item.reason} · 插播 {item.duration} 分钟{item.ownerRole ? ` · ${item.ownerRole}提交` : ""}{item.decidedBy ? ` · ${item.decidedBy}批准` : ""}</p><small>{format(new Date(item.createdAt), "HH:mm:ss")}</small></div> }))} /></Card>;
}

function HistoryPage() {
  const state = useAppSelector((root) => root.rundown);
  return <Card title="操作历史"><Timeline items={state.history.map((entry) => ({ color: "blue", children: <div><b>{entry.label}</b><p>{entry.detail}</p><small>{format(new Date(entry.time), "HH:mm:ss")}</small></div> }))} /></Card>;
}

export default function App() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.rundown);
  const { data = [] } = useGetRundownQuery();
  const { t, i18n } = useTranslation();
  useTakeoverTicker();
  useEffect(() => { if (data.length) dispatch(initialize(data)); }, [data, dispatch]);
  const pendingCount = state.requests.filter((request) => request.status === "待审").length;
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span>LIVE</span><div><b>{t("title")}</b><small>Control room</small></div></div>
      <nav>
        <NavLink to="/">{t("rundown")}</NavLink>
        <NavLink to="/approvals">{t("approvals")} {pendingCount ? <em>{pendingCount}</em> : null}</NavLink>
        <NavLink to="/takeover">{t("takeover")}</NavLink>
        <NavLink to="/queue">{t("queue")} {state.queue.length ? <em>{state.queue.length}</em> : null}</NavLink>
        <NavLink to="/conflicts">{t("conflicts")} {state.conflictBox.length ? <em>{state.conflictBox.length}</em> : null}</NavLink>
        <NavLink to="/reconciliations">{t("reconciliations")} {state.reconciliations.length ? <em>{state.reconciliations.length}</em> : null}</NavLink>
        <NavLink to="/changes">{t("changes")}</NavLink>
        <NavLink to="/history">{t("history")}</NavLink>
      </nav>
      <Button ghost onClick={() => void i18n.changeLanguage(i18n.language === "zh" ? "en" : "zh")}>{i18n.language === "zh" ? "EN" : "中文"}</Button>
    </aside>
    <main>
      <header className="topbar">
        <div><small>直播运行中 · 紧急操作均保留审计记录</small><h1>{t("title")}</h1></div>
        <div className="top-actions">
          <label>在线模式 <Switch checked={state.online} onChange={(value) => dispatch(setOnline(value))} /></label>
          <label>当前岗位 <Select<Role> value={state.role} onChange={(value) => dispatch(setRole(value))} options={ALL_ROLES.map((role) => ({ value: role, label: role }))} style={{ width: 90 }} /></label>
          {state.takeover.active && <Badge status="processing" text={<span className="takeover-pill">导播接管{state.takeover.windowStartedAt ? " · 撤销窗口中" : ""}</span>} />}
        </div>
      </header>
      <Routes>
        <Route path="/" element={<RundownPage />} />
        <Route path="/approvals" element={<ApprovalsPage />} />
        <Route path="/takeover" element={<TakeoverPage />} />
        <Route path="/queue" element={<QueuePage />} />
        <Route path="/conflicts" element={<ConflictsPage />} />
        <Route path="/reconciliations" element={<ReconciliationPage />} />
        <Route path="/changes" element={<ChangesPage />} />
        <Route path="/history" element={<HistoryPage />} />
      </Routes>
    </main>
  </div>;
}
