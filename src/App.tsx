import { useEffect, useState } from "react";
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove, SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Button, Card, Form, Input, InputNumber, Select, Switch, Tag, Timeline, message } from "antd";
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
  addItem, adjustDuration, approveApplication, heartbeat, initialize, markSynced,
  reorder, rejectApplication, setOnline, setRole, skipItem, submitApplication,
  syncQueue, takeOver, tickTakeover, undo, updateStatus
} from "./store/rundownSlice";
import type { ItemType, Role, RundownItem } from "./types";

const schema = z.object({ title: z.string().min(2), type: z.enum(["新闻片", "连线", "嘉宾", "口播", "广告"]), duration: z.number().min(1).max(120), presenter: z.string().min(1), source: z.string().min(1) });
type FormValues = z.infer<typeof schema>;

function useTimeline(items: RundownItem[]) {
  const start = new Date("2026-10-08T08:00:00");
  let cursor = start;
  return items.map((item) => {
    const current = cursor;
    cursor = addMinutes(cursor, item.duration);
    return { item, at: format(current, "HH:mm"), duration: item.duration };
  });
}

/** 审批权限：主编，或接管期间的导播 */
function useCanApprove() {
  const role = useAppSelector((state) => state.rundown.role);
  const takeover = useAppSelector((state) => state.rundown.takeover);
  return role === "主编" || (role === "导播" && !!takeover);
}

/** 岗位接管条：导播接管 / 主编恢复心跳 / 心跳窗口倒计时 */
function TakeoverBanner() {
  const dispatch = useAppDispatch();
  const role = useAppSelector((state) => state.rundown.role);
  const takeover = useAppSelector((state) => state.rundown.takeover);
  const [, force] = useState(0);
  useEffect(() => {
    if (!takeover) return;
    const timer = setInterval(() => { dispatch(tickTakeover()); force((n) => n + 1); }, 1000);
    return () => clearInterval(timer);
  }, [takeover, dispatch]);

  if (takeover) {
    const left = Math.max(0, Math.round((new Date(takeover.deadline).getTime() - Date.now()) / 1000));
    return <Card className="takeover-card" size="small">
      <Tag color="orange">岗位接管中</Tag>
      <span><b>{takeover.from}</b> 离岗 → <b>{takeover.by}</b> 接管审批</span>
      {takeover.continued ? <Tag color="blue">导播继续审批</Tag> : <Tag color="red">心跳窗口剩余 {left}s</Tag>}
    </Card>;
  }
  if (role === "导播") return <Card className="takeover-card" size="small">
    <span>主编临时离岗时，导播可接管审批（30 秒心跳窗口）。</span>
    <Button size="small" type="primary" onClick={() => dispatch(takeOver())}>接管审批</Button>
  </Card>;
  if (role === "主编") return <Card className="takeover-card" size="small">
    <span>接管期间请及时恢复心跳，撤销导播接管。</span>
    <Button size="small" onClick={() => dispatch(heartbeat())}>恢复心跳</Button>
  </Card>;
  return null;
}

/** 待审插播申请：未确认前留在待审，具备审批权的岗位批准后才插入串联单 */
function PendingApplications() {
  const dispatch = useAppDispatch();
  const role = useAppSelector((state) => state.rundown.role);
  const applications = useAppSelector((state) => state.rundown.applications);
  const canApprove = useCanApprove();
  const pending = applications.filter((app) => app.status === "待审");
  if (!pending.length) return null;
  return <Card title={`待审插播申请（${pending.length}）`} className="pending-card">
    {pending.map((app) => <article key={app.id} className="pending-row">
      <div><Tag color="gold">{app.submittedBy} 提交</Tag><b>{app.headline}</b><small>{app.duration} 分钟 · {app.reason} · {format(new Date(app.createdAt), "HH:mm:ss")}</small></div>
      {canApprove
        ? <div className="row-actions"><Button size="small" type="primary" onClick={() => { dispatch(approveApplication(app.id)); message.success("已批准插播申请"); }}>批准</Button><Button size="small" danger onClick={() => { dispatch(rejectApplication(app.id)); message.info("已驳回插播申请"); }}>驳回</Button></div>
        : <Tag>待 {role === "导播" ? "主编或接管导播" : "主编"} 审批</Tag>}
    </article>)}
  </Card>;
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

  useEffect(() => {
    if (!online) return; // 离线时不写远端，保留主链路原状
    const timer = setTimeout(() => {
      void saveMutation(items);
      dispatch(markSynced(items));
    }, 250);
    return () => clearTimeout(timer);
  }, [items, online, saveMutation, dispatch]);

  const onDragEnd = (event: DragEndEvent) => {
    if (!event.over || event.active.id === event.over.id || role !== "导播") return;
    const oldIndex = items.findIndex((item) => item.id === event.active.id);
    const newIndex = items.findIndex((item) => item.id === event.over!.id);
    dispatch(reorder(arrayMove(items, oldIndex, newIndex)));
  };

  const submit = (values: FormValues) => {
    dispatch(addItem(values));
    reset();
  };

  return <div className="page-grid">
    <Card className="main-card">
      <div className="card-heading"><div><small>2026-10-08 · 08:00 开播</small><h2>直播串联单</h2></div><div className="head-actions"><Tag color={online ? "green" : "red"}>{online ? "主备链路正常" : "本地应急模式"}</Tag><Button onClick={() => dispatch(undo())} disabled={!role || role === "字幕"}>撤回上一步</Button></div></div>
      <TakeoverBanner />
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
      <PendingApplications />
    </aside>
  </div>;
}

