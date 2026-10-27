"""Qt-backed, intentionally small Tk-style facade used by the legacy Helper UI.

All widgets and event loops are PySide6 objects. The facade exists only to let
mature business/controller code migrate without changing its user-visible
behaviour in one risky rewrite. New UI should use PySide6 directly.
"""
from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from typing import Any, Callable
from theme_tokens import theme_tokens

from PySide6.QtCore import Qt, QTimer, QPoint, QRect, QSize, QEvent, QObject, Signal
from PySide6.QtGui import QColor, QFont, QPainter, QPen, QBrush, QPolygon, QShortcut, QKeySequence, QTextCharFormat
from shiboken6 import isValid as _is_qt_valid
from PySide6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QFrame, QLabel, QPushButton, QCheckBox,
    QRadioButton, QLineEdit, QPlainTextEdit, QTextEdit, QComboBox, QSlider,
    QProgressBar, QScrollArea, QScrollBar, QTreeWidget, QTreeWidgetItem,
    QTabWidget, QMenu, QFileDialog, QMessageBox, QInputDialog,
    QVBoxLayout, QHBoxLayout, QGridLayout, QBoxLayout, QSizePolicy, QGroupBox,
)

END = "end"; INSERT = "insert"; NORMAL = "normal"; DISABLED = "disabled"
WORD = "word"; SOLID = "solid"; FLAT = "flat"; RAISED = "raised"; SUNKEN = "sunken"
X = "x"; Y = "y"; BOTH = "both"; LEFT = "left"; RIGHT = "right"
TOP = "top"; BOTTOM = "bottom"; CENTER = "center"; N = "n"; S = "s"; E = "e"; W = "w"; NW = "nw"
VERTICAL = "vertical"; HORIZONTAL = "horizontal"

_APP = None
_STYLE_RULES = {}
_STYLE_MAPS = {}


def ensure_app():
    global _APP
    app = QApplication.instance()
    if app is None:
        app = QApplication(sys.argv[:1])
    _APP = app
    app.setStyle("Fusion")
    t=theme_tokens()
    app.setStyleSheet(f"""
      QWidget {{ background-color:{t.background}; color:{t.text}; font-family:'Segoe UI',sans-serif; }}
      QFrame[panel='true'] {{ background:{t.surface}; border:1px solid {t.line}; border-radius:6px; }}
      QPushButton {{ background:#303438; border:1px solid #454b50; border-radius:5px; padding:7px 11px; }}
      QPushButton:hover {{ background:#41474b; border-color:{t.accent}; }}
      QPushButton:pressed {{ background:{t.surface_alt}; }}
      QPushButton:disabled {{ color:#747b80; background:{t.surface_alt}; }}
      QLineEdit,QComboBox,QPlainTextEdit,QTreeWidget {{ background:{t.surface_alt}; border:1px solid {t.line}; border-radius:4px; padding:5px; selection-background-color:{t.accent}; }}
      QComboBox QAbstractItemView {{ background:{t.surface_alt}; selection-background-color:{t.accent}; }}
      QCheckBox,QRadioButton {{ spacing:7px; }}
      QTabWidget::pane {{ border:1px solid {t.line}; }}
      QTabBar::tab {{ background:{t.surface_alt}; padding:8px 12px; border:1px solid {t.line}; }}
      QTabBar::tab:selected {{ background:#34383c; border-bottom:2px solid {t.accent}; }}
      QHeaderView::section {{ background:#303438; padding:5px; border:0; }}
      QScrollBar:vertical {{ background:{t.surface_alt}; width:12px; margin:0; }}
      QScrollBar::handle:vertical {{ background:#555d62; min-height:25px; border-radius:5px; }}
      QScrollBar:horizontal {{ background:{t.surface_alt}; height:12px; margin:0; }}
      QScrollBar::handle:horizontal {{ background:#555d62; min-width:25px; border-radius:5px; }}
      QToolTip {{ background:#202326; color:{t.text}; border:1px solid {t.accent}; padding:5px; }}
      QMenu {{ background:{t.surface_alt}; border:1px solid #454b50; }}
      QMenu::item:selected {{ background:#454b50; }}
    """)
    return app


class Variable:
    def __init__(self, master=None, value=None, **_): self._value = value
    def get(self): return self._value
    def set(self, value): self._value = value

class StringVar(Variable):
    def __init__(self, master=None, value="", **kw): super().__init__(master, value, **kw)
class IntVar(Variable):
    def __init__(self, master=None, value=0, **kw): super().__init__(master, value, **kw)
class DoubleVar(Variable):
    def __init__(self, master=None, value=0.0, **kw): super().__init__(master, value, **kw)
class BooleanVar(Variable):
    def __init__(self, master=None, value=False, **kw): super().__init__(master, value, **kw)


@dataclass
class EventProxy:
    widget: Any
    x: int = 0
    y: int = 0
    delta: int = 0
    width: int = 0
    height: int = 0
    keysym: str = ""
    num: int = 0
    x_root: int = 0
    y_root: int = 0
    state: int = 0

class _TkEventFilter(QObject):
    def __init__(self, widget):
        super().__init__(widget if isinstance(widget,QObject) else None)
        self.widget=widget
    def eventFilter(self,obj,event):
        et=event.type(); names=[]; x=y=delta=width=height=num=0;keysym=""
        if et in (QEvent.Type.MouseButtonPress,QEvent.Type.MouseButtonDblClick):
            x=int(event.position().x());y=int(event.position().y());num={Qt.MouseButton.LeftButton:1,Qt.MouseButton.MiddleButton:2,Qt.MouseButton.RightButton:3}.get(event.button(),1)
            names=[f"<Button-{num}>",f"<ButtonPress-{num}>"]
            if et==QEvent.Type.MouseButtonDblClick:names += [f"<Double-{num}>",f"<Double-Button-{num}>"]
        elif et==QEvent.Type.MouseButtonRelease:
            x=int(event.position().x());y=int(event.position().y());num={Qt.MouseButton.LeftButton:1,Qt.MouseButton.MiddleButton:2,Qt.MouseButton.RightButton:3}.get(event.button(),1);names=[f"<ButtonRelease-{num}>"]
        elif et==QEvent.Type.MouseMove:
            x=int(event.position().x());y=int(event.position().y());names=["<Motion>"]
            if event.buttons()&Qt.MouseButton.LeftButton:names.insert(0,"<B1-Motion>")
            if event.buttons()&Qt.MouseButton.RightButton:names.insert(0,"<B3-Motion>")
        elif et==QEvent.Type.Wheel:
            delta=int(event.angleDelta().y());names=["<MouseWheel>"]
        elif et==QEvent.Type.Resize:
            width=event.size().width();height=event.size().height();names=["<Configure>"]
        elif et==QEvent.Type.KeyPress:
            keysym=QKeySequence(event.key()).toString()
            if len(keysym)==1:keysym=keysym.lower()
            names=["<KeyPress>",f"<{keysym}>"]
            mods=[]
            if event.modifiers()&Qt.KeyboardModifier.ControlModifier:mods.append("Control")
            if event.modifiers()&Qt.KeyboardModifier.AltModifier:mods.append("Alt")
            if event.modifiers()&Qt.KeyboardModifier.ShiftModifier:mods.append("Shift")
            if mods:names.append("<"+"-".join(mods+[keysym])+">")
        elif et==QEvent.Type.Enter:names=["<Enter>"]
        elif et==QEvent.Type.Leave:names=["<Leave>"]
        elif et==QEvent.Type.FocusOut:names=["<FocusOut>"]
        elif et==QEvent.Type.Show:names=["<Map>"]
        if not names:return False
        gp=event.globalPosition().toPoint() if hasattr(event,"globalPosition") else QPoint(x,y)
        proxy=EventProxy(self.widget,x,y,delta,width,height,keysym,num,int(gp.x()),int(gp.y()),int(event.modifiers()) if hasattr(event,"modifiers") else 0)
        for seq,cb in list(getattr(self.widget,"_tk_bindings",[])):
            if seq.lower() in {name.lower() for name in names}:
                try:
                    if cb(proxy)=="break":return True
                except Exception:pass
        app=QApplication.instance()
        for seq,cb,owner in list(getattr(app,"_tk_global_bindings",[])) if app else []:
            if seq.lower() in {name.lower() for name in names}:
                try:
                    if cb(EventProxy(owner,x,y,delta,width,height,keysym,num))=="break":return True
                except Exception:pass
        return False

