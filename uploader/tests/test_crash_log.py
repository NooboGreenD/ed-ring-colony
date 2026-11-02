"""Журнал падений: «программа закрылась без ошибки» должно оставлять след.

Правила, за которые держат эти тесты:

* падение в главном потоке, в рабочем потоке и проглоченное исключение
  попадают в один файл рядом с установкой — оконная сборка консоли не имеет;
* запись в журнал никогда не мешает программе: любая ошибка записи глушится;
* следующий запуск узнаёт про недавнее падение (и не пугает старым);
* установка журнала идемпотентна и снимается без следов.
"""

import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import crash_log  # noqa: E402


class CrashLogTests(unittest.TestCase):
    def setUp(self):
        self.work = Path(tempfile.mkdtemp())
        self.installed = []
        self.original = (sys.excepthook, getattr(threading, "excepthook", None),
                         getattr(sys, "unraisablehook", None))
        # Предыдущие перехватчики глушим: журнал не должен печатать в stderr
        # чужой трассировки во время тестов.
        sys.excepthook = lambda *args: None
        threading.excepthook = lambda args: None
        sys.unraisablehook = lambda args: None

    def tearDown(self):
        crash_log.uninstall()
        sys.excepthook, self.thread_hook, self.unraisable_hook = self.original
        if self.thread_hook is not None:
            threading.excepthook = self.thread_hook
        if self.unraisable_hook is not None:
            sys.unraisablehook = self.unraisable_hook
        import shutil

        shutil.rmtree(self.work, ignore_errors=True)

    def install(self):
        path = crash_log.install(self.work, version="2.24.0", extra="проверка")
        self.installed.append(path)
        return path

    def text(self):
        return crash_log.log_path(self.work).read_text(encoding="utf-8")

    # ------------------------------------------------------------- журнал
    def test_log_lives_next_to_the_installation(self):
        path = self.install()
        self.assertEqual(Path(path), self.work / "logs" / crash_log.LOG_NAME)
        self.assertIn("запуск Helper 2.24.0", self.text())

    def test_main_thread_exception_is_written(self):
        self.install()
        try:
            raise RuntimeError("основной поток упал")
        except RuntimeError:
            sys.excepthook(*sys.exc_info())
        text = self.text()
        self.assertIn("исключение: RuntimeError: основной поток упал", text)
        self.assertIn("Traceback", text, "нужен стек, а не только сообщение")

    def test_thread_exception_is_written_with_its_name(self):
        """Обновления, выгрузка и синхронизация идут в потоках — падают молча."""
        self.install()
        state = {}

        def worker():
            try:
                raise ValueError("поток упал")
            except ValueError:
                state["args"] = threading.ExceptHookArgs(
                    (ValueError, ValueError("поток упал"), sys.exc_info()[2],
                     threading.current_thread()))

        thread = threading.Thread(target=worker, name="route-export")
        thread.start()
        thread.join()
        threading.excepthook(state["args"])
        text = self.text()
        self.assertIn("поток «route-export»: ValueError: поток упал", text)

    def test_unraisable_exception_is_written(self):
        self.install()
        class Args:
            object = None
            err_msg = "в обработчике Qt"

        try:
            raise TypeError("проглотили")
        except TypeError:
            Args.exc_type = TypeError
            Args.exc_value = sys.exc_info()[1]
            Args.exc_traceback = None
            sys.unraisablehook(Args())
        self.assertIn("проглоченное исключение", self.text())

    # --------------------------------------------------------- прошлый запуск
    def test_previous_crash_is_reported_on_the_next_start(self):
        self.install()
        try:
            raise RuntimeError("прошлый запуск")
        except RuntimeError:
            sys.excepthook(*sys.exc_info())
        self.assertIn("RuntimeError: прошлый запуск", crash_log.recent_crash(self.work))

    def test_old_crash_from_last_week_is_not_reported(self):
        self.install()
        path = crash_log.log_path(self.work)
        stamp = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(time.time() - 8 * 24 * 3600))
        path.write_text(
            f"\n{crash_log.MARK}\n{stamp} исключение: RuntimeError: старое\n{crash_log.MARK}\n"
            "Traceback …\n",
            encoding="utf-8",
        )
        self.assertEqual(crash_log.recent_crash(self.work), "")

    def test_clean_log_has_no_crash(self):
        self.install()
        self.assertEqual(crash_log.recent_crash(self.work), "")

    def test_missing_log_is_not_an_error(self):
        self.assertEqual(crash_log.recent_crash(self.work / "нет-такого"), "")
        self.assertEqual(crash_log.recent_crash(Path("/nonexistent/dir")), "")

    def test_native_crash_is_reported_from_the_stack_dump(self):
        """Нативный сбой `faulthandler` пишет без метки времени — берём время файла."""
        self.install()
        with open(crash_log.log_path(self.work), "a", encoding="utf-8") as handle:
            handle.write("\nFatal Python error: Segmentation fault\n\n"
                         "Current thread 0x00001f2c (most recent call first):\n"
                         '  File "overlay.py", line 812 in paint\n')
        self.assertIn("Segmentation fault", crash_log.recent_crash(self.work))
        reason, _path = crash_log.notice_details(self.work)
        self.assertTrue(reason.startswith("Fatal Python error"))

    def test_old_native_crash_is_not_reported(self):
        self.install()
        path = crash_log.log_path(self.work)
        with open(path, "a", encoding="utf-8") as handle:
            handle.write("\nFatal Python error: Segmentation fault\n")
        old = time.time() - 8 * 24 * 3600
        os.utime(path, (old, old))
        self.assertEqual(crash_log.recent_crash(self.work), "")

    def test_long_reason_is_shortened_for_the_window(self):
        """Стартовый экран — не журнал: длинное сообщение не должно его занять."""
        self.install()
        try:
            raise RuntimeError("очень длинная причина " * 40)
        except RuntimeError:
            sys.excepthook(*sys.exc_info())
        reason, _path = crash_log.notice_details(self.work)
        self.assertLessEqual(len(reason), crash_log.REASON_CHARS + 1)
        self.assertTrue(reason.endswith("…"))

    def test_notice_details_gives_reason_and_path_for_the_launcher(self):
        """Стартовый экран показывает и причину, и куда смотреть."""
        self.install()
        reason, path = crash_log.notice_details(self.work)
        self.assertEqual(reason, "")
        self.assertEqual(Path(path), self.work / "logs" / crash_log.LOG_NAME)

        try:
            raise RuntimeError("падение посреди полёта")
        except RuntimeError:
            sys.excepthook(*sys.exc_info())
        reason, path = crash_log.notice_details(self.work)
        self.assertIn("падение посреди полёта", reason)
        self.assertTrue(path.endswith(crash_log.LOG_NAME))

    # ------------------------------------------------------------- установка
    def test_install_twice_keeps_one_banner(self):
        self.install()
        crash_log.install(self.work, version="2.24.0", extra="проверка")
        self.assertEqual(self.text().count("запуск Helper 2.24.0"), 1)

    def test_install_in_another_root_stops_writing_to_the_old_log(self):
        """Установку перенесли — журнал один, а не два."""
        self.install()
        other = self.work / "another"
        crash_log.install(other, version="2.24.0")
        try:
            raise RuntimeError("после переноса")
        except RuntimeError:
            sys.excepthook(*sys.exc_info())
        self.assertIn("после переноса",
                      crash_log.log_path(other).read_text(encoding="utf-8"))
        self.assertNotIn("после переноса", self.text())

    def test_uninstall_restores_the_hooks(self):
        before = sys.excepthook
        self.install()
        self.assertIsNot(sys.excepthook, before)
        crash_log.uninstall()
        self.assertIs(sys.excepthook, before)
        self.assertEqual(crash_log.recent_crash(self.work), "", "после снятия не пишем")

    def test_unwritable_log_does_not_break_the_program(self):
        path = self.work / "logs"
        path.mkdir(parents=True)
        # Каталог на месте файла: запись невозможна, но программа работает.
        (path / crash_log.LOG_NAME).mkdir()
        crash_log.install(self.work, version="2.24.0")
        try:
            raise RuntimeError("некуда писать")
        except RuntimeError:
            sys.excepthook(*sys.exc_info())     # не должно бросить
        self.assertEqual(crash_log.recent_crash(self.work), "")


if __name__ == "__main__":
    unittest.main()