function BreakingForm() {
  const dispatch = useAppDispatch();
  const { items, online } = useAppSelector((state) => state.rundown);
  const [values, setValues] = useState({ headline: "", duration: 5, insertAfter: items[0]?.id ?? "", reason: "突发新闻" });
  return <Card title="突发插播申请" className="breaking-card">
    <Input value={values.headline} onChange={(event) => setValues({ ...values, headline: event.target.value })} placeholder="插播标题" />
    <div className="two-cols"><InputNumber value={values.duration} onChange={(value) => setValues({ ...values, duration: Number(value ?? 5) })} addonAfter="分钟" /><Select value={values.insertAfter} onChange={(value) => setValues({ ...values, insertAfter: value })} options={items.map((item) => ({ value: item.id, label: `插在「${item.title}」后` }))} /></div>
    <Input value={values.reason} onChange={(event) => setValues({ ...values, reason: event.target.value })} placeholder="插播原因" />
    <Button type="primary" danger block disabled={values.headline.length < 2} onClick={() => { dispatch(submitApplication(values)); if (!online) message.warning("已进入本地应急队列，待审批后播出"); setValues({ ...values, headline: "" }); }}>提交插播申请（待审）</Button>
    {!online && <small>离线提交将保留岗位归属，主链路恢复后逐条对账。</small>}
  </Card>;
}

function ChainPage({ mode }: { mode: "changes" | "queue" | "history" | "conflicts" }) {
  const state = useAppSelector((root) => root.rundown);
  if (mode === "queue") return <Card title="本地应急队列"><div className="queue-list">{state.queue.length ? state.queue.map((item) => <article key={item.id}><Tag color="red">{item.action}</Tag><Tag color="blue">{item.role} 提交</Tag><b>{item.detail}</b><small>{format(new Date(item.confirmedAt), "HH:mm:ss")}</small></article>) : <p>当前没有待同步操作。</p>}</div><Button type="primary" disabled={state.online} onClick={() => { dispatchSync(); }}>恢复并逐条对账</Button></Card>;
  if (mode === "conflicts") return <Card title="冲突箱"><div className="queue-list">{state.conflicts.length ? state.conflicts.map((item) => <article key={item.id} className="conflict-row"><Tag color="orange">保留{item.kept === "local" ? "本地" : "远端"}版本</Tag><b>{item.itemTitle}</b><small>{item.reason}</small><small>{format(new Date(item.detectedAt), "HH:mm:ss")}</small></article>) : <p>双方同时修改同一串联单条目时，确认较晚的版本保留，另一版进入冲突箱。</p>}</div></Card>;
  if (mode === "changes") return <Card title="突发变更记录"><Timeline items={state.changes.map((item) => ({ children: <div><b>{item.headline}</b><p>{item.reason} · 插播 {item.duration} 分钟</p><small>{format(new Date(item.createdAt), "HH:mm:ss")}</small></div> }))} /></Card>;
  return <Card title="操作历史"><Timeline items={state.history.map((entry) => ({ color: "blue", children: <div><b>{entry.label}</b><p>{entry.detail}</p><small>{format(new Date(entry.time), "HH:mm:ss")}</small></div> }))} /></Card>;
}

function dispatchSync() {
  window.dispatchEvent(new Event("sync-queue"));
}

export default function App() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.rundown);
  const { data = [] } = useGetRundownQuery();
  const { t, i18n } = useTranslation();
  useEffect(() => { if (data.length) dispatch(initialize(data)); }, [data, dispatch]);
  useEffect(() => {
    const handler = () => { dispatch(syncQueue()); message.success("应急队列已逐条对账"); };
    window.addEventListener("sync-queue", handler);
    return () => window.removeEventListener("sync-queue", handler);
  }, [dispatch]);
  useEffect(() => {
    const timer = setInterval(() => dispatch(tickTakeover()), 1000);
    return () => clearInterval(timer);
  }, [dispatch]);
  const pendingCount = state.applications.filter((app) => app.status === "待审").length;
  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><span>LIVE</span><div><b>{t("title")}</b><small>Control room</small></div></div><nav><NavLink to="/">{t("rundown")}</NavLink><NavLink to="/changes">{t("changes")}</NavLink><NavLink to="/queue">{t("queue")} {state.queue.length ? <em>{state.queue.length}</em> : null}</NavLink><NavLink to="/conflicts">{t("conflicts")} {state.conflicts.length ? <em>{state.conflicts.length}</em> : null}</NavLink><NavLink to="/history">{t("history")}</NavLink></nav><Button ghost onClick={() => void i18n.changeLanguage(i18n.language === "zh" ? "en" : "zh")}>{i18n.language === "zh" ? "EN" : "中文"}</Button></aside>
    <main><header className="topbar"><div><small>直播运行中 · 紧急操作均保留审计记录</small><h1>{t("title")}</h1></div><div className="top-actions"><label>在线模式 <Switch checked={state.online} onChange={(value) => dispatch(setOnline(value))} /></label><label>当前岗位 <Select<Role> value={state.role} onChange={(value) => dispatch(setRole(value))} options={[{ value: "导播" }, { value: "主编" }, { value: "字幕" }, { value: "演播室" }]} /></label></div></header><Routes><Route path="/" element={<RundownPage />} /><Route path="/changes" element={<ChainPage mode="changes" />} /><Route path="/queue" element={<ChainPage mode="queue" />} /><Route path="/conflicts" element={<ChainPage mode="conflicts" />} /><Route path="/history" element={<ChainPage mode="history" />} /></Routes></main>
  </div>;
}