class TkWidgetMixin:
    def _tk_init(self, master=None, **options):
        self.master = master
        self._tk_events = {}
        self._tk_pack_layout = None
        self._tk_after = set()
        self._tk_bindings = []
        self._tk_filter = None
        self._tk_options = {}
        self._tk_grid_rows = {}
        self._tk_grid_cols = {}
        if master is not None:
            try: master._tk_children.append(self)
            except Exception: pass
        self._tk_children = []
        if hasattr(self, "setMouseTracking"): self.setMouseTracking(True)
        if hasattr(self, "setSizePolicy") and isinstance(self, (QLabel, QFrame, QGroupBox)):
            self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Preferred)
        if options: self.configure(**options)

    def configure(self, cnf=None, **kw):
        if isinstance(cnf, dict): kw = {**cnf, **kw}
        elif isinstance(cnf, str): return self.cget(cnf)
        style_name=kw.get("style")
        if style_name:kw={**_STYLE_RULES.get(str(style_name),{}),**kw}
        bootstyle=str(kw.get("bootstyle","")).lower()
        if bootstyle:
            color="#42b9d4" if "info" in bootstyle else ("#65c78a" if "success" in bootstyle else ("#e27676" if "danger" in bootstyle else "#e57b28" if any(x in bootstyle for x in ("warning","primary")) else ""))
            if color:
                if "outline" in bootstyle:kw.setdefault("foreground",color)
                else:kw.setdefault("background",color);kw.setdefault("foreground","#1e2022")
        self._tk_options.update(kw)
        text = kw.get("text")
        if text is not None:
            if isinstance(self, QLabel): self.setText(str(text))
            elif isinstance(self, QPushButton): self.setText(str(text))
            elif isinstance(self, QCheckBox): self.setText(str(text))
            elif isinstance(self, QRadioButton): self.setText(str(text))
            elif isinstance(self, QGroupBox): self.setTitle(str(text))
        css_options=(("bg","background-color"),("background","background-color"),("fg","color"),("foreground","color"),("bordercolor","border-color"))
        css=[]
        for key,prop in css_options:
            if key in kw:css.append(f"{prop}:{kw[key]};")
        if "borderwidth" in kw:css.append(f"border-width:{int(kw['borderwidth'])}px;")
        if "relief" in kw and kw["relief"] not in ("flat",FLAT):css.append("border-style:solid;")
        if css and hasattr(self,"setStyleSheet"):
            selector=self.metaObject().className();self.setStyleSheet(self.styleSheet()+f"\n{selector} {{{''.join(css)}}}")
        if "padding" in kw and isinstance(self,QWidget):
            try:
                p=kw["padding"]
                if isinstance(p,(tuple,list)):vals=list(p)
                else:vals=[p]
                if len(vals)==1:vals*=4
                elif len(vals)==2:vals=[vals[0],vals[1],vals[0],vals[1]]
                self.setContentsMargins(*[int(x) for x in vals[:4]])
            except Exception:pass
        if "font" in kw: self._set_font(kw["font"])
        if "state" in kw:
            state = str(kw["state"]).lower()
            if isinstance(self, (QPlainTextEdit, QTextEdit)):
                self.setReadOnly(state == DISABLED); self.setEnabled(True)
            elif isinstance(self, QLineEdit):
                self.setReadOnly(state == "readonly"); self.setEnabled(state != DISABLED)
            elif isinstance(self,QComboBox):
                self.setEditable(state=="normal");self.setEnabled(state!=DISABLED)
            else: self.setEnabled(state != DISABLED)
        if "width" in kw and isinstance(self,QWidget):
            try:self.setMinimumWidth(int(kw["width"])*(8 if isinstance(self,(QLabel,QPushButton,QLineEdit,QComboBox)) else 1))
            except (ValueError,TypeError):pass
        if "height" in kw and isinstance(self,QWidget):
            try:self.setMinimumHeight(int(kw["height"])*(18 if isinstance(self,(QLabel,QPushButton,QLineEdit,QComboBox)) else 1))
            except (ValueError,TypeError):pass
        if "wraplength" in kw and isinstance(self, QLabel): self.setWordWrap(True)
        if "justify" in kw and isinstance(self, QLabel):
            self.setAlignment({"left":Qt.AlignmentFlag.AlignLeft,"right":Qt.AlignmentFlag.AlignRight,"center":Qt.AlignmentFlag.AlignHCenter}.get(str(kw["justify"]),Qt.AlignmentFlag.AlignLeft)|Qt.AlignmentFlag.AlignVCenter)
        if "anchor" in kw and isinstance(self, QLabel):
            self.setAlignment(_anchor(kw["anchor"]))
        if "values" in kw and isinstance(self, QComboBox):
            current=self.currentText(); self.clear(); self.addItems([str(x) for x in kw["values"]]); self.setCurrentText(current)
        if "textvariable" in kw and isinstance(self, (QLineEdit,QComboBox)):
            var=kw["textvariable"]
            if isinstance(self,QLineEdit):self.setText(str(var.get() or ""));self.textChanged.connect(lambda v,var=var:var.set(v))
            else:self.setCurrentText(str(var.get() or ""));self.currentTextChanged.connect(lambda v,var=var:var.set(v))
        if "show" in kw and isinstance(self,QLineEdit):
            self.setEchoMode(QLineEdit.EchoMode.Password if kw["show"] else QLineEdit.EchoMode.Normal)
        if "variable" in kw and isinstance(self, (QCheckBox,QRadioButton)):
            var=kw["variable"]; self.setChecked(bool(var.get())); self.toggled.connect(lambda v,var=var: var.set(v))
        if "command" in kw and hasattr(self, "clicked"):
            try: self.clicked.disconnect()
            except Exception: pass
            if callable(kw["command"]): self.clicked.connect(kw["command"])
        if "command" in kw and isinstance(self, QSlider):
            try: self.valueChanged.disconnect()
            except Exception: pass
            if callable(kw["command"]): self.valueChanged.connect(kw["command"])
        if "orient" in kw and isinstance(self, (QSlider,QScrollBar)):
            self.setOrientation(Qt.Orientation.Vertical if kw["orient"] in (VERTICAL, "vertical") else Qt.Orientation.Horizontal)
        if "from_" in kw and isinstance(self, QSlider): self.setMinimum(int(kw["from_"]))
        if "to" in kw and isinstance(self, QSlider): self.setMaximum(int(kw["to"]))
        if "length" in kw:
            try: self.setMinimumWidth(int(kw["length"]))
            except Exception: pass
        if isinstance(self,QProgressBar):
            if "maximum" in kw:self.setMaximum(int(kw["maximum"]))
            if "minimum" in kw:self.setMinimum(int(kw["minimum"]))
            if "value" in kw:self.setValue(int(float(kw["value"])))
        if "show" in kw and isinstance(self, QTreeWidget): self.setHeaderHidden(str(kw["show"])=="")
        if "columns" in kw and isinstance(self,QTreeWidget): self.setColumnCount(len(kw["columns"]))
        if "yscrollcommand" in kw and isinstance(self,(QPlainTextEdit,QTreeWidget,QScrollArea)):
            try:self.verticalScrollBar().valueChanged.connect(lambda v: kw["yscrollcommand"](self.verticalScrollBar().value(),self.verticalScrollBar().maximum()))
            except Exception:pass
        if "xscrollcommand" in kw and isinstance(self,(QPlainTextEdit,QTreeWidget,QScrollArea)):
            try:self.horizontalScrollBar().valueChanged.connect(lambda v: kw["xscrollcommand"](self.horizontalScrollBar().value(),self.horizontalScrollBar().maximum()))
            except Exception:pass
        return None
    config = configure

    def _set_font(self, value):
        try:
            if isinstance(value, QFont): self.setFont(value); return
            if isinstance(value, (tuple,list)):
                f=QFont(str(value[0]));
                if len(value)>1: f.setPointSize(int(value[1]))
                if len(value)>2 and ("bold" in str(value[2]).lower()): f.setBold(True)
                self.setFont(f)
            elif isinstance(value,str): self.setFont(QFont(value))
        except Exception: pass
    def cget(self,key):
        if key in self._tk_options:return self._tk_options[key]
        if key=="text" and hasattr(self,"text"): return self.text()
        return None
    def pack(self, **kw):
        parent=self.master
        if parent is None:return
        layout=parent._get_tk_layout("pack",kw.get("side",TOP))
        padx=kw.get("padx",0);pady=kw.get("pady",0)
        if isinstance(padx,(tuple,list)): left,right=padx
        else:left=right=padx
        if isinstance(pady,(tuple,list)): top,bottom=pady
        else:top=bottom=pady
        wrapper=getattr(self,"_tk_pack_wrapper",None)
        if wrapper is None:
            wrapper=QWidget();self._tk_pack_wrapper=wrapper
            box=QVBoxLayout(wrapper);box.setContentsMargins(0,0,0,0);box.setSpacing(0);box.addWidget(self)
        wrapper.layout().setContentsMargins(max(0,int(left)),max(0,int(top)),max(0,int(right)),max(0,int(bottom)))
        stretch=1 if kw.get("expand") else 0
        if isinstance(layout,QBoxLayout):
            if wrapper.parentWidget() is not layout.parentWidget():wrapper.setParent(layout.parentWidget())
            if layout.indexOf(wrapper)<0:layout.addWidget(wrapper,stretch,_alignment(kw.get("anchor")))
            else:layout.setStretch(layout.indexOf(wrapper),stretch)
        elif isinstance(layout,QGridLayout):
            layout.addWidget(wrapper,0,0,alignment=_alignment(kw.get("anchor")))
        fill=kw.get("fill")
        if fill in (BOTH,"both"):wrapper.setSizePolicy(QSizePolicy.Policy.Expanding,QSizePolicy.Policy.Expanding)
        elif fill in (X,"x"):wrapper.setSizePolicy(QSizePolicy.Policy.Expanding,QSizePolicy.Policy.Preferred)
        elif fill in (Y,"y"):wrapper.setSizePolicy(QSizePolicy.Policy.Preferred,QSizePolicy.Policy.Expanding)
        if "ipadx" in kw or "ipady" in kw:
            self.setMinimumSize(self.minimumWidth()+int(kw.get("ipadx",0))*2,self.minimumHeight()+int(kw.get("ipady",0))*2)
        if isinstance(parent, Window): parent._central.show()
        wrapper.show();self.show()
    def pack_forget(self):
        parent=self.master
        for attr,kind in (("_tk_pack_wrapper","pack"),("_tk_grid_wrapper","grid")):
            wrapper=getattr(self,attr,None)
            if parent and wrapper:
                try:parent._get_tk_layout(kind).removeWidget(wrapper)
                except Exception:pass
                wrapper.hide()
        self.hide()
    def grid(self, **kw):
        parent=self.master
        if parent is None:return
        layout=parent._get_tk_layout("grid")
        wrapper=getattr(self,"_tk_grid_wrapper",None)
        if wrapper is None:
            wrapper=QWidget();self._tk_grid_wrapper=wrapper;box=QVBoxLayout(wrapper);box.setContentsMargins(0,0,0,0);box.setSpacing(0);box.addWidget(self)
        padx=kw.get("padx",0);pady=kw.get("pady",0)
        left,right=(padx if isinstance(padx,(tuple,list)) else (padx,padx));top,bottom=(pady if isinstance(pady,(tuple,list)) else (pady,pady))
        wrapper.layout().setContentsMargins(int(left),int(top),int(right),int(bottom))
        layout.addWidget(wrapper,int(kw.get("row",0)),int(kw.get("column",0)),int(kw.get("rowspan",1)),int(kw.get("columnspan",1)),_alignment(kw.get("sticky")))
        if kw.get("sticky") in ("ew","nsew","ns"):wrapper.setSizePolicy(QSizePolicy.Policy.Expanding,QSizePolicy.Policy.Expanding)
        if isinstance(parent,Window):parent._central.show()
        wrapper.show();self.show()
    grid_forget=pack_forget
    def place(self, **kw):
        self._tk_place=kw
        x=int(kw.get("x",0));y=int(kw.get("y",0));w=kw.get("width");h=kw.get("height")
        parent=self.master
        if w is None and parent is not None and kw.get("relwidth") is not None:w=int(parent.width()*float(kw["relwidth"]))
        if h is None and parent is not None and kw.get("relheight") is not None:h=int(parent.height()*float(kw["relheight"]))
        if w is not None:self.resize(int(w),self.height())
        if h is not None:self.resize(self.width(),int(h))
        self.move(x,y);self.show()
    place_forget=pack_forget
    def pack_propagate(self,value=True):
        if not value:
            w=int(self._tk_options.get("width",0) or 0);h=int(self._tk_options.get("height",0) or 0)
            if w:self.setFixedWidth(w)
            if h:self.setFixedHeight(h)
    grid_propagate=pack_propagate
    def _get_tk_layout(self, kind="pack", side=TOP):
        layout=self.layout()
        if layout is None:
            if kind=="grid":
                layout=QGridLayout(self)
                for row,weight in getattr(self,"_tk_grid_rows",{}).items():layout.setRowStretch(row,weight)
                for col,weight in getattr(self,"_tk_grid_cols",{}).items():layout.setColumnStretch(col,weight)
            else:
                direction=QBoxLayout.LeftToRight if side in (LEFT,RIGHT) else QBoxLayout.TopToBottom
                layout=QBoxLayout(direction,self)
            layout.setContentsMargins(0,0,0,0);layout.setSpacing(6)
        return layout
    def bind(self, sequence, callback, add=None):
        if isinstance(self,Window) and str(sequence).startswith("<"):
            return self.bind_all(sequence,callback,add)
        if not add:self._tk_bindings=[x for x in self._tk_bindings if x[0]!=str(sequence)]
        self._tk_bindings.append((str(sequence),callback))
        if self._tk_filter is None and isinstance(self,QObject):
            self._tk_filter=_TkEventFilter(self);self.installEventFilter(self._tk_filter)
        if sequence in ("<Button-1>","<Button-3>","<Button-2>") and isinstance(self,QWidget):self.setCursor(Qt.CursorShape.PointingHandCursor)
        if sequence.startswith("<<") and isinstance(self,QComboBox) and "ComboboxSelected" in sequence:self.currentIndexChanged.connect(lambda *_:callback(EventProxy(self)))
        if sequence.startswith("<<") and isinstance(self,QTreeWidget) and "TreeviewSelect" in sequence:self.itemSelectionChanged.connect(lambda:callback(EventProxy(self)))
        return None
    def bind_all(self,sequence,callback,add=None):
        app=ensure_app();self._tk_global_bindings=getattr(app,"_tk_global_bindings",[])
        self._tk_global_bindings.append((str(sequence),callback,self))
        if not hasattr(app,"_tk_global_filter"):
            app._tk_global_filter=_TkEventFilter(self);app.installEventFilter(app._tk_global_filter)
        return None
    def unbind_all(self,sequence):
        app=ensure_app();app._tk_global_bindings=[x for x in getattr(app,"_tk_global_bindings",[]) if x[0]!=str(sequence)]
    def event(self,ev):
        return super().event(ev)
    def after(self,ms,callback=None,*args):
        if callback is None:return None
        timer=QTimer(self);timer.setSingleShot(True);timer.timeout.connect(lambda:callback(*args));timer.start(max(0,int(ms)));self._tk_after.add(timer);return timer
    def after_idle(self,callback,*args): return self.after(0,callback,*args)
    def after_cancel(self,ident):
        try: ident.stop();ident.deleteLater()
        except Exception:pass
    def update(self): ensure_app().processEvents()
    def update_idletasks(self): ensure_app().processEvents()
    def destroy(self):
        if hasattr(self,"_close_callback"):self._close_callback=None
        self.close() if hasattr(self,"close") else self.deleteLater()
    def winfo_exists(self):
        try:return int(_is_qt_valid(self))
        except Exception:return 0
    def winfo_children(self): return list(getattr(self,"_tk_children",[]))
    def winfo_width(self): return self.width()
    def winfo_height(self): return self.height()
    def winfo_x(self): return self.x()
    def winfo_y(self): return self.y()
    def winfo_rootx(self): return self.mapToGlobal(QPoint(0,0)).x()
    def winfo_rooty(self): return self.mapToGlobal(QPoint(0,0)).y()
    def winfo_screenwidth(self): return ensure_app().primaryScreen().availableGeometry().width()
    def winfo_screenheight(self): return ensure_app().primaryScreen().availableGeometry().height()
    def winfo_viewable(self): return int(self.isVisible())
    winfo_ismapped=winfo_viewable
    def winfo_manager(self):
        parent=self.master;wrapper=getattr(self,"_tk_pack_wrapper",None)
        if wrapper and parent:
            try:return "pack" if parent._get_tk_layout("pack").indexOf(wrapper)>=0 else ""
            except Exception:pass
        return "grid" if parent and self.parentWidget() is parent else ""
    def winfo_id(self): return int(self.winId())
    def focus_set(self): self.setFocus()
    focus=focus_set
    def lift(self): self.raise_();self.activateWindow()
    tkraise=lift
    def grid_rowconfigure(self,row,**kw):
        self._tk_grid_rows[int(row)]=int(kw.get("weight",0));l=self.layout()
        if isinstance(l,QGridLayout):l.setRowStretch(int(row),int(kw.get("weight",0)))
    rowconfigure=grid_rowconfigure
    def grid_columnconfigure(self,col,**kw):
        self._tk_grid_cols[int(col)]=int(kw.get("weight",0));l=self.layout()
        if isinstance(l,QGridLayout):l.setColumnStretch(int(col),int(kw.get("weight",0)))
    columnconfigure=grid_columnconfigure
    def winfo_toplevel(self):
        w=self
        while getattr(w,"master",None) is not None:w=w.master
        return w
    def winfo_reqwidth(self): return self.sizeHint().width()
    def winfo_reqheight(self): return self.sizeHint().height()
    def event_generate(self,seq): pass


