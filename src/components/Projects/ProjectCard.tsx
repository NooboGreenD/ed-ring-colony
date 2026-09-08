"use client";

import Link from "next/link";
import type { Project } from "@/types/project";

interface Props {
  project: Project;
}

const statusMap: Record<string, { label: string; class: string }> = {
  active: { label: "Активен", class: "active" },
  paused: { label: "Приостановлен", class: "paused" },
  completed: { label: "Завершён", class: "completed" },
  archived: { label: "Архив", class: "archived" },
};

export default function ProjectCard({ project }: Props) {
  const st = statusMap[project.status] || { label: project.status, class: "archived" };
  const total = project.system_count || 0;
  const done = project.systems_done || 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <tr>
      <td data-label="Проект">
        <Link href={`/projects/${project.id}`} style={{ textDecoration: "none" }}>
          <div className="col-name">
            <div className="color-bar" style={{ background: project.color }} />
            <div>
              <div className="name-text">{project.name}</div>
              {project.description && (
                <div className="name-desc" title={project.description}>
                  {project.description}
                </div>
              )}
            </div>
          </div>
        </Link>
      </td>
      <td data-label="Статус" className="col-status">
        <span className={`status-pip ${st.class}`} />
        <span className="status-label">{st.label}</span>
      </td>
      <td data-label="Пилотов" className="col-num">{project.member_count || 0}</td>
      <td data-label="Систем" className="col-num">{total}</td>
      <td data-label="Готово" className="col-num">{done}</td>
      <td data-label="Строится" className="col-num">{project.systems_building || 0}</td>
      <td data-label="Прогресс" style={{ minWidth: 140 }}>
        {total > 0 && (
          <>
            <div className="progress-thin">
              <div className="fill" style={{ width: `${pct}%`, background: project.color }} />
            </div>
            <div className="progress-text">{pct}%</div>
          </>
        )}
      </td>
    </tr>
  );
}
