"""Journal-backed faction presence infographic built on the Qt widget facade."""
from __future__ import annotations

import webbrowser
from types import MethodType
from qt_lazy import tb, W, X, BOTH, LEFT, RIGHT
from site_config import DEFAULT_SITE_URL
from locale_config import localized_url,normalize_locale

PALETTE=("#e57b28","#42b9d4","#65c78a","#8e7bf0","#e27676","#dfbd65")


def _open_atlas(widget):
    webbrowser.open(widget.atlas_url,new=2)


def _set_snapshot(widget,system,controlling,factions):
    system=str(system or "").strip();controlling=str(controlling or "").strip();rows=list(factions or [])
    widget.system_label.configure(text=f"СИСТЕМА  /  {system}" if system else "Ожидание данных о системе…")
    widget.control_label.configure(text=f"Контролирующая фракция: {controlling}" if controlling else "")
    try:children=list(widget.cards.winfo_children())
    except Exception:children=[]
    for child in children:
        try:child.pack_forget();child.destroy()
        except Exception:pass
    if not rows:
        widget.empty=tb.Label(widget.cards,text="Запустите Watcher и загрузите журнал из населённой системы, чтобы увидеть присутствующие фракции.",
                              foreground="#a1a8ad",wraplength=760,justify=LEFT)
        widget.empty.pack(anchor=W,pady=14)
        return
    widget.empty=None
    for index,faction in enumerate(rows):
        color=PALETTE[index%len(PALETTE)]
        card=tb.Frame(widget.cards,padding=(12,9),relief="solid",borderwidth=1)
        card.pack(fill=X,pady=4)
        body=tb.Frame(card);body.pack(side=LEFT,fill=X,expand=True)
        name=str(faction.get("name") or "—")
        marker="  ·  КОНТРОЛИРУЕТ СИСТЕМУ" if name==controlling else ""
        tb.Label(body,text=name+marker,font=("Segoe UI",10,"bold"),foreground=color).pack(anchor=W)
        influence=max(0.0,min(1.0,float(faction.get("influence",0) or 0)))
        details=[f"Влияние {influence*100:.1f}%"]
        details.extend(str(faction[k]) for k in ("allegiance","government","state") if faction.get(k))
        states=faction.get("active_states") or []
        if states:details.append("Активно: "+", ".join(str(x) for x in states[:3]))
        tb.Label(body,text="  ·  ".join(details),foreground="#a1a8ad").pack(anchor=W,pady=(2,0))
        tb.Progressbar(body,maximum=100,value=influence*100,bootstyle="info-striped").pack(fill=X,pady=(7,0))
        tb.Button(card,text="Открыть в Atlas ↗",command=widget._open_atlas,bootstyle="info-outline").pack(side=RIGHT,padx=(10,0))


def FactionInfographic(parent=None,locale="ru",site_url=None):
    """Create a native Qt-backed view with the Tk-compatible widget facade."""
    widget=tb.Frame(parent,padding=0)
    widget.locale=normalize_locale(locale)
    widget.atlas_url=localized_url(f"{str(site_url or DEFAULT_SITE_URL).rstrip('/')}/atlas?tab=factions",widget.locale)
    widget._open_atlas=MethodType(_open_atlas,widget)
    widget.set_snapshot=MethodType(_set_snapshot,widget)
    try:widget.setObjectName("FactionInfographic")
    except Exception:pass
    widget.pack(fill=BOTH,expand=True)
    tb.Label(widget,text="FACTION PRESENCE  /  JOURNAL SNAPSHOT",foreground="#42b9d4",
             font=("Segoe UI",9,"bold")).pack(anchor=W,pady=(0,4))
    header=tb.Frame(widget);header.pack(fill=X,pady=(0,4))
    tb.Label(header,text="Фракции в текущей системе",font=("Segoe UI",20,"bold")).pack(side=LEFT,anchor=W)
    tb.Button(header,text="Открыть Atlas ↗",command=widget._open_atlas,bootstyle="info-outline").pack(side=RIGHT,padx=(8,0))
    tb.Label(widget,text="Минорные фракции, влияние и состояния из последнего события FSDJump/Location в журнале.",
             foreground="#a1a8ad",wraplength=820,justify=LEFT).pack(anchor=W,pady=(0,8))
    widget.system_label=tb.Label(widget,text="Ожидание данных о системе…",foreground="#42b9d4",font=("Segoe UI",10,"bold"))
    widget.system_label.pack(anchor=W,pady=(0,4))
    widget.control_label=tb.Label(widget,text="",foreground="#a1a8ad");widget.control_label.pack(anchor=W,pady=(0,8))
    widget.cards=tb.Frame(widget);widget.cards.pack(fill=BOTH,expand=True)
    widget.empty=None
    widget.set_snapshot("","",[])
    return widget