def _anchor(value):
    value=str(value or "center").lower()
    return {"w":Qt.AlignmentFlag.AlignLeft,"e":Qt.AlignmentFlag.AlignRight,"n":Qt.AlignmentFlag.AlignTop,"s":Qt.AlignmentFlag.AlignBottom,"nw":Qt.AlignmentFlag.AlignLeft|Qt.AlignmentFlag.AlignTop,"ne":Qt.AlignmentFlag.AlignRight|Qt.AlignmentFlag.AlignTop,"sw":Qt.AlignmentFlag.AlignLeft|Qt.AlignmentFlag.AlignBottom,"se":Qt.AlignmentFlag.AlignRight|Qt.AlignmentFlag.AlignBottom}.get(value,Qt.AlignmentFlag.AlignCenter)
def _alignment(value):return _anchor(value) if value else Qt.AlignmentFlag(0)

class Frame(QFrame,TkWidgetMixin):
    def __init__(self,master=None,**kw):super().__init__(master if isinstance(master,QWidget) else None);self._tk_init(master,**kw);self.setFrameShape(QFrame.Shape.NoFrame)
class LabelFrame(QGroupBox,TkWidgetMixin):
    def __init__(self,master=None,**kw):
        title=kw.pop("text","");super().__init__(str(title),master if isinstance(master,QWidget) else None);self._tk_init(master,**kw)
