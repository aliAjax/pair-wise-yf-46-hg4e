import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button, Tag } from "antd";
import type { RundownItem } from "../types";

export function SortableItem({ item, cumulative, onStatus, onSkip, onDuration }: { item: RundownItem; cumulative: string; onStatus: () => void; onSkip: () => void; onDuration: (delta: number) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: item.id, disabled: item.status === "已播出" });
  return (
    <article ref={setNodeRef} className={`rundown-row status-${item.status}`} style={{ transform: CSS.Transform.toString(transform), transition }}>
      <button className="drag-handle" {...attributes} {...listeners}>⠿</button>
      <time>{cumulative}</time>
      <div className="row-main"><b>{item.title}</b><small>{item.source} · {item.presenter}</small></div>
      <Tag color={item.type === "广告" ? "gold" : item.type === "连线" ? "blue" : "geekblue"}>{item.type}</Tag>
      <span>{item.duration} 分钟</span>
      <Tag color={item.status === "已播出" ? "green" : item.status === "已跳过" ? "red" : "default"}>{item.status}</Tag>
      <div className="row-actions">
        <Button size="small" onClick={() => onDuration(-1)}>-1</Button>
        <Button size="small" onClick={() => onDuration(1)}>+1</Button>
        <Button size="small" type="primary" disabled={item.status === "已播出"} onClick={onStatus}>播出</Button>
        <Button size="small" danger disabled={item.status === "已播出"} onClick={onSkip}>取消</Button>
      </div>
    </article>
  );
}
