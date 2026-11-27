"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ArchitectNav from "./ArchitectNav";
import LoadingPatternTeam from "./LoadingPatternTeam";
import type { LoadingCollaboration } from "@/lib/architect/loadingPatternMembers";
import { authFetch, supabase } from "@/lib/supabaseClient";
import { useI18n } from "@/lib/i18n/I18nContext";
import { INSTALLATIONS, installationName } from "@/lib/architect/catalogue";
import {
  distributeLoading,
  distributeLoadingRecipes,
  loadingRequirements,
  parseLoadingPattern,
  unassignedLoading,
  type LoadingPattern,
  type LoadingPatternView,
  type loadingProgress,
} from "@/lib/architect/loadingPatterns";

import {
  loadingCategories,
  loadingCategoryName,
  loadingGoodCategory,
  loadingGoodColor,
  orderLoadingGoods,
  type LoadingGoodsOrder,
} from "@/lib/architect/loadingGoods";

type Progress = ReturnType<typeof loadingProgress>;
const empty = (): LoadingPattern => ({
  name: "",
  visibility: "private",
  buildings: [],
  carriers: [],
  allocations: {},
});
export default function LoadingPatternsWorkspace() {
  const { t, locale } = useI18n();
  const [goodsOrder, setGoodsOrder] = useState<LoadingGoodsOrder>("recipe");
  const [category, setCategory] = useState("");
  const [query, setQuery] = useState("");
  const [showCompleted, setShowCompleted] = useState(true);
  const [onlyUnassigned, setOnlyUnassigned] = useState(false);
  const [distribution, setDistribution] = useState("sequential");
  const [scope, setScope] = useState<"mine" | "public">("mine");
  const [list, setList] = useState<LoadingPatternView[]>([]);
  const [selected, setSelected] = useState<LoadingPatternView | null>(null);
  const [draft, setDraft] = useState<LoadingPattern>(empty);
  const [dirty, setDirty] = useState(false);
  const [collaboration, setCollaboration] =
    useState<LoadingCollaboration | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [checked, setChecked] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [reference, setReference] = useState("");
  const [available, setAvailable] = useState<LoadingPattern["carriers"]>([]);
  const epoch = useRef(0);
  const requestSequence = useRef(0);
  const busyRef = useRef(false);
  const dirtyRef = useRef(false);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const listSequence = useRef(0);
  const authUserRef = useRef<string | null>(null);
  dirtyRef.current = dirty;
  const tRef = useRef(t);
  tRef.current = t;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const draftRevision = useRef(0);
  const nf = new Intl.NumberFormat(locale);
  const editable = !selected || selected.canEdit;
  const update = (value: LoadingPattern) => {
    draftRevision.current++;
    setDraft(value);
    setDirty(true);
    dirtyRef.current = true;
    setError("");
    setNotice("");
  };
  const label = (good: string) => {
    const key = `commodity.${good}`;
    const value = t(key);
    return value === key ? good : value;
  };
  const requirements = useMemo(
    () => loadingRequirements(draft.buildings),
    [draft.buildings],
  );
  const matchesGood = (good: string) =>
    (!category || loadingGoodCategory(good) === category) &&
    (!query.trim() ||
      `${label(good)} ${good}`
        .toLocaleLowerCase(locale)
        .includes(query.trim().toLocaleLowerCase(locale)));
  const sortedGoods = <
    T extends {
      commodity: string;
      required: number;
      remaining?: number | null;
    },
  >(
    rows: T[],
  ) =>
    orderLoadingGoods(
      rows.filter((row) => matchesGood(row.commodity)),
      goodsOrder,
      label,
      locale,
    );
  const total = Object.values(requirements).reduce((a, b) => a + b, 0);
  const unassigned = useMemo(() => unassignedLoading(draft), [draft]);
  const allocationInvalid = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const carrier of draft.carriers) {
      let sum = 0;
      for (const [good, qty] of Object.entries(
        draft.allocations[carrier.carrierId] ?? {},
      )) {
        if (
          !Number.isSafeInteger(qty) ||
          qty < 0 ||
          !Object.hasOwn(requirements, good)
        )
          return true;
        sum += qty;
        totals[good] = (totals[good] ?? 0) + qty;
        if (totals[good] > requirements[good]) return true;
      }
      if (sum > carrier.capacity) return true;
    }
    return false;
  }, [draft, requirements]);
  const matrixRows = sortedGoods(
    Object.entries(requirements).map(([commodity, required]) => ({
      commodity,
      required,
      remaining: unassigned[commodity] ?? 0,
    })),
  ).filter((row) => !onlyUnassigned || (unassigned[row.commodity] ?? 0) > 0);
  const categoryTitle = (good: string) =>
    loadingCategoryName(loadingGoodCategory(good), locale);
  const outstanding = Object.values(unassigned).reduce((a, b) => a + b, 0);
  const loadList = useCallback(async () => {
    const version = epoch.current;
    const sequence = ++listSequence.current;
    try {
      const response = await authFetch(
        `/api/architect/loading-patterns?scope=${scopeRef.current}`,
        { cache: "no-store" },
      );
      const data = await response.json();
      if (version !== epoch.current || sequence !== listSequence.current)
        return;
      if (!response.ok)
        throw new Error(data.error || tRef.current("lp.unavailable"));
      setList(data.patterns ?? []);
    } catch (e) {
      if (version === epoch.current && sequence === listSequence.current)
        setError(
          e instanceof Error ? e.message : tRef.current("lp.unavailable"),
        );
    }
  }, []);
  const open = useCallback(async (id: string, refresh = false) => {
    const version = epoch.current;
    const sequence = ++requestSequence.current;
    const revision = draftRevision.current;
    try {
      const response = await authFetch(
        `/api/architect/loading-patterns/${id}`,
        { cache: "no-store" },
      );
      const data = await response.json();
      if (version !== epoch.current || sequence !== requestSequence.current)
        return;
      if (!response.ok)
        throw new Error(data.error || tRef.current("lp.unavailable"));
      if (refresh && dirtyRef.current) return;
      if (!refresh && revision !== draftRevision.current) return;
      if (refresh && data.pattern.version !== selectedRef.current?.version) {
        setProgress(null);
        setCollaboration(null);
        setError(tRef.current("lp.conflict"));
        return;
      }
      if (!refresh) {
        setSelected(data.pattern);
        setDraft(data.pattern.pattern);
        setDirty(false);
        dirtyRef.current = false;
        window.history.replaceState(null, "", `?pattern=${id}`);
      }
      setCollaboration(data.collaboration ?? null);
      setProgress(data.progress);
      setChecked(data.checkedAt);
      setError("");
    } catch (e) {
      if (version === epoch.current && sequence === requestSequence.current) {
        setProgress(null);
        setCollaboration(null);
        setError(
          e instanceof Error ? e.message : tRef.current("lp.unavailable"),
        );
      }
    }
  }, []);
  useEffect(() => {
    setList([]);
    void loadList();
    return () => {
      listSequence.current++;
    };
  }, [scope, loadList]);
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("pattern");
    if (id) void open(id);
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      const userId = session?.user.id ?? null;
      if (event === "INITIAL_SESSION") {
        authUserRef.current = userId;
        return;
      }
      if (authUserRef.current === userId) return;
      authUserRef.current = userId;
      epoch.current++;
      requestSequence.current++;
      setSelected(null);
      setCollaboration(null);
      setDraft(empty());
      setProgress(null);
      setList([]);
      setAvailable([]);
      setDirty(false);
      dirtyRef.current = false;
      setError("");
      setNotice("");
      setBusy(false);
      busyRef.current = false;
      queueMicrotask(() => void loadList());
    });
    return () => {
      epoch.current++;
      subscription.unsubscribe();
    };
  }, [open, loadList]);
  useEffect(() => {
    if (!selected) return;
    const timer = setInterval(() => {
      if (
        document.visibilityState === "visible" &&
        !dirtyRef.current &&
        !busyRef.current
      )
        void open(selected.id, true);
    }, 30000);
    return () => clearInterval(timer);
  }, [selected?.id, open]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  const confirmDiscard = () => !dirty || window.confirm(t("lp.discard"));
  const save = async () => {
    if (busyRef.current || !editable) return;
    let pattern;
    try {
      pattern = parseLoadingPattern(draft);
    } catch {
      setError(t("lp.invalid"));
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError("");
    const version = epoch.current;
    try {
      const response = await authFetch(
        "/api/architect/loading-patterns" + (selected ? `/${selected.id}` : ""),
        {
          method: selected ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...pattern,
            ...(selected ? { version: selected.version } : {}),
          }),
        },
      );
      const data = await response.json();
      if (version !== epoch.current) return;
      if (!response.ok)
        throw new Error(data.error || tRef.current("lp.unavailable"));
      setSelected(data.pattern);
      setDraft(data.pattern.pattern);
      setDirty(false);
      dirtyRef.current = false;
      setNotice(t("lp.saved"));
      void loadList();
      void open(data.pattern.id);
    } catch (e) {
      if (version === epoch.current)
        setError(
          e instanceof Error ? e.message : tRef.current("lp.unavailable"),
        );
    } finally {
      if (version === epoch.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };
  const remove = async () => {
    if (
      !selected?.canEdit ||
      busyRef.current ||
      !window.confirm(t("lp.deleteConfirm"))
    )
      return;
    busyRef.current = true;
    setBusy(true);
    const version = epoch.current;
    try {
      const response = await authFetch(
        `/api/architect/loading-patterns/${selected.id}`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ version: selected.version }),
        },
      );
      const data = await response.json();
      if (version !== epoch.current) return;
      if (!response.ok) throw new Error(data.error);
      setSelected(null);
      setCollaboration(null);
      setDraft(empty());
      setProgress(null);
      setDirty(false);
      void loadList();
    } catch (e) {
      if (version === epoch.current)
        setError(
          e instanceof Error ? e.message : tRef.current("lp.unavailable"),
        );
    } finally {
      if (version === epoch.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };
  const mutateTeam = async (
    method: "POST" | "PATCH" | "DELETE",
    body: Record<string, unknown>,
  ) => {
    const current = selectedRef.current;
    if (!current || dirtyRef.current || busyRef.current) return false;
    const version = epoch.current;
    busyRef.current = true;
    setBusy(true);
    setProgress(null);
    requestSequence.current++;
    try {
      const response = await authFetch(
        `/api/architect/loading-patterns/${current.id}/members`,
        {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const data = await response.json();
      if (version !== epoch.current || selectedRef.current?.id !== current.id)
        return false;
      if (!response.ok)
        throw new Error(data.error || tRef.current("lp.unavailable"));
      setCollaboration(null);
      await open(current.id, true);
      void loadList();
      return true;
    } catch (error) {
      if (version === epoch.current)
        setError(
          error instanceof Error
            ? error.message
            : tRef.current("lp.unavailable"),
        );
      return false;
    } finally {
      if (version === epoch.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };
  const addCarrier = (carrier: LoadingPattern["carriers"][number]) => {
    draftRevision.current++;
    setDraft((current) =>
      current.carriers.some((row) => row.carrierId === carrier.carrierId) ||
      current.carriers.length >= 20
        ? current
        : {
            ...current,
            carriers: [...current.carriers, carrier],
            allocations: { ...current.allocations, [carrier.carrierId]: {} },
          },
    );
    setDirty(true);
    dirtyRef.current = true;
  };
  const findCarrier = async () => {
    const revision = draftRevision.current;
    const sequence = requestSequence.current;
    const version = epoch.current;
    try {
      const response = await authFetch(
        `/api/carriers/${encodeURIComponent(reference.trim())}`,
        { cache: "no-store" },
      );
      const data = await response.json();
      if (version !== epoch.current) return;
      if (
        revision !== draftRevision.current ||
        sequence !== requestSequence.current
      )
        return;
      if (!response.ok || !data.carrier) throw new Error(t("lp.notFound"));
      const c = data.carrier;
      addCarrier({
        carrierId: c.carrierId,
        name: c.name || c.callsign || c.carrierId,
        recipeLimit: c.type === "SquadronCarrier" ? 2 : 1,
        capacity: Math.max(
          0,
          Math.min(
            c.space?.freeSpace ??
              (c.type === "SquadronCarrier" ? 60000 : 25000),
            60000,
          ),
        ),
      });
      setReference("");
    } catch (e) {
      if (version === epoch.current)
        setError(
          e instanceof Error ? e.message : tRef.current("lp.unavailable"),
        );
    }
  };
  const mine = async () => {
    const version = epoch.current;
    try {
      const response = await authFetch("/api/carriers/mine", {
        cache: "no-store",
      });
      const data = await response.json();
      if (version !== epoch.current) return;
      if (!response.ok) throw new Error(t("lp.login"));
      setAvailable(
        [...(data.own ? [data.own] : []), ...(data.squadron ?? [])].map(
          (c) => ({
            carrierId: c.carrierId,
            name: c.name || c.callsign || c.carrierId,
            capacity: Math.max(
              0,
              Math.min(
                c.space?.freeSpace ??
                  (c.type === "SquadronCarrier" ? 60000 : 25000),
                60000,
              ),
            ),
            recipeLimit: (c.type === "SquadronCarrier" ? 2 : 1) as 1 | 2,
          }),
        ),
      );
    } catch {
      if (version === epoch.current) setError(tRef.current("lp.unavailable"));
    }
  };
  return (
    <main className="lp-workspace">
      <ArchitectNav active="loading" />
      <header className="lp-heading">
        <div>
          <h1>{t("lp.title")}</h1>
          <p>{t("lp.intro")}</p>
        </div>
        <button
          className="btn"
          disabled={busy}
          onClick={() => {
            if (confirmDiscard()) {
              requestSequence.current++;
              draftRevision.current++;
              setSelected(null);
              setCollaboration(null);
              setDraft(empty());
              setDirty(false);
              setProgress(null);
              setNotice("");
              window.history.replaceState(null, "", "/architect/loading");
            }
          }}
        >
          {t("lp.new")}
        </button>
      </header>
      {error && (
        <p role="alert" className="lp-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {selected?.catalogueUpdated && (
        <p role="status" className="lp-warning">
          {t("lp.catalogueUpdated")}
        </p>
      )}
      <div className="lp-layout">
        <aside className="card lp-library">
          <div className="lp-actions">
            {(["mine", "public"] as const).map((value) => (
              <button
                key={value}
                aria-pressed={scope === value}
                onClick={() => setScope(value)}
              >
                {t(`lp.${value}`)}
              </button>
            ))}
            <button onClick={() => void loadList()}>{t("cj.refresh")}</button>
          </div>
          {!list.length && <p>{t("lp.none")}</p>}
          {list.map((view) => (
            <button
              className={
                "lp-library-item" + (selected?.id === view.id ? " active" : "")
              }
              key={view.id}
              disabled={busy}
              onClick={() => {
                if (confirmDiscard()) void open(view.id);
              }}
            >
              <strong>{view.pattern.name}</strong>
              <small>
                {view.author} · {nf.format(view.total)} t
              </small>
            </button>
          ))}
        </aside>
        <section className="lp-editor">
          {selected && collaboration && (
            <LoadingPatternTeam
              key={selected.id}
              collaboration={collaboration}
              carriers={selected.pattern.carriers}
              disabled={busy || dirty}
              mutate={mutateTeam}
            />
          )}
          <div className="card lp-settings">
            <div className="lp-actions">
              <input
                aria-label={t("lp.name")}
                placeholder={t("lp.name")}
                value={draft.name}
                maxLength={100}
                disabled={!editable || busy}
                onChange={(e) => update({ ...draft, name: e.target.value })}
              />
              <select
                aria-label={t("lp.visibility")}
                value={draft.visibility}
                disabled={!editable || busy}
                onChange={(e) =>
                  update({
                    ...draft,
                    visibility: e.target.value as LoadingPattern["visibility"],
                  })
                }
              >
                <option value="private">{t("lp.private")}</option>
                <option value="public">{t("lp.public")}</option>
              </select>
              {editable ? (
                <button
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => void save()}
                >
                  {t("lp.save")}
                </button>
              ) : (
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() => {
                    requestSequence.current++;
                    setSelected(null);
                    setCollaboration(null);
                    update({
                      ...draft,
                      name: draft.name + " · " + t("lp.copy"),
                      visibility: "private",
                    });
                    setProgress(null);
                  }}
                >
                  {t("lp.copy")}
                </button>
              )}
              {selected?.canEdit && (
                <button disabled={busy} onClick={() => void remove()}>
                  {t("lp.delete")}
                </button>
              )}
              {selected && (
                <a href={`/architect/loading?pattern=${selected.id}`}>
                  {t("lp.link")}
                </a>
              )}
            </div>
            <div className="lp-metrics">
              <span>
                {t("lp.total")}
                <b>{nf.format(total)} t</b>
              </span>
              <span>
                {t("lp.capacity")}
                <b>
                  {nf.format(
                    draft.carriers.reduce((sum, c) => sum + c.capacity, 0),
                  )}{" "}
                  t
                </b>
              </span>
              <span className={outstanding ? "lp-warning" : ""}>
                {t("lp.unassigned")}
                <b>{nf.format(outstanding)} t</b>
              </span>
              <span>
                {dirty
                  ? t("lp.unsaved")
                  : selected
                    ? t("lp.saved")
                    : t("lp.new")}
              </span>
            </div>
          </div>
          <div className="lp-inputs">
            <section className="card">
              <h2>{t("lp.buildings")}</h2>
              {draft.buildings.map((row, i) => (
                <div className="lp-row" key={i}>
                  <select
                    aria-label={t("lp.building")}
                    value={row.installationId}
                    disabled={!editable || busy}
                    onChange={(e) =>
                      update({
                        ...draft,
                        buildings: draft.buildings.map((item, n) =>
                          n === i
                            ? {
                                ...item,
                                installationId: e.target.value,
                                primary: false,
                              }
                            : item,
                        ),
                      })
                    }
                  >
                    {INSTALLATIONS.map((item) => (
                      <option key={item.id} value={item.id}>
                        {installationName(item, locale)}
                      </option>
                    ))}
                  </select>
                  <input
                    aria-label={t("lp.count")}
                    type="number"
                    min={1}
                    max={100}
                    value={row.count}
                    disabled={!editable || busy}
                    onChange={(e) =>
                      update({
                        ...draft,
                        buildings: draft.buildings.map((item, n) =>
                          n === i
                            ? { ...item, count: Number(e.target.value) }
                            : item,
                        ),
                      })
                    }
                  />
                  <button
                    disabled={!editable || busy}
                    aria-label={t("lp.remove")}
                    onClick={() =>
                      update({
                        ...draft,
                        buildings: draft.buildings.filter((_, n) => n !== i),
                      })
                    }
                  >
                    ×
                  </button>
                  <label>
                    <input
                      type="checkbox"
                      checked={row.primary}
                      disabled={
                        !editable ||
                        busy ||
                        !INSTALLATIONS.find(
                          (item) => item.id === row.installationId,
                        )?.primary
                      }
                      onChange={(e) =>
                        update({
                          ...draft,
                          buildings: draft.buildings.map((item, n) =>
                            n === i
                              ? { ...item, primary: e.target.checked }
                              : item,
                          ),
                        })
                      }
                    />
                    {t("lp.primary")}
                  </label>
                </div>
              ))}
              {editable && (
                <button
                  disabled={busy || draft.buildings.length >= 100}
                  onClick={() =>
                    update({
                      ...draft,
                      buildings: [
                        ...draft.buildings,
                        {
                          installationId: INSTALLATIONS[0].id,
                          count: 1,
                          primary: false,
                        },
                      ],
                    })
                  }
                >
                  {t("lp.addBuilding")}
                </button>
              )}
            </section>
            <section className="card">
              <h2>{t("lp.carriers")}</h2>
              <p className="lp-hint">{t("lp.capacityHint")}</p>
              {draft.carriers.map((carrier, i) => (
                <div className="lp-row" key={carrier.carrierId}>
                  <a href={`/carriers/${carrier.carrierId}`}>{carrier.name}</a>
                  <label className="lp-kit-limit">
                    {t("lp.recipeLimit")}
                    <select
                      aria-label={`${carrier.name}: ${t("lp.recipeLimit")}`}
                      value={carrier.recipeLimit ?? 1}
                      disabled={!editable || busy}
                      onChange={(e) =>
                        update({
                          ...draft,
                          carriers: draft.carriers.map((c, n) =>
                            n === i
                              ? {
                                  ...c,
                                  recipeLimit: Number(e.target.value) as 1 | 2,
                                }
                              : c,
                          ),
                        })
                      }
                    >
                      <option value={1}>{t("lp.oneKit")}</option>
                      <option value={2}>{t("lp.twoKits")}</option>
                    </select>
                  </label>
                  <input
                    aria-label={t("lp.capacity")}
                    type="number"
                    min={0}
                    max={60000}
                    value={carrier.capacity}
                    disabled={!editable || busy}
                    onChange={(e) =>
                      update({
                        ...draft,
                        carriers: draft.carriers.map((item, n) =>
                          n === i
                            ? { ...item, capacity: Number(e.target.value) }
                            : item,
                        ),
                      })
                    }
                  />
                  <button
                    disabled={!editable || busy}
                    aria-label={t("lp.remove")}
                    onClick={() => {
                      const allocations = { ...draft.allocations };
                      delete allocations[carrier.carrierId];
                      update({
                        ...draft,
                        carriers: draft.carriers.filter((_, n) => n !== i),
                        allocations,
                      });
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
              {editable && (
                <>
                  <div className="lp-actions">
                    <input
                      value={reference}
                      disabled={busy}
                      placeholder={t("lp.reference")}
                      aria-label={t("lp.reference")}
                      onChange={(e) => setReference(e.target.value)}
                    />
                    <button
                      disabled={busy || !reference.trim()}
                      onClick={() => void findCarrier()}
                    >
                      {t("lp.add")}
                    </button>
                    <button disabled={busy} onClick={() => void mine()}>
                      {t("lp.myCarriers")}
                    </button>
                  </div>
                  {available.map((c) => (
                    <button
                      key={c.carrierId}
                      disabled={
                        busy ||
                        draft.carriers.some(
                          (row) => row.carrierId === c.carrierId,
                        )
                      }
                      onClick={() => addCarrier(c)}
                    >
                      {c.name} +
                    </button>
                  ))}
                </>
              )}
            </section>
          </div>
          <section
            className="card lp-goods-controls"
            aria-label={t("lp.goodsView")}
          >
            <h2>{t("lp.goodsView")}</h2>
            <div className="lp-view-controls">
              <label>
                {t("lp.order")}
                <select
                  aria-label={t("lp.order")}
                  value={goodsOrder}
                  onChange={(e) =>
                    setGoodsOrder(e.target.value as LoadingGoodsOrder)
                  }
                >
                  {(
                    [
                      "recipe",
                      "category",
                      "name",
                      "quantity",
                      "remaining",
                    ] as const
                  ).map((mode) => (
                    <option key={mode} value={mode}>
                      {t(`lp.order.${mode}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t("lp.category")}
                <select
                  aria-label={t("lp.category")}
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                >
                  <option value="">{t("lp.allCategories")}</option>
                  {Object.keys(loadingCategories).map((cat) => (
                    <option key={cat} value={cat}>
                      {loadingCategoryName(cat, locale)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t("lp.searchGoods")}
                <input
                  aria-label={t("lp.searchGoods")}
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
            </div>
            <div className="lp-actions lp-view-checks">
              <label>
                <input
                  type="checkbox"
                  checked={showCompleted}
                  onChange={(e) => setShowCompleted(e.target.checked)}
                />{" "}
                {t("lp.showCompleted")}
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={onlyUnassigned}
                  onChange={(e) => setOnlyUnassigned(e.target.checked)}
                />{" "}
                {t("lp.onlyUnassigned")}
              </label>
            </div>
            <p className="lp-hint">{t("lp.viewHint")}</p>
          </section>
          <section className="card">
            <div className="lp-heading">
              <h2>{t("lp.distribution")}</h2>
              {editable && (
                <button
                  disabled={busy}
                  onClick={() =>
                    update({
                      ...draft,
                      allocations: Object.fromEntries(
                        draft.carriers.map((c) => [c.carrierId, {}]),
                      ),
                    })
                  }
                >
                  {t("lp.clearAllocation")}
                </button>
              )}
              {editable && (
                <label className="lp-distribution-mode">
                  {t("lp.distributionMode")}
                  <select
                    aria-label={t("lp.distributionMode")}
                    value={distribution}
                    disabled={busy}
                    onChange={(e) => setDistribution(e.target.value)}
                  >
                    {["sequential", "kits", "category", "quantity"].map(
                      (mode) => (
                        <option key={mode} value={mode}>
                          {t(`lp.distribute.${mode}`)}
                        </option>
                      ),
                    )}
                  </select>
                </label>
              )}
              {editable && (
                <button
                  disabled={
                    busy || !draft.carriers.length || !draft.buildings.length
                  }
                  onClick={() => {
                    if (
                      Object.values(draft.allocations).some(
                        (rows) => Object.keys(rows).length,
                      ) &&
                      !window.confirm(t("lp.redistribute"))
                    )
                      return;
                    update({
                      ...draft,
                      allocations:
                        distribution === "kits"
                          ? distributeLoadingRecipes(
                              draft.buildings,
                              draft.carriers,
                            )
                          : distributeLoading(
                              distribution === "sequential"
                                ? requirements
                                : Object.fromEntries(
                                    orderLoadingGoods(
                                      Object.entries(requirements).map(
                                        ([commodity, required]) => ({
                                          commodity,
                                          required,
                                        }),
                                      ),
                                      distribution === "category"
                                        ? "category"
                                        : "quantity",
                                      (good) => good,
                                    ).map((row) => [
                                      row.commodity,
                                      row.required,
                                    ]),
                                  ),
                              draft.carriers,
                            ),
                    });
                  }}
                >
                  {t("lp.auto")}
                </button>
              )}
            </div>
            {distribution === "kits" && (
              <p className="lp-hint">{t("lp.kitsHint")}</p>
            )}
            {allocationInvalid && (
              <p role="alert" className="lp-warning">
                {t("lp.adjust")}
              </p>
            )}
            <div className="lp-table-scroll">
              <table className="lp-table">
                <thead>
                  <tr>
                    <th>{t("lp.good")}</th>
                    <th>{t("lp.total")}</th>
                    {draft.carriers.map((c) => (
                      <th key={c.carrierId}>{c.name}</th>
                    ))}
                    <th>{t("lp.unassigned")}</th>
                  </tr>
                </thead>
                <tbody>
                  {matrixRows.map(
                    ({ commodity: good, required: qty }, index) => (
                      <Fragment key={good}>
                        {goodsOrder === "category" &&
                          (index === 0 ||
                            loadingGoodCategory(
                              matrixRows[index - 1].commodity,
                            ) !== loadingGoodCategory(good)) && (
                            <tr className="lp-category-heading">
                              <th
                                colSpan={draft.carriers.length + 3}
                                style={{ color: loadingGoodColor(good) }}
                              >
                                {categoryTitle(good)}
                              </th>
                            </tr>
                          )}
                        <tr>
                          <td
                            className="lp-good-name"
                            style={{
                              borderLeft: `3px solid ${loadingGoodColor(good)}`,
                            }}
                            title={categoryTitle(good)}
                          >
                            {label(good)}
                          </td>
                          <td>{nf.format(qty)}</td>
                          {draft.carriers.map((c) => (
                            <td key={c.carrierId}>
                              <input
                                aria-label={`${c.name}: ${label(good)}`}
                                type="number"
                                min={0}
                                max={qty}
                                value={
                                  draft.allocations[c.carrierId]?.[good] ?? 0
                                }
                                disabled={!editable || busy}
                                onChange={(e) =>
                                  update({
                                    ...draft,
                                    allocations: {
                                      ...draft.allocations,
                                      [c.carrierId]: {
                                        ...draft.allocations[c.carrierId],
                                        [good]: Number(e.target.value),
                                      },
                                    },
                                  })
                                }
                              />
                            </td>
                          ))}
                          <td
                            className={
                              (unassigned[good] ?? 0) > 0 ? "lp-warning" : ""
                            }
                          >
                            {nf.format(unassigned[good] ?? 0)}
                          </td>
                        </tr>
                      </Fragment>
                    ),
                  )}
                  {!matrixRows.length && (
                    <tr>
                      <td colSpan={draft.carriers.length + 3}>
                        {t("lp.noGoods")}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="lp-actions">
              {draft.carriers.map((c) => (
                <small key={c.carrierId}>
                  {c.name}:{" "}
                  {nf.format(
                    Object.values(draft.allocations[c.carrierId] ?? {}).reduce(
                      (a, b) => a + b,
                      0,
                    ),
                  )}{" "}
                  / {nf.format(c.capacity)} t
                </small>
              ))}
            </div>
          </section>
          {selected && (
            <section className="card">
              <div className="lp-heading">
                <h2>{t("lp.progress")}</h2>
                <button
                  disabled={busy || dirty}
                  onClick={() => void open(selected.id, true)}
                >
                  {t("cj.refresh")}
                </button>
              </div>
              <p className="lp-hint">{t("lp.progressHint")}</p>
              {dirty ? (
                <p>{t("lp.saveFirst")}</p>
              ) : (
                progress && (
                  <>
                    <progress
                      max={Math.max(progress.total, 1)}
                      value={progress.loaded}
                    />
                    <b>
                      {" "}
                      {nf.format(progress.loaded)} / {nf.format(progress.total)}{" "}
                      t
                    </b>
                    <small>
                      {" "}
                      · {t("lp.unknown")}: {nf.format(progress.unknown)} t ·{" "}
                      {checked && new Date(checked).toLocaleString(locale)}
                    </small>
                    <div className="lp-progress-grid">
                      {progress.carriers.map((c) => (
                        <details key={c.carrierId}>
                          <summary>
                            {c.name} ·{" "}
                            {c.known
                              ? `${nf.format(c.loaded ?? 0)} / ${nf.format(c.target)} t`
                              : t("lp.unknown")}
                          </summary>
                          <small>
                            {c.updatedAt
                              ? new Date(c.updatedAt).toLocaleString(locale)
                              : t("lp.unknown")}
                          </small>
                          {sortedGoods(c.items)
                            .filter(
                              (item) => showCompleted || item.remaining !== 0,
                            )
                            .map((item, index, rows) => (
                              <Fragment key={item.commodity}>
                                {goodsOrder === "category" &&
                                  (index === 0 ||
                                    loadingGoodCategory(
                                      rows[index - 1].commodity,
                                    ) !==
                                      loadingGoodCategory(item.commodity)) && (
                                    <div
                                      className="lp-category-heading"
                                      style={{
                                        color: loadingGoodColor(item.commodity),
                                      }}
                                    >
                                      {categoryTitle(item.commodity)}
                                    </div>
                                  )}
                                <div
                                  className="lp-progress-item"
                                  style={{
                                    borderLeft: `3px solid ${loadingGoodColor(item.commodity)}`,
                                  }}
                                  title={categoryTitle(item.commodity)}
                                >
                                  <span>{label(item.commodity)}</span>
                                  <span>
                                    {item.loaded === null
                                      ? "?"
                                      : nf.format(item.loaded)}{" "}
                                    / {nf.format(item.required)} t ·{" "}
                                    {t("lp.remaining")}:{" "}
                                    {item.remaining === null
                                      ? "?"
                                      : nf.format(item.remaining)}{" "}
                                    t
                                  </span>
                                </div>
                              </Fragment>
                            ))}
                          {!sortedGoods(c.items).some(
                            (item) => showCompleted || item.remaining !== 0,
                          ) && <p className="lp-hint">{t("lp.noGoods")}</p>}
                        </details>
                      ))}
                    </div>
                  </>
                )
              )}
            </section>
          )}
        </section>
      </div>
    </main>
  );
}