class Label(QLabel,TkWidgetMixin):
    def __init__(self,master=None,**kw):
        text=kw.pop("text","");super().__init__(str(text),master if isinstance(master,QWidget) else None);self._tk_init(master,**kw);self.setWordWrap(True)
class Button(QPushButton,TkWidgetMixin):
    def __init__(self,master=None,**kw):
        text=kw.pop("text","");command=kw.pop("command",None);super().__init__(str(text),master if isinstance(master,QWidget) else None);self._tk_init(master,**kw)
        if command:self.clicked.connect(command)
class Checkbutton(QCheckBox,TkWidgetMixin):
    def __init__(self,master=None,**kw):
        text=kw.pop("text","");super().__init__(str(text),master if isinstance(master,QWidget) else None);self._tk_init(master,**kw)
class Radiobutton(QRadioButton,TkWidgetMixin):
    def __init__(self,master=None,**kw):
        text=kw.pop("text","");super().__init__(str(text),master if isinstance(master,QWidget) else None);self._tk_init(master,**kw)
class Entry(QLineEdit,TkWidgetMixin):
    def __init__(self,master=None,**kw):super().__init__(master if isinstance(master,QWidget) else None);self._tk_init(master,**kw)
    def get(self):return self.text()
    def insert(self,index,text):
        pos=len(self.text()) if str(index).lower()=="end" else (int(index) if str(index).isdigit() else self.cursorPosition());self.setCursorPosition(pos);QLineEdit.insert(self,str(text))
    def delete(self,start,end=None):
        a=int(start) if str(start).isdigit() else 0;b=len(self.text()) if end in (None,END,"end") else int(end);self.setSelection(a,max(0,b-a));QLineEdit.insert(self,"")
