#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════
# ED Ring Colony — разбор застрявшего обновления («Обновить сейчас»).
#
# Зачем это нужно отдельным файлом.
#
# Обновление проекта выполняет deploy/update-project.sh — скрипт ИЗ КЛОНА
# на сервере (см. deploy/Dockerfile.update-agent: UPDATE_SCRIPT по умолчанию
# равен $PROJECT_DIR/deploy/update-project.sh). Пока клон не перемотан на
# ревизию с исправлением, кнопка запускает СТАРЫЙ скрипт. А старый скрипт
# падает на `git stash` раньше, чем успевает сделать `git merge`, — то есть
# исправление не может доставить само себя: перемотка заблокирована тем самым
# сбоем, который исправление и лечит. Это не «кнопка не сработала», это
# замкнутый круг, и разорвать его нужно один раз вручную.
#
# Что делает скрипт:
#
#   1. показывает состояние клона: ревизию, `git status --short`, признак
#      незавершённой операции, записи незавершённого слияния в индексе и
#      список stash (с метками edrc-update-… от прошлых прогонов);
#   2. с `--apply` снимает записи незавершённого слияния в индексе точечным
#      `git reset -- <путь>` (файлы на диске не трогаются) и возвращает на
#      место отслеживаемые файлы, которых нет в рабочем дереве;
#   3. НИЧЕГО не коммитит, не прячет в stash, не перематывает ветку и не
#      трогает чужие stash. Правки админа остаются как были.
#
# Настоящее незавершённое слияние (MERGE_HEAD, CHERRY_PICK_HEAD, REVERT_HEAD,
# rebase-*) скрипт НЕ разбирает: там решение принимает человек, поэтому он
# только называет готовую команду и выходит с ошибкой.
#
# Запуск (по умолчанию — только показать, ничего не менять):
#   bash deploy/fix-update-stuck.sh            # осмотр
#   bash deploy/fix-update-stuck.sh --apply    # починить
#
# Если клон застрял на старой ревизии, свежую версию этого файла можно взять
# из ветки, не трогая рабочее дерево:
#   cd /opt/ed-ring-colony/src
#   git fetch origin main
#   git show origin/main:deploy/fix-update-stuck.sh > /tmp/edrc-fix.sh
#   bash /tmp/edrc-fix.sh            # посмотреть
#   bash /tmp/edrc-fix.sh --apply    # починить
# Затем — «Обновить сейчас»: она перемотает клон на main уже вместе с
# исправлением deploy/update-project.sh.
# ═════════════════════════════════════════════════════════════════════
set -Eeuo pipefail

PROJECT_DIR="${PROJECT_DIR:-/opt/ed-ring-colony/src}"
APPLY=0

for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --dry-run) APPLY=0 ;;
    -h | --help)
      sed -n '2,45p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      printf 'неизвестный аргумент: %s (допустимы --apply, --dry-run, --help)\n' "$arg" >&2
      exit 2
      ;;
  esac
done

say() { printf '%s\n' "$*"; }
warn() { printf '⚠ %s\n' "$*" >&2; }
die() {
  printf 'ОШИБКА: %s\n' "$*" >&2
  exit 1
}

command -v git >/dev/null 2>&1 || die "git не найден — разбирайте клон на сервере, а не в контейнере без git"
[ -d "$PROJECT_DIR" ] || die "PROJECT_DIR=$PROJECT_DIR не найден (задайте PROJECT_DIR)"
cd "$PROJECT_DIR" || die "не могу войти в $PROJECT_DIR"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "$PROJECT_DIR не git-клон"

# Пути с записями незавершённого слияния. Пока они есть, git отказывается
# писать индекс: «<файл>: needs merge / could not write index» — и `git stash`
# из скрипта обновления падает ещё до начала работы.
unmerged_paths() {
  git ls-files -u 2>/dev/null | cut -f2 | sort -u || true
}

# Какая операция оставила эти записи: настоящий merge/rebase/cherry-pick —
# его разбирает человек — или хвост прошлого `git stash pop --index`.
pending_operation() {
  local marker path
  for marker in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD; do
    path="$(git rev-parse --git-path "$marker" 2>/dev/null || true)"
    if [ -n "$path" ] && [ -f "$path" ]; then printf '%s\n' "$marker"; return 0; fi
  done
  for marker in rebase-merge rebase-apply; do
    path="$(git rev-parse --git-path "$marker" 2>/dev/null || true)"
    if [ -n "$path" ] && [ -d "$path" ]; then printf '%s\n' rebase; return 0; fi
  done
  return 0
}

