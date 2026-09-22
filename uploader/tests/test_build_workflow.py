"""Правила запуска сборки EXE (.github/workflows/build-exe.yml).

Сборка Windows-раннера идёт около десяти минут и заканчивается публикацией
релиза. Пуш, который правил только сайт, не должен ни того, ни другого: у
пользователей новый релиз с тем же самым EXE выглядит как обновление, в
котором ничего не изменилось.

Поэтому у `on.push` обязан быть фильтр путей. Тест держит именно это правило,
а не форматирование файла: YAML легко перекроить и случайно потерять `paths`.
"""

import re
import unittest
from pathlib import Path

WORKFLOW = Path(__file__).resolve().parents[2] / ".github" / "workflows" / "build-exe.yml"


def _load():
    text = WORKFLOW.read_text(encoding="utf-8")
    try:
        import yaml  # type: ignore
    except ImportError:
        return text, None
    return text, yaml.safe_load(text)


def _block(text: str, header: str, indent: int) -> str:
    """Строки одного YAML-блока: от `header` до следующего ключа того же уровня."""
    pad = " " * indent
    lines = text.splitlines()
    out = []
    inside = False
    for line in lines:
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


class BuildWorkflowTriggerTests(unittest.TestCase):
    def setUp(self):
        self.text, self.data = _load()

    def test_workflow_exists_and_is_the_exe_build(self):
        self.assertTrue(WORKFLOW.is_file(), f"нет файла {WORKFLOW}")
        self.assertIn("Build Colonial Helper EXE", self.text)

    def test_push_is_filtered_by_paths(self):
        """Без `paths` сборка срабатывает на любой пуш — ради этого и тест."""
        push = _block(_block(self.text, "on", 0), "push", 2)
        self.assertIn("paths:", push, "у on.push пропал фильтр путей — EXE будет собираться на каждый пуш")

    def test_paths_cover_uploader_and_the_workflow_itself(self):
        push = _block(_block(self.text, "on", 0), "push", 2)
        paths = _list_items(_block(push, "paths", 4))
        self.assertIn("uploader/**", paths, "правки самой программы обязаны запускать сборку")
        self.assertIn(
            ".github/workflows/build-exe.yml", paths,
            "правка правил сборки должна проверяться сборкой",
        )

    def test_site_only_paths_are_not_listed(self):
        """Каталоги сайта в фильтре означали бы сборку EXE на правку сайта."""
        push = _block(_block(self.text, "on", 0), "push", 2)
        paths = _list_items(_block(push, "paths", 4))
        for path in paths:
            self.assertFalse(
                path.startswith(("src/", "supabase/", "deploy/", "scripts/")),
                f"путь сайта {path!r} в фильтре сборки EXE",
            )
        for site in ("src/**", "supabase/**", "**", "*"):
            self.assertNotIn(site, paths)

    def test_branches_are_preserved(self):
        push = _block(_block(self.text, "on", 0), "push", 2)
        branches = _list_items(_block(push, "branches", 4))
        self.assertIn("main", branches)
        self.assertIn("arena/**", branches)

    def test_manual_run_stays_available(self):
        """Ручной запуск — обходной путь, когда EXE нужен без правок uploader/."""
        self.assertIn("workflow_dispatch:", self.text)
        dispatch = _block(_block(self.text, "on", 0), "workflow_dispatch", 2)
        self.assertNotIn("paths:", dispatch, "workflow_dispatch фильтром путей не ограничивается")

    def test_parsed_yaml_agrees_when_pyyaml_is_available(self):
        if self.data is None:
            self.skipTest("PyYAML не установлен — достаточно текстовых проверок")
        # ключ `on` YAML 1.1 читает как булево True
        trigger = self.data.get("on", self.data.get(True))
        self.assertIsInstance(trigger, dict)
        push = trigger["push"]
        self.assertIn("paths", push)
        self.assertIn("uploader/**", push["paths"])
        self.assertIn("main", push["branches"])
        self.assertIn("workflow_dispatch", trigger)


if __name__ == "__main__":
    unittest.main()