class ComboBox(QComboBox,TkWidgetMixin):
    def __init__(self,master=None,**kw):
        values=kw.pop("values",());state=kw.pop("state",None);super().__init__(master if isinstance(master,QWidget) else None);self._tk_init(master,**kw);self.addItems([str(x) for x in values])
        if kw.get("textvariable") is not None:self.setCurrentText(str(kw["textvariable"].get() or ""))
        if state:self.setEditable(state!="readonly")
    def get(self):return self.currentText()
    def set(self,value):self.setCurrentText(str(value))
    def current(self,index=None):
        if index is None:return self.currentIndex()
        self.setCurrentIndex(int(index))
class Scale(QSlider,TkWidgetMixin):
    def __init__(self,master=None,**kw):
        orient=kw.pop("orient",HORIZONTAL);var=kw.pop("variable",None);command=kw.pop("command",None);a=kw.pop("from_",0);b=kw.pop("to",100);super().__init__(Qt.Orientation.Vertical if orient==VERTICAL else Qt.Orientation.Horizontal,master if isinstance(master,QWidget) else None);self._tk_init(master,**kw);self.setRange(int(a),int(b));self._variable=var
        if var:self.setValue(int(var.get()));self.valueChanged.connect(lambda v:var.set(v))
        if command:self.valueChanged.connect(command)
    def get(self):return self.value()
    def set(self,v):self.setValue(int(v))
class Progressbar(QProgressBar,TkWidgetMixin):
    def __init__(self,master=None,**kw):super().__init__(master if isinstance(master,QWidget) else None);self._tk_init(master,**kw);self.setRange(0,100)
    def start(self,interval=80):self.setRange(0,0)
    def stop(self):self.setRange(0,100)
class Separator(QFrame,TkWidgetMixin):
    def __init__(self,master=None,**kw):
        orient=kw.pop("orient",HORIZONTAL);super().__init__(master if isinstance(master,QWidget) else None);self._tk_init(master,**kw);self.setFrameShape(QFrame.Shape.HLine if orient==HORIZONTAL else QFrame.Shape.VLine);self.setFrameShadow(QFrame.Shadow.Sunken)
class Text(QPlainTextEdit,TkWidgetMixin):
    def __init__(self,master=None,**kw):super().__init__(master if isinstance(master,QWidget) else None);self._tk_init(master,**kw);self._tags={}
    def get(self,start="1.0",end=END):return self.toPlainText()
    def insert(self,index,text,tags=()):
        cur=self.textCursor();cur.setPosition(self._textpos(index));cur.insertText(str(text));self.setTextCursor(cur)
        for tag in (tags if isinstance(tags,(tuple,list)) else (tags,)):
            self.tag_add(tag,index,f"{index} + {len(str(text))} chars")
    def delete(self,start,end=None):
        a=self._textpos(start);b=self._textpos(end) if end is not None else a+1;c=self.textCursor();c.setPosition(a);c.setPosition(b,QTextCursor.MoveMode.KeepAnchor);c.removeSelectedText();self.setTextCursor(c)
    def _textpos(self,index):
        s=self.toPlainText()
        if index in ("end",END):return len(s)
        m=re.match(r"(\d+)\.(\d+|end)(?:\s*([+-])\s*(\d+)\s*chars?)?",str(index))
        if not m:return 0
        line=int(m.group(1))-1; lines=s.split("\n");pos=sum(len(x)+1 for x in lines[:line])
        pos+=len(lines[line]) if m.group(2)=="end" and line<len(lines) else int(m.group(2))
        if m.group(3):pos+=int(m.group(4))*(1 if m.group(3)=="+" else -1)
        return max(0,min(len(s),pos))
    def see(self,index):self.moveCursor(QTextCursor.MoveOperation.End);self.ensureCursorVisible()
    def yview(self,*args):
        bar=self.verticalScrollBar()
        if not args:return (bar.value()/max(1,bar.maximum()),(bar.value()+bar.pageStep())/max(1,bar.maximum()))
        if args[0]=="moveto":bar.setValue(int(float(args[1])*bar.maximum()))
        elif args[0]=="scroll":bar.setValue(bar.value()+int(args[1])*bar.singleStep())
    def tag_configure(self,name,**kw):self._tags[name]=kw
    tag_config=tag_configure
    def tag_add(self,name,start,end):
        cur=self.textCursor();cur.setPosition(self._textpos(start));cur.setPosition(self._textpos(end),QTextCursor.MoveMode.KeepAnchor);fmt=QTextCharFormat();opts=self._tags.get(name,{})
        if opts.get("foreground"):fmt.setForeground(QColor(opts["foreground"]))
        if opts.get("background"):fmt.setBackground(QColor(opts["background"]))
        if opts.get("font") and "bold" in str(opts["font"]):fmt.setFontWeight(QFont.Weight.Bold)
        cur.mergeCharFormat(fmt)

class Scrollbar(QScrollBar,TkWidgetMixin):
    def __init__(self,master=None,**kw):
        orient=kw.pop("orient",VERTICAL);command=kw.pop("command",None);super().__init__(Qt.Orientation.Vertical if orient==VERTICAL else Qt.Orientation.Horizontal,master if isinstance(master,QWidget) else None);self._tk_init(master,**kw);self._command=command
        self.valueChanged.connect(lambda v: command("moveto",v/max(1,self.maximum())) if command else None)
    def set(self,first,last):
        try:self.setRange(0,1000);self.setValue(int(float(first)*1000));self.setPageStep(max(1,int((float(last)-float(first))*1000)))
        except Exception:pass
