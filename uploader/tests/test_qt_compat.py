"""Small real-widget smoke tests for the PySide6 Tk-API facade."""
import os
import sys
import unittest
from pathlib import Path

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent))
os.environ.setdefault("QT_QPA_PLATFORM","offscreen")
try:
    import qt_compat as qt
    QT_ERROR=None
except (ImportError,OSError) as exc:
    qt=None;QT_ERROR=str(exc)

@unittest.skipIf(qt is None,f"PySide6 GUI runtime unavailable: {QT_ERROR}")
class QtCompatSmokeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app=qt.ensure_app()

    def test_line_edit_preserves_insert_delete_contract(self):
        entry=qt.ttk.Entry()
        entry.insert(0,"ab");entry.insert(1,"X");entry.insert("end","!")
        self.assertEqual(entry.get(),"aXb!")
        entry.delete(0,qt.END)
        self.assertEqual(entry.get(),"")
        entry.deleteLater()

    def test_text_widget_supports_ranges_and_readonly_logs(self):
        text=qt.tk.Text()
        text.insert("1.0","hello\nworld")
        text.tag_configure("accent",foreground="#42b9d4",font=("Segoe UI",10,"bold"))
        text.tag_add("accent","1.0","1.5")
        text.configure(state=qt.DISABLED)
        self.assertEqual(text.get("1.0",qt.END),"hello\nworld")
        self.assertTrue(text.isReadOnly())
        text.deleteLater()

    def test_pack_layout_and_frameless_window_are_qt_widgets(self):
        window=qt.tk.Tk();window.geometry("500x360");window.minsize(400,300)
        frame=qt.tk.Frame(window);frame.pack(fill=qt.BOTH,expand=True)
        label=qt.tk.Label(frame,text="Qt-backed")
        label.pack(anchor=qt.W,padx=8,pady=6)
        self.assertTrue(window.isWindow())
        self.assertTrue(window.windowFlags()&qt.Qt.WindowType.FramelessWindowHint)
        self.assertIsNotNone(frame.layout())
        window.destroy()

    def test_root_window_is_visible_and_can_be_withdrawn(self):
        window=qt.tk.Tk()
        self.app.processEvents()
        self.assertTrue(window.isVisible())
        window.withdraw()
        self.assertFalse(window.isVisible())
        self.assertEqual(window.state(),"withdrawn")
        window.deiconify()
        self.assertTrue(window.isVisible())
        window.destroy()

    def test_faction_widget_is_clickable_qt_ui(self):
        # Отдельный процесс: другие тесты подменяют qt_lazy заглушками, и в
        # общем процессе фабрика вернула бы mock вместо настоящего виджета.
        import subprocess
        script=(
            "from qt_factions import FactionInfographic\n"
            "from ui_qt import ensure_app\n"
            "app=ensure_app()\n"
            "widget=FactionInfographic(locale='ja')\n"
            "assert widget.layout().count()>0, 'no layout items'\n"
            "assert widget.objectName()=='FactionInfographic', widget.objectName()\n"
            "print('ok')\n")
        completed=subprocess.run([sys.executable,"-c",script],cwd=str(HERE.parent),
                                 capture_output=True,text=True,timeout=120)
        self.assertEqual(completed.returncode,0,completed.stderr[-1500:])
        self.assertIn("ok",completed.stdout)

if __name__=="__main__":unittest.main()