# Отслеживаемые файлы, которых нет в рабочем дереве. После снятия конфликтной
# записи такой путь выглядел бы как ` D` (удалён локально), и обновление
# упиралось бы в конфликт «удалено здесь / изменено в ветке». Возвращаем их из
# индекса: это ровно то содержимое, которое лежит в ревизии клона.
missing_tracked() { # $1 — список путей через перевод строки
  local path
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    if [ ! -e "$path" ] && git cat-file -e "HEAD:$path" 2>/dev/null; then
      printf '%s\n' "$path"
    fi
  done <<< "$1"
}

say "каталог:      $PROJECT_DIR"
say "ветка:        $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
say "ревизия:      $(git rev-parse --short=12 HEAD 2>/dev/null || echo '?')"
if git rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1; then
  say "незавершено:  слияние (MERGE_HEAD)"
fi

DIRTY="$(git status --short 2>/dev/null || true)"
UNMERGED="$(unmerged_paths)"
OP="$(pending_operation)"
STASHES="$(git stash list 2>/dev/null || true)"

say ""
if [ -n "$DIRTY" ]; then
  say "рабочее дерево:"
  printf '%s\n' "$DIRTY" | sed 's/^/  /'
else
  say "рабочее дерево чистое"
fi

if [ -n "$STASHES" ]; then
  say ""
  say "сохранённые правки (git stash list):"
  printf '%s\n' "$STASHES" | sed 's/^/  /'
  if printf '%s\n' "$STASHES" | grep -qE ': edrc-update-'; then
    say "  → метка edrc-update-… значит, это правки прошлого неудачного обновления:"
    say "    они целы; новый update-project.sh возвращает их сам после перемотки."
  fi
fi

if [ -z "$UNMERGED" ] && [ -z "$OP" ]; then
  say ""
  if [ -n "$DIRTY" ]; then
    say "записей незавершённого слияния нет — обновление ничто не блокирует."
    say "если кнопка всё равно падает, пришлите журнал: Админка → Мониторинг → журнал обновления."
  else
    say "проблем не найдено: дерево чистое, записей слияния нет."
  fi
  exit 0
fi

if [ -n "$OP" ]; then
  hint="git merge --abort"
  case "$OP" in
    CHERRY_PICK_HEAD) hint="git cherry-pick --abort" ;;
    REVERT_HEAD) hint="git revert --abort" ;;
    rebase) hint="git rebase --abort" ;;
  esac
  say ""
  say "в клоне НЕЗАВЕРШЁННАЯ ОПЕРАЦИЯ ($OP) — разбирает человек, скрипт её не трогает."
  say "конфликтные файлы: $(printf '%s' "$UNMERGED" | tr '\n' ' ')"
  say ""
  say "как разобрать (выберите одно):"
  say "  • отменить операцию:  $hint"
  say "  • оставить свою версию: отредактируйте файлы, затем git add <файл> && git commit"
  say ""
  say "после этого повторите: bash $0 --apply && «Обновить сейчас»"
  exit 1
fi

MISSING="$(missing_tracked "$UNMERGED")"

say ""
say "найдены записи незавершённого слияния в индексе (хвост неудачного git stash pop):"
printf '%s\n' "$UNMERGED" | sed 's/^/  • /'
if [ -n "$MISSING" ]; then
  say "этих файлов нет в рабочем дереве, они вернутся из ревизии клона:"
  printf '%s\n' "$MISSING" | sed 's/^/  • /'
fi
say ""
say "с такими записями git отказывается писать индекс, поэтому git stash падает"
say "с «needs merge», и обновление не начинается."

if [ "$APPLY" != "1" ]; then
  say ""
  say "это осмотр: ничего не изменено. Чтобы починить, повторите с --apply:"
  say "  bash $0 --apply"
  exit 0
fi

say ""
say "снимаю записи слияния (меняется только индекс, файлы на диске не трогаются)…"
while IFS= read -r path; do
  [ -n "$path" ] || continue
  git reset -q -- "$path" 2>/dev/null || true
  say "  • индекс: $path"
done <<< "$UNMERGED"

if [ -n "$MISSING" ]; then
  say "возвращаю на место файлы, которых нет в рабочем дереве…"
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    mkdir -p "$(dirname "$path")"
    git checkout -q -- "$path" 2>/dev/null || true
    say "  • из ревизии: $path"
  done <<< "$MISSING"
fi

LEFT="$(unmerged_paths)"
if [ -n "$LEFT" ]; then
  die "часть записей осталась ($(printf '%s' "$LEFT" | tr '\n' ' ')) — разберите вручную: git status --short"
fi

say ""
say "готово. Состояние сейчас:"
git status --short 2>/dev/null | sed 's/^/  /' || true
[ -n "$(git status --short 2>/dev/null || true)" ] || say "  (чисто)"
say ""
say "дальше: нажмите «Обновить сейчас» в админке. Если в git stash list остались"
say "правки прошлого прогона (edrc-update-…), новый update-project.sh вернёт их"
say "сам после перемотки — вручную их доставать не нужно."