class Treeview(QTreeWidget,TkWidgetMixin):
    def __init__(self,master=None,**kw):
        cols=kw.pop("columns",());show=kw.pop("show","headings");super().__init__(master if isinstance(master,QWidget) else None);self._tk_init(master,**kw);self._cols=list(cols);self.setColumnCount(len(cols));self.setHeaderLabels([str(c) for c in cols]);self.setHeaderHidden(show=="");self._rows={}
    def heading(self,col,**kw):
        i=self._col(col)
        if "text" in kw:self.headerItem().setText(i,str(kw["text"]))
    def column(self,col,**kw):
        i=self._col(col)
        if "width" in kw:self.setColumnWidth(i,int(kw["width"]))
        if "minwidth" in kw:self.header().setMinimumSectionSize(int(kw["minwidth"]))
    def _col(self,col):return self._cols.index(col) if col in self._cols else int(col)
    def insert(self,parent,index,iid=None,**kw):
        iid=str(iid or len(self._rows));vals=kw.get("values",());item=QTreeWidgetItem([str(v) for v in vals]);parent_item=self._rows.get(parent)
        (parent_item.addChild(item) if parent_item else self.addTopLevelItem(item));self._rows[iid]=item;item.setData(0,Qt.ItemDataRole.UserRole,iid)
        for tag in kw.get("tags",()):self._apply_tree_tag(item,tag)
        return iid
    def _apply_tree_tag(self,item,tag):
        opts=getattr(self,"_tree_tags",{}).get(tag,{})
        if opts.get("foreground"):
            for i in range(self.columnCount()):item.setForeground(i,QColor(opts["foreground"]))
        if opts.get("background"):
            for i in range(self.columnCount()):item.setBackground(i,QColor(opts["background"]))
    def tag_configure(self,name,**kw):
        if not hasattr(self,"_tree_tags"):self._tree_tags={}
        self._tree_tags[name]=kw
        for item in self._rows.values():self._apply_tree_tag(item,name)
    tag_config=tag_configure
    def get_children(self,item=""):return [k for k,v in self._rows.items() if v.parent() is None] if not item else [k for k,v in self._rows.items() if v.parent() is self._rows.get(item)]
    get_children_alias=get_children
    def item(self,iid,**kw):
        item=self._rows.get(str(iid))
        if item is None:return {}
        if "values" in kw:
            for i,v in enumerate(kw["values"]):item.setText(i,str(v))
        return {"values":[item.text(i) for i in range(self.columnCount())]}
    def delete(self,*iids):
        for iid in iids:
            item=self._rows.pop(str(iid),None)
            if item:
                (item.parent().removeChild(item) if item.parent() else self.takeTopLevelItem(self.indexOfTopLevelItem(item)))
    def selection(self):return [str(x.data(0,Qt.ItemDataRole.UserRole) or self._iid(x)) for x in self.selectedItems()]
    def selection_set(self,*iids):
        self.clearSelection()
        for iid in iids:
            item=self._rows.get(str(iid))
            if item:item.setSelected(True)
    def selection_remove(self,*iids):
        for iid in iids:
            item=self._rows.get(str(iid))
            if item:item.setSelected(False)
    def exists(self,iid):return str(iid) in self._rows
    def set(self,iid,column,value=None):
        item=self._rows.get(str(iid));col=self._col(column)
        if item is None:return ""
        if value is not None:item.setText(col,str(value))
        return item.text(col)
    def identify_row(self,y):
        item=self.itemAt(2,int(y));return self._iid(item) if item else ""
    def see(self,iid):
        item=self._rows.get(str(iid))
        if item:self.scrollToItem(item)
    def _iid(self,item):return next((k for k,v in self._rows.items() if v is item),"")
    def yview(self,*args):
        bar=self.verticalScrollBar()
        if args and args[0]=="moveto":bar.setValue(int(float(args[1])*bar.maximum()))

class Notebook(QTabWidget,TkWidgetMixin):
    def __init__(self,master=None,**kw):super().__init__(master if isinstance(master,QWidget) else None);self._tk_init(master,**kw);self._tabs=[]
    def add(self,child,**kw):self.addTab(child,str(kw.get("text", "")));self._tabs.append(child)
    def tab(self,child,**kw):
        i=self.index(child)
        if "text" in kw:self.setTabText(i,str(kw["text"]))
        return {"text":self.tabText(i)}
    def index(self,child):return self.indexOf(child) if isinstance(child,QWidget) else int(child)
    def select(self,child=None):
        if child is not None:self.setCurrentIndex(self.index(child))
        return self.currentIndex()

class _CanvasSurface(QWidget):
    def __init__(self,canvas):super().__init__();self.canvas=canvas;self.setMinimumSize(1,1)
    def paintEvent(self,event):
        p=QPainter(self);p.setRenderHint(QPainter.RenderHint.Antialiasing)
        for kind,coords,opts in self.canvas._items.values():
            if kind=="window":continue
            pts=list(zip(coords[::2],coords[1::2]));fill=QColor(opts.get("fill") or "transparent");outline=QColor(opts.get("outline") or opts.get("fill") or "transparent");width=float(opts.get("width",1));p.setPen(QPen(outline,width));p.setBrush(QBrush(fill))
            if kind=="rectangle" and len(pts)>=2:p.drawRect(QRect(int(pts[0][0]),int(pts[0][1]),int(pts[1][0]-pts[0][0]),int(pts[1][1]-pts[0][1])))
            elif kind=="oval" and len(pts)>=2:p.drawEllipse(QRect(int(pts[0][0]),int(pts[0][1]),int(pts[1][0]-pts[0][0]),int(pts[1][1]-pts[0][1])))
            elif kind=="line" and len(pts)>=2:
                for a,b in zip(pts,pts[1:]):p.drawLine(int(a[0]),int(a[1]),int(b[0]),int(b[1]))
            elif kind=="polygon" and pts:p.drawPolygon(QPolygon([QPoint(int(x),int(y)) for x,y in pts]))
            elif kind=="arc" and len(pts)>=2:p.drawArc(QRect(int(pts[0][0]),int(pts[0][1]),int(pts[1][0]-pts[0][0]),int(pts[1][1]-pts[0][1])),0,180*16)
            elif kind=="text" and pts:
                p.setPen(QColor(opts.get("fill", "#f2f3f4")));p.setFont(QFont("Segoe UI",int(opts.get("font",(10,))[1] if isinstance(opts.get("font"),(tuple,list)) else 10)));p.drawText(int(pts[0][0]),int(pts[0][1]),str(opts.get("text","")))

class Canvas(QScrollArea,TkWidgetMixin):
    def __init__(self,master=None,**kw):
        super().__init__(master if isinstance(master,QWidget) else None);self._tk_init(master,**kw);self.setWidgetResizable(False);self._surface=_CanvasSurface(self);self.setWidget(self._surface);self._items={};self._seq=0;self._windows={};self._region=None
    def _new(self,kind,coords,opts):
        self._seq+=1;self._items[self._seq]=(kind,list(coords),dict(opts));self._redraw();return self._seq
    def create_line(self,*coords,**kw):return self._new("line",coords,kw)
    def create_rectangle(self,*coords,**kw):return self._new("rectangle",coords,kw)
    def create_oval(self,*coords,**kw):return self._new("oval",coords,kw)
    def create_polygon(self,*coords,**kw):return self._new("polygon",coords,kw)
    def create_arc(self,*coords,**kw):return self._new("arc",coords,kw)
    def create_text(self,*coords,**kw):return self._new("text",coords,kw)
    def create_window(self,*coords,**kw):
        win=kw.pop("window",None);ident=self._new("window",coords,kw)
        if win:
            win.setParent(self._surface);x,y=coords[:2];win.move(int(x),int(y));win.show();self._windows[ident]=win
        return ident
    def itemconfigure(self,ident,**kw):
        kind,coords,opts=self._items[ident];opts.update(kw);self._items[ident]=(kind,coords,opts)
        if ident in self._windows:
            if "width" in kw:self._windows[ident].setFixedWidth(int(kw["width"]))
            if "height" in kw:self._windows[ident].setFixedHeight(int(kw["height"]))
        self._redraw()
    itemconfig=itemconfigure
    def coords(self,ident,*coords):
        kind,old,opts=self._items[ident]
        if coords:self._items[ident]=(kind,list(coords),opts);self._redraw()
        return self._items[ident][1]
    def delete(self,ident):
        if ident in ("all",):self._items.clear();self._windows.clear()
        else:self._items.pop(ident,None);self._windows.pop(ident,None)
        self._redraw()
    def bbox(self,ident="all"):
        pts=[]
        for item_id,(kind,coords,opts) in self._items.items():
            pts.extend((coords[i],coords[i+1]) for i in range(0,len(coords)-1,2))
            if kind=="window" and item_id in self._windows:
                x,y=coords[:2];w=self._windows[item_id]
                pts.append((x+w.width(),y+w.height()))
        return (min((x for x,y in pts),default=0),min((y for x,y in pts),default=0),max((x for x,y in pts),default=self.viewport().width()),max((y for x,y in pts),default=self.viewport().height()))
    def configure(self,cnf=None,**kw):
        if isinstance(cnf,dict):kw={**cnf,**kw}
        region=kw.pop("scrollregion",None)
        if region:
            self._region=tuple(map(int,region));self._surface.resize(max(1,self._region[2]+10),max(1,self._region[3]+10))
        return TkWidgetMixin.configure(self,**kw)
    config=configure
    def yview(self,*args):return self.verticalScrollBar().setValue(int(float(args[-1])*self.verticalScrollBar().maximum())) if args else (0,1)
    def yview_scroll(self,number,what="units"):
        bar=self.verticalScrollBar();bar.setValue(bar.value()+int(number)*(bar.singleStep() if what=="units" else bar.pageStep()))
    def xview(self,*args):return self.horizontalScrollBar().setValue(int(float(args[-1])*self.horizontalScrollBar().maximum())) if args else (0,1)
    def xview_scroll(self,number,what="units"):
        bar=self.horizontalScrollBar();bar.setValue(bar.value()+int(number)*(bar.singleStep() if what=="units" else bar.pageStep()))
    def _redraw(self):
        if hasattr(self,"_surface"):self._surface.update()

