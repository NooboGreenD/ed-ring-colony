"""Content preferences and pure HUD projections (no Tk / network dependencies)."""
import math

# section -> (UI label, direct child widgets of the overlay content frame)
CONTENT_OPTIONS = {
    'route': {
        'current': ('Текущая система', ('current_label',)),
        'next': ('Следующая система', ('next_label',)),
        'star': ('Класс звезды и заправка', ('star_label',)),
        'distance': ('Расстояние прыжка', ('distance_label',)),
        'remaining': ('Остаток маршрута', ('remaining_label',)),
        'destination': ('Конечная точка', ('destination_label',)),
        'progress': ('Прогресс', ('progress_frame', 'progress_label')),
        'hint': ('Стройка и первооткрыватель', ('hint_frame',)),
    },
    'status': {
        'connection': ('Подключение к сервисам', ('status_frame',)),
        'game': ('Состояние игры', ('game_frame',)),
        'watcher': ('Наблюдение за журналом', ('watcher_frame',)),
        'progress': ('Ход загрузки', ('progress_text',)),
        'warnings': ('Предупреждения и ошибки', ('detail_text',)),
    },
    'ship': {
        'identity': ('Название корабля', ('ship_name_label',)),
        'chips': ('Индикаторы состояния', ('chips_frame',)),
    },
    'cargo': {
        'capacity': ('Вместимость и заполнение', ('capacity_header', 'capacity_frame', 'cargo_bar_bg')),
        'items': ('Список товаров', ('items_header', 'cargo_canvas', 'cargo_scrollbar')),
    },
    'carrier': {
        'identity': ('Название и позывной', ('carrier_header',)),
        'capacity': ('Вместимость и заполнение', ('total_label', 'cargo_bar_bg')),
        'details': ('Топливо, прыжок и службы', ('detail_label',)),
        'project': ('Выбранная стройка', ('project_label',)),
        'items': ('Товары', ('list_frame',)),
        'summary': ('Общие итоги и источник данных', ('summary_label',)),
    },
    'session': {
        'metrics': ('Счётчики сессии', ('session_header', 'stats_grid')),
        'route': ('Системы маршрута', ('route_system_label', 'route_info')),
        'history': ('История груза', ('history_header', 'chart_canvas')),
    },
    'exobio': {
        'body': ('Текущее тело', ('body_label',)),
        'telemetry': ('Телеметрия и параметры', ('telemetry_frame', 'params_label', 'signals_label')),
        'samples': ('Образцы', ('samples_header', 'organics_label')),
        'action': ('Следующее действие', ('next_action_label',)),
        'predictions': ('Прогноз родов', ('predict_header', 'predict_label')),
        'bodies': ('Тела системы', ('bodies_header', 'bodies_label')),
        'planets': ('Поиск планет', ('planet_separator', 'planets_header', 'planets_label')),
        'value': ('Примечание к прогнозу', ('footer_label',)),
    },
    'footmap': {
        'body': ('Тело под ногами', ('body_label',)),
        'coords': ('Координаты', ('coords_label',)),
        'map': ('Карта, след и точки', ('canvas',)),
        'target': ('Расстояние до корабля', ('ship_label',)),
        'vitals': ('Кислород, здоровье и гравитация', ('vitals_label',)),
    },
    'events': {key: (label, ()) for key, label in (
        ('timestamps', 'Время события'), ('info', 'Информация'),
        ('success', 'Успешные события'), ('warn', 'Предупреждения'), ('error', 'Ошибки'))},
}
CONTENT_DEFAULTS = {option: True for option in (
    f'overlay_{block}_{section}' for block, sections in CONTENT_OPTIONS.items() for section in sections)}
# Five lines fit the existing compact window; context/progress remain optional.
CONTENT_DEFAULTS.update(overlay_route_current=False, overlay_route_progress=False)

CARRIER_FILTERS = {'all': 'Все товары', 'aboard': 'Только на борту',
                   'project': 'Материалы стройки', 'missing': 'Только недостающие'}


def option_key(block, section):
    return f'overlay_{block}_{section}'


def filter_carrier_rows(rows, mode='all', query=''):
    query = str(query or '').strip().casefold()
    def number(row, field):
        try:
            return float(row.get(field) or 0)
        except (TypeError, ValueError):
            return 0
    return [row for row in rows if
            (not query or query in str(row.get('name') or '').casefold()
             or query in str(row.get('symbol') or row.get('key') or '').casefold())
            and (mode not in CARRIER_FILTERS or mode == 'all'
                 or mode == 'aboard' and number(row, 'amount') > 0
                 or mode == 'project' and number(row, 'need') > 0
                 or mode == 'missing' and number(row, 'remaining') > 0)]


def _point(value):
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        return None
    try:
        nums = tuple(float(v) for v in value)
        return nums if all(math.isfinite(v) for v in nums) else None
    except (TypeError, ValueError):
        return None


def route_summary(systems, current=''):
    """NavRoute waypoints, not an invented straight-line distance to the goal.

    Current location is authoritative. CSV routes may not have any coordinates.
    If off route, the first leg is unknown; never borrow a visited system's
    coordinates as if it were the pilot's actual position.
    """
    current = str(current or '').strip()
    index = next((i for i, row in enumerate(systems)
                  if current and str(row.get('name', '')).casefold() == current.casefold()), None)
    pending = [row for row in (systems[index + 1:] if index is not None else systems)
               if row.get('status') != 'visited']
    next_row = pending[0] if pending else {}
    star = str(next_row.get('star_class') or '').strip()
    start = _point(systems[index].get('star_pos')) if index is not None else None
    distance = None
    remaining = 0.0 if not pending else None
    points = [start] + [_point(row.get('star_pos')) for row in pending]
    if pending and points[0] is not None and points[1] is not None:
        distance = math.dist(points[0], points[1])
    if pending and all(p is not None for p in points):
        remaining = sum(math.dist(a, b) for a, b in zip(points, points[1:]))
    return {'current': current or '—', 'next': next_row.get('name') or '—',
            'destination': systems[-1].get('name', '—') if systems else '—',
            'star_class': star or None,
            'scoopable': star.upper() in ('O', 'B', 'A', 'F', 'G', 'K', 'M') if star else None,
            'jump_distance': distance, 'remaining_distance': remaining if systems else None,
            'jumps_left': len(pending), 'total': len(systems),
            'visited': sum(row.get('status') == 'visited' for row in systems),
            'remaining': [row.get('name', '') for row in pending]}
