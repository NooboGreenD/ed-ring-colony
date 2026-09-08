"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import ProjectCard from "@/components/Projects/ProjectCard";
import { Toaster, toast } from "@/components/ui/Toaster";
import type { Project } from "@/types/project";

type Filter = "all" | "active" | "paused" | "completed" | "archived";
type SortKey = "created" | "name" | "progress" | "systems";

const statusLabels: Record<string, string> = {
  active: "Активен",
  paused: "Приостановлен",
  completed: "Завершён",
  archived: "Архив",
};

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState("#3b82f6");
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("created");
  const [user, setUser] = useState<any>(null);

  const load = async () => {
    setLoading(true);
    const res = await fetch("/api/projects?limit=100");
    const data = await res.json();
    setProjects(data.projects || []);
    setLoading(false);
  };

  useEffect(() => {
    load();
    supabase.auth.getUser().then(({ data }) => setUser(data.user));
  }, []);

  const createProject = async () => {
    if (!name.trim()) {
      toast("Введите название проекта", "error");
      return;
    }
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description, color }),
    });
    if (res.ok) {
      toast("Проект создан", "success");
      setShowCreate(false);
      setName("");
      setDescription("");
      setColor("#3b82f6");
      load();
    } else {
      const j = await res.json().catch(() => ({}));
      toast(j.error || "Ошибка создания", "error");
    }
  };

  const filtered = useMemo(() => {
    let list = [...projects];
    if (filter !== "all") {
      list = list.filter((p) => p.status === filter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.description || "").toLowerCase().includes(q)
      );
    }
    list.sort((a, b) => {
      switch (sort) {
        case "name":
          return a.name.localeCompare(b.name);
        case "progress": {
          const pa = a.system_count ? (a.systems_done || 0) / a.system_count : 0;
          const pb = b.system_count ? (b.systems_done || 0) / b.system_count : 0;
          return pb - pa;
        }
        case "systems":
          return (b.system_count || 0) - (a.system_count || 0);
        case "created":
        default:
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      }
    });
    return list;
  }, [projects, filter, search, sort]);

  const filterCounts = useMemo(() => {
    const counts: Record<string, number> = { all: projects.length };
    for (const p of projects) {
      counts[p.status] = (counts[p.status] || 0) + 1;
    }
    return counts;
  }, [projects]);

  return (
    <main className="card" style={{ width: "100%" }}>
      <Toaster />

      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 20,
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <div>
          <div className="kicker">Эскадрильи // Управление</div>
          <h1 style={{ marginTop: 8, fontSize: 20, letterSpacing: 3 }}>
            Проекты колонизации
          </h1>
        </div>
        {user && (
          <button
            onClick={() => setShowCreate(!showCreate)}
            className="btn btn-orange"
          >
            {showCreate ? "Отмена" : "+ Создать проект"}
          </button>
        )}
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="project-form">
          <h3>Новый проект</h3>
          <div className="project-form-grid">
            <input
              placeholder="Название проекта *"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <textarea
              placeholder="Описание миссии..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              style={{ minHeight: 60 }}
            />
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <label
                style={{
                  color: "var(--muted)",
                  fontSize: 12,
                  fontFamily: "ui-monospace, monospace",
                  letterSpacing: 1,
                  textTransform: "uppercase",
                }}
              >
                Цвет:
              </label>
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                style={{
                  width: 48,
                  height: 32,
                  border: "none",
                  borderRadius: 2,
                  cursor: "pointer",
                  padding: 0,
                }}
              />
              <span
                style={{
                  color: color,
                  fontSize: 12,
                  fontWeight: 600,
                  fontFamily: "ui-monospace, monospace",
                }}
              >
                {color}
              </span>
            </div>
          </div>
          <div className="project-form-actions">
            <button onClick={createProject} className="btn btn-cyan">
              Создать проект
            </button>
            <button onClick={() => setShowCreate(false)} className="btn">
              Отмена
            </button>
          </div>
        </div>
      )}

      {/* Toolbar */}
      <div className="projects-toolbar">
        <input
          type="search"
          placeholder="Поиск проектов..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="filter-pills">
          {(
            [
              ["all", "Все"],
              ["active", "Активные"],
              ["paused", "Приостановленные"],
              ["completed", "Завершённые"],
              ["archived", "Архив"],
            ] as [Filter, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={`filter-pill${filter === key ? " active" : ""}`}
            >
              {label}
              <span className="count">({filterCounts[key] || 0})</span>
            </button>
          ))}
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
          {(
            [
              ["created", "Дата"],
              ["name", "Название"],
              ["progress", "Прогресс"],
              ["systems", "Системы"],
            ] as [SortKey, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setSort(key)}
              className={`sort-btn${sort === key ? " active" : ""}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <p
          style={{
            color: "var(--muted)",
            fontFamily: "ui-monospace, monospace",
            letterSpacing: 2,
            textTransform: "uppercase",
            fontSize: 12,
            padding: "40px 0",
            textAlign: "center",
          }}
        >
          Загрузка проектов...
        </p>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">&#128640;</div>
          <h3>Проектов не найдено</h3>
          <p>
            {projects.length === 0
              ? "Создайте первую эскадрилью для координации строительства"
              : "Попробуйте изменить фильтры или поисковый запрос"}
          </p>
        </div>
      ) : (
        <div className="table-scroll">
          <table className="projects-table">
            <thead>
              <tr>
                <th>Проект</th>
                <th style={{ textAlign: "center" }}>Статус</th>
                <th style={{ textAlign: "right" }}>Пилотов</th>
                <th style={{ textAlign: "right" }}>Систем</th>
                <th style={{ textAlign: "right" }}>Готово</th>
                <th style={{ textAlign: "right" }}>Строится</th>
                <th style={{ minWidth: 140 }}>Прогресс</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <ProjectCard key={p.id} project={p} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