class Menu(QMenu,TkWidgetMixin):
    def __init__(self,master=None,**kw):super().__init__(master if isinstance(master,QWidget) else None);self._tk_init(master,**kw)
    def add_command(self,**kw):
        action=self.addAction(str(kw.get("label","")));action.triggered.connect(kw.get("command") or (lambda:None));
        if kw.get("state")==DISABLED:action.setEnabled(False)
        return action
    def add_separator(self):return self.addSeparator()
    def add_cascade(self,**kw):
        action=self.addMenu(kw["menu"]);action.setText(str(kw.get("label","")));return action
    def tk_popup(self,x,y):self.exec(QPoint(int(x),int(y)))
    def grab_release(self):pass

class Style:
    def __init__(self,master=None,theme=None):ensure_app()
    def theme_use(self,*args):return "fusion"
    def configure(self,name=None,**kw):
        if name:_STYLE_RULES.setdefault(str(name),{}).update(kw)
    def map(self,name=None,**kw):
        if name:_STYLE_MAPS.setdefault(str(name),{}).update(kw)

class _FramelessResizeFilter(QObject):
    def eventFilter(self,obj,event):
        if not isinstance(obj,QWidget):return False
        top=obj.window()
        if not isinstance(top,Window):return False
        margin=7;pos=event.globalPosition().toPoint() if hasattr(event,"globalPosition") else None
        if pos is None:return False
        rect=top.frameGeometry();edges=Qt.Edge(0)
        if pos.x()<=rect.left()+margin:edges|=Qt.Edge.LeftEdge
        elif pos.x()>=rect.right()-margin:edges|=Qt.Edge.RightEdge
        if pos.y()<=rect.top()+margin:edges|=Qt.Edge.TopEdge
        elif pos.y()>=rect.bottom()-margin:edges|=Qt.Edge.BottomEdge
        if event.type()==QEvent.Type.MouseButtonPress and event.button()==Qt.MouseButton.LeftButton and edges:
            handle=top.windowHandle()
            if handle and handle.startSystemResize(edges):return True
        if event.type()==QEvent.Type.MouseMove and not event.buttons():
            cursor=Qt.CursorShape.ArrowCursor
            if edges in (Qt.Edge.LeftEdge|Qt.Edge.TopEdge,Qt.Edge.RightEdge|Qt.Edge.BottomEdge):cursor=Qt.CursorShape.SizeFDiagCursor
            elif edges in (Qt.Edge.RightEdge|Qt.Edge.TopEdge,Qt.Edge.LeftEdge|Qt.Edge.BottomEdge):cursor=Qt.CursorShape.SizeBDiagCursor
            elif edges&(Qt.Edge.LeftEdge|Qt.Edge.RightEdge):cursor=Qt.CursorShape.SizeHorCursor
            elif edges&(Qt.Edge.TopEdge|Qt.Edge.BottomEdge):cursor=Qt.CursorShape.SizeVerCursor
            obj.setCursor(cursor)
        return False

class Window(QMainWindow,TkWidgetMixin):
    def __init__(self,themename=None,**kw):
        ensure_app();super().__init__();self._tk_init(None);self._central=QWidget();self.setCentralWidget(self._central);self._tk_children=[];self._tk_window_title="";self._closed=False
        self.setWindowFlags(Qt.WindowType.FramelessWindowHint|Qt.WindowType.Window)
        self._outer=QVBoxLayout(self._central);self._outer.setContentsMargins(0,0,0,0);self._outer.setSpacing(0)
        self._title=QWidget();self._title.setFixedHeight(34);self._title.setStyleSheet("background:#17191b;")
        row=QHBoxLayout(self._title);row.setContentsMargins(12,0,6,0);self._title_text=QLabel("");row.addWidget(self._title_text);row.addStretch(1)
        self._min_btn=QPushButton("—");self._max_btn=QPushButton("□");self._close_btn=QPushButton("×")
        for b in (self._min_btn,self._max_btn,self._close_btn):b.setFixedSize(34,28);row.addWidget(b)
        self._min_btn.clicked.connect(self.showMinimized);self._max_btn.clicked.connect(self._toggle_max);self._close_btn.clicked.connect(self.close)
        self._outer.addWidget(self._title);self._central_layout=QVBoxLayout();self._central_layout.setContentsMargins(10,8,10,10);self._central_layout.setSpacing(7);self._outer.addLayout(self._central_layout)
        self._drag=None;self._title.mousePressEvent=self._title_press;self._title.mouseMoveEvent=self._title_move;self._title.mouseDoubleClickEvent=lambda e:self._toggle_max()
        self.setStyleSheet("background:#1e2022;color:#f2f3f4;")
        app=ensure_app()
        if not hasattr(app,"_qt_resize_filter"):
            app._qt_resize_filter=_FramelessResizeFilter(app);app.installEventFilter(app._qt_resize_filter)
        if kw:self.configure(**kw)
    def _get_tk_layout(self,kind="pack",side=TOP):
        if kind=="grid":
            layout=self._central.layout()
            if not isinstance(layout,QGridLayout):
                layout=QGridLayout();self._central.setLayout(layout)
            return layout
        return self._central_layout
    def setWindowTitle(self,title):super().setWindowTitle(str(title));self._title_text.setText(str(title))
    def title(self,value=None):
        if value is None:return self.windowTitle()
        self.setWindowTitle(value)
    def geometry(self,value=None):
        if value is None:return f"{self.width()}x{self.height()}+{self.x()}+{self.y()}"
        m=re.match(r"(?:(\d+)x(\d+))?(?:([+-]\d+)([+-]\d+))?",str(value))
        if m:
            if m.group(1):self.resize(int(m.group(1)),int(m.group(2)))
            if m.group(3):self.move(int(m.group(3)),int(m.group(4)))
    def minsize(self,w,h):self.setMinimumSize(int(w),int(h))
    def resizable(self,width=True,height=True):
        if width:self.setMinimumWidth(0);self.setMaximumWidth(16777215)
        else:self.setMinimumWidth(self.width());self.setMaximumWidth(self.width())
        if height:self.setMinimumHeight(0);self.setMaximumHeight(16777215)
        else:self.setMinimumHeight(self.height());self.setMaximumHeight(self.height())
        if hasattr(self,"_max_btn"):
            self._max_btn.setVisible(bool(width or height))
    def protocol(self,name,callback):
        if name=="WM_DELETE_WINDOW":self._close_callback=callback
    def closeEvent(self,event):
        cb=getattr(self,"_close_callback",None)
        if cb:
            event.ignore();cb()
        else:event.accept()
    def mainloop(self):ensure_app().exec()
    def quit(self):ensure_app().quit()
    def configure(self,cnf=None,**kw):return TkWidgetMixin.configure(self,cnf,**kw)
    config=configure
    def attributes(self,key,*args):
        if key in ("-topmost","topmost"):
            self.setWindowFlag(Qt.WindowType.WindowStaysOnTopHint,bool(args[0]) if args else True);self.show()
        elif key in ("-alpha","alpha") and args:self.setWindowOpacity(float(args[0]))
    def iconbitmap(self,*args):pass
    def _toggle_max(self):self.showNormal() if self.isMaximized() else self.showMaximized()
    def _title_press(self,e):
        self._drag=e.globalPosition().toPoint();self._system_drag=False
        handle=self.windowHandle()
        if handle and e.button()==Qt.MouseButton.LeftButton:
            try:self._system_drag=bool(handle.startSystemMove())
            except Exception:pass
    def _title_move(self,e):
        if self._drag and not self._system_drag and e.buttons()&Qt.MouseButton.LeftButton:
            p=e.globalPosition().toPoint();self.move(self.pos()+p-self._drag);self._drag=p

