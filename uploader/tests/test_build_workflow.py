"""Правила CI: что собирается на каждую правку, а что — раз в квартал.

После перехода на пакетное обновление у программы два конвейера:

* `build-bundle.yml` — пакет кода. Быстрый (ubuntu, ~30 с), срабатывает на
  любую правку `uploader/**`, публикует подписанный пакет на наш сервер.
* `build-exe.yml` — базовая сборка (лаунчер). Windows-раннер на 10 минут и
  новый 22-мегабайтный файл у каждого пилота, поэтому он обязан срабатывать
  ТОЛЬКО при смене рантайма: зависимости, лаунчер, механика обновлений.

Тесты держат именно это разделение: если `uploader/**` снова попадёт в фильтр
exe-сборки, мы вернёмся к «обновлению», в котором для пилота ничего не
изменилось, а если пакетный workflow потеряет публикацию — обновления просто
перестанут доезжать.
"""

import re
import unittest
from pathlib import Path

WORKFLOWS = Path(__file__).resolve().parents[2] / ".github" / "workflows"
EXE = WORKFLOWS / "build-exe.yml"
BUNDLE = WORKFLOWS / "build-bundle.yml"

#: Файлы, правка которых обязана пересобрать exe: это и есть «рантайм».
RUNTIME_PATHS = (
    "uploader/requirements.txt",
    "uploader/launcher.py",
    "uploader/build_exe.py",
    "uploader/bundle.py",
    "uploader/bundle_updater.py",
)


def _load(path: Path):
    text = path.read_text(encoding="utf-8")
    try:
        import yaml  # type: ignore
    except ImportError:
        return text, None
    return text, yaml.safe_load(text)


def _block(text: str, header: str, indent: int) -> str:
    """Строки одного YAML-блока: от `header` до следующего ключа того же уровня."""
    pad = " " * indent
    out = []
    inside = False
    for line in text.splitlines():
        if not inside:
            if line == f"{pad}{header}:" or line.startswith(f"{pad}{header}:"):
                inside = True
            continue
        stripped = line.strip()
        if stripped and not line.startswith(pad + " ") and not stripped.startswith("#"):
            break
        out.append(line)
    return "\n".join(out)


def _list_items(block: str) -> list:
    return [m.group(1).strip().strip("'\"")
            for m in re.finditer(r"^\s*-\s+(.+?)\s*$", block, re.MULTILINE)]


def _push_paths(text: str) -> list:
    push = _block(_block(text, "on", 0), "push", 2)
    return _list_items(_block(push, "paths", 4))


def _push_branches(text: str) -> list:
    push = _block(_block(text, "on", 0), "push", 2)
    return _list_items(_block(push, "branches", 4))


class ExeWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.text, self.data = _load(EXE)

    def test_workflow_exists(self):
        self.assertTrue(EXE.is_file(), f"нет файла {EXE}")
        self.assertIn("Build Colonial Helper EXE", self.text)

    def test_push_is_filtered_by_paths(self):
        self.assertIn("paths:", _block(_block(self.text, "on", 0), "push", 2),
                      "без фильтра путей exe будет собираться на каждый пуш")

    def test_code_only_changes_do_not_rebuild_the_exe(self):
        """Главное правило новой схемы: код едет пакетом, а не сборкой."""
        paths = _push_paths(self.text)
        self.assertNotIn("uploader/**", paths,
                         "правка кода не должна гонять Windows-раннер и плодить "
                         "22-мегабайтные релизы: для этого есть build-bundle.yml")
        self.assertNotIn("uploader/*.py", paths)

    def test_runtime_changes_do_rebuild_the_exe(self):
        paths = _push_paths(self.text)
        for path in RUNTIME_PATHS:
            self.assertIn(path, paths, f"{path} меняет рантайм — exe обязан пересобраться")
        self.assertIn(".github/workflows/build-exe.yml", paths)

    def test_site_paths_are_not_listed(self):
        for path in _push_paths(self.text):
            self.assertFalse(path.startswith(("src/", "supabase/", "deploy/", "scripts/")),
                             f"путь сайта {path!r} в фильтре сборки EXE")

    def test_branches_and_manual_run_are_preserved(self):
        branches = _push_branches(self.text)
        self.assertIn("main", branches)
        self.assertIn("arena/**", branches)
        self.assertIn("workflow_dispatch:", self.text)

    def test_embedded_bundle_is_signed_with_the_channel_key(self):
        """Без ключа в этом workflow пакет внутри exe будет неподписанным."""
        self.assertIn("UPLOADER_SIGN_KEY", self.text)

    def test_launcher_metadata_is_published(self):
        """Иначе программа не узнает, где взять новую базовую сборку."""
        self.assertIn("--publish-launcher", self.text)


class BundleWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.text, self.data = _load(BUNDLE)

    def test_workflow_exists(self):
        self.assertTrue(BUNDLE.is_file(), f"нет файла {BUNDLE}")

    def test_any_code_change_publishes_a_bundle(self):
        paths = _push_paths(self.text)
        self.assertIn("uploader/**", paths)

    def test_runs_on_linux_not_windows(self):
        """Ради этого всё и затевалось: 30 секунд вместо 10 минут."""
        self.assertIn("runs-on: ubuntu-latest", self.text)
        self.assertNotIn("windows-latest", self.text)

    def test_tests_run_before_publishing(self):
        self.assertIn("python -m unittest discover -s uploader/tests", self.text)
        self.assertLess(self.text.index("unittest discover"), self.text.index("--publish"),
                        "публикация не должна опережать тесты")

    def test_publishes_exactly_what_was_built(self):
        """Пересборка дала бы другую подпись, чем в артефакте."""
        self.assertIn("--publish-existing", self.text)

    def test_signing_key_is_wired(self):
        self.assertIn("UPLOADER_SIGN_KEY", self.text)
        self.assertIn("UPLOADER_PUBLISH_TOKEN", self.text)

    def test_missing_secrets_do_not_break_the_build(self):
        """Пока канал не настроен, сборка пакета всё равно должна проходить."""
        self.assertIn("if: ${{ env.UPLOADER_PUBLISH_URL != ''", self.text)

    def test_parsed_yaml_agrees_when_pyyaml_is_available(self):
        if self.data is None:
            self.skipTest("PyYAML не установлен — достаточно текстовых проверок")
        trigger = self.data.get("on", self.data.get(True))
        self.assertIn("uploader/**", trigger["push"]["paths"])
        self.assertIn("main", trigger["push"]["branches"])
        self.assertIn("workflow_dispatch", trigger)


if __name__ == "__main__":
    unittest.main()
