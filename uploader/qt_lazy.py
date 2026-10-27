"""Lazy bindings to the PySide6 compatibility facade.

Importing parser/business modules must remain possible in headless test jobs;
the Qt runtime is loaded only when a desktop window is actually requested.
"""
from __future__ import annotations
import importlib

_CONSTANTS={"END":"end","INSERT":"insert","NORMAL":"normal","DISABLED":"disabled","WORD":"word","SOLID":"solid","FLAT":"flat","X":"x","Y":"y","BOTH":"both","LEFT":"left","RIGHT":"right","TOP":"top","BOTTOM":"bottom","CENTER":"center","N":"n","S":"s","E":"e","W":"w","NW":"nw","VERTICAL":"vertical","HORIZONTAL":"horizontal"}

class _LazyNamespace:
    def __init__(self, name): self._name=name
    def __getattr__(self, attr):
        if attr in _CONSTANTS:return _CONSTANTS[attr]
        module=importlib.import_module("qt_compat")
        return getattr(getattr(module,self._name),attr)

class _LazyFunction:
    def __init__(self,name):self._name=name
    def __call__(self,*args,**kwargs):return getattr(importlib.import_module("qt_compat"),self._name)(*args,**kwargs)

qt = _LazyNamespace("tk")
tk = qt
ttk = _LazyNamespace("ttk")
tb = _LazyNamespace("tb")
filedialog = _LazyNamespace("filedialog")
messagebox = _LazyNamespace("messagebox")
simpledialog = _LazyNamespace("simpledialog")
ScrolledText = _LazyFunction("ScrolledText")
QVBoxLayout = _LazyFunction("QVBoxLayout")
ensure_app = _LazyFunction("ensure_app")

END="end"; INSERT="insert"; NORMAL="normal"; DISABLED="disabled"; WORD="word"; SOLID="solid"
X="x";Y="y";BOTH="both";LEFT="left";RIGHT="right";TOP="top";BOTTOM="bottom";CENTER="center"
N="n";S="s";E="e";W="w";NW="nw";VERTICAL="vertical";HORIZONTAL="horizontal"