class Toplevel(QWidget,TkWidgetMixin):
    def __init__(self,master=None,**kw):
        ensure_app();super().__init__(master if isinstance(master,QWidget) else None);self._tk_init(master);self.setWindowFlags(Qt.WindowType.FramelessWindowHint|Qt.WindowType.Window);self._tk_outer=QVBoxLayout(self);self._tk_outer.setContentsMargins(0,0,0,0);self._tk_layout=QVBoxLayout();self._tk_outer.addLayout(self._tk_layout)
        if kw:self.configure(**kw)
    def _get_tk_layout(self,kind="pack",side=TOP):return self._tk_layout
    def title(self,value):self.setWindowTitle(str(value))
    def geometry(self,value):
        m=re.match(r"(?:(\d+)x(\d+))?(?:([+-]\d+)([+-]\d+))?",str(value))
        if m:
            if m.group(1):self.resize(int(m.group(1)),int(m.group(2)))
            if m.group(3):self.move(int(m.group(3)),int(m.group(4)))
    def protocol(self,name,callback):self._close_callback=callback
    def overrideredirect(self,value):pass
    def attributes(self,key,*args):
        if key in ("-topmost","topmost") and args:self.setWindowFlag(Qt.WindowType.WindowStaysOnTopHint,bool(args[0]));self.show()
        elif key in ("-alpha","alpha") and args:self.setWindowOpacity(float(args[0]))
    def deiconify(self):self.show()
    def withdraw(self):self.hide()
    def mainloop(self):ensure_app().exec()
    def closeEvent(self,e):
        cb=getattr(self,"_close_callback",None)
        if cb:e.ignore();cb()
        else:e.accept()

class TkNamespace:
    Tk=Window;Toplevel=Toplevel;Frame=Frame;Label=Label;Button=Button;Entry=Entry;Text=Text;Canvas=Canvas;Menu=Menu;Scrollbar=Scrollbar
    StringVar=StringVar;IntVar=IntVar;DoubleVar=DoubleVar;BooleanVar=BooleanVar;TclError=RuntimeError
    END=END;INSERT=INSERT;NORMAL=NORMAL;DISABLED=DISABLED;WORD=WORD;SOLID=SOLID;FLAT=FLAT
    X=X;Y=Y;BOTH=BOTH;LEFT=LEFT;RIGHT=RIGHT;TOP=TOP;BOTTOM=BOTTOM;CENTER=CENTER
    N=N;S=S;E=E;W=W;NW=NW;VERTICAL=VERTICAL;HORIZONTAL=HORIZONTAL
class TtkNamespace:
    Frame=Frame;Label=Label;Button=Button;Checkbutton=Checkbutton;Radiobutton=Radiobutton;Entry=Entry;Combobox=ComboBox;Scrollbar=Scrollbar;Treeview=Treeview;Separator=Separator;Progressbar=Progressbar;Scale=Scale;Notebook=Notebook;LabelFrame=LabelFrame;Style=Style
class TBNamespace(TtkNamespace):
    Window=Window;Frame=Frame;Label=Label;Button=Button;Checkbutton=Checkbutton;Radiobutton=Radiobutton;Entry=Entry;Combobox=ComboBox;Scrollbar=Scrollbar;Treeview=Treeview;Separator=Separator;Progressbar=Progressbar;Scale=Scale;Notebook=Notebook;LabelFrame=LabelFrame;Style=Style

tk=TkNamespace();ttk=TtkNamespace();tb=TBNamespace()

def _dialog_filter(filetypes):
    if isinstance(filetypes,str):return filetypes
    try:return ";;".join(f"{label} ({pattern})" for label,pattern in filetypes)
    except (TypeError,ValueError):return ""

class _FileDialog:
    @staticmethod
    def askopenfilename(**kw):return QFileDialog.getOpenFileName(None,kw.get("title","Open"),kw.get("initialdir",""),_dialog_filter(kw.get("filetypes",())))[0]
    @staticmethod
    def askdirectory(**kw):return QFileDialog.getExistingDirectory(None,kw.get("title","Select folder"),kw.get("initialdir",""))
    @staticmethod
    def asksaveasfilename(**kw):return QFileDialog.getSaveFileName(None,kw.get("title","Save"),kw.get("initialdir",""),_dialog_filter(kw.get("filetypes",())))[0]
filedialog=_FileDialog
class _MessageBox:
    @staticmethod
    def showinfo(title,message,**kw):return QMessageBox.information(None,str(title),str(message))
    @staticmethod
    def showwarning(title,message,**kw):return QMessageBox.warning(None,str(title),str(message))
    @staticmethod
    def showerror(title,message,**kw):return QMessageBox.critical(None,str(title),str(message))
    @staticmethod
    def askyesno(title,message,**kw):return QMessageBox.question(None,str(title),str(message),QMessageBox.StandardButton.Yes|QMessageBox.StandardButton.No)==QMessageBox.StandardButton.Yes
    @staticmethod
    def askokcancel(title,message,**kw):return QMessageBox.question(None,str(title),str(message),QMessageBox.StandardButton.Ok|QMessageBox.StandardButton.Cancel)==QMessageBox.StandardButton.Ok
messagebox=_MessageBox
class _SimpleDialog:
    @staticmethod
    def askstring(title,prompt,**kw):
        value,ok=QInputDialog.getText(None,str(title),str(prompt),text=str(kw.get("initialvalue", "")));return value if ok else None
simpledialog=_SimpleDialog

class _Constants:
    X=X;Y=Y;BOTH=BOTH;LEFT=LEFT;RIGHT=RIGHT;TOP=TOP;BOTTOM=BOTTOM;CENTER=CENTER;N=N;S=S;E=E;W=W;NW=NW;VERTICAL=VERTICAL;HORIZONTAL=HORIZONTAL;END=END;NORMAL=NORMAL;DISABLED=DISABLED
constants=_Constants()

class ScrolledText(Frame):
    def __init__(self,master=None,**kw):super().__init__(master);self.text=Text(self,**kw);self.text.pack(fill=BOTH,expand=True)
    def __getattr__(self,name):return getattr(self.text,name)

# PySide QTextCursor isn't re-exported by QtWidgets.
from PySide6.QtGui import QTextCursor
