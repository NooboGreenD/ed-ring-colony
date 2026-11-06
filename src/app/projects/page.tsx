"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import ProjectCard from "@/components/Projects/ProjectCard";
import { toast } from "@/components/ui/Toaster";
import { useI18n } from '@/lib/i18n/I18nContext';
import type { Project } from "@/types/project";

type Filter = "all" | "active" | "paused" | "completed" | "archived";
type SortKey = "created" | "name" | "progress" | "systems";

const statusLabels: Record<string, string> = {
  active: "pg.statusActive",
  paused: "pg.statusPaused",
  completed: "pg.statusCompleted",
  archived: "pg.statusArchived",
};

export default function ProjectsPage() {
  const { t } = useI18n();
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
      toast(t('pg.enterName'), "error");
      return;
    }
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description, color }),
    });
    if (res.ok) {
      toast(t('pg.created'), "success");
      setShowCreate(false);
      setName("");
      setDescription("");
      setColor("#3b82f6");
      load();
    } else {
      const j = await res.json().catch(() => ({}));
      toast(j.error || t('pg.createFailed'), "error");
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
          <div className="kicker">{t('pg.kicker')}</div>
          <h1 style={{ marginTop: 8, fontSize: 20, letterSpacing: 3 }}>
            {t('pg.title')}
          </h1>
        </div>
        {user && (
          <button
            onClick={() => setShowCreate(!showCreate)}
            className="btn btn-orange"
          >
            {showCreate ? t('pg.cancel') : t('pg.createToggle')}
          </button>
        )}
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="project-form">
          <h3>{t('pg.newProject')}</h3>
          <div className="project-form-grid">
            <input
              placeholder={t('pg.namePlaceholder')}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <textarea
              placeholder={t('pg.descPlaceholder')}
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
                {t('pg.color')}
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
              {t('pg.createButton')}
            </button>
            <button onClick={() => setShowCreate(false)} className="btn">
              {t('pg.cancel')}
            </button>
          </div>
        </div>
      )}

      {/* Toolbar */}
      <div className="projects-toolbar">
        <input
          type="search"
          placeholder={t('pg.searchPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="filter-pills">
          {(
            [
              ["all", "pg.filterAll"],
              ["active", "pg.filterActive"],
              ["paused", "pg.filterPaused"],
              ["completed", "pg.filterCompleted"],
              ["archived", "pg.filterArchived"],
            ] as [Filter, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={`filter-pill${filter === key ? " active" : ""}`}
            >
              {t(label)}
              <span className="count">({filterCounts[key] || 0})</span>
            </button>
          ))}
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
          {(
            [
              ["created", "pg.sortCreated"],
              ["name", "pg.sortName"],
              ["progress", "pg.sortProgress"],
              ["systems", "pg.sortSystems"],
            ] as [SortKey, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setSort(key)}
              className={`sort-btn${sort === key ? " active" : ""}`}
            >
              {t(label)}
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
          {t('pg.loading')}
        </p>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">&#128640;</div>
          <h3>{t('pg.emptyTitle')}</h3>
          <p>
            {projects.length === 0
              ? t('pg.emptyNoProjects')
              : t('pg.emptyFiltered')}
          </p>
        </div>
      ) : (
        <div className="table-scroll">
          <table className="projects-table">
            <thead>
              <tr>
                <th>{t('pg.colProject')}</th>
                <th style={{ textAlign: "center" }}>{t('pg.colStatus')}</th>
                <th style={{ textAlign: "right" }}>{t('pg.colPilots')}</th>
                <th style={{ textAlign: "right" }}>{t('pg.colSystems')}</th>
                <th style={{ textAlign: "right" }}>{t('pg.colDone')}</th>
                <th style={{ textAlign: "right" }}>{t('pg.colBuilding')}</th>
                <th style={{ minWidth: 140 }}>{t('pg.colProgress')}</th>
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
