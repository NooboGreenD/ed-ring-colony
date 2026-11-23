# ED Ring Colony / Colonial Helper — инвентаризация исходников

> Снимок 2026-11-23, база `d2f8315135bb009fb3ed24ec98af342a023643ea`. Автоматический структурный индекс, не доказательство работоспособности каждого модуля. Аналитическая карта — [PROJECT-CONTEXT.md](PROJECT-CONTEXT.md).

## 1. Все модули Colonial Helper

Индекс построен через Python AST: классы, методы, функции и локальные зависимости. Имена и строки относятся к исходникам данного снимка; значения констант/ключей сюда не копируются.

### `uploader/api_client.py` — 854 строк

HTTP клиент для ED Ring Colony API.

Локальные зависимости: `i18n`, `locale_config`, `site_config`.

- L44: `_session_for_thread()`
- L52: `_safe_json()`
- L79: класс **`ApiClient`** — `__init__`, `set_locale`, `validate_token`, `_post_upload`, `upload_deliveries`, `upload_construction_events`, `upload_community_goal_reports`, `_upload_chunks`, `reset_journal_data`, `sync_carrier_events`, `sync_bgs_snapshots`, `upload_squadron`, `fetch_my_carriers`, `fetch_carrier`, `is_connected`, `display_name`, `get_system_scans`, `get_system_factions`, `get_system_powerplay`, `upload_system_scans`, `get_route_hint`, `fetch_site_projects`, `register_site_project`, `upload_station_reports`, `upload_ship_state`, `pull_atlas_route`, `upload_pilot_stats`, `get_capi_status`, `sync_capi`, `get_capi_profile`

### `uploader/bgs_sync.py` — 268 строк

Минорные фракции на сайте проекта: состояние посещённых систем из журнала.

Локальные зависимости: `i18n`.

- L66: `_project_states()`
- L77: `_project_faction()`
- L91: `project_bgs_event()`
- L128: `_signature()`
- L134: `_system_key()`
- L138: `_timestamp()`
- L143: класс **`BgsSnapshotCollector`** — `__init__`, `pending_count`, `_save_if_due`, `save`, `feed`, `flush`

### `uploader/build_bundle.py` — 401 строк

Сборщик пакета кода Colonial Helper: манифест, подпись, публикация.

Локальные зависимости: `bundle`.

- L69: `channel_for_branch()`
- L87: `current_version()`
- L96: `latest_changelog()`
- L113: `bundle_files()`
- L118: `bundle_version()`
- L127: `read_secret()`
- L141: `keygen()`
- L168: `build()`
- L204: `embed()`
- L217: `launcher_version()`
- L229: `_post()`
- L264: `publish_launcher()`
- L278: `publish()`
- L319: `main()`

### `uploader/build_exe.py` — 182 строк

Сборка базовой сборки (лаунчера) Colonial Helper.

Локальные зависимости: `build_bundle`.

- L81: `collect_imports()`
- L108: `collect_package_args()`
- L118: `main()`

### `uploader/build_installer.py` — 75 строк

Build a one-file Windows installer containing the latest launcher EXE.

- L26: `main()`

### `uploader/bundle.py` — 928 строк

Пакет кода Colonial Helper: манифест, проверка хешей, подпись, установка.

Локальные зависимости: `i18n`.

- L110: класс **`BundleError`**
- L123: `_sha512()`
- L127: `_modp_inv()`
- L131: `_recover_x()`
- L153: `_point_add()`
- L164: `_point_mul()`
- L174: `_point_equal()`
- L180: `_point_compress()`
- L188: `_point_decompress()`
- L200: `_secret_expand()`
- L210: `ed25519_public_key()`
- L216: `ed25519_sign()`
- L227: `ed25519_verify()`
- L251: `sha256_bytes()`
- L255: `sha256_file()`
- L263: `safe_member_path()`
- L288: `canonical_bytes()`
- L302: `check_manifest()`
- L354: `trusted_keys()`
- L379: `verify_manifest()`
- L427: `manifest_files()`
- L437: `build_manifest()`
- L479: `sign_manifest()`
- L496: `executable_dir()`
- L511: `install_marker_path()`
- L515: `read_install_marker()`
- L530: `write_install_marker()`
- L537: `write_install_marker_at()`
- L566: `remove_install_marker()`
- L575: `install_root()`
- L606: `versions_dir()`
- L610: `version_dir()`
- L616: `stage_dir()`
- L622: `state_path()`
- L626: `_blank_state()`
- L631: `load_state()`
- L649: `save_state()`
- L660: `read_manifest()`
- L669: `verify_directory()`
- L688: `verify_installed()`
- L706: `write_bundle_files()`
- L729: `running_version()`
- L743: `_replace_files_in_place()`
- L779: `promote_stage()`
- L798: `activate()`
- L812: `note_launch()`
- L823: `mark_healthy()`
- L832: `needs_rollback()`
- L842: `rollback()`
- L860: `installed_versions()`
- L871: `prune_versions()`
- L901: `version_tuple()`
- L915: `launcher_supports()`
- L924: `temp_dir_for()`

### `uploader/bundle_updater.py` — 626 строк

Обновление кода Colonial Helper по сети: манифест, дельта, установка.

Локальные зависимости: `bundle`, `http_errors`, `i18n`, `site_config`.

- L70: `launcher_url()`
- L97: `update_base()`
- L109: `_session()`
- L117: `_headers()`
- L133: `_get_json()`
- L148: `_get_bytes()`
- L178: `check_for_update()`
- L243: `local_index()`
- L266: `plan_update()`
- L286: `_stage_from_sources()`
- L321: `_install_stage()`
- L344: `apply_update()`
- L393: `install_from_directory()`
- L415: `repair()`
- L480: `extract_zip()`
- L509: `check_launcher()`
- L534: `download_launcher()`
- L594: `restart_command()`
- L602: `restart_program()`

### `uploader/carrier.py` — 1238 строк

Груз на авианосце (Fleet Carrier): сколько уже завезено и сколько осталось.

Локальные зависимости: `event_dispatch`, `i18n`.

- L100: `_as_int()`
- L107: `is_carrier_market()`
- L113: `event_time()`
- L140: `_iso_epoch()`
- L152: класс **`CarrierState`** — `__init__`, `known`, `cargo_capacity`, `fill_percent`, `tracked_total`, `kind_label`, `display_name`, `summary`, `remaining`, `clear_cargo`, `_spread`, `_trim_to`, `_scale_commodities`, `reconcile`, `cargo_source`, `get_state_dict`
- L575: класс **`CarrierTracker`** — `__init__`, `_remember`, `_switch_to`, `_state_for`, `_kind_for`, `states`, `handle`, `reset`, `_absorb_stats`, `_absorb_rename`, `_absorb_buy`, `_absorb_decommission`, `_absorb_cancel_decommission`, `_absorb_docked`, `_absorb_carrier_location`, `_absorb_jump_request`, `_absorb_jump_cancelled`, `_absorb_undocked`, `_absorb_transfer`, `_absorb_market`, `_add_commodity`, `merge_remote`, `merge_server`, `delivered_total`, `remote_age`, `reconcile`, `get_state_dict`

### `uploader/carrier_sync.py` — 468 строк

Учёт авианосцев на сайте проекта: сбор событий журнала и отправка на сервер.

Локальные зависимости: `i18n`.

- L83: `_as_int()`
- L95: `is_carrier_market()`
- L100: `canonical_commodity()`
- L112: `project()`
- L117: `_services()`
- L124: `inventory_from_cargo()`
- L141: класс **`CarrierEventCollector`** — `__init__`, `_push`, `_save_if_due`, `save`, `pending_count`, `pending_carrier_ids`, `flush`, `_docked_at_carrier`, `_set_system`, `_dock`, `_undock`, `_read_inventory`, `_bank_adjust`, `_bank_cargo`, `feed`, `_feed`
- L443: `carrier_market_cargo()`

### `uploader/colonial_helper.py` — 9949 строк

Colonial Helper — standalone uploader for ED Ring Colony. Qt desktop app with live journal monitoring and an in-game HUD overlay.

Локальные зависимости: `api_client`, `bgs_sync`, `bundle`, `bundle_updater`, `carrier`, `carrier_sync`, `colonisation`, `colony_build_types`, `community_goals`, `crash_log`, `eddn_api`, `edsm_api`, `event_dispatch`, `exobiology`, `factions_data`, `foot_map`, `helper_pages`, `helper_shell`, `helper_window`, `i18n`, `inara_api`, `journal_parser`, `locale_config`, `overlay`, `overlay_options`, `pilot_equipment`, `powerplay_data`, `qt_factions`, `raven_colonial_api`, `route_export`, `route_hint`, `route_tracker`, `route_travel`, `ship_tracker`, `site_config`, `site_projects`, `squadron_sync`, `station_commerce`, `system_map`, `ui_qt`.

- L163: `_atomic_write_journal_offsets()`
- L212: `bundle_mode()`
- L228: `_screen_with_game_label()`
- L235: `_screen_label()`
- L242: класс **`ColonialHelperApp`** — `_start_geometry`, `__init__`, `_build_header`, `_build_notebook`, `_show_page`, `_build_tab_auth`, `_on_eddn_toggle`, `_journal_cmdr_name`, `_inara_cmdr_name`, `_save_inara_settings`, `_refresh_inara_status`, `_sync_inara_commander`, `_apply_inara_commander`, `_save_eddn_setting`, `_save_edsm_settings`, `_pilot_percent`, `_pilot_init_state`, `_build_tab_pilot`, `_on_pilot_compact_changed_from_page`, `_on_pilot_compact_changed`, `_on_pilot_columns_changed`, `_on_pilot_resize`, `_rebuild_pilot_layout_if_needed`, `_rebuild_pilot_layout`, `_pilot_window_width`, `_pilot_column_count`, `_pilot_is_visible`, `_pilot_cancel_refresh`, `_pilot_sample_series`, `_pilot_rate`, `_pilot_squadron_text`, `_refresh_pilot_infographic`, `_schedule_pilot_equipment_refresh`, `_refresh_pilot_equipment`, `_on_equipment_refresh`, `_on_equipment_selected`, `_on_fleet_refresh`, `_load_fleet`, `_pilot_tick`, `_pilot_set`, `_pilot_journal_count`, `_pilot_journal_state`, `_build_tab_upload`, `_on_skip_imported_changed`, `_on_backfill_third_party_changed`, `_build_tab_route`, `_build_tab_colony`, `_autofill_cmdr_from_key`, `_current_cmdr_name`, `_update_colony_key_label`, `_selected_colony_project`, `_on_colony_select`, `_set_colony_busy`, `_on_colony_refresh`, `_colony_refresh_thread`, `_colony_refresh_done`, `_push_site_projects_to_raven`, `_build_id_from_result`, `_extract_colony_projects`, `_extract_primary_id`, `_project_progress`, `_fill_colony_tree`, `_sync_colony_primary_project`, `_colony_build_type_code`, `_colony_body_choices`, `_colony_refresh_body_choices`, `_colony_sync_body_num`, `_current_site_market`, `_on_colony_bind_site`, `_flush_raven_after_binding`, `_on_colony_unbind_site`, `_on_colony_set_primary`, `_on_colony_clear_primary`, `_on_colony_complete`, `_colony_simple_call_thread`, `_colony_action_done`, `_on_colony_copy_id`, `_on_colony_open_project`, `_colony_open_url`, `_on_colony_options_changed`, `_update_colony_site_label`, `_colony_form_snapshot`, `_colony_form_dirty`, `_on_colony_fill_current`, `_colony_autofill_from_site`, `_fetch_colony_site_context`, `_colony_site_context_done`, `_extract_site_plans`, `_site_plan_label`, `_on_colony_plan_selected`, `_on_colony_clear_form`, `_on_colony_check_system`, `_colony_check_system_thread`, `_colony_check_system_done`, `_parse_commodities`, `_on_colony_create`, `_colony_create_thread`, `_colony_create_done`, `_build_tab_factions`, `_update_faction_infographic`, `_faction_address`, `_faction_tracker_system`, `_faction_pilot_system`, `_refresh_factions_data`, `_faction_refresh_worker`, `_apply_faction_refresh`, `_render_factions_infographic`, `_update_powerplay`, `_refresh_powerplay`, `_powerplay_refresh_worker`, `_apply_powerplay_refresh`, `_render_powerplay`, `_select_map_object`, `_copy_map_text`, `_fetch_external_scans_if_needed`, `_on_external_scans_received`, `_queue_scan_for_upload`, `_flush_scans_to_upload`, `_capi_set_status`, `_capi_open_site`, `_on_capi_link`, `_capi_refresh_status`, `_on_capi_fetch`, `_capi_unlink`, `_capi_fetch_and_upload`, `_maybe_sync_pilot_stats`, `_maybe_sync_ship_state`, `_update_pilot_stats_from_event`, `_feed_system_map`, `_on_notebook_tab_changed`, `_build_tab_overlay`, `_size_label`, `_idle_label`, `_idle_seconds`, `_block_size_preset`, `_overlay_screen_choices`, `_overlay_screens_text`, `_block_screen_label`, `_block_alpha_label`, `_block_font_label`, `_rule_key_by_label`, `_preset_key_by_label`, `_on_block_visible_changed`, `_on_block_lock_changed`, `_on_block_screen_changed`, `_on_lock_all`, `_on_lock_hotkey_changed`, `_on_toggle_overlay_lock`, `_on_block_alpha_changed`, `_on_block_font_changed`, `_on_block_size_changed`, `_on_block_rule_changed`, `_on_block_hotkey_changed`, `_on_block_reset`, `_on_all_size_preset_changed`, `_on_auto_rules_changed`, `_on_idle_changed`, `_on_overlay_content_changed`, `_on_carrier_filter_changed`, `_on_carrier_search_changed`, `_sync_overlay_block_rows`, `_on_overlay_settings_changed`, `_update_overlay_hotkey_hint`, `_on_toggle_overlay`, `_on_toggle_overlay_visibility`, `_refresh_profile_combo`, `_on_profile_save`, `_on_profile_apply`, `_on_profile_delete`, `_on_margin_changed`, `_on_anchor_changed`, `_on_apply_anchors`, `_on_hide_without_game_changed`, `_restart_overlay`, `_update_layout_info`, `_on_alpha_changed`, `_on_font_changed`, `_on_font_size_changed`, `_on_show_route_changed`, `_on_show_status_changed`, `_on_show_ship_changed`, `_on_show_cargo_changed`, `_on_show_session_changed`, `_on_show_events_changed`, `_on_show_exobio_changed`, `_on_attach_game_changed`, `_on_ship_block_changed`, `_on_ship_modules_view_changed`, `_on_reset_overlay_positions`, `_get_overlay_data`, `_build_tab_exobio`, `_set_all_genera`, `_clear_planet_filters`, `_on_exobio_filters_changed`, `_update_tab_exobio`, `_set_exobio_status`, `_start_exobio_history_indexer`, `_ensure_system_exobio`, `_ensure_body_exobio`, `_scan_journals_for_current_system`, `_scan_all_journals_for_exobio`, `_map_visible`, `_map_schedule_redraw`, `_map_redraw_now`, `_map_motion_start`, `_map_motion_stop`, `_map_arm_autorefresh`, `_map_refresh_from_raven`, `_map_set_hint`, `_map3d_scene`, `_draw_system_map`, `_draw_system_map_3d`, `_on_map_tree_context`, `_on_map_motion_toggle`, `_on_map_motion_speed`, `_on_map_level_change`, `_on_map_view_preset`, `_on_map_reset_3d`, `_on_map_reset_time`, `_on_map_key`, `_on_map_dolly`, `_on_map_open_3d`, `_map_viewer_options`, `_build_tab_log`, `_build_status_bar`, `set_status`, `_update_channel_value`, `_auto_check_update`, `_set_update_ui`, `_bundle_root`, `_mark_bundle_healthy`, `_on_check_update`, `_check_update_sources`, `_on_bundle_checked`, `_start_bundle_update`, `_on_bundle_applied`, `_restart_after_update`, `_on_repair_install`, `_on_repair_done`, `_offer_launcher_update`, `_on_launcher_checked`, `_on_update_checked`, `_on_update_downloaded`, `_tick_game_status`, `_tick_travel`, `log`, `set_connection_status`, `api_client`, `_migrate_old_configs`, `load_config`, `save_config`, `_load_imported_files`, `_save_imported_files`, `_is_file_imported`, `_mark_files_imported`, `_reset_import_cache`, `_reset_server_journals`, `_on_server_journals_reset`, `_on_close`, `_open_site_account`, `_change_site_url`, `_on_validate_token`, `_on_token_validated`, `_apply_token_result`, `_auto_validate`, `_auto_start_watcher`, `_on_paste_token`, `_toggle_token_visibility`, `_on_check_raven`, `_check_raven_key_async`, `_apply_rcc_commander`, `_on_browse_journal_path`, `_exobiology_overlay_state`, `_wire_exobio_state_provider`, `_exobiology_filters`, `_on_select_files`, `_on_upload`, `_read_file_text`, `_delivery_for_api`, `_format_import_summary`, `_format_delivery_kinds`, `log_block`, `_update_progress`, `_any_third_party_enabled`, `_do_upload_thread`, `_on_toggle_watcher`, `_start_watcher`, `_watcher_thread_main`, `_prepare_watcher_state`, `_log_session_event`, `_set_inara_state`, `_on_third_party_result`, `_detect_game_version`, `_send_inara_event`, `_send_edsm_event`, `_send_carrier_event_to_raven`, `_send_edsm_text`, `_auto_load_navroute`, `_determine_cmdr_system`, `_restore_station_state_from_journal`, `_load_current_state_files`, `_maybe_log_modules`, `_load_latest_loadout`, `_stop_watcher`, `_upload_target`, `_load_journal_offsets`, `_save_journal_offsets`, `_show_journal_reconciliation_progress`, `_finish_journal_reconciliation`, `_flush_deferred_uploads`, `_watcher_loop`, `_record_session_deliveries`, `_send_deliveries_to_raven`, `_queue_raven_deliveries`, `_raven_delivery_key`, `_raven_commodity`, `_raven_site_binding`, `_resolve_site_project`, `_site_on_pause`, `_note_site_miss`, `_clear_site_miss`, `_warn_site_unresolved`, `_raven_cmdr_name`, `_flush_raven_deliveries`, `_flush_raven_deliveries_locked`, `_save_raven_ledger`, `_load_raven_ledger`, `_flush_station_reports`, `_station_commerce_collector`, `_carrier_sync_collector`, `_bgs_sync_collector`, `_squadron_collector`, `_flush_squadron_sync`, `_flush_bgs_sync`, `_read_ship_inventory`, `_on_station_inventory`, `_flush_carrier_sync`, `_load_server_carriers`, `_handle_tracked_event`, `_carrier_need`, `_carrier_need_info`, `_feed_carrier`, `_refresh_carrier_cargo`, `_load_carrier_cargo`, `_refresh_primary_project`, `_refresh_primary_project_from_site`, `_load_primary_project_from_site`, `_load_primary_project`, `_maybe_confirm_project_complete`, `_confirm_project_complete`, `_confirm_complete_thread`, `_on_raven_supply_sent`, `_refresh_site_project`, `_load_site_project`, `_log_site_project_need`, `_site_card_for_market`, `_check_raven_credit`, `_journal_site_deliveries`, `_on_colony_reconcile`, `_colony_reconcile_thread`, `_push_raven_supply`, `_colony_reconcile_done`, `_feed_construction_site`, `_on_construction_site_changed`, `_process_journal_changes`, `_on_import_atlas_route`, `_on_import_route`, `_on_export_route`, `_start_route_export`, `_route_status_text`, `_route_export_worker`, `_route_export_hints`, `_route_export_progress`, `_route_export_done`, `_on_clear_route`, `_travel_next_system`, `_travel_current_system`, `_travel_state`, `_refresh_travel`, `_travel_copy_next`, `_travel_set_clipboard`, `_on_travel_paste`, `_on_travel_load_file`, `_travel_accept`, `_on_travel_follow_changed`, `_on_travel_copy_next`, `_on_travel_restart`, `_on_travel_refresh_info`, `_on_travel_clear`, `_on_travel_pin_route`, `_travel_request_hint`, `_travel_note_jump`, `_travel_tick`, `_refresh_route_tree`, `_on_clear_log`, `after`
- L9864: `_journal()`
- L9874: `_install_crash_log()`
- L9896: `main()`

### `uploader/colonisation.py` — 614 строк

Стройплощадки колонизации: определение по журналу и черновик проекта Raven Colonial.

Локальные зависимости: `event_dispatch`, `i18n`.

- L71: `is_construction_site()`
- L94: `is_primary_port_station()`
- L119: `classify_station()`
- L174: `default_project_name()`
- L195: класс **`SiteResource`** — `remaining`, `from_journal`
- L232: класс **`ConstructionSite`** — `is_primary_port`, `suggested_name`, `has_depot`, `total_required`, `total_provided`, `total_remaining`, `progress_percent`, `remaining_by_commodity`, `summary`, `update_from_depot`
- L347: класс **`ConstructionSiteTracker`** — `__init__`, `site`, `known_sites`, `reset`, `handle`, `_absorb_position`, `_absorb_station`, `_absorb_depot`, `_fill_from_current`, `_register`
- L545: `build_project_draft()`
- L612: `format_commodities()`

### `uploader/colony_build_types.py` — 148 строк

Типы построек для Raven Colonial (`buildType`) — фиксированный справочник.

Локальные зависимости: `i18n`.

- L106: `build_type_label()`
- L117: `_lookup()`
- L126: `normalize_build_type()`

### `uploader/community_goals.py` — 109 строк

Extract account-scoped Community Goal snapshots from Elite journal events.

- L8: `_number()`
- L18: `_tier()`
- L26: `community_goal_reports_from_event()`
- L66: класс **`CommunityGoalReportCollector`** — `__init__`, `_key`, `feed`, `add_reports`, `drain`, `requeue`

### `uploader/companion_api.py` — 903 строк

Legacy Frontier CAPI client and profile parser.

Локальные зависимости: `i18n`.

- L86: `set_app_version()`
- L93: `capi_user_agent()`
- L104: `normalize_platform()`
- L112: `normalize_audience()`
- L138: `_b64url()`
- L146: `create_code_verifier()`
- L151: `create_code_challenge()`
- L156: `build_auth_url()`
- L177: `_free_port()`
- L184: класс **`_CallbackHandler`** — `do_GET`, `log_message`
- L217: класс **`CompanionAuthError`** — `__init__`, `needs_relink`
- L254: `is_no_entitlement_response()`
- L263: `assess_capi_entitlement()`
- L293: `describe_capi_error()`
- L358: класс **`CompanionAuth`** — `__init__`, `load`, `save`, `update`, `clear`, `mark_verified`, `mark_failed`, `status`, `authorize`, `_serve_until_code`, `exchange_code`, `refresh`, `_token_request`, `access_token`, `is_linked`
- L576: класс **`CompanionClient`** — `__init__`, `_request`, `_get`, `get_profile`, `get_market`, `get_fleetcarrier`, `verify`
- L721: `_int_or_none()`
- L736: `_first_present()`
- L744: `_dict()`
- L748: `_name_of()`
- L758: `profile_to_stats()`
- L852: `decode_token()`
- L867: `parse_identity()`
- L881: `fetch_identity()`

### `uploader/crash_log.py` — 306 строк

Журнал падений Helper: без него «программа закрылась без ошибки» не разобрать.

Локальные зависимости: `bundle`.

- L55: `default_root()`
- L76: `log_path()`
- L81: `_append()`
- L90: `note()`
- L98: `_format()`
- L103: `install()`
- L175: `install_qt_messages()`
- L211: `closing_note()`
- L223: `uninstall()`
- L244: `recent_crash()`
- L288: `notice_details()`
- L304: `log_hint()`

### `uploader/eddn_api.py` — 254 строк

Публикация исследовательских событий журнала в EDDN (открытую ленту сообщества).

Локальные зависимости: `http_errors`, `i18n`.

- L52: `_strip_localised()`
- L65: `_clean_faction()`
- L70: `clean_message()`
- L83: `_valid_position()`
- L91: `_present()`
- L95: `augment_location()`
- L119: класс **`EddnContext`** — `__init__`, `observe`, `_set_version`, `is_live`, `build`
- L206: класс **`EddnClient`** — `__init__`, `enabled`, `set_enabled`, `submit`

### `uploader/edsm_api.py` — 191 строк

Необязательная отправка навигационных событий в EDSM.

Локальные зависимости: `http_errors`, `i18n`.

- L39: класс **`EDSMAPI`** — `__init__`, `enabled`, `set_credentials`, `set_app_version`, `set_game_version`, `submit_event`, `_submit_once`, `fetch_system_bodies`

### `uploader/event_dispatch.py` — 1225 строк

Фоновая отправка событий журнала во внешние сервисы.

Локальные зависимости: `eddn_api`, `i18n`.

- L93: `normalize_commodity()`
- L117: `canonical_commodity()`
- L128: `is_fleet_carrier()`
- L162: `_coords()`
- L170: `_body_coords()`
- L181: `_inara_location()`
- L198: `_inara_dock()`
- L209: `_inara_jump()`
- L223: `_inara_carrier_jump()`
- L233: `_inara_land()`
- L255: `_inara_cargo_item()`
- L287: класс **`ThirdPartyDispatcher`** — `__init__`, `set_game_version`, `_inara_game_version_allowed`, `_is_seen`, `_remember_seen`, `_update_game_state`, `_transient_fields`, `configure`, `_log`, `_notify_failure`, `_notify_success`, `_notify`, `submit`, `_edsm_enabled`, `_inara_enabled`, `_raven_enabled`, `_eddn_enabled`, `_submit_eddn`, `_submit_edsm`, `_submit_inara`, `_submit_raven_supply`, `submit_supply_update`, `_submit_raven`, `_submit_raven_transfer`, `_enqueue`, `_start_locked`, `_worker_loop`, `_do_edsm`, `_do_eddn`, `_do_inara`, `_send_inara_now`, `_apply_inara_result`, `_inara_push`, `_ensure_inara_flusher`, `_inara_flush_loop`, `_flush_inara`, `_raven_fc_known`, `_notify_fc_unknown`, `submit_fc_cargo_correction`, `_do_raven_fc_set`, `_do_raven`, `_do_raven_supply`, `pending`, `flush`, `snapshot_stats`, `reset_stats`, `stop`

### `uploader/exobiology.py` — 2323 строк

Экзобиология: состояние тел и предсказание образцов.

Локальные зависимости: `i18n`.

- L67: `is_landable()`
- L290: `normalize_genus()`
- L308: `_as_float()`
- L315: `_as_int()`
- L322: `atmosphere_category()`
- L354: `body_props()`
- L426: `estimate_value()`
- L475: `format_credits()`
- L531: `planet_group_label()`
- L628: `preset_label()`
- L637: `_preset_classes()`
- L650: `body_matches()`
- L702: `search_planets()`
- L737: `filter_predictions()`
- L1070: `_gas_tokens()`
- L1090: `_gas_set()`
- L1105: `_has_any_gas()`
- L1115: `_volcanism_text()`
- L1122: `_temp_of()`
- L1126: `_gravity_g()`
- L1131: `_conditions_miss()`
- L1150: `_species_soft_miss()`
- L1164: `species_candidates()`
- L1182: `rule_weight_ceiling()`
- L1208: `data_coverage()`
- L1216: `score_genus()`
- L1317: `predict_genera()`
- L1339: `prediction_rows()`
- L1472: класс **`ExobiologyTracker`** — `__init__`, `_key`, `_body_key`, `_ensure_body`, `_event_system`, `_event_time`, `_seen_once`, `_trim`, `handle`, `set_body_footfall`, `system_genera`, `current_body_state`, `body_state`, `_genus_of`, `search_system_planets`, `system_bodies`, `system_body_count`, `system_scanned_count`, `system_known_body_count`, `system_bio_signals_total`, `system_bio_bodies_count`, `recent_bodies`, `export_system_data`, `import_system_data`, `load_from_cache`, `save_to_cache`
- L2055: класс **`ExobiologyCache`** — `__init__`, `load`, `save`, `is_file_indexed`, `mark_files_indexed`, `get_system`, `all_systems`, `clear_system`, `store_system`
- L2187: `scan_journals_for_system()`
- L2259: `scan_all_journals_for_exobio()`

### `uploader/factions_data.py` — 381 строк

Фракции текущей системы: снимок из журнала игры и карточка с сайта проекта.

Локальные зависимости: `bgs_sync`.

- L41: `_as_float()`
- L52: `_state_names()`
- L63: `_text()`
- L67: `_sort_factions()`
- L72: `_as_reputation()`
- L105: `_first_state()`
- L116: `_system_info_from_event()`
- L136: `_system_info_from_site()`
- L154: `_state_title()`
- L170: `snapshot_from_event()`
- L220: `snapshot_from_site()`
- L264: `parse_timestamp()`
- L282: `snapshot_timestamp()`
- L289: `format_timestamp()`
- L297: `prefer_snapshot()`
- L320: `_matches()`
- L330: `scan_journal_for_factions()`
- L374: `snapshot_system()`
- L379: `system_key()`

### `uploader/foot_map.py` — 953 строк

Миникарта пешехода: где командир, где его корабль и что рядом.

- L120: `codex_name()`
- L134: `clonal_range()`
- L159: `normalize_heading()`
- L170: `_coordinate()`
- L183: `local_offsets()`
- L198: `distance_m()`
- L205: `bearing_deg()`
- L212: `to_screen()`
- L231: `clamp_marker_offset()`
- L250: `settlement_kind()`
- L265: `_pad_number()`
- L274: `pick_scale()`
- L288: `split_distance()`
- L302: `empty_state()`
- L333: класс **`FootMap`** — `__init__`, `handle`, `_take_place`, `_take_ship_point`, `_take_vehicle_point`, `_forget_srv`, `_set_poi`, `_take_sample`, `_place_sample`, `_forget_samples`, `_place_pending_sample`, `_take_poi`, `_drop_farthest_poi`, `_set_vehicle`, `reset`, `update_status`, `_take_vitals`, `_move_to`, `poll`, `_refresh_signature`, `state`, `_place_summary`, `_set_is_complete`, `_samples_list`, `_sample_summary`, `_pois_list`, `trail_points`, `poi_keys`, `sample_points`
- L949: `trail_offsets()`

### `uploader/game_monitor.py` — 408 строк

Отслеживание запуска Elite Dangerous.

Локальные зависимости: `i18n`.

- L48: класс **`GameState`** — `width`, `height`, `as_dict`, `label`
- L96: `_win32_processes()`
- L145: `_own_pid()`
- L155: `_is_own_window()`
- L170: `_is_game_title()`
- L176: `_win32_window_pid()`
- L188: `_win32_window_title()`
- L203: `_win32_find_game_window()`
- L241: `_win32_window_rect()`
- L255: `_win32_monitor_rect()`
- L283: `_win32_foreground_hwnd()`
- L295: класс **`GameMonitor`** — `__init__`, `state`, `refresh`, `_run_probe`, `_probe`, `is_running`, `is_focused`, `label`

### `uploader/helper_pages.py` — 4508 строк

Native Qt pages for the Colonial Helper main window.

Локальные зависимости: `hud_icons`, `i18n`, `route_export`, `ui_qt`.

- L71: класс **`LogPage`** — `__init__`, `_format`, `append`, `append_block`, `clear`, `log`, `text`, `entry_count`, `update_count`, `is_read_only`
- L167: класс **`StatusLabel`** — `__init__`, `set_status`
- L182: класс **`AuthPageState`**
- L202: класс **`AuthPageActions`**
- L218: класс **`AuthPage`** — `__init__`, `_title`, `_hint`, `_divider`, `_field`, `_row`, `_button`, `_build_api`, `_build_capi`, `_build_journals`, `_build_raven`, `_raven_check`, `_build_edsm`, `_build_eddn`, `_on_eddn_toggled`, `_build_inara`, `toggle_token_visibility`, `token_is_hidden`, `set_auth_result`
- L457: класс **`UploadPageActions`**
- L469: класс **`UploadPage`** — `__init__`, `_divider`, `_call`, `_select_files`, `_upload`, `_toggle_watcher`, `_reset_import_cache`, `_reset_server_journals`, `_on_skip_imported_toggled`, `_on_backfill_toggled`, `set_files_text`, `files_text`, `set_upload_enabled`, `set_progress`, `progress_value`, `set_progress_text`, `progress_text`, `set_watcher_running`, `watcher_running`, `set_skip_imported`, `set_backfill_third_party`
- L685: `column_title()`
- L701: класс **`RoutePageActions`**
- L710: класс **`RoutePage`** — `__init__`, `_call`, `_import_route`, `_export_csv`, `_import_atlas`, `_clear`, `set_rows`, `row_values`, `row_count`, `set_counter`, `counter_text`
- L867: класс **`TravelPageActions`**
- L889: класс **`TravelPage`** — `__init__`, `_call`, `_paste_route`, `_load_file`, `_copy_next`, `_refresh_info`, `_restart`, `_clear`, `_pin_route`, `_follow_btn_clicked`, `_follow_changed`, `route_text`, `set_route_text`, `clear_route_text`, `is_following`, `set_following`, `set_pin_state`, `set_state`, `set_upcoming`, `upcoming_count`, `stat_text`, `info_text`, `progress_value`
- L1200: класс **`RouteSection`** — `__init__`, `show_route`, `show_travel`, `tab_index`
- L1241: класс **`RouteExportDialog`** — `__init__`, `_select_all`, `_select_defaults`, `_update_summary`, `selection`, `_accept`, `ask`
- L1392: класс **`RefreshingCombo`** — `__init__`, `showPopup`
- L1413: класс **`ColonyPageActions`**
- L1436: класс **`ColonyPage`** — `__init__`, `_call`, `_divider`, `_build_top`, `_build_table`, `_build_actions`, `_action_callback`, `_refresh`, `_selected`, `_build_create_form`, `plan_none_label`, `_fill_current`, `_reconcile`, `_create`, `_clear_form`, `_check_system`, `_refresh_body_choices`, `value`, `set_value`, `clear_fields`, `set_combo_values`, `cmdr_text`, `set_cmdr`, `set_status`, `status_text`, `set_key_status`, `key_text`, `set_site_text`, `site_text`, `set_actions_enabled`, `set_create_enabled`, `set_rows`, `clear_rows`, `row_count`, `row_values`, `selected_values`, `select_row`, `plan_labels`, `set_plan_labels`, `plan_index`, `plan_text`, `set_plan_text`, `plan_none_selected`, `set_plan_none`
- L1904: `screen_with_game_label()`
- L1909: `screen_label()`
- L1915: класс **`OverlayBlockRow`**
- L1931: класс **`OverlayPageState`**
- L1971: класс **`OverlayPageActions`**
- L2009: класс **`OverlayPage`** — `toggle_on_text`, `toggle_off_text`, `__init__`, `_add_tab`, `tab_index`, `_call`, `_divider`, `_section`, `_hint`, `_combo`, `set_combo_text`, `_build_header`, `_build_general`, `_on_alpha_slider`, `_on_font_size_slider`, `_build_blocks`, `_block_reset_callback`, `_all_size_apply`, `_build_behaviour`, `_build_ship`, `_build_content`, `_build_layout`, `reset_btn_2`, `_build_hotkeys`, `_toggle`, `_reset_positions`, `_on_margin_slider`, `alpha_value`, `set_alpha`, `font_family`, `set_font_family`, `font_size`, `set_font_size`, `block_value`, `set_block_value`, `set_screen_choices`, `sync_combo_choices`, `ship_block`, `ship_modules_view`, `set_ship_modules_view`, `content_value`, `auto_rules`, `set_auto_rules`, `attach_game`, `set_attach_game`, `hide_without_game`, `idle_text`, `set_idle_text`, `lock_hotkey_text`, `set_lock_hotkey_text`, `all_size_text`, `set_all_size_text`, `profile_text`, `set_profile_text`, `set_profiles`, `profiles`, `margin_value`, `set_margin`, `anchor_text`, `set_anchor_text`, `carrier_filter_text`, `set_carrier_filter_text`, `carrier_search_text`, `set_carrier_search_text`, `set_toggle_running`, `set_screens_text`, `set_info_text`, `set_hotkey_hint_text`
- L2751: `pilot_columns()`
- L2767: `sparkline_points()`
- L2783: `bars_geometry()`
- L2812: класс **`ElidedLabel`** — `__init__`, `full_text`, `text`, `setText`, `_apply`, `set_full_text`, `resizeEvent`, `sizeHint`
- L2865: класс **`SparklineWidget`** — `__init__`, `set_values`, `paintEvent`
- L2911: класс **`BarsChart`** — `__init__`, `set_rows`, `paintEvent`
- L2949: класс **`PilotPage`** — `__init__`, `_header`, `_refresh_clicked`, `_compact_toggled`, `_build_kpis`, `columns`, `_clear_tiles`, `_tile`, `_row_widget`, `_bar_widget`, `_rebuild_tiles`, `_tile_session`, `_tile_ship`, `_tile_route`, `_tile_systems`, `_tile_status`, `_tile_journal`, `set_value`, `set_bar`, `set_spark`, `set_systems`, `set_updated`, `column_count`, `resizeEvent`
- L3300: `equip_grade_text()`
- L3305: `equip_signed()`
- L3315: `equip_resistance_color()`
- L3328: `equip_number()`
- L3341: класс **`EquipGradeBadge`** — `__init__`, `set_grade`
- L3359: класс **`EquipChip`** — `__init__`, `set_value`
- L3387: класс **`EquipRow`** — `__init__`, `set_value`
- L3411: класс **`EquipWeaponCard`** — `__init__`, `set_weapon`
- L3471: класс **`EquipLoadoutCard`** — `__init__`, `set_loadout`, `mouseReleaseEvent`
- L3526: класс **`EquipmentPage`** — `__init__`, `_build_header`, `_refresh_clicked`, `_panel`, `_section_caption`, `_build_suit_column`, `_build_stats_column`, `_build_backpack_column`, `_build_loadouts_row`, `_select_clicked`, `_clear`, `signature_of`, `set_state`, `_time_text`
- L3935: класс **`FleetPageState`**
- L3944: класс **`FleetPageActions`**
- L3950: класс **`FleetPage`** — `__init__`, `_build_header`, `_refresh_clicked`, `set_state`, `_time_text`
- L4136: класс **`PilotSection`** — `__init__`, `set_equipment`, `set_fleet`, `show_equipment`, `show_fleet`, `show_infographic`
- L4202: класс **`ExobioPageState`**
- L4220: класс **`ExobioPageActions`**
- L4228: класс **`ExobioPage`** — `__init__`, `_divider`, `_section`, `_hint`, `_call`, `_build_header`, `_build_bodies`, `_build_genera`, `_build_planets`, `_on_filters_changed`, `set_system_text`, `set_summary_text`, `set_status_text`, `set_rows`, `row_values`, `genera`, `genus_checked`, `set_genera`, `set_all_genera`, `planet_ids`, `planet_checked`, `set_planet_ids`, `clear_planets`, `show_planets`, `set_show_planets`

### `uploader/helper_shell.py` — 472 строк

Native Qt shell for the Colonial Helper main window.

Локальные зависимости: `i18n`, `ui_qt`.

- L52: `sidebar_width_for()`
- L62: класс **`PageHost`** — `__init__`, `_get_tk_layout`, `pack`
- L93: класс **`HelperShell`** — `__init__`, `_build`, `_header`, `_sidebar`, `_workspace`, `_status_bar`, `set_game_state`, `game_state`, `set_game_hint`, `set_connection`, `connection`, `resizeEvent`, `apply_adaptive_widths`, `_pack_into_root`, `_take_over_window_style`, `add`, `select`, `set_status`, `status`, `pages`, `title`
- L462: `build_shell()`

### `uploader/helper_window.py` — 353 строк

Native Qt main window for Colonial Helper.

Локальные зависимости: `crash_log`, `ui_qt`.

- L22: `journal()`
- L32: `call_safely()`
- L68: `window_limits()`
- L83: класс **`HelperWindow`** — `__init__`, `apply_screen_limits`, `fit_to_screen`, `showEvent`, `run`, `_note_quit`, `geometry`, `title`, `minsize`, `iconbitmap`, `winfo_width`, `winfo_exists`, `after`, `_start_scheduled`, `_start_timer`, `after_cancel`, `update_idletasks`, `clipboard_clear`, `clipboard_append`, `bind`, `protocol`, `closeEvent`, `_quit_soon`, `destroy`

### `uploader/hotkeys.py` — 298 строк

Глобальные горячие клавиши для оверлея.

Локальные зависимости: `i18n`.

- L76: `parse_hotkey()`
- L108: `normalize_hotkey()`
- L128: класс **`HotkeyManager`** — `__init__`, `running`, `register`, `unregister`, `clear`, `combos`, `start`, `stop`, `_log`, `_dispatch`, `_loop`

### `uploader/http_errors.py` — 183 строк

Разбор «плохих» ответов внешних API: без сырого HTML в логе.

Локальные зависимости: `i18n`.

- L57: `looks_like_html()`
- L63: `header_safe()`
- L81: `header_token()`
- L89: `user_agent()`
- L108: `_status_of()`
- L115: `_body_of()`
- L122: `describe_bad_response()`
- L166: `short_body()`
- L174: `apply_client_headers()`

### `uploader/hud_icons.py` — 349 строк

Иконки HUD в стиле сайта: тонкий контур, скруглённые концы, один цвет.

- L248: `icon_names()`
- L253: `icon_path()`
- L281: `draw_icon()`
- L303: класс **`HudIcon`** — `__init__`, `icon_name`, `set_icon`, `set_color`, `color`, `set_size`, `sizeHint`, `paintEvent`

### `uploader/hud_win32.py` — 286 строк

Win32-часть HUD: HWND, «клик насквозь», самое верхнее окно.

Локальные зависимости: `game_monitor`.

- L14: `_get_ed_hwnd()`
- L35: `_is_ed_foreground()`
- L70: `_set_window_topmost()`
- L95: `_user32()`
- L155: `_toplevel_hwnd()`
- L195: `_foreground_window()`
- L206: `_window_pid()`
- L222: `_set_click_through()`

### `uploader/hud_window.py` — 1043 строк

HUD оверлея на чистом Qt: корпус блока, шапка, меню и мелкие детали.

Локальные зависимости: `hud_win32`, `i18n`, `overlay_layout`, `overlay_options`, `ui_qt`.

- L76: `hud_font()`
- L87: `paint()`
- L105: `hud_label()`
- L136: `hud_section()`
- L148: `hud_separator()`
- L156: `hud_panel()`
- L170: класс **`HudBar`** — `__init__`, `set_color`, `set_fraction`, `fraction`
- L200: класс **`HudChart`** — `__init__`, `set_history`, `set_font_spec`, `paintEvent`
- L269: класс **`_Header`** — `__init__`, `mousePressEvent`, `mouseMoveEvent`, `mouseReleaseEvent`
- L291: класс **`HudButton`** — `__init__`, `set_color`, `mousePressEvent`
- L316: класс **`HudWindow`** — `__init__`, `_build_frame`, `resizeEvent`, `_begin_drag`, `_drag_move`, `_end_drag`, `set_position`, `set_geometry`, `set_size`, `size`, `_apply_anchor`, `_screen_area`, `set_area_provider`, `set_on_move`, `set_on_resize`, `set_on_release`, `set_controller`, `_alpha_below_one`, `_on_window_map`, `showEvent`, `_sync_click_through`, `ensure_mouse_mode`, `_state_color`, `_refresh_state_colors`, `set_locked`, `_refresh_lock_controls`, `_toggle_lock`, `set_detached`, `_toggle_detached`, `_move_to_monitor`, `_flash_indicator`, `_menu_monitors`, `_current_monitor_index`, `_destroy_edit_menu`, `_add_custom_menu_entries`, `_show_edit_menu`, `_persist`, `_menu_alpha`, `_set_own_font`, `_set_anchor`, `_reset_size`, `set_alpha`, `set_topmost`, `make_label`, `_rescale_labels`, `_register_fonts`, `apply_font`, `on_font_changed`, `font_spec`, `is_visible`, `lift`, `toggle`, `apply_data_options`, `destroy`

### `uploader/i18n.py` — 73 строк

Локализация интерфейса Launcher, Setup и Helper.

Локальные зависимости: `i18n_catalogs`, `locale_config`.

- L27: `available()`
- L32: `current_locale()`
- L36: `set_locale()`
- L43: `catalog()`
- L48: `tr()`
- L65: `is_translated()`

### `uploader/i18n_catalogs.py` — 14488 строк

Переводы интерфейса: лаунчер, установщик, оболочка Helper.

- L14476: `_build_catalogs()`

### `uploader/inara_api.py` — 307 строк

Минимальный клиент Inara API v1.

Локальные зависимости: `http_errors`, `i18n`.

- L37: `resolve_commander_name()`
- L52: `connection_status()`
- L70: класс **`InaraAPI`** — `__init__`, `enabled`, `set_credentials`, `set_app_version`, `submit`, `submit_batch`, `_build_payload`, `_post_with_retries`, `_submit_once`, `_post`

### `uploader/installer.py` — 288 строк

First-run Windows installer for the Colonial Helper launcher.

Локальные зависимости: `bundle`, `i18n`, `installer_window`, `ui_qt`, `uninstall`.

- L30: `validate_install_dir()`
- L60: `payload_executable()`
- L69: `has_existing_install()`
- L79: `install_root_default()`
- L88: `create_shortcut()`
- L139: `_launch()`
- L156: `install_launcher()`
- L235: `_argument()`
- L244: `main()`

### `uploader/installer_window.py` — 264 строк

Native Qt setup window for Colonial Helper.

Локальные зависимости: `i18n`, `installer`, `launcher_settings`, `ui_qt`, `uninstall_window`.

- L47: класс **`SetupWindow`** — `__init__`, `_build`, `_actions`, `_refresh_mode`, `choose_folder`, `_install_clicked`, `remove`, `_after_uninstall`, `_buttons`, `install`, `_release_buttons`, `_installed`, `_install_failed`

### `uploader/journal_parser.py` — 851 строк

Парсер журналов Elite Dangerous.

Локальные зависимости: `colonisation`.

- L80: `is_construction_source()`
- L85: `is_construction_kind()`
- L90: `_update_station()`
- L116: `_station_kind_at()`
- L132: `build_inventory()`
- L146: `_normalize_name()`
- L153: `_event_key()`
- L169: `_source_hash()`
- L180: `iter_journal_events()`
- L203: `parse_events()`
- L544: `parse_journal()`
- L567: `_construction_signature()`
- L591: класс **`ConstructionSnapshotCollector`** — `__init__`, `__call__`, `drain`, `requeue`
- L666: `_strict_number()`
- L678: `compact_construction_resources()`
- L713: `_construction_event_from()`
- L735: `site_deliveries_from_text()`
- L809: `extract_construction_events_from_events()`
- L828: `extract_construction_events()`
- L837: `parse_file()`

### `uploader/launcher.py` — 777 строк

Загрузчик Colonial Helper: находит свежий пакет кода и запускает его.

Локальные зависимости: `bundle`, `bundle_updater`, `i18n`, `uninstall`.

- L68: `log_path()`
- L72: `configured_update_channel()`
- L82: `log()`
- L100: `frozen_dir()`
- L108: `_path_is_inside()`
- L118: `_is_pyinstaller_temp_path()`
- L126: `_readable_ca_bundle()`
- L133: `configure_tls_ca_bundle()`
- L218: `embedded_bundle()`
- L231: `install_embedded()`
- L251: `choose_version()`
- L291: `purge_version_modules()`
- L318: `activate_path()`
- L335: `missing_module()`
- L354: `ensure_install_marker()`
- L374: `entry_module()`
- L379: `run_module()`
- L389: `apply_saved_locale()`
- L404: `legacy_bundle_message()`
- L420: `report_failure()`
- L438: `run_helper()`
- L550: `dashboard_candidates()`
- L576: `dashboard_folder()`
- L582: `fallback_dir()`
- L588: `import_dashboard()`
- L599: `use_fallback()`
- L613: `use_dashboard()`
- L625: `drop_dashboard()`
- L635: `show_dashboard()`
- L678: `crash_reason()`
- L694: `helper_exit_code()`
- L707: `run_dashboard_loop()`
- L738: `run_uninstall()`
- L756: `main()`

### `uploader/launcher_account.py` — 321 строк

Привязка лаунчера к учётной записи на сайте и перенос настроек.

Локальные зависимости: `i18n`, `launcher_settings`, `settings_sync`, `site_config`.

- L39: `account_path()`
- L52: `_load_file()`
- L56: `_save_file()`
- L60: `_account_raw()`
- L65: `read_account()`
- L78: `is_linked()`
- L82: `site_url()`
- L91: `device_name()`
- L99: `profile_title()`
- L112: `normalize_code()`
- L122: `initials()`
- L132: `avatar_url()`
- L145: `_store_account()`
- L153: `link_with_code()`
- L177: `refresh_profile()`
- L196: `unlink()`
- L214: `synced_at()`
- L219: `_remember_sync()`
- L225: `push()`
- L238: `pull()`
- L260: `pull_into_file()`
- L270: `push_from_file()`
- L275: `auto_pull()`
- L308: `device_label()`

### `uploader/launcher_content.py` — 251 строк

Content model behind the Launcher feed: fetching, normalizing and formatting.

Локальные зависимости: `i18n`, `locale_config`, `site_config`.

- L34: `normalize_home_data()`
- L55: `fetch_home_data()`
- L71: `format_date()`
- L81: `article_url()`
- L88: `article_markup()`
- L134: `_inline_segments()`
- L155: `article_blocks()`
- L191: `plain_text()`
- L214: `article_html()`

### `uploader/launcher_profile.py` — 423 строк

Профиль пилота в лаунчере: значок в верхней панели и окно привязки.

Локальные зависимости: `i18n`, `launcher_account`, `launcher_settings`, `locale_config`, `ui_qt`.

- L45: `_round_pixmap()`
- L64: `_fetch_avatar()`
- L70: класс **`ProfileBadge`** — `__init__`, `reload`, `refresh`, `_state_text`, `avatar_tooltip`, `reset_avatar`, `load_avatar`, `_avatar_loaded`
- L161: класс **`AccountDialog`** — `__init__`, `_build`, `_locale`, `_render`, `_idle_status`, `_normalize_code`, `_link`, `_linked`, `_pulled_after_link`, `_link_failed`, `_pull`, `_pulled`, `_push`, `_pushed`, `_unlink`, `_unlinked`, `_failed`, `_notify`, `showEvent`, `_refresh_in_background`
- L410: `open_account_dialog()`
- L418: `site_profile_url()`

### `uploader/launcher_settings.py` — 96 строк

User settings touched by the Launcher: site language and update channel.

Локальные зависимости: `bundle`, `locale_config`.

- L20: `settings_path()`
- L24: `load_settings()`
- L33: `read_site_locale()`
- L37: `save_settings()`
- L65: `save_site_locale()`
- L75: `update_channel()`
- L81: `active_version()`

### `uploader/launcher_ui.py` — 99 строк

Desktop start screen entry point for Colonial Helper.

Локальные зависимости: `bundle`, `i18n`, `launcher_content`, `launcher_settings`, `launcher_window`, `ui_qt`.

- L56: `_launcher_runtime()`
- L66: `show_launcher()`

### `uploader/launcher_window.py` — 812 строк

Native Qt start screen for Colonial Helper.

Локальные зависимости: `bundle`, `bundle_updater`, `crash_log`, `i18n`, `launcher`, `launcher_account`, `launcher_content`, `launcher_profile`, `launcher_settings`, `locale_config`, `site_config`, `ui_qt`.

- L62: `launcher_version()`
- L70: `current_version()`
- L83: класс **`LauncherWindow`** — `__init__`, `_build`, `_header`, `_sidebar`, `_feed_panel`, `_footer`, `_notice_text`, `_crash_details`, `open_account`, `account_changed`, `sync_account`, `_account_refreshed`, `_settings_pulled`, `_tab_title`, `_connection_text`, `_feed_status_text`, `_retranslate`, `_fetch_from_site`, `_clear_feed`, `_render_feed`, `_placeholder_text`, `_article_card`, `_select_tab`, `refresh_news`, `_news_loaded`, `_news_failed`, `_on_locale_changed`, `_apply_locale_change`, `_log_problem`, `_render_update_state`, `check_updates`, `_update_check_failed`, `_update_checked`, `install_update`, `_update_installed`, `launch`

### `uploader/locale_config.py` — 25 строк

Supported site locales shared by Launcher and Colonial Helper.

- L16: `normalize_locale()`
- L21: `localized_url()`

### `uploader/map_export.py` — 374 строк

Экспорт карты системы в PNG без сторонних зависимостей.

Локальные зависимости: `i18n`, `map_font`, `system_map`.

- L50: `_hex()`
- L60: класс **`_Raster`** — `__init__`, `set`, `line`, `circle`, `dashed_circle`, `dashed_line`, `rect`, `text`, `png_bytes`
- L198: `_diamond()`
- L216: `_map_font_text()`
- L233: `export_map_png()`
- L245: `_draw_map_png()`
- L366: `save_map_png()`

### `uploader/map_font.py` — 167 строк

Битмап-шрифт 8x10 для экспорта карты в PNG без сторонних зависимостей.


### `uploader/orrery.py` — 985 строк

Геометрия 3D-оррери системы — общая для Tk-карты и HTML-экспорта Plotly.

- L42: `_num()`
- L52: `_log_map()`
- L60: `star_designation()`
- L76: `estimate_star_luminosity()`
- L85: `habitable_zone_ls()`
- L93: `body_marker_size()`
- L107: `units_per_pixel()`
- L113: `body_display_radius_units()`
- L121: `ellipse_path()`
- L141: `has_real_elements()`
- L150: `solve_kepler()`
- L165: `true_anomaly()`
- L172: `orbit_point()`
- L186: `orbital_path()`
- L196: `orbital_position()`
- L226: `star_color_from_temperature()`
- L239: `star_radius_scale()`
- L250: `_body_view()`
- L308: `_resolve_star_owner()`
- L344: `plan_system()`
- L597: `_parent_by_name()`
- L605: `_distribute_radii()`
- L634: `_map_ls_to_units()`
- L656: `place_stations()`
- L707: `on_sphere()`
- L719: `body_sphere_radius_units()`
- L736: `scene_aspect()`
- L747: `scene_camera()`
- L780: `focus_window()`
- L785: `overview_window()`
- L790: `trace_extent()`
- L822: `sphere_mesh()`
- L827: `sphere_geometry()`
- L865: `detail_sphere_radius_units()`
- L871: `_match_body()`
- L894: `focus_view()`
- L937: `_nearest_distance()`
- L951: `neighbours_of()`
- L966: `summarize_plan()`

### `uploader/overlay.py` — 1856 строк

Менеджер HUD оверлея: блоки, их показ, раскладка и настройки.

Локальные зависимости: `exobiology`, `game_monitor`, `hotkeys`, `hud_win32`, `hud_window`, `overlay_blocks`, `overlay_layout`, `overlay_options`, `screens`, `ship_hud`, `ship_tracker`.

- L158: класс **`OverlayManager`** — `__init__`, `start`, `_create_windows`, `_wire_block`, `_on_block_released`, `_blocks`, `_make_moved_handler`, `game_state`, `game_running`, `screen_area`, `overlay_area`, `monitors`, `block_detached`, `_block_rect`, `block_monitor`, `block_area`, `ensure_block_on_screen`, `set_block_detached`, `move_block_to_monitor`, `_move_block_into`, `_reanchor`, `apply_anchors`, `snap_block`, `reset_positions`, `list_profiles`, `active_profile`, `capture_layout`, `apply_layout`, `delete_profile`, `set_layout_margin`, `_on_resized`, `_on_route_moved`, `_on_status_moved`, `_on_ship_moved`, `_on_cargo_moved`, `_on_session_moved`, `_on_events_moved`, `_update_loop`, `_own_overlay_in_focus`, `set_ui_editing`, `_set_all_visibility`, `_hash_data`, `_footmap_fingerprint`, `_exobiology_fingerprint`, `_apply_update`, `set_content_option`, `set_carrier_filter`, `_add_log_safe`, `log`, `log_session_event`, `stop`, `toggle`, `toggle_visibility`, `set_alpha`, `set_font`, `set_show_route`, `set_show_status`, `set_show_ship`, `set_show_cargo`, `set_show_session`, `refresh_ship`, `set_ship_modules_view`, `set_ship_block`, `set_exobio_filters`, `refresh_exobio`, `set_exobio_state_provider`, `set_attach_to_game`, `set_hide_when_game_off`, `_overlay_for`, `_notify_block`, `set_block_visible`, `toggle_block`, `toggle_all_blocks`, `set_block_locked`, `all_locked`, `set_all_locked`, `toggle_all_locked`, `set_block_alpha`, `set_block_font_size`, `set_block_size`, `apply_size_preset`, `set_auto_rule`, `set_auto_rules_enabled`, `set_idle_timeout`, `reset_block`, `apply_block_style`, `mark_activity`, `idle_timeout`, `update_context`, `evaluate_block_visibility`, `register_hotkeys`, `set_lock_hotkey`, `set_block_hotkey`, `save_settings`
- L1641: `_migrate_click_through_to_lock()`
- L1656: `migrate_overlay_settings()`
- L1797: `load_overlay_settings()`
- L1813: `save_overlay_settings()`

### `uploader/overlay_blocks.py` — 2926 строк

Блоки HUD оверлея на чистом Qt.

Локальные зависимости: `exobiology`, `foot_map`, `hud_icons`, `hud_window`, `i18n`, `overlay_options`, `route_hint`, `ship_hud`.

- L80: `is_monospace_font()`
- L85: `format_table()`
- L128: `_section_text()`
- L133: `_species_tail()`
- L140: класс **`_RowsHost`** — `__init__`, `add`, `add_stretch`, `clear_rows`
- L173: класс **`RouteOverlay`** — `__init__`, `_hint_column_width`, `_settings_width`, `_text_width`, `_hint_visible`, `_apply_text_wrap`, `apply_data_options`, `resizeEvent`, `_render_hint`, `get_hint`, `update_route`
- L458: класс **`SessionEventsOverlay`** — `__init__`, `add_event`, `render_events`
- L512: класс **`StatusOverlay`** — `__init__`, `_indicator_row`, `set_status`, `set_game`, `set_watcher`, `set_progress`, `add_log`
- L606: класс **`ShipOverlay`** — `__init__`, `_row_widget`, `_render_chips`, `update_ship`, `_render_rows`, `_metrics`, `_title_metrics`, `_row_text_width`, `_fit_text`, `_rows_height`, `_rows_space`, `_fit_rows_to_block`, `_fit_block_height`, `_apply_min_height`, `_char_width`, `_fit_rows_width`, `get_rows`, `showEvent`, `resizeEvent`, `get_hud`, `on_font_changed`
- L927: класс **`CargoOverlay`** — `__init__`, `update_cargo`, `_make_cargo_row`, `_render_cargo_rows`
- L1050: класс **`CarrierOverlay`** — `__init__`, `update_carrier`, `_cell_width`, `_name_width_chars`, `_make_row`, `empty_default`, `_empty_text`, `_render_rows`
- L1444: `foot_distance_text()`
- L1453: `foot_coordinate()`
- L1468: `foot_poi_title()`
- L1477: класс **`FootMapCanvas`** — `__init__`, `set_font_spec`, `set_empty_text`, `set_state`, `state`, `paintEvent`, `_chip`, `_draw_readouts`, `_draw_grid`, `_draw_trail`, `_draw_samples`, `_draw_pois`, `_draw_srv_marker`, `_draw_settlement_marker`, `_draw_port_marker`, `_draw_ship_marker`, `_draw_north`, `_draw_pilot`
- L1857: класс **`FootMapOverlay`** — `__init__`, `_vitals_text`, `_vitals_color`, `_place_text`, `_points_text`, `_sample_text`, `_sample_color`, `update_footmap`, `apply_data_options`, `on_font_changed`, `resizeEvent`
- L2083: класс **`ExobiologyOverlay`** — `__init__`, `update_exobiology`, `_schedule_tick`, `_on_tick`, `destroy`, `_has_pending_samples`, `_format_prob_bar`, `_render`, `_render_content`, `_suggest_next_action`, `_table_width`, `_table_or_flow`, `_set_table_text`, `_set_flow_text`
- L2396: класс **`BiologyOverlay`** — `__init__`, `_icon_label`, `_chip`, `_paint_chip`, `update_biology`, `_render`, `_render_content`, `_show_telemetry_chips`, `_hide_telemetry_chips`, `_set_planets_visible`, `_short_body`, `_body_marks`, `_render_bodies`, `_render_planets`, `_table_width`, `_table_or_flow`, `_set_table_text`, `_set_flow_text`
- L2832: класс **`SessionOverlay`** — `__init__`, `_make_stat_row`, `update_session`, `_draw_chart`, `on_font_changed`

### `uploader/overlay_layout.py` — 345 строк

Настройки блоков HUD и раскладка: чистые функции без тулкита.

- L86: `preset_size()`
- L98: `resolve_block_alpha()`
- L109: `resolve_block_font_size()`
- L120: `block_click_through()`
- L131: `legacy_click_through()`
- L142: `block_detached()`
- L147: `auto_rule_matches()`
- L206: `compute_anchored_position()`
- L264: `capture_layout_snapshot()`
- L311: `apply_layout_snapshot()`

### `uploader/overlay_options.py` — 136 строк

Content preferences and pure HUD projections (no Tk / network dependencies).

- L77: `option_key()`
- L81: `filter_carrier_rows()`
- L97: `_point()`
- L107: `route_summary()`

### `uploader/pilot_equipment.py` — 906 строк

Снаряжение пилота на ногах: костюм, оружие, модификации, рюкзак.

- L263: `symbol_key()`
- L279: `suit_from_symbol()`
- L293: `weapon_from_symbol()`
- L299: `modification()`
- L321: `modification_name()`
- L330: `tools_for()`
- L341: `_percent()`
- L346: `_suit_grade()`
- L353: `suit_stats()`
- L424: `weapon_stats()`
- L462: `empty_state()`
- L478: `_entry_name()`
- L488: `_counts()`
- L513: класс **`PilotEquipment`** — `__init__`, `handle`, `_store_loadout`, `_upgrade_suit`, `_weapons_from_event`, `_delete_loadout`, `_rename_loadout`, `_equip_module`, `_remove_module`, `_replace_backpack`, `_change_backpack`, `read_backpack_file`, `select`, `shown_id`, `state`, `to_dict`, `from_dict`, `load`, `save`

### `uploader/powerplay_data.py` — 677 строк

PowerPlay 2.0: состояние командира и текущей системы — из журнала игры.

- L115: `power_key()`
- L123: `power_info()`
- L138: `normalize_power()`
- L151: `color_for()`
- L157: `state_info()`
- L174: `allegiance_title()`
- L182: `_hash()`
- L190: `_hsl_to_hex()`
- L225: `_int()`
- L238: `_number()`
- L250: `_text()`
- L254: `_powers_list()`
- L264: `parse_timestamp()`
- L282: `is_powerplay2()`
- L291: `newer()`
- L302: `system_event()`
- L311: `system_state()`
- L345: `site_state()`
- L374: `action_record()`
- L408: класс **`PowerplayTracker`** — `__init__`, `handle`, `_take_commander`, `_take_action`, `_take_system`, `apply_system`, `_remember`, `state`, `forget`
- L607: `_matches()`
- L617: `scan_journal_for_powerplay()`
- L673: `actions_text_keys()`

### `uploader/qt_factions.py` — 773 строк

Faction presence infographic — native Qt, no Tk facade.

Локальные зависимости: `factions_data`, `i18n`, `locale_config`, `qt_powerplay`, `site_config`, `ui_qt`.

- L128: `state_title()`
- L137: `state_description()`
- L143: `state_tone()`
- L147: `reputation_label()`
- L166: `influence_change()`
- L179: класс **`TrendChart`** — `__init__`, `set_values`, `paintEvent`
- L253: класс **`ReputationBar`** — `__init__`, `set_value`, `paintEvent`
- L284: `_reputation_color()`
- L291: класс **`FactionInfographic`** — `__init__`, `_open_atlas`, `refresh`, `set_snapshot`, `cards_count`, `names`, `_source_text`, `_card_widgets`, `_clear_cards`, `_style_card`, `_render_system_info`, `_history_key`, `_record_history`, `history_for`, `_card`, `_state_chips`
- L669: `_chip()`
- L678: `_trend_text()`
- L689: `_population_text()`
- L725: `_economy_hint()`
- L730: `_security_hint()`
- L735: класс **`BgsSection`** — `__init__`, `show_factions`, `show_powerplay`

### `uploader/qt_powerplay.py` — 709 строк

Вкладка PowerPlay: состояние командира и текущей системы — чистый Qt.

Локальные зависимости: `factions_data`, `i18n`, `locale_config`, `powerplay_data`, `site_config`, `ui_qt`.

- L91: `_thousands()`
- L100: `duration_text()`
- L115: `power_label()`
- L124: `action_text()`
- L146: класс **`BalanceBar`** — `__init__`, `set_values`, `paintEvent`
- L193: класс **`StateScale`** — `__init__`, `set_state`, `paintEvent`
- L242: `_dim()`
- L247: `_as_int()`
- L254: класс **`PowerplayPanel`** — `__init__`, `_style_card`, `_open_atlas`, `refresh`, `state`, `set_state`, `_render_system`, `_clear_system`, `_state_title`, `_point_text`, `_penalty_text`, `_multiplier_text`, `_rank_text`, `_pledge_text`, `_salary_text`, `_state_text`, `_control_text`, `_powers_text`, `_source_text`, `_clear_actions`, `_show_empty`, `action_lines`

### `uploader/raven_colonial_api.py` — 835 строк

API клиент для Raven Colonial (ravencolonial.com).

Локальные зависимости: `colony_build_types`, `i18n`.

- L34: `projects_from()`
- L53: `project_url()`
- L58: `system_url()`
- L65: класс **`RavenColonialAPI`** — `__init__`, `set_key`, `invalidate_project_cache`, `is_connected`, `_headers`, `get_project`, `_cache_project`, `_fallback_by_system`, `resolve_project_by_id`, `supply_fc`, `get_fc`, `fc_known`, `set_fc_cargo`, `get_fc_cargo`, `contribute`, `update_supply`, `_request`, `_describe_error`, `_esc`, `get_project_by_id`, `get_cmdr_by_key`, `cmdr_display_name`, `get_cmdr_active`, `get_system_projects`, `get_primary`, `get_system_sites`, `get_system_architect`, `get_system_v2`, `create_project`, `update_project`, `_prepare_build_type`, `mark_complete`, `set_primary`, `clear_primary`, `link_cmdr`, `assign_commodity`, `set_ready`

### `uploader/route_export.py` — 355 строк

Выгрузка маршрута в CSV: какие столбцы выгружать и что в них попадает.

Локальные зависимости: `i18n`, `locale_config`.

- L35: класс **`Field`**
- L88: `default_keys()`
- L93: `all_keys()`
- L97: `normalize_keys()`
- L112: `needs_hints()`
- L117: `needs_coordinates()`
- L128: `header_aliases()`
- L160: `sniff_delimiter()`
- L178: `read_columns()`
- L199: `titles()`
- L209: `_num()`
- L222: `_coord()`
- L228: `_ly()`
- L234: `_count()`
- L240: `_text()`
- L244: `format_visited()`
- L256: `position()`
- L274: `jump_distance()`
- L284: `build_rows()`
- L337: `build_csv()`
- L353: `row_count()`

### `uploader/route_hint.py` — 195 строк

Подсказка о следующей системе маршрута: стройка и первооткрыватель.

- L40: `empty_hint()`
- L69: `_text()`
- L75: `_number()`
- L87: `_percent()`
- L94: `_count()`
- L99: `_coordinates()`
- L116: `normalize_hint()`
- L178: `mark_loading()`
- L188: `hint_signature()`

### `uploader/route_tracker.py` — 495 строк

Трекер маршрута — импорт/экспорт.

Локальные зависимости: `i18n`, `locale_config`, `route_export`, `route_hint`.

- L14: `_system_column_names()`
- L41: `_csv_cell()`
- L47: `_number_from_csv()`
- L58: класс **`RouteTracker`** — `__init__`, `load_from_navroute`, `load_from_csv`, `refresh_next_system_info`, `_load_hint_cache`, `_save_hint_cache`, `_cached_hint`, `_hint_age`, `next_name`, `upcoming_names`, `refresh_system_hint`, `_hint_worker`, `prefetch_system_hints`, `get_system_hint`, `hint_matches`, `get_next_system_info`, `cached_hint`, `remember_hint`, `mark_visited`, `is_on_route`, `export_csv`, `clear`, `visited_count`

### `uploader/route_travel.py` — 682 строк

Путешествие по маршруту: разбор вставленного маршрута, позиция пилота и статистика.

- L72: класс **`ParsedRoute`** — `ok`
- L90: `clean_name()`
- L101: `_coords()`
- L121: `_system_from_item()`
- L145: `_unique()`
- L158: `_split_line()`
- L169: `_parse_lines()`
- L201: `_looks_like_csv()`
- L212: `parse_route_text()`
- L268: класс **`Jump`**
- L276: класс **`TravelSession`** — `__init__`, `start`, `restart`, `record`, `reset`, `elapsed`, `tempo`, `measured_distance`
- L339: `_now()`
- L348: `_tr()`
- L352: `format_duration()`
- L367: `format_light_years()`
- L375: `format_clock()`
- L389: `_key()`
- L393: `find_system()`
- L404: `pending_from()`
- L411: `next_system_name()`
- L425: `_point()`
- L435: `_distance()`
- L441: `_legs()`
- L456: `route_distances()`
- L502: `_construction_text()`
- L523: `travel_state()`
- L657: `follow_status_text()`
- L666: `route_format_title()`

### `uploader/screens.py` — 244 строк

Мониторы: список экранов и перенос окна с одного экрана на другой.

Локальные зависимости: `i18n`.

- L41: класс **`MonitorInfo`** — `work_area`, `size`, `label`
- L72: `order_monitors()`
- L100: `_intersection()`
- L109: `monitor_for_area()`
- L138: `header_visible()`
- L149: `fit_into_area()`
- L157: `translate_between_areas()`
- L188: `list_monitors()`

### `uploader/settings_sync.py` — 213 строк

Настройки Helper на сайте проекта: снимок раскладки оверлея.

Локальные зависимости: `i18n`.

- L46: класс **`SyncError`**
- L50: `collect_snapshot()`
- L80: `apply_snapshot()`
- L121: `_request()`
- L154: `claim_code()`
- L169: `fetch_profile()`
- L176: `unlink_device()`
- L180: `fetch_settings()`
- L197: `download_settings()`
- L202: `upload_settings()`

### `uploader/ship_hud.py` — 1082 строк

Компактная модель SHIP-оверлея: только то, что действительно известно.

Локальные зависимости: `i18n`.

- L56: `empty_hint()`
- L74: `hull_source_text()`
- L86: `line_budget()`
- L185: `tone_for_percent()`
- L196: `bar()`
- L209: `short_name()`
- L237: `slot_label()`
- L256: `percent_of()`
- L273: `clip()`
- L281: `is_weapon()`
- L286: `_age_seconds()`
- L311: `age_text()`
- L327: `hhmm()`
- L335: `module_rows()`
- L384: `module_mark()`
- L396: `module_note()`
- L408: `module_line()`
- L434: `fit_module_line()`
- L511: `module_table_row()`
- L568: `modules_table_lines()`
- L612: `modules_table_line()`
- L624: `module_bar_limit()`
- L639: `modules_table()`
- L645: `build_ship_hud()`
- L889: `has_ship_data()`
- L898: `empty_hud()`
- L918: `ship_title()`
- L939: `pack_parts()`
- L962: `fit_bar_line()`
- L989: `hud_rows()`
- L1049: `limit_module_rows()`
- L1071: `render_hud_text()`

### `uploader/ship_tracker.py` — 1271 строк

Отслеживание состояния корабля Elite Dangerous.

Локальные зависимости: `i18n`.

- L50: `normalize_module_ref()`
- L66: `find_slot_for_ref()`
- L87: класс **`ShipModule`** — `total_ammo`
- L116: класс **`ShipState`** — `note`, `has_shield_generator`, `shield_state`, `heat_active`, `ammo_total`, `afmu`, `hull_percent`, `shield_percent`, `fuel_percent`, `power_percent`, `damaged_modules`, `critical_modules`
- L323: `decode_status_flags()`
- L335: класс **`ShipTracker`** — `__init__`, `on_update`, `_notify`, `parse_event`, `_handle_loadout`, `_handle_status`, `_health_value`, `_handle_module_info`, `_recalc_ammo`, `_recalc_power`, `_apply_hull`, `_apply_impact_module_damage`, `_handle_hull_damage`, `_handle_crime_or_collision`, `_handle_touchdown`, `_handle_heat_damage`, `_handle_shield_state`, `_handle_module_damage`, `_handle_jet_cone_damage`, `_handle_cockpit_breached`, `_handle_repair`, `_handle_repair_all`, `_handle_repair_drone`, `_handle_synthesis`, `_handle_afmu_repair`, `_handle_reboot_repair`, `_handle_ammo_used`, `_handle_ammo_refilled`, `_handle_fuel_scoop`, `_handle_load_game`, `_handle_module_buy`, `_handle_module_sell`, `_handle_module_swap`, `_handle_cargo`, `_handle_reservoir_replenished`, `_handle_refuel_all`, `_handle_refuel_partial`, `parse_journal_text`, `parse_status_json`, `parse_modules_info_json`, `parse_cargo_json`, `reset`, `get_state_dict`

### `uploader/site_config.py` — 49 строк

Public website configuration; the desktop never needs a Supabase key.

Локальные зависимости: `i18n`.

- L9: `normalize_site_url()`
- L37: `saved_connection()`

### `uploader/site_projects.py` — 351 строк

Проекты строительства на сайте проекта — первичный источник для Helper.

- L35: `_text()`
- L43: `_int()`
- L52: `_float()`
- L61: `_commodities()`
- L75: `normalize_card()`
- L124: `normalize_raven()`
- L162: `normalize_projects()`
- L172: `_merge_into()`
- L203: `merge_projects()`
- L251: `need_from_project()`
- L260: `project_label()`
- L269: `progress_text()`
- L285: `raven_project_payload()`
- L326: `projects_payload()`
- L338: `raven_available()`

### `uploader/squadron_sync.py` — 266 строк

Эскадрилья пилота из журнала игры → сайт проекта.

Локальные зависимости: `i18n`.

- L61: `normalize_game_rank()`
- L76: `_clean()`
- L80: `squadron_state_from_event()`
- L112: класс **`SquadronInfoCollector`** — `__init__`, `_load`, `_save`, `feed`, `state`, `pending_payload`, `flush`, `reset`

### `uploader/station_commerce.py` — 216 строк

Station metadata and complete Market/Outfitting/Shipyard snapshots for the project.

- L17: `_time()`
- L29: `_items()`
- L61: класс **`StationCommerceCollector`** — `__init__`, `_save`, `_queue`, `feed`, `_report`, `inventory`, `read_files`, `flush`

### `uploader/system_map.py` — 2621 строк

Карта системы: тела, станции, стройплощадки и где сейчас пилот.

Локальные зависимости: `colonisation`, `event_dispatch`, `i18n`.

- L65: `_tons()`
- L73: `classify_body_signal()`
- L191: `_as_float()`
- L201: `_as_int()`
- L208: `better_kind()`
- L221: `merged_source()`
- L232: `classify_station()`
- L254: `classify_signal()`
- L270: класс **`MapStation`** — `remaining_tons`, `percent_delivered`, `is_site`, `title`, `caption`
- L346: класс **`MapBody`** — `is_star`, `is_moon`, `label`, `site`
- L422: класс **`PlayerPosition`** — `place`
- L454: класс **`MapSnapshot`** — `star`, `planets`, `moons`, `sites`, `building`, `built`
- L501: класс **`SystemMapBuilder`** — `__init__`, `reset`, `_touch_system`, `find_body`, `_body`, `_station`, `handle`, `_absorb_system`, `_absorb_ship`, `_set_body`, `_absorb_station_fields`, `_attach`, `_on_location`, `_on_loadgame`, `_on_loadout`, `_on_shipyardbuy`, `_on_shipyardswap`, `_on_fsdjump`, `_on_carrierjump`, `_on_supercruiseentry`, `_on_supercruiseexit`, `_on_approachbody`, `_on_leavebody`, `_on_touchdown`, `_on_liftoff`, `_on_docked`, `_on_undocked`, `_on_carrierstats`, `_has_planet_parent`, `_on_scan`, `_on_saascancomplete`, `_on_saasignalsfound`, `_on_fssbodysignals`, `load_external_bodies`, `_on_fssdiscoveryscan`, `_on_fsssignaldiscovered`, `_resolve_parents`, `_on_colonisationconstructiondepot`, `_body_name_by_num`, `merge_projects`, `_project_station`, `merge_site_plans`, `_raven_radius_m`, `_raven_body_fields`, `merge_bodies`, `_find_plan_station`, `snapshot`
- L1579: класс **`PlacedItem`** — `bar_width`
- L1622: `orbit_color_for()`
- L1633: `habitable_zone_ls()`
- L1689: `body_color()`
- L1709: `station_color()`
- L1723: `_find_center_item()`
- L1739: `_layout_3d()`
- L2024: `_station_lift_px()`
- L2037: `layout()`
- L2313: `_rects_overlap()`
- L2318: `_label_size()`
- L2337: `label_box()`
- L2345: `_icon_box()`
- L2357: `_spread_labels()`
- L2410: `due_timestamp()`
- L2428: `due_note()`
- L2457: `commodity_label()`
- L2463: `map_report()`
- L2521: `map_summary()`
- L2555: класс **`MapRavenCache`** — `__init__`, `load`, `store`, `_read`, `_write`

### `uploader/system_view.py` — 669 строк

Пакет данных карты системы — общий для сайта и приложения.

Локальные зависимости: `i18n`, `orrery`, `system_map`.

- L90: `body_color()`
- L125: `get_star_color()`
- L144: `get_ring_color()`
- L158: `structure_color()`
- L167: `_as_float()`
- L178: `_as_int()`
- L182: `format_number()`
- L191: `format_tons()`
- L199: `_decimal()`
- L209: `format_distance()`
- L225: `format_radius()`
- L237: `format_temp()`
- L245: `format_gravity()`
- L254: `format_period()`
- L266: `build_progress_bar()`
- L273: `estimate_habitable_zone_ls()`
- L283: `normalize_view_mode()`
- L291: `short_label()`
- L311: `build_view_payload()`
- L549: `_station_progress_percent()`
- L565: `_station_resources()`
- L586: `_orbit_payload()`
- L601: `_player_payload()`
- L617: `_habitable_band()`
- L631: `_parent_name()`
- L649: `_is_primary()`
- L654: `_primary_name()`
- L659: `_match_body()`
- L665: `_round3()`

### `uploader/theme_tokens.py` — 38 строк

Semantic theme tokens. Premium-market themes can register a token set later.

- L10: класс **`ThemeTokens`**
- L27: `theme_tokens()`

### `uploader/ui_qt.py` — 979 строк

Native Qt building blocks shared by the Launcher and Setup windows.

Локальные зависимости: `i18n`.

- L174: `enclosing_combo()`
- L191: `combo_popup_open()`
- L197: `inside_combo_popup()`
- L210: класс **`WheelGuard`** — `__init__`, `scroll_ancestor`, `scroll_by`, `eventFilter`
- L298: `install_wheel_guard()`
- L309: `ensure_app()`
- L321: класс **`Task`** — `start`, `_run`
- L347: `describe_error()`
- L354: `run_async()`
- L361: `panel()`
- L373: `label()`
- L397: `heading()`
- L403: `action_button()`
- L416: `separator()`
- L424: `row()`
- L437: `column()`
- L450: `open_url()`
- L454: `center_on_screen()`
- L466: `_title_button()`
- L489: класс **`_TitleBar`** — `__init__`, `set_title`, `mousePressEvent`, `mouseMoveEvent`, `mouseReleaseEvent`, `mouseDoubleClickEvent`
- L555: `native_hit_test_enabled()`
- L564: `hit_test_code()`
- L589: класс **`FramelessWindow`** — `__init__`, `setWindowTitle`, `_toggle_maximized`, `_edges_at`, `_cursor_for`, `mouseMoveEvent`, `mousePressEvent`, `nativeEvent`
- L719: класс **`FramedDialog`** — `__init__`, `result`, `accept`, `reject`, `_finish`, `closeEvent`, `keyPressEvent`, `showEvent`, `center_on_parent`, `exec`
- L807: `_point()`
- L814: `show_error_dialog()`
- L825: `report_startup_error()`
- L845: `_dialog_parent()`
- L849: `_qt_filter()`
- L860: `ask_yes_no()`
- L876: `_show_box()`
- L888: `show_info()`
- L896: `show_warning()`
- L904: `show_error()`
- L912: `ask_string()`
- L924: `ask_directory()`
- L934: `ask_open_files()`
- L946: `ask_open_file()`
- L958: `ask_save_file()`
- L978: `schedule()`

### `uploader/uninstall.py` — 522 строк

Удаление Colonial Helper с компьютера: что именно и в каком порядке.

Локальные зависимости: `bundle`, `i18n`, `ui_qt`, `uninstall_window`.

- L63: класс **`UninstallPlan`** — `ok`, `summary`
- L93: `_norm()`
- L97: `protected_reason()`
- L127: `looks_like_install()`
- L142: `directory_size()`
- L165: `start_menu_dir()`
- L170: `desktop_shortcut()`
- L175: `build_plan()`
- L241: `_winreg()`
- L250: `current_version()`
- L259: `register_uninstall()`
- L293: `registered_install_root()`
- L315: `unregister_uninstall()`
- L333: `deferred_delete_script()`
- L377: `schedule_deferred_delete()`
- L399: `execute()`
- L472: `_defer()`
- L486: `main()`

### `uploader/uninstall_window.py` — 219 строк

Окно удаления Colonial Helper: галочки «что удалить» и один шаг подтверждения.

Локальные зависимости: `bundle`, `i18n`, `launcher_settings`, `ui_qt`, `uninstall`.

- L44: `_human_size()`
- L57: класс **`UninstallWindow`** — `__init__`, `_build`, `_actions`, `_refresh_size`, `plan`, `remove`, `_removed`, `_failed`

### `uploader/window_chrome.py` — 278 строк

Small Windows-only custom title bars for the desktop Tk windows.

- L32: `_window_handle()`
- L62: `style_native_caption()`
- L97: `remove_native_caption()`
- L156: `_begin_native_drag()`
- L180: `add_custom_titlebar()`

## 2. Все страницы сайта

- `/account/capi` → `src/app/account/capi/page.tsx`
- `/account/friends` → `src/app/account/friends/page.tsx`
- `/account/journal` → `src/app/account/journal/page.tsx`
- `/account/messages` → `src/app/account/messages/page.tsx`
- `/account` → `src/app/account/page.tsx`
- `/admin/billing` → `src/app/admin/billing/page.tsx`
- `/admin` → `src/app/admin/page.tsx`
- `/architect` → `src/app/architect/page.tsx`
- `/architect/projects/[id]` → `src/app/architect/projects/[id]/page.tsx`
- `/architect/projects` → `src/app/architect/projects/page.tsx`
- `/atlas/market` → `src/app/atlas/market/page.tsx`
- `/atlas` → `src/app/atlas/page.tsx`
- `/atlas/sector/[id]` → `src/app/atlas/sector/[id]/page.tsx`
- `/atlas/sector` → `src/app/atlas/sector/page.tsx`
- `/auth/email` → `src/app/auth/email/page.tsx`
- `/carriers/[id]` → `src/app/carriers/[id]/page.tsx`
- `/carriers/jumps` → `src/app/carriers/jumps/page.tsx`
- `/carriers` → `src/app/carriers/page.tsx`
- `/cg` → `src/app/cg/page.tsx`
- `/cmdr/[name]` → `src/app/cmdr/[name]/page.tsx`
- `/cmdr/[name]/ships` → `src/app/cmdr/[name]/ships/page.tsx`
- `/cmdrs` → `src/app/cmdrs/page.tsx`
- `/details` → `src/app/details/page.tsx`
- `/engineers` → `src/app/engineers/page.tsx`
- `/forgot-password` → `src/app/forgot-password/page.tsx`
- `/forum/[slug]` → `src/app/forum/[slug]/page.tsx`
- `/forum/latest` → `src/app/forum/latest/page.tsx`
- `/forum` → `src/app/forum/page.tsx`
- `/forum/search` → `src/app/forum/search/page.tsx`
- `/forum/thread/[id]` → `src/app/forum/thread/[id]/page.tsx`
- `/galnet/[nid]` → `src/app/galnet/[nid]/page.tsx`
- `/galnet` → `src/app/galnet/page.tsx`
- `/leaderboard` → `src/app/leaderboard/page.tsx`
- `/login` → `src/app/login/page.tsx`
- `/m-admin` → `src/app/m-admin/page.tsx`
- `/maintenance` → `src/app/maintenance/page.tsx`
- `/map` → `src/app/map/page.tsx`
- `/news/[id]` → `src/app/news/[id]/page.tsx`
- `/news` → `src/app/news/page.tsx`
- `/offer` → `src/app/offer/page.tsx`
- `/outfitting` → `src/app/outfitting/page.tsx`
- `/` → `src/app/page.tsx`
- `/premium-shop` → `src/app/premium-shop/page.tsx`
- `/premium-shop/pay/[intentId]` → `src/app/premium-shop/pay/[intentId]/page.tsx`
- `/projects/[id]` → `src/app/projects/[id]/page.tsx`
- `/projects` → `src/app/projects/page.tsx`
- `/register` → `src/app/register/page.tsx`
- `/resend-confirmation` → `src/app/resend-confirmation/page.tsx`
- `/reset-password` → `src/app/reset-password/page.tsx`
- `/squadrons/[id]` → `src/app/squadrons/[id]/page.tsx`
- `/squadrons` → `src/app/squadrons/page.tsx`
- `/station-search` → `src/app/station-search/page.tsx`
- `/subscriptions` → `src/app/subscriptions/page.tsx`
- `/support` → `src/app/support/page.tsx`
- `/system/[name]` → `src/app/system/[name]/page.tsx`
- `/systems` → `src/app/systems/page.tsx`
- `/wiki/[slug]` → `src/app/wiki/[slug]/page.tsx`
- `/wiki/category/[slug]` → `src/app/wiki/category/[slug]/page.tsx`
- `/wiki/create` → `src/app/wiki/create/page.tsx`
- `/wiki/edit/[slug]` → `src/app/wiki/edit/[slug]/page.tsx`
- `/wiki/history/[slug]` → `src/app/wiki/history/[slug]/page.tsx`
- `/wiki` → `src/app/wiki/page.tsx`
- `/wiki/search` → `src/app/wiki/search/page.tsx`
- `/wiki/tag/[slug]` → `src/app/wiki/tag/[slug]/page.tsx`

## 3. Все API-маршруты

Список показывает объявленные обработчики HTTP. Авторизацию и ограничения надо смотреть внутри маршрута и вызываемых функций.

- `/api/account/avatar` [POST, DELETE] → `src/app/api/account/avatar/route.ts`
- `/api/admin/access` [GET] → `src/app/api/admin/access/route.ts`
- `/api/admin/auth-providers` [GET, PATCH] → `src/app/api/admin/auth-providers/route.ts`
- `/api/admin/backup` [GET, POST, DELETE] → `src/app/api/admin/backup/route.ts`
- `/api/admin/billing/credits` [POST] → `src/app/api/admin/billing/credits/route.ts`
- `/api/admin/billing/export` [GET] → `src/app/api/admin/billing/export/route.ts`
- `/api/admin/billing/intents` [GET, POST] → `src/app/api/admin/billing/intents/route.ts`
- `/api/admin/billing/items` [GET, POST, PATCH, DELETE] → `src/app/api/admin/billing/items/route.ts`
- `/api/admin/billing/plans` [GET, POST, PATCH, DELETE] → `src/app/api/admin/billing/plans/route.ts`
- `/api/admin/billing/profiles` [GET] → `src/app/api/admin/billing/profiles/route.ts`
- `/api/admin/billing/providers` [GET, PATCH, POST] → `src/app/api/admin/billing/providers/route.ts`
- `/api/admin/billing/refund` [POST] → `src/app/api/admin/billing/refund/route.ts`
- `/api/admin/billing/settings` [GET, PATCH] → `src/app/api/admin/billing/settings/route.ts`
- `/api/admin/billing/stats` [GET] → `src/app/api/admin/billing/stats/route.ts`
- `/api/admin/billing/subscriptions` [GET, POST, DELETE] → `src/app/api/admin/billing/subscriptions/route.ts`
- `/api/admin/billing/transactions` [GET] → `src/app/api/admin/billing/transactions/route.ts`
- `/api/admin/community-goals` [GET, POST, PATCH, DELETE] → `src/app/api/admin/community-goals/route.ts`
- `/api/admin/content` [POST, GET] → `src/app/api/admin/content/route.ts`
- `/api/admin/email-health` [GET] → `src/app/api/admin/email-health/route.ts`
- `/api/admin/env/apply` [POST] → `src/app/api/admin/env/apply/route.ts`
- `/api/admin/env` [GET, POST, DELETE] → `src/app/api/admin/env/route.ts`
- `/api/admin/factions` [GET, POST] → `src/app/api/admin/factions/route.ts`
- `/api/admin/factions/upload` [GET, POST, PUT] → `src/app/api/admin/factions/upload/route.ts`
- `/api/admin/galaxy` [GET, POST] → `src/app/api/admin/galaxy/route.ts`
- `/api/admin/monitor` [GET] → `src/app/api/admin/monitor/route.ts`
- `/api/admin/monitor/update` [GET, POST, DELETE] → `src/app/api/admin/monitor/update/route.ts`
- `/api/admin/outfitting` [GET, POST] → `src/app/api/admin/outfitting/route.ts`
- `/api/admin/powerplay` [GET, POST] → `src/app/api/admin/powerplay/route.ts`
- `/api/admin/powerplay/upload` [GET, POST, PUT] → `src/app/api/admin/powerplay/upload/route.ts`
- `/api/admin/ships/images` [GET, POST, DELETE] → `src/app/api/admin/ships/images/route.ts`
- `/api/admin/ships/images/upload-folder` [POST] → `src/app/api/admin/ships/images/upload-folder/route.ts`
- `/api/admin/smtp/apply` [POST] → `src/app/api/admin/smtp/apply/route.ts`
- `/api/admin/smtp` [GET, POST, DELETE] → `src/app/api/admin/smtp/route.ts`
- `/api/admin/squadrons/[id]/leader` [PATCH] → `src/app/api/admin/squadrons/[id]/leader/route.ts`
- `/api/admin/storage` [GET, POST] → `src/app/api/admin/storage/route.ts`
- `/api/admin/uploader/build-kit` [GET] → `src/app/api/admin/uploader/build-kit/route.ts`
- `/api/admin/uploader/config` [GET, POST] → `src/app/api/admin/uploader/config/route.ts`
- `/api/admin/uploader/publish` [POST] → `src/app/api/admin/uploader/publish/route.ts`
- `/api/admin/uploader/release` [GET, DELETE, POST] → `src/app/api/admin/uploader/release/route.ts`
- `/api/admin/uploader/setup` [GET, POST, DELETE] → `src/app/api/admin/uploader/setup/route.ts`
- `/api/admin/uploader/versions` [GET, POST, DELETE] → `src/app/api/admin/uploader/versions/route.ts`
- `/api/admin/users/[id]/confirm-email` [POST] → `src/app/api/admin/users/[id]/confirm-email/route.ts`
- `/api/admin/users/[id]/resend-confirmation` [POST] → `src/app/api/admin/users/[id]/resend-confirmation/route.ts`
- `/api/admin/users/confirm-email` [GET] → `src/app/api/admin/users/confirm-email/route.ts`
- `/api/architect/existing` [GET] → `src/app/api/architect/existing/route.ts`
- `/api/architect/governance` [GET, PUT, DELETE] → `src/app/api/architect/governance/route.ts`
- `/api/architect/plans/[id]` [GET, PUT, DELETE] → `src/app/api/architect/plans/[id]/route.ts`
- `/api/architect/plans` [GET, POST] → `src/app/api/architect/plans/route.ts`
- `/api/architect/projects/[id]/carriers` [POST, PATCH, DELETE] → `src/app/api/architect/projects/[id]/carriers/route.ts`
- `/api/architect/projects/[id]/leaderboard` [GET] → `src/app/api/architect/projects/[id]/leaderboard/route.ts`
- `/api/architect/projects/[id]/members` [GET, POST, PATCH, DELETE] → `src/app/api/architect/projects/[id]/members/route.ts`
- `/api/architect/projects/[id]/progress` [GET, POST] → `src/app/api/architect/projects/[id]/progress/route.ts`
- `/api/architect/projects/[id]` [GET, PATCH, DELETE] → `src/app/api/architect/projects/[id]/route.ts`
- `/api/architect/projects/[id]/systems` [POST, PATCH, DELETE] → `src/app/api/architect/projects/[id]/systems/route.ts`
- `/api/architect/projects` [GET, POST] → `src/app/api/architect/projects/route.ts`
- `/api/architect/raven-key` [GET, PUT, DELETE] → `src/app/api/architect/raven-key/route.ts`
- `/api/architect/raven-project` [POST] → `src/app/api/architect/raven-project/route.ts`
- `/api/architect/sourcing` [POST] → `src/app/api/architect/sourcing/route.ts`
- `/api/atlas/candidates` [GET] → `src/app/api/atlas/candidates/route.ts`
- `/api/atlas/carriers/name` [PUT] → `src/app/api/atlas/carriers/name/route.ts`
- `/api/atlas/carriers` [GET] → `src/app/api/atlas/carriers/route.ts`
- `/api/atlas/carriers/watch` [GET, PUT, DELETE] → `src/app/api/atlas/carriers/watch/route.ts`
- `/api/atlas/favorites` [GET, POST, DELETE] → `src/app/api/atlas/favorites/route.ts`
- `/api/atlas/nearby` [POST] → `src/app/api/atlas/nearby/route.ts`
- `/api/atlas/ring-route/finalize` [POST] → `src/app/api/atlas/ring-route/finalize/route.ts`
- `/api/atlas/ring-route/hubs` [POST] → `src/app/api/atlas/ring-route/hubs/route.ts`
- `/api/atlas/ring-route/preview` [GET] → `src/app/api/atlas/ring-route/preview/route.ts`
- `/api/atlas/ring-route/refine` [POST] → `src/app/api/atlas/ring-route/refine/route.ts`
- `/api/atlas/ring-route/replan` [POST] → `src/app/api/atlas/ring-route/replan/route.ts`
- `/api/atlas/ring-route` [POST, GET] → `src/app/api/atlas/ring-route/route.ts`
- `/api/atlas/ring-route/save` [POST] → `src/app/api/atlas/ring-route/save/route.ts`
- `/api/atlas/route` [POST] → `src/app/api/atlas/route/route.ts`
- `/api/atlas/route-finder` [POST] → `src/app/api/atlas/route-finder/route.ts`
- `/api/atlas/search` [POST, GET] → `src/app/api/atlas/search/route.ts`
- `/api/atlas/sector/[id]` [GET] → `src/app/api/atlas/sector/[id]/route.ts`
- `/api/atlas/sector` [GET] → `src/app/api/atlas/sector/route.ts`
- `/api/atlas/sessions` [GET] → `src/app/api/atlas/sessions/route.ts`
- `/api/atlas/system-bodies` [GET, POST] → `src/app/api/atlas/system-bodies/route.ts`
- `/api/auth/callback` [GET] → `src/app/api/auth/callback/route.ts`
- `/api/auth/desktop` [GET, POST] → `src/app/api/auth/desktop/route.ts`
- `/api/auth/email/request` [POST] → `src/app/api/auth/email/request/route.ts`
- `/api/auth/email/verify` [POST] → `src/app/api/auth/email/verify/route.ts`
- `/api/auth/ensure-profile` [POST] → `src/app/api/auth/ensure-profile/route.ts`
- `/api/auth/password` [GET, POST] → `src/app/api/auth/password/route.ts`
- `/api/auth/providers` [GET] → `src/app/api/auth/providers/route.ts`
- `/api/auth/register` [POST] → `src/app/api/auth/register/route.ts`
- `/api/auth/token` [POST] → `src/app/api/auth/token/route.ts`
- `/api/auth/tokens` [GET, POST, DELETE] → `src/app/api/auth/tokens/route.ts`
- `/api/auth/vk/callback` [GET] → `src/app/api/auth/vk/callback/route.ts`
- `/api/auth/vk` [GET, DELETE] → `src/app/api/auth/vk/route.ts`
- `/api/auth/yandex/callback` [GET] → `src/app/api/auth/yandex/callback/route.ts`
- `/api/auth/yandex` [GET, DELETE] → `src/app/api/auth/yandex/route.ts`
- `/api/avatars/[id]` [GET] → `src/app/api/avatars/[id]/route.ts`
- `/api/billing/checkout` [POST] → `src/app/api/billing/checkout/route.ts`
- `/api/billing/cosmetics` [GET, POST] → `src/app/api/billing/cosmetics/route.ts`
- `/api/billing/intent/[id]` [GET] → `src/app/api/billing/intent/[id]/route.ts`
- `/api/billing/my-transactions` [GET] → `src/app/api/billing/my-transactions/route.ts`
- `/api/billing/plans` [GET] → `src/app/api/billing/plans/route.ts`
- `/api/billing/providers` [GET] → `src/app/api/billing/providers/route.ts`
- `/api/billing/subscribe` [POST] → `src/app/api/billing/subscribe/route.ts`
- `/api/billing/webhooks/[provider]` [POST, GET] → `src/app/api/billing/webhooks/[provider]/route.ts`
- `/api/capi/auth` [GET] → `src/app/api/capi/auth/route.ts`
- `/api/capi/callback` [GET] → `src/app/api/capi/callback/route.ts`
- `/api/capi/helper` [GET, POST] → `src/app/api/capi/helper/route.ts`
- `/api/capi/journal` [GET] → `src/app/api/capi/journal/route.ts`
- `/api/capi/network-check` [GET] → `src/app/api/capi/network-check/route.ts`
- `/api/capi/profile` [GET] → `src/app/api/capi/profile/route.ts`
- `/api/capi/status` [GET] → `src/app/api/capi/status/route.ts`
- `/api/capi/sync/[jobId]` [GET] → `src/app/api/capi/sync/[jobId]/route.ts`
- `/api/capi/sync` [GET, POST] → `src/app/api/capi/sync/route.ts`
- `/api/capi/token` [GET, POST] → `src/app/api/capi/token/route.ts`
- `/api/capi/unlink` [DELETE] → `src/app/api/capi/unlink/route.ts`
- `/api/carriers/[id]/card` [GET] → `src/app/api/carriers/[id]/card/route.ts`
- `/api/carriers/[id]` [GET] → `src/app/api/carriers/[id]/route.ts`
- `/api/carriers/bind` [POST, DELETE] → `src/app/api/carriers/bind/route.ts`
- `/api/carriers/directory` [GET] → `src/app/api/carriers/directory/route.ts`
- `/api/carriers/jumps/history` [GET] → `src/app/api/carriers/jumps/history/route.ts`
- `/api/carriers/jumps` [GET] → `src/app/api/carriers/jumps/route.ts`
- `/api/carriers/jumps/schedules/[id]` [GET, PATCH, POST, DELETE] → `src/app/api/carriers/jumps/schedules/[id]/route.ts`
- `/api/carriers/jumps/schedules` [GET, POST] → `src/app/api/carriers/jumps/schedules/route.ts`
- `/api/carriers/mine` [GET] → `src/app/api/carriers/mine/route.ts`
- `/api/carriers` [GET, POST] → `src/app/api/carriers/route.ts`
- `/api/carriers/sync` [POST] → `src/app/api/carriers/sync/route.ts`
- `/api/cg` [GET] → `src/app/api/cg/route.ts`
- `/api/cmdr/route` [POST] → `src/app/api/cmdr/route/route.ts`
- `/api/cmdr/ship-state` [GET, POST] → `src/app/api/cmdr/ship-state/route.ts`
- `/api/cmdr/squadron` [POST, GET] → `src/app/api/cmdr/squadron/route.ts`
- `/api/cmdr/stats` [GET, POST] → `src/app/api/cmdr/stats/route.ts`
- `/api/comments/[id]` [DELETE] → `src/app/api/comments/[id]/route.ts`
- `/api/comments` [GET, POST] → `src/app/api/comments/route.ts`
- `/api/cron/capi-sync` [GET] → `src/app/api/cron/capi-sync/route.ts`
- `/api/cron/capi-sync-jobs` [POST] → `src/app/api/cron/capi-sync-jobs/route.ts`
- `/api/cron/cg-check` [GET] → `src/app/api/cron/cg-check/route.ts`
- `/api/cron/colonisation-cleanup` [GET] → `src/app/api/cron/colonisation-cleanup/route.ts`
- `/api/cron/eddn-cleanup` [GET] → `src/app/api/cron/eddn-cleanup/route.ts`
- `/api/cron/eddn-listener` [GET] → `src/app/api/cron/eddn-listener/route.ts`
- `/api/cron/factions-sync` [GET] → `src/app/api/cron/factions-sync/route.ts`
- `/api/cron/galaxy-import` [GET] → `src/app/api/cron/galaxy-import/route.ts`
- `/api/cron/powerplay-sync` [GET] → `src/app/api/cron/powerplay-sync/route.ts`
- `/api/cron/translate` [GET, POST] → `src/app/api/cron/translate/route.ts`
- `/api/cron/update-progress` [POST] → `src/app/api/cron/update-progress/route.ts`
- `/api/discord/webhook` [POST] → `src/app/api/discord/webhook/route.ts`
- `/api/eddn/ingest` [POST] → `src/app/api/eddn/ingest/route.ts`
- `/api/eddn` [GET, POST] → `src/app/api/eddn/route.ts`
- `/api/edsm/batch` [см. исходник] → `src/app/api/edsm/batch/route.ts`
- `/api/edsm/search` [GET] → `src/app/api/edsm/search/route.ts`
- `/api/edsm/system` [GET] → `src/app/api/edsm/system/route.ts`
- `/api/factions/presence` [GET] → `src/app/api/factions/presence/route.ts`
- `/api/factions/search` [GET] → `src/app/api/factions/search/route.ts`
- `/api/factions/sync` [POST] → `src/app/api/factions/sync/route.ts`
- `/api/factions/system` [GET] → `src/app/api/factions/system/route.ts`
- `/api/factions/systems` [GET] → `src/app/api/factions/systems/route.ts`
- `/api/forum/categories` [GET] → `src/app/api/forum/categories/route.ts`
- `/api/forum/latest` [GET] → `src/app/api/forum/latest/route.ts`
- `/api/forum/posts` [GET, POST, PATCH] → `src/app/api/forum/posts/route.ts`
- `/api/forum/reactions` [GET] → `src/app/api/forum/reactions/route.ts`
- `/api/forum/report` [POST] → `src/app/api/forum/report/route.ts`
- `/api/forum/search` [GET] → `src/app/api/forum/search/route.ts`
- `/api/forum/subscribe` [POST] → `src/app/api/forum/subscribe/route.ts`
- `/api/forum/threads` [GET, POST] → `src/app/api/forum/threads/route.ts`
- `/api/forum/views` [POST] → `src/app/api/forum/views/route.ts`
- `/api/friends` [GET, POST, PATCH, DELETE] → `src/app/api/friends/route.ts`
- `/api/galaxy/all-systems` [GET] → `src/app/api/galaxy/all-systems/route.ts`
- `/api/galaxy/stats` [GET] → `src/app/api/galaxy/stats/route.ts`
- `/api/galaxy/systems/[id64]` [GET] → `src/app/api/galaxy/systems/[id64]/route.ts`
- `/api/galaxy/systems/by-name` [GET] → `src/app/api/galaxy/systems/by-name/route.ts`
- `/api/galaxy/systems/search` [GET, HEAD] → `src/app/api/galaxy/systems/search/route.ts`
- `/api/galnet/[nid]` [GET] → `src/app/api/galnet/[nid]/route.ts`
- `/api/galnet` [GET, POST, PATCH] → `src/app/api/galnet/route.ts`
- `/api/health` [GET] → `src/app/api/health/route.ts`
- `/api/home-data` [GET] → `src/app/api/home-data/route.ts`
- `/api/hubs/resolve` [GET] → `src/app/api/hubs/resolve/route.ts`
- `/api/hubs` [GET] → `src/app/api/hubs/route.ts`
- `/api/inara/sync` [POST] → `src/app/api/inara/sync/route.ts`
- `/api/journal/import` [POST] → `src/app/api/journal/import/route.ts`
- `/api/journal/parse` [POST] → `src/app/api/journal/parse/route.ts`
- `/api/journal/reset` [POST] → `src/app/api/journal/reset/route.ts`
- `/api/leaderboard` [GET] → `src/app/api/leaderboard/route.ts`
- `/api/leaderboard/stats` [GET] → `src/app/api/leaderboard/stats/route.ts`
- `/api/logs/import` [POST] → `src/app/api/logs/import/route.ts`
- `/api/logs/upload` [POST] → `src/app/api/logs/upload/route.ts`
- `/api/maintenance` [GET] → `src/app/api/maintenance/route.ts`
- `/api/map/carriers` [GET] → `src/app/api/map/carriers/route.ts`
- `/api/map/pilots` [GET] → `src/app/api/map/pilots/route.ts`
- `/api/market/find` [GET] → `src/app/api/market/find/route.ts`
- `/api/market/find/start` [POST] → `src/app/api/market/find/start/route.ts`
- `/api/market/find/status` [GET] → `src/app/api/market/find/status/route.ts`
- `/api/market/find/step` [POST] → `src/app/api/market/find/step/route.ts`
- `/api/market/search` [GET] → `src/app/api/market/search/route.ts`
- `/api/mobile/admin-summary` [GET] → `src/app/api/mobile/admin-summary/route.ts`
- `/api/mobile/auth` [GET, POST] → `src/app/api/mobile/auth/route.ts`
- `/api/news/[id]` [GET] → `src/app/api/news/[id]/route.ts`
- `/api/news` [GET, POST] → `src/app/api/news/route.ts`
- `/api/notifications` [GET, PATCH] → `src/app/api/notifications/route.ts`
- `/api/outfitting/builds` [GET, POST, DELETE] → `src/app/api/outfitting/builds/route.ts`
- `/api/outfitting/catalog` [GET] → `src/app/api/outfitting/catalog/route.ts`
- `/api/powerplay/systems` [GET] → `src/app/api/powerplay/systems/route.ts`
- `/api/projects/[id]/assign` [POST, DELETE] → `src/app/api/projects/[id]/assign/route.ts`
- `/api/projects/[id]/members` [GET, POST, PATCH, DELETE] → `src/app/api/projects/[id]/members/route.ts`
- `/api/projects/[id]/progress` [GET, POST] → `src/app/api/projects/[id]/progress/route.ts`
- `/api/projects/[id]/route` [POST] → `src/app/api/projects/[id]/route/route.ts`
- `/api/projects/[id]` [GET, PATCH, DELETE] → `src/app/api/projects/[id]/route.ts`
- `/api/projects/[id]/systems/bulk` [POST] → `src/app/api/projects/[id]/systems/bulk/route.ts`
- `/api/projects/[id]/systems` [GET, POST, PATCH, DELETE] → `src/app/api/projects/[id]/systems/route.ts`
- `/api/projects/active` [GET] → `src/app/api/projects/active/route.ts`
- `/api/projects/register` [POST] → `src/app/api/projects/register/route.ts`
- `/api/projects` [GET, POST] → `src/app/api/projects/route.ts`
- `/api/push/send` [POST] → `src/app/api/push/send/route.ts`
- `/api/push/subscribe` [POST, DELETE] → `src/app/api/push/subscribe/route.ts`
- `/api/ravencolonial/[name]` [GET] → `src/app/api/ravencolonial/[name]/route.ts`
- `/api/ravencolonial/sync/log` [GET] → `src/app/api/ravencolonial/sync/log/route.ts`
- `/api/ravencolonial/sync` [POST] → `src/app/api/ravencolonial/sync/route.ts`
- `/api/ravencolonial/sync/single` [POST] → `src/app/api/ravencolonial/sync/single/route.ts`
- `/api/route/progress` [POST] → `src/app/api/route/progress/route.ts`
- `/api/route/resolve` [см. исходник] → `src/app/api/route/resolve/route.ts`
- `/api/route` [GET] → `src/app/api/route/route.ts`
- `/api/shop/equip` [POST] → `src/app/api/shop/equip/route.ts`
- `/api/shop/items` [GET] → `src/app/api/shop/items/route.ts`
- `/api/shop/purchase` [POST] → `src/app/api/shop/purchase/route.ts`
- `/api/shop/topup` [POST] → `src/app/api/shop/topup/route.ts`
- `/api/shop/user-state` [GET] → `src/app/api/shop/user-state/route.ts`
- `/api/squadrons/[id]/branding` [POST, DELETE] → `src/app/api/squadrons/[id]/branding/route.ts`
- `/api/squadrons/[id]/chat/[messageId]` [DELETE] → `src/app/api/squadrons/[id]/chat/[messageId]/route.ts`
- `/api/squadrons/[id]/chat` [GET, POST] → `src/app/api/squadrons/[id]/chat/route.ts`
- `/api/squadrons/[id]/images/[kind]` [GET] → `src/app/api/squadrons/[id]/images/[kind]/route.ts`
- `/api/squadrons/[id]/members` [GET, POST, PATCH, DELETE] → `src/app/api/squadrons/[id]/members/route.ts`
- `/api/squadrons/[id]/projects` [GET, POST] → `src/app/api/squadrons/[id]/projects/route.ts`
- `/api/squadrons/[id]/ranks` [GET, POST, PATCH, DELETE] → `src/app/api/squadrons/[id]/ranks/route.ts`
- `/api/squadrons/[id]` [GET, PATCH, DELETE] → `src/app/api/squadrons/[id]/route.ts`
- `/api/squadrons/[id]/voice` [GET, POST] → `src/app/api/squadrons/[id]/voice/route.ts`
- `/api/squadrons/my` [GET] → `src/app/api/squadrons/my/route.ts`
- `/api/squadrons` [GET, POST] → `src/app/api/squadrons/route.ts`
- `/api/stations/report` [POST] → `src/app/api/stations/report/route.ts`
- `/api/stations/search/options` [GET] → `src/app/api/stations/search/options/route.ts`
- `/api/stations/search` [GET] → `src/app/api/stations/search/route.ts`
- `/api/status` [GET] → `src/app/api/status/route.ts`
- `/api/support/tickets/[id]/messages` [POST] → `src/app/api/support/tickets/[id]/messages/route.ts`
- `/api/support/tickets/[id]` [GET, PATCH] → `src/app/api/support/tickets/[id]/route.ts`
- `/api/support/tickets` [GET, POST] → `src/app/api/support/tickets/route.ts`
- `/api/support/unread` [GET] → `src/app/api/support/unread/route.ts`
- `/api/support/upload` [POST] → `src/app/api/support/upload/route.ts`
- `/api/systems/overview` [GET] → `src/app/api/systems/overview/route.ts`
- `/api/systems/progress` [GET] → `src/app/api/systems/progress/route.ts`
- `/api/systems/route-hint` [GET] → `src/app/api/systems/route-hint/route.ts`
- `/api/translate` [POST] → `src/app/api/translate/route.ts`
- `/api/uploader/blob/[hash]` [GET] → `src/app/api/uploader/blob/[hash]/route.ts`
- `/api/uploader/bundle/[file]` [GET] → `src/app/api/uploader/bundle/[file]/route.ts`
- `/api/uploader/download` [GET] → `src/app/api/uploader/download/route.ts`
- `/api/uploader/launcher/[platform]` [GET] → `src/app/api/uploader/launcher/[platform]/route.ts`
- `/api/uploader/launcher` [GET] → `src/app/api/uploader/launcher/route.ts`
- `/api/uploader/link/claim` [POST] → `src/app/api/uploader/link/claim/route.ts`
- `/api/uploader/link/code` [POST] → `src/app/api/uploader/link/code/route.ts`
- `/api/uploader/link/me` [GET, DELETE] → `src/app/api/uploader/link/me/route.ts`
- `/api/uploader/link` [GET, DELETE] → `src/app/api/uploader/link/route.ts`
- `/api/uploader/manifest` [GET] → `src/app/api/uploader/manifest/route.ts`
- `/api/uploader/settings` [GET, PUT] → `src/app/api/uploader/settings/route.ts`
- `/api/uploader/setup/[platform]` [GET] → `src/app/api/uploader/setup/[platform]/route.ts`
- `/api/user/ships/photos` [GET, POST, DELETE] → `src/app/api/user/ships/photos/route.ts`
- `/api/wiki/articles/[slug]/revisions` [GET] → `src/app/api/wiki/articles/[slug]/revisions/route.ts`
- `/api/wiki/articles/[slug]` [GET, PATCH, DELETE] → `src/app/api/wiki/articles/[slug]/route.ts`
- `/api/wiki/articles` [GET, POST] → `src/app/api/wiki/articles/route.ts`
- `/api/wiki/categories/[slug]` [GET] → `src/app/api/wiki/categories/[slug]/route.ts`
- `/api/wiki/categories` [GET] → `src/app/api/wiki/categories/route.ts`
- `/api/wiki/favorites/[id]` [DELETE] → `src/app/api/wiki/favorites/[id]/route.ts`
- `/api/wiki/favorites` [GET, POST] → `src/app/api/wiki/favorites/route.ts`
- `/api/wiki/search` [GET] → `src/app/api/wiki/search/route.ts`
- `/api/wiki/tags/[slug]` [GET] → `src/app/api/wiki/tags/[slug]/route.ts`
- `/api/wiki/tags` [GET, POST] → `src/app/api/wiki/tags/route.ts`
- `/auth/callback` [GET] → `src/app/auth/callback/route.ts`
- `/auth/templates/[template]` [GET] → `src/app/auth/templates/[template]/route.ts`

## 4. Все модули серверной и общей логики сайта

- `src/lib/achievements.ts` — `AchievementRank`, `AchievementTrack`, `TrackProgress`, `ACHIEVEMENT_TRACKS`, `HERO_BADGES`, `trackValue`, `rankProgress`, `tierColor`, `tierBg`, `tierBorder`, `checkHeroBadges`, `pilotAchievements`
- `src/lib/adminAccess.ts` — `STAFF_ROLES`, `StaffRole`, `AccessReason`, `AccessHint`, `ProfileErrorLike`, `AccessInput`, `AccessDecision`, `classifyProfileError`, `decideAccess`
- `src/lib/adminEmailActions.ts` — `AdminEmailAction`, `confirmUserEmail`, `resendUserConfirmation`, `emailConfirmedAt`
- `src/lib/architect/bodyNames.ts` — `BodyMatchKind`, `BodyMatch`, `normalizeBodyKey`, `compactBodyKey`, `shortBodyKey`, `stripRingSuffix`, `BodyIndex`, `buildBodyIndex`, `ResolveOptions`, `resolveBodyName`, `canonicalBodyName`, `sameBodyName`
- `src/lib/architect/bodySync.ts` — `BodyRecordSource`, `BodySourceId`, `BodyRow`, `CompareOptions`, `BodyComparison`, `CompareSummary`, `scoreBodyRecord`, `compareBodyRecords`, `compareBodySources`, `compareSystemBodies`, `normalizeEdsmBody`, `normalizeSpanshBody`, `SyncStatus`, `SyncSourceState`, `SystemSyncReport`, `parseSyncReport`
- `src/lib/architect/catalogue.ts` — `CATALOGUE_VERSION`, `COMMODITY_LABELS_RU`, `ECONOMY_LABELS_RU`, `BUILD_CLASS_LABELS_RU`, `PAD_LABELS_RU`, `PRE_REQS`, `SYSTEM_UNLOCKS`, `INSTALLATIONS`, `installationName`, `BuildingRef`, `BuildingLinks`, `installationLinks`
- `src/lib/architect/dataQuality.ts` — `DataIssueLevel`, `DataIssue`, `BodyDataReport`, `PlanDataReport`, `auditBodyRows`, `auditPlanData`
- `src/lib/architect/economy.ts` — `BodyTrait`, `BODY_TRAIT_LABELS_RU`, `EconomyFitLevel`, `EconomyAffinity`, `ECONOMY_AFFINITY`, `EconomyMarket`, `ECONOMY_MARKET`, `bodyTraits`, `EconomyBodyFit`, `economyBodyFit`, `bodyBoostedEconomies`
- `src/lib/architect/existing.ts` — `ExistingSource`, `ExistingStructure`, `EDSM_STATION_TYPES`, `installationFromStationType`, `ParseExistingOptions`, `parseExistingStructures`, `AdoptResult`, `AdoptOptions`, `adoptExisting`
- `src/lib/architect/governance.ts` — `GOVERNANCE_TABLE`, `systemKey`, `SystemArchitectRow`, `ArchitectAssignment`, `GovernanceViewer`, `GovernanceInfo`, `QueryClientLike`, `rowToAssignment`, `loadAssignment`, `loadCallerProfile`, `checkPlanEditRights`, `lockReasonRu`
- `src/lib/architect/insights.ts` — `Share`, `cargoShares`, `economyShares`, `StatusBreakdown`, `statusBreakdown`, `EffectBar`, `effectBars`, `TierBudget`, `tierBudgets`, `BodyLoad`, `bodyLoads`, `haulTrips`, `PlanPulse`, `planPulse`
- `src/lib/architect/planner.ts` — `PLAN_FORMAT_VERSION`, `SURFACE_SLOT_LIMIT`, `ORBITAL_SLOT_LIMIT`, `SURFACE_MAX_TEMP_K`, `SURFACE_MAX_GRAVITY_G`, `getInstallation`, `canBePrimary`, `primarySiteOf`, `siteCargo`, `listInstallations`, `commodityLabel`, `fromScanRecords`, `predictSurfaceSlots`, `surfaceSlotReasonNote`, `surfaceSlotReason`, `orbitalLimit`, `setOrbitalSlots`, `placementCheck`, `createPlan`, `nextSiteId`, `addSite`, `linkSiteToRaven`, `removeSite`, `setSiteStatus`, `setSitePrimary`, `SitePatch`, `updateSite`, `setPlanArchitect`, `setPlanNotes`, `computeBuildOrder`, `portTax`, `evaluatePlan`, `parsePlan`, `serializePlan`, `planToStructures`, `cargoList`, `formatTons`, `summarizePlan`
- `src/lib/architect/progress.ts` — `BUILD_TYPE_ALIASES`, `normalizeBuildType`, `ActualSite`, `parseActualSites`, `MatchKind`, `SiteProgress`, `ProgressReport`, `matchProgress`
- `src/lib/architect/projectLeaders.ts` — `LEADER_PERIODS`, `LeaderPeriod`, `LeaderScope`, `PERIOD_LABELS`, `isLeaderPeriod`, `periodSince`, `canonicalCommodity`, `ContributionRow`, `ActivityRow`, `PilotInfo`, `SiteInfo`, `LeaderInput`, `LeaderSlice`, `LeaderBreakdownRow`, `LeaderPilot`, `LeaderSite`, `LeaderCommodity`, `LeaderSystem`, `LeaderCarrier`, `LeaderTimeline`, `LeaderMatrix`, `ProjectLeadersView`, `buildProjectLeaders`
- `src/lib/architect/projectProgress.ts` — `RavenCacheRow`, `DepotRow`, `PlanRow`, `ProgressSources`, `SiteCommodity`, `ProjectSite`, `PlanSiteState`, `SystemStatus`, `SystemProgressView`, `ProjectProgressSummary`, `ProjectProgressView`, `resourceKey`, `pickRavenRow`, `cleanDepotName`, `mergeSites`, `SystemInput`, `buildSystemProgress`, `summarizeProject`, `buildProjectProgress`, `siteDirectory`, `staleSystems`
- `src/lib/architect/projectRouteKit.ts` — `ProjectAccess`, `jsonError`, `errorResponse`, `currentUserId`, `readJson`, `openProject`
- `src/lib/architect/projectStore.ts` — `PROJECT_COLUMNS`, `SYSTEM_COLUMNS`, `CARRIER_LINK_COLUMNS`, `ProjectRow`, `ProfileInfo`, `AccessResult`, `loadIsAdmin`, `loadProjectAccess`, `loadProfiles`, `loadMemberRows`, `loadSystemRows`, `loadCarrierLinks`, `loadPlanRefs`, `memberView`, `systemView`, `projectHeader`, `projectSummaries`, `loadProgressSources`, `computeProjectProgress`, `storeProgressSummary`, `canShareCarrier`, `loadCarrierRows`, `projectCarrierViews`
- `src/lib/architect/projects.ts` — `PROJECT_ROLES`, `ProjectRole`, `PROJECT_STATUSES`, `ProjectStatus`, `SYSTEM_STAGES`, `SystemStage`, `ROLE_LABELS`, `STATUS_LABELS`, `STAGE_LABELS`, `PRIORITY_LABELS`, `PROJECT_COLORS`, `DEFAULT_PROJECT_COLOR`, `PROJECT_LIMITS`, `ProjectPermissions`, `isProjectRole`, `isProjectStatus`, `isSystemStage`, `projectPermissions`, `ProjectActor`, `MemberTarget`, `canRemoveMember`, `canChangeRole`, `canEditDuty`, `RESPONSIBLE_SYSTEM_FIELDS`, `editableSystemFields`, `normalizeSystemName`, `systemKey`, `ParsedSystemList`, `parseSystemList`, `cleanLine`, `normalizeColor`, `parseDateOnly`, `parseTimestamp`, `ProjectInput`, `validateNewProject`, `sanitizeProjectPatch`, `sanitizeSystemPatch`, `isUuid`, `ProjectSummary`, `ProjectProgressSnapshot`, `ProjectMemberView`, `ProjectPlanRef`, `ProjectSystemView`, `ProjectDetail`, `sortSystems`, `sortMembers`, `progressSnapshot`, `parseProgressSnapshot`
- `src/lib/architect/ravenCreate.ts` — `RavenDraftInput`, `RavenDraftResult`, `buildRavenProjectDraft`
- `src/lib/architect/sourcing.ts` — `DEFAULT_SOURCING_OPTIONS`, `ResolvedSourcingOptions`, `normalizeCommodityKey`, `commodityNameVariants`, `SystemCoords`, `MarketPriceRow`, `MarketOffer`, `distanceLy`, `buildOffers`, `resolveSourcingOptions`, `CommoditySourcing`, `ShoppingStop`, `SourcingPlan`, `planSourcing`, `formatCredits`
- `src/lib/architect/store.ts` — `PLAN_TABLE`, `PlanVisibility`, `PLAN_VISIBILITIES`, `VISIBILITY_LABEL_KEYS`, `VISIBILITY_HINT_KEYS`, `isPlanVisibility`, `sharePath`, `PlanMetrics`, `planMetrics`, `StoredPlanRow`, `PlanView`, `buildPlanInsert`, `buildPlanUpdate`, `rowToView`, `rowToStoredPlan`
- `src/lib/architect/types.ts` — `ArchitectLocation`, `ArchitectBuildClass`, `ArchitectPadSize`, `ArchitectTier`, `SystemEconomy`, `SystemEffectKey`, `SystemEffects`, `ArchitectPreReq`, `TierCost`, `PrimaryPortCargo`, `ArchitectInstallation`, `ArchitectBodyKind`, `ArchitectBody`, `PlannedSiteStatus`, `PlannedSite`, `ArchitectPlan`, `IssueLevel`, `PrimaryPortInfo`, `PlanIssue`, `PlanStep`, `PlanEvaluation`, `PlacementNote`, `PlacementCheck`
- `src/lib/archiveUploadClient.ts` — `ArchiveUploadResponse`, `ArchiveUploadFetch`, `ArchiveUploadHttpError`, `ARCHIVE_UPLOAD_CHUNK_FALLBACK`, `ArchiveUploadFile`, `ArchiveUploadSession`, `postArchiveUpload`, `uploadArchiveFile`
- `src/lib/atlas.ts` — `AtlasCandidateLike`, `AtlasCandidateSort`, `AtlasCandidateFilter`, `formatDistanceLy`, `formatArrivalLs`, `formatCredits`, `formatDateTime`, `relativeTime`, `formatCoordinates`, `normalizeSystemKey`, `favoriteKey`, `worldTypeLabel`, `candidateMatchesQuery`, `filterCandidates`, `sortCandidates`, `countByWorldType`, `escapeCsvValue`, `buildCsv`, `sanitizeFileName`, `downloadCsv`, `copyText`, `routeToCsvRows`
- `src/lib/atlasNearby.ts` — `NearbyShape`, `NearbySourceId`, `NearbyPoint`, `NearbySystem`, `NearbySource`, `NearbyResult`, `nearbyNameKey`, `nearbyPoint`, `nearbyDistance`, `inNearbyVolume`, `mergeNearbySystems`
- `src/lib/atlasNearbySearch.ts` — `searchNearbySystems`
- `src/lib/atlasRingGeometry.ts` — `XYZ`, `RingBasis3D`, `ringBasis3D`, `ringPointAtAngle3D`, `ringHeightOffset`
- `src/lib/atlasRingHubSearch.ts` — `HUB_SEARCH_RADIUS`, `HubCandidate`, `AnchorHubResult`, `findHubsForAnchors`, `invalidateHubCatalogCache`
- `src/lib/atlasRingMapGeometry.ts` — `atlasRingPointToThree`
- `src/lib/atlasRingParams.ts` — `parseRingParam`
- `src/lib/atlasRingPreview.ts` — `readAtlasRingPreview`, `readServerRingPreview`, `publishAtlasRingPreview`, `subscribeAtlasRingPreview`
- `src/lib/atlasRingSearch.ts` — `MIN_RING_RADIUS`, `MAX_RING_RADIUS`, `DEFAULT_RING_RADIUS`, `MIN_SEARCH_RADIUS`, `MAX_SEARCH_RADIUS`, `DEFAULT_SEARCH_RADIUS`, `MAX_JUMP`, `ANCHOR_SPACING_MIN`, `ANCHOR_SPACING_TARGET`, `ANCHOR_SPACING_MAX`, `ANCHOR_SPACING_LIMIT`, `ANCHOR_DEVIATION_PREFERRED`, `ANCHOR_DEVIATION_LIMIT`, `GALACTIC_DISK_HALF_THICKNESS`, `GALACTIC_DISK_RECOMMENDED`, `MIN_HEIGHT_OFFSET`, `MAX_HEIGHT_OFFSET`, `MIN_TILT_DEGREES`, `MAX_TILT_DEGREES`, `ROUTE_CORRIDOR`, `DEFAULT_STEP_SECTORS`, `RingSource`, `XYZ`, `RingPoint`, `RingAnchor`, `RingStats`, `KeySystem`, `RingPlan`, `RingStepResult`, `RingValidation`, `RingHubSummary`, `RingResult`, `distance3`, `computeSectorCount`, `ringPointAtAngle`, `ringTarget`, `ringBasis`, `ringDeviation3D`, `ringDeviation`, `ringPointAtDistance`, `ringPointAtDistance2D`, `distanceToSegment`, `resolveRingSystem`, `loadRingSession`, `RingSessionRoute`, `loadRingRoute`, `planRingSession`, `replanRingSession`, `AnchorCandidate`, `chooseAnchor`, `stepRingSession`, `invalidateRingCatalogCache`, `bridgeWithSystems`, `validateRingRoute`, `finalizeRingSession`, `remainingSectors`, `findRingSessionByStart`, `routeIsClosed`, `RingBudget`
- `src/lib/atlasSearchProgress.ts` — `AtlasSearchKind`, `AtlasSearchPointKind`, `AtlasSearchPoint`, `AtlasSearchCounters`, `AtlasSearchCorridor`, `AtlasSearchRingBasis`, `AtlasSearchRing`, `AtlasSearchCube`, `AtlasSearchProgress`, `EMPTY_ATLAS_SEARCH_PROGRESS`, `publishAtlasSearchProgress`, `pinAtlasSearchProgress`, `clearAtlasSearchResult`, `readAtlasSearchResult`, `subscribeAtlasSearchResult`, `startAtlasSearchProgress`, `finishAtlasSearchProgress`, `resetAtlasSearchProgress`, `readAtlasSearchProgress`, `subscribeAtlasSearchProgress`, `appendAtlasSearchPoints`, `pointKey`, `publishAtlasSearchPoints`
- `src/lib/atlasSystemCache.ts` — `CachedSystem`, `Box`, `CachedBody`, `boxAround`, `listCachedSystemsInBox`, `listCachedSystemsNear`, `saveCachedSystems`, `listCachedBodiesInBox`, `saveCachedBodies`
- `src/lib/atlasWorldSearch.ts` — `WorldSearchPoint`, `WorldSearchProgress`, `WorldSearchCandidate`, `writeSearchProgress`, `BodySystemLink`, `resolveBodySystems`, `resolveCoordinates`, `WorldSearchContext`, `runWorldSearch`, `resolveReferenceSystem`
- `src/lib/authProfile.ts` — `nickFromUser`, `avatarFromUser`, `hasProvider`
- `src/lib/authProviders/registry.ts` — `AuthProviderKind`, `AuthProviderMeta`, `GOTRUE_CALLBACK`, `AUTH_PROVIDER_REGISTRY`, `AUTH_PROVIDER_IDS`, `authProviderMeta`, `AuthProviderSetting`, `AuthProviderSettings`, `DEFAULT_VISIBLE`
- `src/lib/authProviders/settings.ts` — `getAuthProviderSettings`, `AuthProviderPatch`, `updateAuthProviderSettings`, `publicAuthProviderSettings`, `resolveVkSettings`, `resolveYandexSettings`, `visibleGotrueProviders`
- `src/lib/avatarUrl.ts` — `configuredSupabaseUrl`, `isSupabaseStorageUrl`, `resolveAvatarUrl`, `avatarInitials`, `avatarColor`
- `src/lib/bgs.ts` — `BGS_ALLEGIANCES`, `BgsAllegiance`, `BGS_ALLEGIANCE_LABEL`, `BGS_ALLEGIANCE_COLOR`, `normalizeAllegiance`, `BGS_GOVERNMENT_LABEL`, `normalizeGovernment`, `BGS_ECONOMY_LABEL`, `normalizeEconomy`, `BGS_SECURITY_LABEL`, `normalizeSecurity`, `BGS_STATE_LABEL`, `normalizeState`, `BGS_CONFLICT_STATES`, `BGS_HAPPINESS_LABEL`, `normalizeHappiness`, `allegianceLabel`, `governmentLabel`, `economyLabel`, `securityLabel`, `stateLabel`, `happinessLabel`, `BGS_SOURCES`, `BgsSource`, `BGS_SOURCE_LABEL`, `normalizeSource`, `cleanName`, `id64FromAny`, `coordinate`, `observationTime`, `BgsSnapshotFaction`, `BgsSnapshot`, `snapshotToRpcRow`, `normalizeInfluence`, `normalizeStateList`, `BgsLayerTuple`, `BgsLayerMeta`, `EMPTY_BGS_META`, `BgsLayerResponse`, `BgsLayerRow`, `encodeBgsLayer`, `BgsSystem`, `BgsLayerData`, `decodeBgsMeta`, `decodeBgsLayer`, `BgsFactionSummary`, `decodeFactionSearch`, `BgsPresenceSystem`, `BgsFactionPresence`, `decodeFactionPresence`, `BgsSystemDetailFaction`, `BgsSystemDetail`, `decodeSystemDetail`, `BgsFilter`, `DEFAULT_BGS_FILTER`, `parseBgsFilter`, `toggleAllegiance`, `soloAllegiance`, `BgsSelectedFaction`, `BGS_MAX_SELECTED`, `BGS_SELECTION_COLORS`, `nextSelectionColor`, `parseBgsSelection`, `filterBgsSystems`, `searchBgsSystems`, `countBgsAllegiances`, `BgsPointEntry`, `BgsPointShape`, `BgsMapPoint`, `BGS_POINT_SIZE`, `buildBgsMapPoints`, `orderBgsPoints`, `BgsOverview`, `bgsOverview`, `formatInfluence`, `formatPopulation`, `formatBgsDate`, `bgsAge`
- `src/lib/bgsDump.ts` — `BgsDumpSkipReason`, `BgsDumpLine`, `trimEdsmPopulatedLine`, `edsmPopulatedRecord`, `parseEdsmPopulatedLine`, `BgsDumpStats`, `BgsDumpCounter`
- `src/lib/bgsJournal.ts` — `BGS_JOURNAL_EVENTS`, `BGS_SYSTEM_FIELDS`, `BGS_FACTION_FIELDS`, `projectBgsEvent`, `BgsJournalReject`, `journalEventToSnapshot`, `BgsSnapshotCollector`
- `src/lib/bgsProgress.ts` — `BGS_SYNC_STAGES`, `BgsStageId`, `BgsStageStatus`, `BgsSyncTrigger`, `BgsSyncPhase`, `BgsLogLevel`, `BgsSyncMode`, `BGS_MODE_STAGES`, `BGS_MODE_LABEL`, `BGS_TRIGGER_LABEL`, `BGS_PHASE_LABEL`, `BGS_LOG_LIMIT`, `BgsStageProgress`, `BgsSyncSummary`, `BgsSyncProgress`, `BgsLogLine`, `BgsPublicProgress`, `bgsStageLabel`, `createBgsProgress`, `bgsStageFraction`, `computeBgsPercent`, `startBgsStage`, `resetBgsStage`, `updateBgsStage`, `finishBgsStage`, `markBgsInterrupted`, `finishBgsProgress`, `pushBgsLog`, `sanitizeBgsProgress`, `sanitizeBgsLog`, `publicBgsProgress`, `formatBgsBytes`, `formatBgsCount`, `formatBgsDuration`, `formatBgsSpeed`
- `src/lib/bgsShards.ts` — `BGS_SHARD_VERSION`, `BGS_SHARD_MANIFEST`, `DEFAULT_BGS_SHARD_SYSTEMS`, `BGS_SPLIT_ABORTED`, `BgsDumpSource`, `sameBgsDumpSource`, `BgsShardEntry`, `BgsShardManifest`, `bgsShardFileName`, `bgsShardManifestPath`, `createBgsShardManifest`, `readBgsShardManifest`, `writeBgsShardManifest`, `clearBgsShards`, `BgsShardsInfo`, `bgsShardsInfo`, `readBgsShardRows`, `BgsSplitProgress`, `SplitBgsArchiveOptions`, `splitBgsArchive`
- `src/lib/bgsStore.ts` — `resetBgsLayerCache`, `BgsLayerResult`, `loadBgsLayer`, `searchBgsFactions`, `readBgsPresence`, `findBgsSystemIdByName`, `readBgsSystem`, `PilotApplyResult`, `applyPilotSnapshots`
- `src/lib/bgsSync.ts` — `DEFAULT_BGS_DUMP_URL`, `BGS_ARCHIVE_FILE`, `BGS_MIN_SYSTEMS`, `BGS_SHRINK_GUARD`, `BGS_KEEP_DAYS`, `BGS_DEFAULT_REFRESH_DAYS`, `BGS_DEFAULT_SEGMENTS`, `BGS_DEFAULT_STALL_SECONDS`, `BGS_ARCHIVE_SOURCE_NAME`, `BGS_MAX_SEGMENTS`, `BGS_DEFAULT_PIECE_MB`, `BGS_SCHEDULE`, `BGS_CANCEL_MESSAGE`, `bgsDumpUrl`, `bgsArchiveDir`, `bgsArchivePath`, `bgsShardsDirFor`, `bgsShardsDir`, `bgsArchiveKeep`, `bgsMinSystems`, `bgsRefreshDays`, `clampBgsSegments`, `bgsDownloadSegments`, `bgsPieceBytes`, `bgsStallMs`, `bgsShortRequests`, `bgsFreshConnections`, `bgsShardSystems`, `BgsSyncState`, `readBgsSyncState`, `BgsArchiveInfo`, `bgsArchiveInfo`, `adoptManualBgsArchive`, `bgsShardsStatus`, `BgsRunSnapshot`, `isBgsSyncRunning`, `bgsLayerGeneration`, `bgsJournalGeneration`, `bumpBgsJournalGeneration`, `getBgsLiveRun`, `getBgsLastRun`, `resetBgsSyncRuntime`, `cancelBgsSync`, `BgsSyncOptions`, `BgsSyncResult`, `runBgsSync`, `startBgsSync`, `bgsEdsmFetch`, `cleanupBgsArchive`, `BgsTableSummary`, `readBgsSummary`, `nextBgsScheduledRun`, `bgsSyncInterrupted`, `BgsScheduleDecision`, `decideBgsScheduledSync`
- `src/lib/bgsUpload.ts` — `BGS_UPLOAD_CHUNK_BYTES`, `BGS_UPLOAD_MAX_BYTES`, `BgsUploadInfo`, `BgsUploadResult`, `bgsUploadFile`, `bgsUploadInfo`, `startBgsUpload`, `appendBgsUpload`, `finishBgsUpload`, `cancelBgsUpload`
- `src/lib/bgsWriter.ts` — `BgsWriterBackend`, `BGS_BATCH_SIZE`, `BGS_PG_BATCH_SIZE`, `BgsApplyResult`, `BgsDbWriter`, `BgsPgClient`, `bgsBatchSize`, `bgsDirectDb`, `describeBgsWriter`, `isStatementTimeout`, `isWriteConflict`, `recountAllFactions`, `createPostgrestBgsWriter`, `createPgBgsWriter`, `CreateBgsWriterOptions`, `createBgsWriter`
- `src/lib/billing/auth.ts` — `BILLING_VIEW_ROLES`, `BILLING_MANAGE_ROLES`, `BillingActor`, `billingActor`, `forbidden`, `requireUser`, `requireStaff`, `requireAdmin`, `errorResponse`
- `src/lib/billing/catalogSeed.ts` — `INITIAL_PLANS`, `INITIAL_SHOP_ITEMS`
- `src/lib/billing/profiles.ts` — `ResolvedProfile`, `resolveProfile`, `searchProfiles`
- `src/lib/billing/providers.ts` — `CreatePaymentInput`, `CreatePaymentResult`, `WebhookResult`, `ProviderDriver`, `SECRET_MASK`, `webhookUrlFor`, `PROVIDER_DRIVERS`, `getDriver`, `maskConfig`, `mergeConfig`
- `src/lib/billing/shopAccess.ts` — `SHOP_SUBSCRIPTION_REQUIRED`, `hasPremiumShopAccess`, `requirePremiumShopAccess`
- `src/lib/billing/storage.ts` — `Row`, `ListOptions`, `TableAdapter`, `TABLE_PK`, `hasSupabaseServiceConfig`, `getBillingAdapter`, `resetBillingAdapter`
- `src/lib/billing/subscriptionBonus.ts` — `SubscriptionBonus`, `DEFAULT_BONUS`, `getPlanBonus`, `getUserSubscriptionBonus`, `getAtlasFavoritesLimit`, `getSquadronMemberLimit`, `hasShipPhotoGalleryPerk`, `userHasShipPhotoGallery`, `computeTopupBonus`, `computeDeliveryTonnageBonus`
- `src/lib/billing/tbank.ts` — `tbankToken`, `rubToKopecks`, `tbank`
- `src/lib/billingData.ts` — `DEFAULT_CREDIT_PACKS`, `DEFAULT_SETTINGS`, `PurchaseResult`, `SubscribeResult`, `PublicCosmeticItem`, `PublicCosmetics`, `slugify`, `billingRepo`
- `src/lib/bodySignals.ts` — `SignalKind`, `SIGNAL_KINDS`, `BodySignals`, `EMPTY_SIGNALS`, `SIGNAL_META`, `classifySignal`, `mergeSignals`, `signalsFromList`, `signalsFromRecord`, `totalSignals`, `hasSignals`, `activeSignalKinds`, `describeSignals`, `signalsToColumns`
- `src/lib/capi/client.ts` — `CAPI_BASE`, `CAPI_LEGACY_BASE`, `capiUserAgent`, `CapiErrorKind`, `NO_ENTITLEMENT_HINT`, `CapiError`, `isUnauthorizedError`, `needsCapiRelink`, `describeCapiError`, `CapiClient`
- `src/lib/capi/entitlement.ts` — `NO_ENTITLEMENT_MESSAGE`, `ENTITLEMENT_RECOVERY_HINT`, `isNoEntitlementResponse`, `assessCapiEntitlement`
- `src/lib/capi/failure.ts` — `CapiFailure`, `diagnoseCapiFailure`
- `src/lib/capi/fleetCarrier.ts` — `decodeVanityName`, `parseFleetCarrier`, `getCarrierMarketSummary`
- `src/lib/capi/journal.ts` — `parseCapiJournal`, `journalPath`
- `src/lib/capi/linkState.ts` — `CAPI_STATE_COOKIE`, `CAPI_PKCE_COOKIE`, `CAPI_LINK_COOKIE`, `CAPI_PLATFORM_COOKIE`, `CAPI_FLOW_TTL_SECONDS`, `parseCookies`, `readCookie`, `safeEqual`, `linkStateSecret`, `createOauthState`, `signLinkState`, `verifyLinkState`, `CapiLinkStatus`, `CapiLinkReason`, `CapiRedirectOptions`, `buildCapiRedirect`
- `src/lib/capi/locationSync.ts` — `syncMemberLocation`
- `src/lib/capi/messages.ts` — `CapiReasonText`, `REASONS`, `CAPI_REASON_KEYS`, `capiReasonKeys`, `CAPI_JOURNAL_KEYS`, `capiJournalKey`, `capiReasonText`
- `src/lib/capi/networkProbe.ts` — `CapiHostProbe`, `probeCapiNetwork`
- `src/lib/capi/oauth.ts` — `FRONTIER_DECODE_URL`, `FRONTIER_ME_URL`, `FRONTIER_APP_CLIENT_ID`, `FRONTIER_PUBLIC_CLIENT_ID`, `frontierClientId`, `frontierClientSecret`, `isPkceConfigured`, `FRONTIER_CALLBACK_PATH`, `frontierRedirectUri`, `createCodeVerifier`, `createCodeChallenge`, `PkcePair`, `createPkcePair`, `AuthUrlOptions`, `buildAuthUrl`, `TokenResponse`, `FrontierAuthError`, `ExchangeCodeOptions`, `exchangeCode`, `refreshAccessToken`, `decodeFrontierToken`, `isTokenExpiredStatus`, `FrontierIdentity`, `parseFrontierIdentity`, `fetchFrontierIdentity`
- `src/lib/capi/persist.ts` — `PostgrestLikeError`, `missingColumnFromError`, `ResilientTable`, `ResilientClient`, `WriteOutcome`, `upsertResilient`, `updateResilient`, `schemaWarning`
- `src/lib/capi/platform.ts` — `FRONTIER_AUDIENCES`, `FrontierAudience`, `DEFAULT_AUDIENCE`, `normalizePlatform`, `normalizeAudience`, `platformSelection`
- `src/lib/capi/profile.ts` — `normalizeShips`, `normalizeCapiProfile`, `isBlankProfile`, `capiProfileRow`, `pilotStatsRow`
- `src/lib/capi/profileBinding.ts` — `ProfileBindingStatus`, `ProfileBinding`, `normalizePilotName`, `assessProfileBinding`
- `src/lib/capi/session.ts` — `CapiTokenRow`, `RefreshFn`, `CapiSession`, `capiSession`
- `src/lib/capi/syncJobs.ts` — `CAPI_SYNC_JOB_FIELDS`, `findActiveCapiSyncJob`, `enqueueCapiSyncJob`, `safeCapiDiagnostic`, `publicCapiSyncResult`
- `src/lib/capi/syncPilot.ts` — `JournalStatus`, `CapiSyncResult`, `SyncOptions`, `syncCapiPilot`, `markCapiTokenBroken`
- `src/lib/cargoScope.ts` — `DeliveryKind`, `DELIVERY_KINDS`, `CONSTRUCTION_KINDS`, `DELIVERY_KIND_LABELS`, `DELIVERY_KIND_HINTS`, `StationKind`, `StationSignature`, `StationContext`, `CONSTRUCTION_NAME_PREFIXES`, `COLONISATION_SHIP_NAMES`, `CONSTRUCTION_STATION_SERVICE`, `isConstructionStationName`, `isColonisationShipStation`, `classifyStation`, `isConstructionStationKind`, `constructionKindForStation`, `deliveryKindForStation`, `normalizeDeliveryKind`, `isConstructionKindValue`
- `src/lib/carrierCard.ts` — `CARRIER_CARD_WINDOW_DAYS`, `CARRIER_CARD_JUMPS_LIMIT`, `CARRIER_CARD_DAILY_BUCKETS`, `CARRIER_CARD_MONTHLY_BUCKETS`, `CARRIER_CARD_TOP_DESTINATIONS`, `CarrierCardJump`, `CarrierCardBucket`, `CarrierCardDestination`, `CarrierCardStats`, `CarrierCardService`, `carrierCardId`, `carrierCardHref`, `carrierCardSince`, `carrierCardJumpFromRow`, `orderCarrierCardJumps`, `carrierCardBuckets`, `carrierCardBucketIndex`, `carrierCardStats`, `carrierCardServices`, `carrierCardServiceSummary`, `carrierCardTitle`, `carrierCardClock`
- `src/lib/carrierCardStore.ts` — `CarrierCardLocation`, `CarrierCardJumpOrder`, `CarrierCardOwner`, `CarrierCardSquadron`, `CarrierCardView`, `LoadCarrierCardOptions`, `loadCarrierCard`
- `src/lib/carrierCatalog.ts` — `CARRIER_CATALOG_PAGE_SIZE`, `CARRIER_CATALOG_MAX_PAGE_SIZE`, `CARRIER_CATALOG_SEARCH_MAX`, `CARRIER_CATALOG_FIRST_PAGE`, `CarrierCatalogSort`, `CarrierCatalogOrigin`, `CarrierCatalogScope`, `CarrierCatalogJump`, `CarrierCatalogState`, `CarrierCatalogPosition`, `CarrierCatalogJumpOrder`, `CarrierCatalogRow`, `CARRIER_CATALOG_DEFAULT_STATE`, `catalogIso`, `normalizeCatalogSearch`, `catalogPageNumber`, `catalogOrigin`, `catalogScope`, `catalogJumpFilter`, `catalogSort`, `catalogPageCount`, `catalogClampPage`, `catalogPageWindow`, `parseCatalogState`, `catalogQueryString`, `catalogHref`, `catalogApiHref`, `catalogJumpState`, `catalogRowFromRow`, `catalogPageRange`
- `src/lib/carrierCatalogStore.ts` — `CarrierCatalogRequest`, `CarrierCatalogPage`, `loadCarrierCatalogPage`
- `src/lib/carrierDirectory.ts` — `CARRIER_NOTE_MAX`, `CARRIER_SEARCH_LIMIT`, `CARRIER_SEARCH_MAX`, `CARRIER_QUERY_MIN`, `CARRIER_WATCH_LIMIT`, `CarrierWatchScope`, `CarrierWatch`, `CarrierDirectoryEntry`, `normalizeCarrierQuery`, `carrierQueryTokens`, `carrierMatchesQuery`, `watchFor`, `isFavoriteCarrier`, `mergeCarrierWatches`, `CarrierWatchInput`, `CarrierWatchNormalized`, `normalizeCarrierWatch`, `orderCarrierDirectory`, `countFavorites`, `carrierLabel`, `CARRIER_WATCH_LOCAL_KEY`, `readLocalCarrierWatches`, `writeLocalCarrierWatches`, `localCarrierWatch`
- `src/lib/carrierJumpHistory.ts` — `HistoryPeriod`, `HISTORY_PERIODS`, `HistoryGranularity`, `JumpHistorySource`, `HISTORY_GRANULARITY`, `HISTORY_BUCKET_COUNT`, `HISTORY_ROWS_LIMIT`, `HISTORY_SEARCH_SCAN`, `parseHistoryPeriod`, `historyGranularity`, `historyBuckets`, `historySince`, `historyBucketIndex`, `CarrierJumpRecord`, `HistorySummary`, `EMPTY_HISTORY_SUMMARY`, `jumpRecordFromRow`, `historySummaryFromJson`, `fillHistoryBuckets`, `historyBarHeights`, `HistoryBar`, `historyBars`, `historyBarWidth`, `historyBucketLabel`, `matchesHistoryQuery`, `historyRoute`, `CarrierJumpHistoryResponse`
- `src/lib/carrierJumpHistoryStore.ts` — `HISTORY_COLUMNS`, `HISTORY_TOP_LIMIT`, `LoadJumpHistoryOptions`, `loadCarrierJumpHistory`
- `src/lib/carrierJumpSchedule.ts` — `SCHEDULE_TITLE_MAX`, `SCHEDULE_NOTE_MAX`, `ENTRY_NOTE_MAX`, `SCHEDULE_LIST_LIMIT`, `SCHEDULE_ENTRIES_LIMIT`, `ENTRY_MAX_AHEAD_MS`, `ENTRY_MAX_AGO_MS`, `JumpScheduleVisibility`, `JUMP_SCHEDULE_VISIBILITIES`, `JumpSchedule`, `JumpScheduleEntry`, `ScheduleNormalized`, `EntryNormalized`, `parseVisibility`, `normalizeScheduleTitle`, `normalizeSchedule`, `normalizeScheduleEntry`, `scheduleFromRow`, `entryFromRow`, `entryDay`, `compareEntries`, `groupEntriesByDay`, `CalendarDay`, `CalendarMonth`, `monthKey`, `shiftMonth`, `buildMonthGrid`, `entriesForDay`, `entriesForMonth`, `nextEntryAt`, `isDuplicateEntry`, `entryFromBoardRow`, `scheduleHref`, `matchesScheduleQuery`, `compareSchedules`
- `src/lib/carrierJumpScheduleStore.ts` — `SCHEDULE_COLUMNS`, `ENTRY_COLUMNS`, `ScheduleStats`, `EMPTY_STATS`, `ScheduleFailure`, `scheduleStats`, `listJumpSchedules`, `LoadedSchedule`, `loadJumpSchedule`, `createJumpSchedule`, `updateJumpSchedule`, `deleteJumpSchedule`, `addScheduleEntry`, `deleteScheduleEntry`, `isScheduleFailure`
- `src/lib/carrierJumps.ts` — `JUMP_LOOKBACK_MS`, `JUMP_PLAN_DRIFT_MS`, `JUMP_BOARD_LIMIT`, `JumpPlanState`, `JumpPlanView`, `JumpPlan`, `JumpBoardRow`, `isJumpPending`, `jumpDistanceLy`, `jumpPlanView`, `compareJumpRows`, `JumpBoardOptions`, `buildJumpBoard`, `matchesJumpQuery`, `jumpSnapshot`, `JumpWatchRow`, `buildJumpWatchRows`, `JUMP_ALERT_STORAGE_KEY`, `JUMP_ALERT_MEMORY_LIMIT`, `JumpAlertKind`, `JumpAlertMemory`, `JumpAlert`, `jumpAlertPrint`, `collectJumpAlerts`, `parseJumpAlertMemory`
- `src/lib/carrierMap.ts` — `MapCarrierRelation`, `MapCarrierType`, `MapCarrierSource`, `MapPoint`, `MapCarrierJump`, `CarrierJumpHistoryEntry`, `CARRIER_HISTORY_WINDOW_MS`, `CARRIER_HISTORY_MAX_PER_CARRIER`, `MapCarrier`, `MapDirectoryInfo`, `CarrierLayerStatus`, `MapCarriersResponse`, `MAP_CARRIER_RELATIONS`, `MAP_CARRIER_TYPES`, `MAP_CARRIER_SOURCES`, `CARRIER_RELATION_LABEL`, `CARRIER_RELATION_HINT`, `CARRIER_TYPE_LABEL`, `CARRIER_TYPE_FULL`, `CARRIER_SOURCE_LABEL`, `CARRIER_SOURCE_COLOR`, `carrierSourceOf`, `CarrierTone`, `CARRIER_TONE_COLOR`, `CARRIER_STALE_MS`, `CarrierLayerFilter`, `DEFAULT_CARRIER_FILTER`, `carrierSystemKey`, `isMapPoint`, `filterMapCarriers`, `isDefaultCarrierFilter`, `carrierHistoryShown`, `toggleCarrierHistory`, `toggleCarrierRelation`, `toggleCarrierType`, `toggleCarrierSource`, `CarrierCounts`, `countMapCarriers`, `carrierTitle`, `compareMapCarriers`, `CarrierRouteLeg`, `CarrierSystemGroup`, `groupCarriersBySystem`, `isCarrierStale`, `CarrierFade`, `CARRIER_FADE_OPACITY`, `CarrierIconVariant`, `carrierIconVariant`, `carrierTone`, `carrierBadgeText`, `carrierRelativeTime`, `carrierJumpText`, `carrierLocationText`, `carrierCountLabel`, `carrierListLabel`, `carrierGroupForTarget`
- `src/lib/carrierMapStore.ts` — `MAP_DIRECTORY_LIMIT`, `MAP_HISTORY_SCAN`, `resetCarrierMapCache`, `ResolveOptions`, `resolveMapCoordinates`, `LoadMapCarriersOptions`, `loadJumpHistoryRows`, `loadCarrierHistory`, `loadDirectoryRows`, `loadMapCarriers`, `JUMP_ROW_LOOKBACK_MS`, `JUMP_ROWS_LIMIT`, `LoadCarrierJumpsOptions`, `CarrierJumpsResponse`, `loadCarrierJumps`, `CarrierSearchRequest`, `CarrierSearchResult`, `searchMapCarriers`, `loadSystemCarriers`
- `src/lib/carrierMapView.ts` — `SCRAP_AFTER_MS`, `UNBOUND_MAX_AGE_MS`, `DIRECTORY_COLUMNS`, `DIRECTORY_COLUMNS_BASE`, `MAP_CARRIER_COLUMNS`, `MapCarrierContext`, `isMapCarrierRow`, `rowCoordinates`, `coordinateNamesNeeded`, `shapeMapCarrier`, `shapeMapCarriers`, `shapeDirectoryCarrier`, `shapeDirectoryCarriers`, `directoryCoordinateNames`
- `src/lib/carrierRegistry.ts` — `CarrierRegistrySource`, `CarrierRegistryRow`, `CarrierVisitRow`, `CARRIER_NAME_MAX`, `isCarrierCallsign`, `isCarrierMarketId`, `eddnCarrierRow`, `rememberCarrierJump`, `carrierVisitsFromJournal`, `carrierNamesFromJournal`, `normalizeCarrierName`, `CarrierRegistryEntry`, `registryEntryFromRow`, `mergeDirectoryEntry`
- `src/lib/carrierRegistryStore.ts` — `REGISTRY_COLUMNS`, `REGISTRY_STALE_MS`, `applyEddnCarrierMessage`, `applyCarrierRegistryRows`, `applyCarrierSightings`, `searchCarrierRegistry`, `carrierRegistryByIds`, `carriersViewerCanName`, `setCarrierName`
- `src/lib/carrierServices.ts` — `CARRIER_SERVICE_LABELS`, `serviceLabel`, `DOCKING_LABELS`, `dockingLabel`, `carrierServiceActive`, `carrierServiceRole`
- `src/lib/carrierTags.ts` — `normalizeSquadronTag`, `gameSquadronTag`, `looksLikeSquadronCallsign`, `carrierSquadronTag`, `squadronTagConflict`
- `src/lib/carrierWatch.ts` — `WATCH_COLUMNS`, `WATCH_COLUMNS_BASE`, `watchFromRow`, `watchToRow`
- `src/lib/colonisationEvents.ts` — `CompactResource`, `ColonisationSiteRow`, `DepotEventLike`, `SITE_WRITE_BATCH`, `asText`, `asId`, `progressPercent`, `compactResources`, `depotStateFingerprint`, `siteRowFromDepot`, `siteRowFromTelemetry`, `latestDepotEvents`, `DepotSnapshotRow`, `snapshotRowsForChangedSites`, `ColonisationSiteWriteOutcome`, `persistColonisationSites`
- `src/lib/commodities.ts` — `BUILD_COMMODITIES`, `MARKET_COMMODITIES`, `commodityKey`, `resolveCommodity`
- `src/lib/communityGoalAdmin.ts` — `COMMUNITY_GOAL_MODERATION_STATUSES`, `CommunityGoalModerationStatus`, `COMMUNITY_GOAL_EDITABLE_FIELDS`, `CommunityGoalEditableField`, `CommunityGoalOverrides`, `effectiveCommunityGoal`, `isCommunityGoalModerationStatus`
- `src/lib/communityGoalCatalog.ts` — `catalogGoalIsComplete`, `markExpiredCommunityGoalsComplete`, `normalizeCapiCommunityGoals`, `normalizeJournalCommunityGoals`, `upsertCommunityGoalCatalog`, `syncCommunityGoalsFromCapi`, `syncCommunityGoalsFromFrontier`, `syncCommunityGoalsFromJournal`
- `src/lib/communityGoalCommodityLinks.ts` — `CommunityGoalObjectivePart`, `splitCommunityGoalObjective`
- `src/lib/communityGoalReports.ts` — `persistCommunityGoalReports`
- `src/lib/communityGoalStatus.ts` — `CommunityGoalFilter`, `CommunityGoalTiming`, `communityGoalExpiryTime`, `isCommunityGoalExpired`, `isCommunityGoalComplete`, `withCommunityGoalCompletion`, `communityGoalMatchesFilter`
- `src/lib/constructionBlueprints.ts` — `CONSTRUCTION_BLUEPRINTS`, `CONSTRUCTION_COMMODITIES`, `constructionBlueprint`, `constructionCommodities`
- `src/lib/cookieBudget.ts` — `COOKIE_WARN_BYTES`, `COOKIE_RESET_BYTES`, `RESET_MIN_APP_BYTES`, `RESET_MARKER_COOKIE`, `RESET_MARKER_SECONDS`, `LEGACY_COOKIE_NAMES`, `APP_COOKIE_PREFIXES`, `CookieLike`, `cookieHeaderBytes`, `chunkIndexOf`, `isAppCookie`, `appCookieBytes`, `deadCookieNames`, `resetCookieNames`, `ResetDecision`, `shouldResetCookies`
- `src/lib/coordinateResolveHandler.ts` — `coordinateResolvePOST`
- `src/lib/cronAuth.ts` — `isCronAuthorized`, `runCronTask`
- `src/lib/deliveryImport.ts` — `DeliveryImportOutcome`, `DELIVERY_IMPORT_WRITE_BATCH_SIZE`, `persistImportedDeliveries`
- `src/lib/discordOAuth.ts` — `startDiscordOAuth`
- `src/lib/discordWebhook.ts` — `sendDiscordNotification`, `buildHubUpdateEmbed`
- `src/lib/dossierCargo.ts` — `CargoDeliveryRow`, `CargoKindStat`, `CargoSummary`, `amountOf`, `kindOfRow`, `isConstructionRow`, `summarizeCargo`
- `src/lib/dumpArchive.ts` — `ARCHIVE_META_SUFFIX`, `ArchiveMeta`, `archiveMetaPath`, `readArchiveMeta`, `writeArchiveMeta`, `archiveMetaSource`, `fileSize`, `archiveIsComplete`, `removeArchive`, `archiveLeftovers`, `freeBytes`, `DumpArchiveInfo`, `dumpArchiveInfo`, `uploadedDumpEtag`, `readFileHead`, `adoptManualArchive`
- `src/lib/dumpShards.ts` — `SHARD_MANIFEST_VERSION`, `SHARD_MANIFEST`, `DumpSource`, `sameDumpSource`, `cleanDumpSource`, `writeFileAtomic`, `ShardEntry`, `ShardManifest`, `shardFileName`, `shardFilePattern`, `shardManifestPath`, `createShardManifest`, `readShardManifest`, `writeShardManifest`, `clearShards`, `ShardsInfo`, `shardsInfo`, `readShardRows`, `writeShardFile`
- `src/lib/dumpUpload.ts` — `DUMP_UPLOAD_CHUNK_BYTES`, `DumpUploadError`, `DumpUploadInfo`, `DumpUploadResult`, `DumpUploadConfig`, `dumpUploadFile`, `gunzipHeadText`, `inspectEdsmArrayHead`, `createDumpUpload`
- `src/lib/ed3dCanon.ts` — `SAGA`, `SOL`, `COLONIA`, `GALAXY_PLANE_LY`, `GALAXY_RADIUS_LY`, `LANDMARKS`, `eliteToThree`, `eliteToThreeCentered`, `threeToElite`, `loadImage`, `StarParticles`, `particlesFromHeightmap`, `dist3`
- `src/lib/eddn/listener.ts` — `EDDN_DEFAULT_RELAY`, `EDDN_JOURNAL_SCHEMA`, `EddnListenerStatus`, `EddnListenerStats`, `EddnListenerSnapshot`, `EddnListenerOptions`, `parseRelay`, `eddnRelay`, `eddnListenerForbidden`, `EddnSkip`, `eddnObservation`, `decodeEddnFrame`, `getEddnListener`, `isEddnListenerRunning`, `startEddnListener`, `stopEddnListener`, `resetEddnListenerRuntime`, `EddnListenerSettings`, `readEddnSettings`, `setEddnEnabled`, `EddnEnsureResult`, `ensureEddnListener`, `ensureEddnListenerSoon`
- `src/lib/eddn/subscriber.ts` — `wantsEddnPayload`, `startEddnListener`
- `src/lib/eddn/zmtp.ts` — `ZMTP_GREETING_BYTES`, `ZmtpCloseInfo`, `ZmtpSubscribeOptions`, `ZmtpSession`, `zmtpGreeting`, `zmtpFrame`, `zmtpCommand`, `zmtpProperties`, `parseZmtpProperties`, `zmtpSubscribe`
- `src/lib/eddnClient.ts` — `EDDNListenerConfig`, `parseEDDNMessage`, `matchesFilter`, `formatEDDNForDB`
- `src/lib/emailAuth.ts` — `EmailAuthError`, `emailAuthEnabled`, `authJson`, `authError`, `authRequestIp`, `readAuthBody`, `normalizedEmail`, `publicAuthClient`, `requireEmailDelivery`, `EMAIL_SENT_MESSAGE`, `VerifyFailure`, `classifyVerifyFailure`
- `src/lib/engineers/data.ts` — `EngineerBranch`, `Engineer`, `ENGINEERS`, `ENGINEER_BY_ID`, `childrenOf`, `rootsOf`, `depthOf`, `pathTo`, `resolveEngineer`, `lookupNames`
- `src/lib/engineers/i18n.ts` — `EngineerTextField`, `EngineerTexts`, `SKILL_NAMES`, `engineerText`, `engineerSkills`, `engineerSearchText`
- `src/lib/engineers/locales/de.ts` — `de`
- `src/lib/engineers/locales/en.ts` — `en`
- `src/lib/engineers/locales/it.ts` — `it`
- `src/lib/engineers/locales/ja.ts` — `ja`
- `src/lib/engineers/locales/ko.ts` — `ko`
- `src/lib/engineers/locales/zh.ts` — `zh`
- `src/lib/ensureProfile.ts` — `EnsureProfileBody`, `ensureUserProfile`
- `src/lib/fleetCarrierCollector.ts` — `FC_MARKET_MIN`, `FC_MARKET_MAX`, `CARRIER_EVENT_FIELDS`, `isCarrierMarketId`, `CarrierEventCollector`
- `src/lib/fleetCarrierStore.ts` — `ApplyTotals`, `applyCarrierOps`, `ViewerContext`, `viewerContext`, `relationFor`, `buildViews`, `findCarrier`, `findOrCreateCarrier`
- `src/lib/fleetCarriers.ts` — `FC_MARKET_MIN`, `FC_MARKET_MAX`, `JUMP_TRANSIT_MS`, `CARRIER_JOURNAL_EVENTS`, `SQUADRON_PROOF_EVENTS`, `SquadronProofEvent`, `CarrierType`, `CarrierSource`, `CarrierOp`, `NormalizeResult`, `canonicalCommodity`, `isCarrierMarketId`, `looksLikeCallsign`, `carrierDeltaHash`, `normalizeCarrierEvents`, `CarrierMarketItem`, `carrierMarketCargo`, `carrierOpsFromStationReport`, `CarrierRelation`, `CarrierCargoView`, `CarrierView`, `buildCarrierView`, `parseCarrierReference`
- `src/lib/freshFetch.ts` — `FreshFetchOptions`, `createFreshConnectionFetch`, `sharedFreshConnectionFetch`
- `src/lib/frontierCommunityGoals.mjs` — `FRONTIER_PUBLIC_COMMUNITY_GOALS_URL`, `normalizeFrontierPublicCommunityGoals`, `fetchFrontierPublicCommunityGoals`
- `src/lib/galaxyArchiveStore.ts` — `PARTS_SUFFIX`, `RemovedFile`, `CleanupResult`, `archiveKeepAfterImport`, `shardsKeepAlways`, `diskCheckEnabled`, `DiskUsage`, `diskUsage`, `ArchiveOnDisk`, `listArchives`, `pruneArchives`, `pruneShards`, `cleanupBeforeDownload`, `SpaceCheck`, `checkDiskSpace`, `releaseArchiveAfterImport`, `GalaxyStorageStatus`, `getGalaxyStorageStatus`, `cleanupGalaxyStorage`
- `src/lib/galaxyCatalogStatus.ts` — `GalaxyImportPhase`, `GalaxyCatalogImport`, `GalaxyCatalogStatus`, `CatalogNote`, `fetchGalaxyCatalogStatus`, `catalogNote`
- `src/lib/galaxyCopyWriter.ts` — `GALAXY_STAGE_TABLE`, `COPY_CHUNK_ROWS`, `COPY_MERGE_ROWS`, `COPY_MERGE_TIMEOUT_S`, `mergeTimeoutSeconds`, `loadCopyFrom`, `copyValue`, `copyLine`, `stageDdlSql`, `copySql`, `mergeStatements`, `PgCopyWriterOptions`, `createPgCopyWriter`, `supersedes`
- `src/lib/galaxyDumpVariants.ts` — `GalaxyDumpVariant`, `DumpVariantInfo`, `DUMP_VARIANTS`, `DUMP_LADDER`, `DEFAULT_DUMP_BASE_URL`, `DUMP_GENERATION_LAG_MS`, `DUMP_SAFETY_MS`, `isDumpVariant`, `dumpBaseUrl`, `dumpVariantUrl`, `variantFromUrl`, `archiveFileNameForVariant`, `DumpPlanInput`, `DumpPlan`, `planDumpDownload`, `widerVariant`, `variantCoversGap`, `formatGap`
- `src/lib/galaxyImport.ts` — `SPANSH_DUMP_URL`, `galaxyImportUrl`, `DEFAULT_ARCHIVE_DIR`, `ARCHIVE_FILE_NAME`, `galaxyArchiveDir`, `galaxyArchivePath`, `galaxyArchivePathForVariant`, `galaxyImportFile`, `DumpDownloadInfo`, `DumpSourceValidators`, `DumpSourceChanged`, `isDumpSourceChanged`, `dumpSourceMismatch`, `DownloadDumpOptions`, `parseContentRangeTotal`, `verifyGzipFile`, `downloadDumpFile`, `segmentStatePath`, `DumpSegment`, `DumpSegmentPlan`, `MIN_PIECE_BYTES`, `planDumpPieces`, `rechunkDumpSegments`, `contiguousDumpBytes`, `contiguousBytesOnDisk`, `downloadedBytesOnDisk`, `planDumpSegments`, `galaxyDownloadSegments`, `DEFAULT_DOWNLOAD_SEGMENTS`, `SEGMENTED_MIN_BYTES`, `DumpProbe`, `probeDumpSource`, `SegmentedDownloadUnsupported`, `SegmentedDownloadOptions`, `MIN_SHORT_REQUEST_BYTES`, `downloadDumpSegmented`, `SmartDownloadOptions`, `SmartDownloadResult`, `downloadDump`, `GALAXY_TABLE`, `POINTS_UPLOAD_LIMIT`, `POINTS_BUCKET_LIMIT_ASSUMED`, `pointsFileLimit`, `PointCloudPlan`, `planPointCloud`, `readPointsBucketLimit`, `GALAXY_META_TABLE`, `PG_BATCH_SIZE`, `SUPABASE_BATCH_SIZE`, `POINTS_CAPACITY`, `GalaxyImportBackend`, `GalaxyRowWriter`, `pointsSampleSql`, `pgLiteral`, `GALAXY_ROW_COLUMNS`, `galaxyRowSupersedes`, `collapseGalaxyBatch`, `isGalaxyCardinalityViolation`, `isGalaxyUniqueViolation`, `isGalaxyStatementTimeout`, `pgInsertSql`, `pgDeleteConflictsSql`, `writeGalaxyRowsPg`, `GalaxyWriteClient`, `GalaxyDeferredWrite`, `GalaxyDeferredState`, `GalaxyWriteOptions`, `GalaxySupabaseWriteOptions`, `SUPABASE_TIMEOUT_RETRIES`, `GALAXY_MAX_DEFERRED_ROWS`, `GALAXY_MAX_CONSECUTIVE_DEFERRED`, `deferredRowsFailure`, `writeGalaxyRowsSupabase`, `createPgWriter`, `createSupabaseWriter`, `PointCloud`, `readPointsFromPg`, `readPointsFromSupabase`, `GalaxyImportSnapshot`, `GalaxyImportRunOptions`, `GalaxyImportRunResult`, `FinalizePointCloudOptions`, `finalizePointCloud`, `runGalaxyImport`, `formatBytes`, `describeImportBackends`, `PostgrestFallbackReason`, `postgrestWriteWarning`
- `src/lib/galaxyImportJob.ts` — `IMPORT_STATE_KEY`, `GalaxyImportPhase`, `GalaxyImportState`, `EMPTY_IMPORT_STATE`, `ARCHIVE_STATE_KEY`, `GalaxyArchivePhase`, `GalaxyArchiveState`, `EMPTY_ARCHIVE_STATE`, `parseArchiveState`, `archivePercent`, `parseImportState`, `importPercent`, `readImportState`, `getGalaxyArchiveStatus`, `archiveIsFresh`, `startGalaxyDownload`, `cancelGalaxyDownload`, `GalaxyImportPlan`, `planGalaxyImport`, `startGalaxyUnpack`, `cancelGalaxyUnpack`, `GalaxyUnpackStatus`, `getGalaxyUnpackStatus`, `GalaxyImportStatus`, `getGalaxyImportStatus`, `StartGalaxyImportOptions`, `StartGalaxyImportResult`, `CreateWriterOptions`, `createWriterWithFallback`, `GalaxyDbCheck`, `checkGalaxyDbConnection`, `resolvePointsBudget`, `resetPointsBudget`, `GalaxyPointsBuildState`, `getGalaxyPointsBuildState`, `buildGalaxyPointsFromCatalog`, `publishGalaxyPointsFromCache`, `startGalaxyPointsBuild`, `startGalaxyPointsPublish`, `pointsCacheStatus`, `startGalaxyImport`, `cleanupGalaxyDisk`, `cancelGalaxyImport`
- `src/lib/galaxyImportSchedule.ts` — `FRESH_MS`, `MAX_ATTEMPTS`, `STALE_RUNNING_MS`, `ScheduledImportDecision`, `ScheduledImportInput`, `decideScheduledImport`
- `src/lib/galaxyNebulae.ts` — `NebulaKind`, `NebulaShape`, `GalaxyNebula`, `NEBULA_KIND_LABELS`, `GALAXY_NEBULAE`, `MAJOR_NEBULAE`, `nebulaByName`, `nebulaDistanceTo`
- `src/lib/galaxyPointsPick.ts` — `POINT_CELL_MIN_LY`, `POINT_CELL_MAX_LY`, `POINT_CELL_TARGET`, `POINT_CELL_LY`, `cellHash`, `PointGrid`, `choosePointCellSize`, `buildPointGrid`, `findPointCell`, `Ray`, `PickCamera`, `PickResult`, `classBitVisible`, `shaderMaskVisible`, `worldUnitsPerPixel`, `screenDistance`, `pickAlongRay`
- `src/lib/galaxyPointsPublish.ts` — `POINTS_FILE_NAME`, `POINTS_META_SUFFIX`, `PointsTarget`, `PointsPublishResult`, `pointsCacheDir`, `pointsCachePath`, `looksLikePointsFile`, `writePointsCache`, `readPointsCache`, `pointsCacheInfo`, `dropPointsCache`, `storageErrorInfo`, `PointsUploadOptions`, `uploadPointsToStorage`, `publishPointCloud`
- `src/lib/galaxyRegions.ts` — `GalaxyRegion`, `GALAXY_REGIONS`
- `src/lib/galaxyShards.ts` — `SHARD_MANIFEST`, `SHARD_VERSION`, `DEFAULT_ROWS_PER_SHARD`, `shardsDir`, `galaxyImportMode`, `GalaxyShardEntry`, `GalaxyShardManifest`, `encodeShardRow`, `decodeShardRow`, `shardFileName`, `manifestPath`, `readShardManifest`, `writeShardManifest`, `manifestMatchesArchive`, `clearShards`, `createGrowingReadStream`, `UnpackProgress`, `UnpackShardsOptions`, `unpackArchiveToShards`, `ShardImportSnapshot`, `ShardImportOptions`, `ShardImportResult`, `runShardImport`, `ShardStatus`, `getShardStatus`
- `src/lib/galaxySpanshStream.ts` — `SpanshSystemObject`, `GalaxySystemRecord`, `JsonArrayObjectsOptions`, `JsonArrayObjects`, `streamObjects`, `toGalaxySystemRow`
- `src/lib/galaxySystems.ts` — `SAGA_LY`, `StarClass`, `GiantClass`, `StarClassification`, `classifyStar`, `STAR_CLASS_INDEX`, `STAR_CLASS_LIST`, `STAR_CLASS_COLORS`, `STAR_CLASS_LABELS`, `normalizeSystemName`, `distanceFromSols`, `distanceFromSgra`, `POINTS_MAGIC`, `POINTS_VERSION`, `POINTS_HEADER_SIZE`, `POINTS_STORAGE_BUCKET`, `POINTS_STORAGE_OBJECT`, `POINTS_BYTES_PER_POINT`, `POINTS_MAX_DEFAULT`, `POINTS_FILE_BUDGET`, `pointsForBytes`, `bytesForPoints`, `POINTS_MAX_LIMIT`, `galaxyPointsMax`, `pointSampleStride`, `AllSystemsData`, `GalaxySystemPoint`, `PointsBuilder`, `encodePointsFile`, `parsePointsFile`, `toMapPositions`, `id64FromParts`
- `src/lib/galaxySystemsDb.ts` — `GalaxySystemRow`, `GalaxyStats`, `FULL_CATALOG_MIN`, `catalogIsComplete`, `invalidateGalaxyStatsCache`, `getGalaxyStats`, `markPointsUploaded`, `findSystemByName`, `systemById64`, `findSystemsByNames`, `searchSystems`, `findStarCandidates`, `findSystemsInCube`, `rowWorldType`
- `src/lib/helperAuth.ts` — `RequestUser`, `looksLikeApiToken`, `resolveRequestUser`
- `src/lib/helperDevices.ts` — `LINK_CODE_TTL_SECONDS`, `LINK_CODE_LENGTH`, `MAX_SETTINGS_BYTES`, `HelperProfile`, `HelperDevice`, `HelperSettingsSnapshot`, `normalizeLinkCode`, `createLinkCode`, `ClaimResult`, `claimLinkCode`, `DeviceAuth`, `resolveDeviceToken`, `profileForDevice`, `listDevices`, `revokeDevice`, `readSettings`, `writeSettings`
- `src/lib/helperReleaseJobs.ts` — `HelperReleaseInput`, `startHelperReleaseJob`, `getHelperReleaseJob`, `getLatestHelperReleaseJob`, `cancelHelperReleaseJob`
- `src/lib/i18n/I18nContext.tsx` — `TranslationParams`, `I18nProvider`, `useI18n`
- `src/lib/i18n/achievementLabels.ts` — `AchievementTranslate`, `achievementTrackTitle`, `achievementTrackSubtitle`, `achievementRankName`, `achievementRankDesc`, `heroBadgeName`, `heroBadgeDesc`
- `src/lib/i18n/apiT.ts` — `apiTranslate`
- `src/lib/i18n/architectLabels.ts` — `architectLabelTranslations`, `architectLabel`, `architectKindTranslations`
- `src/lib/i18n/bgsLabels.ts` — `ECONOMY_KEYS`, `SECURITY_KEYS`, `HAPPINESS_KEYS`, `BGS_SOURCE_KEYS`, `bgsEconomyText`, `bgsSecurityText`, `bgsHappinessText`, `bgsSourceText`, `formatPopulationText`, `bgsAgeText`
- `src/lib/i18n/carrierCard.ts` — `carrierCardTranslations`
- `src/lib/i18n/carrierCatalog.ts` — `carrierCatalogTranslations`
- `src/lib/i18n/carrierJumps.ts` — `carrierJumpTranslations`
- `src/lib/i18n/commodities.ts` — `commodityTranslations`
- `src/lib/i18n/engineers.ts` — `engineersTranslations`
- `src/lib/i18n/exchangeText.ts` — `exchangeTranslations`, `issueText`
- `src/lib/i18n/format.ts` — `setFormatLocale`, `getFormatLocale`, `formatTranslate`
- `src/lib/i18n/gameLabels.ts` — `TFn`, `ALLEGIANCE_KEYS`, `GOVERNMENT_KEYS`, `STATE_KEYS`, `POWER_ALLEGIANCE_KEYS`, `POWER_STATE_KEYS`, `POWER_STATE_PLURAL_KEYS`, `POWER_STATE_HINT_KEYS`, `POWER_STATE_ZONE_KEYS`, `POWER_BASIS_KEYS`, `gameLabel`
- `src/lib/i18n/nebulaLabels.ts` — `NEBULA_KIND_KEYS`
- `src/lib/i18n/orreryTips.ts` — `orreryTipTranslations`, `discoveredByLabel`
- `src/lib/i18n/outfitting.ts` — `outfittingTranslations`
- `src/lib/i18n/outfittingAnalysis.ts` — `outfittingAnalysisTranslations`
- `src/lib/i18n/outfittingSpecials.ts` — `outfittingSpecialsTranslations`
- `src/lib/i18n/planMessages.ts` — `planMessageTranslations`
- `src/lib/i18n/planText.ts` — `PlanTranslate`, `issueText`, `primaryNoteText`, `economyMarketText`, `placementNoteText`, `placementCheckTexts`, `economyFitText`, `bodyTraitLabel`
- `src/lib/i18n/server.ts` — `normalizeServerLocale`, `ServerT`, `getServerI18n`
- `src/lib/i18n/translations.ts` — `translations`, `SUPPORTED_LOCALES`, `LOCALE_NAMES`, `LOCALE_FLAGS`
- `src/lib/i18n/types.ts` — `Locale`, `TranslationKey`
- `src/lib/imageLimits.ts` — `AVATAR_MAX_BYTES`, `SQUADRON_IMAGE_LIMITS`
- `src/lib/imageStorage.ts` — `errorText`, `uploadImageToStorage`
- `src/lib/importProgress.ts` — `ImportStageStatus`, `ImportPhase`, `ImportLogLevel`, `ArchiveImportMode`, `ArchiveImportStageId`, `ARCHIVE_IMPORT_MODE_STAGES`, `ARCHIVE_IMPORT_MODE_LABEL`, `IMPORT_PHASE_LABEL`, `IMPORT_INTERRUPTED_MESSAGE`, `ImportStageDef`, `ImportStageProgress`, `ImportProgress`, `ImportLogLine`, `ImportPublicProgress`, `ImportProgressConfig`, `importStageFraction`, `createImportProgressKit`, `formatImportBytes`, `formatImportCount`, `formatImportDuration`, `formatImportSpeed`
- `src/lib/importRetry.ts` — `ChunkResponse`, `ChunkedUploadOutcome`, `ChunkedUploadOptions`, `sendInChunks`
- `src/lib/inara/client.ts` — `INARA_APP_NAME`, `INARA_APP_VERSION`, `InaraClient`
- `src/lib/inara/community-goals.mjs` — `communityGoalIdentityKey`, `normalizeCommunityGoal`, `normalizeCommunityGoals`
- `src/lib/journalIngest.ts` — `JournalResetError`, `JournalBatchInput`, `JournalBatchOutcome`, `wantsJournalReset`, `ingestJournalBatch`, `projectSyncSummary`
- `src/lib/journalParser.ts` — `DeliverySource`, `CONSTRUCTION_SOURCES`, `isConstructionSourceName`, `Delivery`, `JournalParseStats`, `ParseResult`, `SystemLookup`, `JournalParseState`, `createJournalParseState`, `emptyKindRecord`, `JournalEventHook`, `parseJournal`, `ParsedColonisationDepot`, `ParsedColonisationContribution`, `ParsedCommunityGoalReport`, `parseColonisationEvents`
- `src/lib/journalReset.ts` — `JournalResetOutcome`, `resetJournalData`
- `src/lib/journalTelemetry.ts` — `PilotStatsSource`, `PersistTelemetryOptions`, `ConstructionResourceRow`, `ConstructionSnapshotEvent`, `SystemScanRow`, `PilotStats`, `MERCENARY_COINS_LIMIT`, `isPlausibleMercenaryCoins`, `JournalTelemetryStats`, `JournalTelemetry`, `TelemetryState`, `createTelemetryState`, `TelemetryCollector`, `parseJournalTelemetry`, `JournalTelemetryPayload`, `JournalTelemetryOutcome`, `persistJournalTelemetry`
- `src/lib/launcherChunkUpload.ts` — `uploadLauncherInChunks`
- `src/lib/launcherUploadProtocol.ts` — `LAUNCHER_UPLOAD_CHUNK_BYTES`, `MIN_LAUNCHER_UPLOAD_CHUNK_BYTES`, `MAX_LAUNCHER_UPLOAD_BYTES`, `MAX_SETUP_UPLOAD_BYTES`
- `src/lib/launcherUploadSessions.ts` — `UploadKind`, `LauncherUploadSession`, `LauncherUploadError`, `createLauncherUpload`, `getLauncherUploadSession`, `writeLauncherUploadChunk`, `acquireLauncherUploadFinalizeLock`, `releaseLauncherUploadFinalizeLock`, `assembleLauncherUpload`, `markLauncherUploadCompleted`, `cancelLauncherUpload`
- `src/lib/localizedContent.ts` — `DEFAULT_CONTENT_LOCALE`, `safeContentLocale`, `localizedValue`, `missingTranslationLangs`
- `src/lib/maintenance.ts` — `readMaintenanceState`, `beginMaintenance`, `endMaintenance`, `readBackupRecord`, `writeBackupRecord`, `stopBackupWatcher`, `watchBackupJob`, `reconcileMaintenance`
- `src/lib/maintenanceEdge.ts` — `readMaintenanceCached`, `resetMaintenanceCache`
- `src/lib/maintenanceFlag.ts` — `MAINTENANCE_KEY`, `DB_BACKUP_KEY`, `MAINTENANCE_REFRESH_MS`, `MAINTENANCE_MAX_MS`, `BACKUP_DUE_AFTER_MS`, `MaintenanceState`, `BackupRecord`, `parseMaintenanceState`, `maintenanceValue`, `MAINTENANCE_EXEMPT_PREFIXES`, `MAINTENANCE_EXEMPT_FILES`, `isMaintenanceExemptPath`, `backupDue`, `parseBackupRecord`, `mergeBackupRecord`, `formatBytes`
- `src/lib/mapLayerDefaults.ts` — `MapStatus`, `mapSystemStatus`, `MapLayerDefaults`, `ATLAS_LAYER_DEFAULTS`, `RING_MAP_LAYER_DEFAULTS`, `mapLayerDefaults`, `lastBuildTarget`
- `src/lib/markdown.tsx` — `MarkdownRenderer`
- `src/lib/marketDiscovery.ts` — `resolveRefCoords`, `discoverMarketSystems`
- `src/lib/marketUpstream.ts` — `marketUpstream`, `marketError`
- `src/lib/nebulaClouds.ts` — `EMISSIVE_OPACITY`, `EMISSIVE_ADDITIVE`, `DARK_OPACITY`, `PUFF_SIZE_MIN`, `PUFF_SIZE_MAX`, `PUFF_SIZE_TARGET`, `PUFF_SIZE_JITTER`, `DETAIL_CHANCE`, `DETAIL_SIZE`, `DETAIL_WEIGHT`, `STRUCTURE_SCALE`, `STRUCTURE_MIN`, `STRUCTURE_SPAN`, `STRUCTURE_HOLE`, `MAX_PUFFS`, `PUFFS_PER_LY`, `HALO_MIN_SIZE`, `HALO_ALPHA_SCALE`, `TONE_SATURATION`, `TONE_LIGHT_LIFT`, `TONE_WHITE_MIX`, `TONE_WHITE`, `DOME_WHITE_MIX`, `ATLAS_TILE`, `ALPHA_MIN`, `ALPHA_MAX`, `ATLAS_PEAK`, `PUFF_FALLOFF`, `SCREEN_MIN_PIXELS`, `SCREEN_FADE_CURVE`, `SCREEN_FADE_FLOOR`, `TARGET_PEAK`, `CORE_WEIGHT`, `Vec3`, `PuffBucket`, `emptyPuffBucket`, `alphaScaleFor`, `puffCountFor`, `hashString`, `mulberry32`, `makeValueNoise`, `mixWhite`, `gameToneRgb`, `shiftRgb`, `buildPuffAtlasData`, `buildNebulaPuffs`, `buildNebulaBuckets`
- `src/lib/notify.ts` — `NotificationInput`, `NotifyResult`, `notifyUsers`
- `src/lib/oauthFlow.ts` — `OAUTH_FLOW_COOKIE`, `OAUTH_FLOW_TTL`, `OAuthFlow`, `createOAuthFlow`, `readOAuthFlow`
- `src/lib/oauthProviders.ts` — `OAUTH_PROVIDERS`, `OAuthProvider`, `OAuthMode`, `isOAuthProvider`, `enabledOAuthProviders`, `oauthErrorMessage`, `canUnlinkOAuthIdentity`
- `src/lib/orrery3d/camera.ts` — `ViewPreset`, `ZoomLevel`, `CameraFrame`, `CAMERA_DIRECTIONS`, `CAMERA_FOV_DEG`, `toThree`, `fromThree`, `fitDistance`, `frameFor`, `cameraPosition`, `cameraUp`, `easeInOutCubic`, `shouldReframeCamera`, `CameraState`, `cameraStateFor`, `interpolateCamera`, `ZOOM_LABELS`
- `src/lib/orrery3d/index.ts`
- `src/lib/orrery3d/motion.ts` — `OrbitBasis`, `orbitBasis`, `angleInBasis`, `pointAtAngle`, `orbitPhase`, `positionAtTime`, `positionDelta`, `keplerTrueAnomaly`, `orbitalDeltas`, `MOTION_SPEEDS`
- `src/lib/orrery3d/palette.ts` — `BODY_CLASS_COLORS`, `BODY_FALLBACK_COLOR`, `STAR_SPECTRAL_COLORS`, `STAR_FALLBACK_COLOR`, `RING_CLASS_COLORS`, `STRUCTURE_COLORS`, `SCENE_COLORS`, `clampChannel`, `starColor`, `bodyColor`, `ringColor`, `structureColor`, `orbitColor`, `formatNumber`, `formatTons`, `formatLightSeconds`, `formatPeriod`, `formatRadius`, `formatGravity`, `shortBodyName`
- `src/lib/orrery3d/payload.ts` — `BuildOrreryViewOptions`, `buildOrreryView`, `describeView`, `lsToAu`, `structureTint`, `orbitTint`
- `src/lib/orrery3d/scene.ts` — `LayerName`, `DEFAULT_LAYERS`, `OrrerySceneModel`, `PickInfo`, `buildOrreryScene`, `pickInfoOf`
- `src/lib/orrery3d/types.ts` — `ORRERY_VIEW_VERSION`, `Vec3`, `BodyKindView`, `OrreryViewRing`, `OrreryViewElements`, `HabitableBand`, `OrreryViewBody`, `OrreryViewOrbit`, `OrreryViewZone`, `OrreryViewStructure`, `OrreryViewCluster`, `OrreryViewSignals`, `OrreryViewSummary`, `OrreryViewPlayer`, `OrreryViewPayload`, `emptyOrreryView`
- `src/lib/orrery3d/viewer.ts` — `FilterMode`, `LabelsMode`, `ViewerTranslate`, `OrreryViewerOptions`, `OrreryViewerState`, `OrreryViewer`, `viewerStyles`, `injectViewerStyles`, `bodyTooltipHtml`, `structureTooltipHtml`, `createOrreryViewer`
- `src/lib/outfitting/analysis.ts` — `DamageType`, `DAMAGE_TYPES`, `isWeapon`, `weaponRoF`, `WeaponMetrics`, `weaponMetrics`, `WeaponEntry`, `OffenceSummary`, `offenceSummary`, `ResistanceSet`, `DefenceSummary`, `defenceSummary`, `LoadPoint`, `coreModules`, `profileAt`, `cargoCurve`, `fuelCurve`, `engPipCurve`, `sysPipCurve`, `costBreakdown`, `powerBreakdown`
- `src/lib/outfitting/build.ts` — `defaultBuild`, `strippedBuild`, `encodeBuild`, `decodeBuild`, `blueprintLabel`, `moduleLabel`
- `src/lib/outfitting/calc.ts` — `STANDARD_GROUPS`, `indexModules`, `findModule`, `parseRef`, `moduleRef`, `moduleOf`, `massCurveMultiplier`, `ruleFor`, `RESISTANCES`, `effectiveModule`, `buildSlots`, `modulesForSlot`, `BuildStats`, `DEFAULT_PIPS`, `sysDamageResistance`, `pipEffectiveShield`, `pipAdjustedSpeed`, `pipRechargeRate`, `BuildWarning`, `jumpDistance`, `thrusterMultiplier`, `computeStats`, `computeModuleDelta`, `blueprintsForGroup`
- `src/lib/outfitting/catalog.ts` — `CatalogKind`, `CatalogGroup`, `CatalogValue`, `CatalogAction`, `CatalogChange`, `CatalogHistoryEntry`, `CatalogState`, `CatalogSnapshot`, `CatalogCommand`, `CATALOG_CATEGORIES`, `CATALOG_MOUNTS`, `CatalogMount`, `PROTECTED_GROUPS`, `EMPTY_CATALOG_STATE`, `CatalogError`, `isRecord`, `changeId`, `sourceValue`, `catalogValue`, `mergeCatalog`, `validateCatalogValue`, `parseCatalogCommands`, `groupDeletionReason`, `applyCatalogCommands`, `catalogSnapshot`
- `src/lib/outfitting/catalogAuth.ts` — `requireCatalogAdmin`
- `src/lib/outfitting/catalogStore.ts` — `loadCatalogSource`, `catalogStorage`, `readCatalogState`, `saveCatalogState`
- `src/lib/outfitting/exchange.ts` — `ExchangeFormat`, `ImportIssue`, `ImportResult`, `ExportResult`, `toCoriolisCode`, `coriolisUrl`, `fromCoriolisCode`, `parseCoriolisUrl`, `toSlef`, `fromSlef`, `parseImport`, `nativeUrl`
- `src/lib/outfitting/factory.ts` — `FactoryBlueprint`, `FactoryInfo`, `factoryInfo`, `isFactoryModule`, `canApplyExperimental`
- `src/lib/outfitting/fdnames.ts` — `moduleSymbol`, `ParsedSymbol`, `parseSymbol`, `SHIP_FD_TO_CORIOLIS`, `shipFdName`, `shipCoriolisId`, `bulkheadSymbol`, `bulkheadIndex`
- `src/lib/outfitting/i18n.ts` — `BULKHEAD_NAMES`, `GROUP_NAMES`, `BLUEPRINT_WORDS`, `BLUEPRINT_PREFIX`, `MOUNT_NAMES`, `bulkheadName`, `groupName`, `catalogGroupName`, `blueprintWord`, `blueprintPrefix`, `mountName`
- `src/lib/outfitting/merccoin.ts` — `MercKind`, `MercCoinEntry`, `MERC_COIN_ITEMS`, `mercEntryForRef`, `mercBlueprintsForGroup`, `mercEntryFor`, `mercRefsOf`, `mercCoinCost`, `mercUpgradeCost`
- `src/lib/outfitting/moduleGrades.ts` — `ModuleGrade`, `moduleNameForSymbol`, `moduleSymbolKey`, `moduleGrade`
- `src/lib/outfitting/origins.ts` — `ModuleOrigin`, `ORIGIN_COLORS`, `moduleOrigins`, `originColor`, `originLabelKey`
- `src/lib/outfitting/shipImages.ts` — `CapiShipType`, `CAPI_SHIP_TYPE_TO_OUTFITTING_ID`, `capiShipTypeToOutfittingId`, `shipImageUrlFromStorage`
- `src/lib/outfitting/specials.ts` — `SpecialFeature`, `specialFeatures`, `specialsForGroup`
- `src/lib/outfitting/specs.ts` — `SpecSection`, `SpecDef`, `MODULE_SPECS`, `specFor`, `specName`, `SpecValue`, `moduleSpecValues`
- `src/lib/outfitting/symbols.ts` — `SymbolMatch`, `normalizeSymbol`, `symbolIndex`, `modulesBySymbol`, `moduleBySymbol`
- `src/lib/outfitting/types.ts` — `ModuleValue`, `PreEngineered`, `OutfittingModule`, `Bulkhead`, `InternalSlot`, `ShipProperties`, `OutfittingShip`, `BlueprintGrade`, `Blueprint`, `SpecialEffect`, `ModificationRule`, `ModuleBlueprintIndex`, `OutfittingData`, `SlotModification`, `ShipBuild`, `BuildSlot`, `PipState`, `ModuleComparisonDelta`
- `src/lib/outfitting/useOutfittingData.ts` — `publishOutfittingData`, `loadOutfittingData`, `useOutfittingData`
- `src/lib/passwordPolicy.ts` — `MIN_PASSWORD_LENGTH`, `passwordError`
- `src/lib/passwordRecovery.ts` — `RECOVERY_COOKIE`, `RECOVERY_TTL`, `sessionId`, `createRecoveryGrant`, `readRecoveryGrant`
- `src/lib/pgModule.ts` — `PgQueryResult`, `PgQueryEvents`, `PgClientLike`, `PgPoolLike`, `PgClientConfig`, `PgModule`, `galaxyDbUrl`, `loadPg`, `PgConnectionFailureKind`, `PgConnectionFailure`, `PG_CONNECT_BACKOFF_MS`, `pgConnectionTarget`, `describePgConnectionError`, `PgConnectionError`, `isPgConnectionError`, `PgConnectRetryOptions`, `connectWithRetries`, `ConnectPgClientOptions`, `connectPgClient`
- `src/lib/pgReachability.ts` — `PgReachabilityKind`, `PgReachability`, `isPrivateAddress`, `reachabilityMessage`, `probePgReachability`
- `src/lib/pilotDossier.ts` — `DossierStatsInput`, `MergedPilotStats`, `mergePilotStats`
- `src/lib/powerplay.ts` — `POWERPLAY_STATES`, `PowerplayState`, `POWERPLAY_STATE_LABEL`, `POWERPLAY_STATE_PLURAL`, `POWERPLAY_STATE_HINT`, `POWERPLAY_STATE_ZONE`, `POWERPLAY_STATE_RANGE_LY`, `powerplayStateRank`, `PowerAllegiance`, `POWER_ALLEGIANCE_LABEL`, `PowerInfo`, `POWERPLAY_POWERS`, `POWERPLAY_ACTIVE_POWERS`, `powerKey`, `normalizePowerName`, `normalizePowerplayState`, `POWERPLAY_BASES`, `PowerplayBasis`, `POWERPLAY_BASIS_LABEL`, `POWERPLAY_BASIS_SHORT`, `normalizePowerplayBasis`, `POWERPLAY_UNKNOWN_POWER`, `POWERPLAY_UNKNOWN_INFO`, `isUnknownPower`, `powerInfo`, `powerColor`, `powerLabel`, `hexToRgbUnit`, `PowerplaySystemTuple`, `PowerplayLayerStatus`, `PowerplayLayerMeta`, `PowerplayLayerResponse`, `PowerplaySystem`, `PowerplayLayerData`, `PowerplayRow`, `encodePowerplayLayer`, `EMPTY_POWERPLAY_META`, `decodePowerplayLayer`, `PowerplayFilter`, `DEFAULT_POWERPLAY_FILTER`, `isDefaultPowerplayFilter`, `isPowerVisible`, `togglePowerVisible`, `soloPower`, `showAllPowers`, `hideAllPowers`, `soloAllegiance`, `isAllegianceSolo`, `powerplayFilterPowers`, `togglePowerplayState`, `parsePowerplayFilter`, `filterPowerplaySystems`, `PowerplayPowerCount`, `PowerplayCounts`, `countPowerplay`, `powerplayBasisText`, `orderPowerplaySystems`, `searchPowerplaySystems`, `findPowerplaySystem`, `PowerplayPoint`, `distanceLy`, `PowerplayInfluence`, `powerplayInfluenceAt`, `PowerplayOverview`, `powerplayOverview`, `formatLy`, `formatPowerplayDate`, `powerplayAge`
- `src/lib/powerplayDump.ts` — `POWERPLAY_PARSER_VERSION`, `PowerplayDumpRecord`, `PowerplayDumpRow`, `PowerplaySkipReason`, `PowerplayDumpStats`, `PowerplayDumpResult`, `edsmDateToIso`, `edsmRecordToRow`, `parseEdsmPowerplayDump`
- `src/lib/powerplayJournal.ts` — `POWERPLAY_JOURNAL_FIELDS`, `POWERPLAY2_START_MS`, `PowerplayObservedState`, `PowerplayObservation`, `PowerplayJournalReject`, `hasPowerplayFields`, `journalEventToPowerplay`, `powerplayObservationToRpcRow`, `latestPowerplayObservations`
- `src/lib/powerplayProgress.ts` — `POWERPLAY_SYNC_STAGES`, `PowerplayStageId`, `PowerplayStageStatus`, `PowerplaySyncTrigger`, `PowerplaySyncPhase`, `PowerplayLogLevel`, `PowerplaySyncMode`, `POWERPLAY_MODE_STAGES`, `POWERPLAY_MODE_LABEL`, `POWERPLAY_TRIGGER_LABEL`, `POWERPLAY_PHASE_LABEL`, `POWERPLAY_LOG_LIMIT`, `PowerplayStageProgress`, `PowerplaySyncSummary`, `PowerplaySyncProgress`, `PowerplayLogLine`, `PowerplayPublicProgress`, `powerplayStageLabel`, `createPowerplayProgress`, `powerplayStageFraction`, `computePowerplayPercent`, `startPowerplayStage`, `resetPowerplayStage`, `updatePowerplayStage`, `finishPowerplayStage`, `markPowerplayInterrupted`, `finishPowerplayProgress`, `pushPowerplayLog`, `sanitizePowerplayProgress`, `sanitizePowerplayLog`, `publicPowerplayProgress`, `sanitizePublicPowerplayProgress`, `formatPowerplayBytes`, `formatPowerplayCount`, `formatPowerplayDuration`, `formatPowerplaySpeed`
- `src/lib/powerplayShards.ts` — `POWERPLAY_SHARD_PREFIX`, `DEFAULT_POWERPLAY_SHARD_SYSTEMS`, `POWERPLAY_MAX_ARCHIVE_BYTES`, `POWERPLAY_MAX_TEXT_BYTES`, `POWERPLAY_SPLIT_ABORTED`, `PowerplayShardManifest`, `PowerplayShardsInfo`, `powerplayShardFileName`, `createPowerplayShardManifest`, `readPowerplayShardManifest`, `writePowerplayShardManifest`, `clearPowerplayShards`, `powerplayShardsInfo`, `decodePowerplayDump`, `powerplayRowToDb`, `PowerplaySplitProgress`, `SplitPowerplayArchiveOptions`, `splitPowerplayArchive`
- `src/lib/powerplayStore.ts` — `resetPowerplayLayerCache`, `rowsFromRpc`, `PowerplayLayerResult`, `loadPowerplayLayer`, `PilotPowerplayResult`, `EMPTY_PILOT_POWERPLAY`, `applyPilotPowerplay`
- `src/lib/powerplaySync.ts` — `DEFAULT_POWERPLAY_DUMP_URL`, `POWERPLAY_ARCHIVE_FILE`, `POWERPLAY_ARCHIVE_SOURCE_NAME`, `POWERPLAY_MIN_ROWS`, `POWERPLAY_SHRINK_GUARD`, `POWERPLAY_DEFAULT_SEGMENTS`, `POWERPLAY_MAX_SEGMENTS`, `POWERPLAY_DEFAULT_PIECE_KB`, `POWERPLAY_DEFAULT_STALL_SECONDS`, `POWERPLAY_STALE_AFTER_MS`, `POWERPLAY_RETRY_AFTER_MS`, `POWERPLAY_SCHEDULE`, `POWERPLAY_CANCEL_MESSAGE`, `powerplayDumpUrl`, `powerplayArchiveDir`, `powerplayArchivePath`, `powerplayShardsDirFor`, `powerplayShardsDir`, `powerplayArchiveKeep`, `clampPowerplaySegments`, `powerplayDownloadSegments`, `powerplayPieceBytes`, `powerplayStallMs`, `powerplayShortRequests`, `powerplayFreshConnections`, `powerplayMinRows`, `powerplayShardSystems`, `powerplayEdsmFetch`, `PowerplaySyncState`, `PowerplaySyncResult`, `PowerplaySyncOptions`, `readPowerplaySyncState`, `powerplayParserCurrent`, `PowerplayArchiveInfo`, `powerplayArchiveInfo`, `powerplayShardsStatus`, `PowerplayRunSnapshot`, `isPowerplaySyncRunning`, `powerplayLayerGeneration`, `powerplayJournalGeneration`, `bumpPowerplayJournalGeneration`, `getPowerplayLiveRun`, `getPowerplayLastRun`, `resetPowerplaySyncRuntime`, `cancelPowerplaySync`, `runPowerplaySync`, `startPowerplaySync`, `cleanupPowerplayArchive`, `PowerplayPowerSummary`, `PowerplayUnknownSummary`, `PowerplayTableSummary`, `readPowerplaySummary`, `nextPowerplayScheduledRun`, `PowerplayFreshness`, `powerplaySyncInterrupted`, `powerplayNeedsRefresh`, `powerplayNextLazyAttempt`, `ensurePowerplayFresh`
- `src/lib/powerplayUpload.ts` — `POWERPLAY_UPLOAD_CHUNK_BYTES`, `POWERPLAY_UPLOAD_MAX_BYTES`, `PowerplayUploadInfo`, `PowerplayUploadResult`, `powerplayUploadFile`, `powerplayUploadInfo`, `startPowerplayUpload`, `appendPowerplayUpload`, `finishPowerplayUpload`, `cancelPowerplayUpload`
- `src/lib/powerplayWriter.ts` — `PowerplayWriterBackend`, `PowerplayPgClient`, `POWERPLAY_BATCH_SIZE`, `PowerplayApplyResult`, `PowerplayDbWriter`, `powerplayBatchSize`, `powerplayDirectDb`, `describePowerplayWriter`, `createPostgrestPowerplayWriter`, `createPgPowerplayWriter`, `CreatePowerplayWriterOptions`, `createPowerplayWriter`
- `src/lib/privacy.ts` — `PrivacyKey`, `PRIVACY_KEYS`, `PrivacySettings`, `DEFAULT_PRIVACY`, `resolvePrivacy`, `privacyForViewer`, `privacyPayload`, `HIDDEN_PLACEHOLDER`, `maskPilotStats`, `maskCapiProfile`
- `src/lib/projects/autoProgress.ts` — `ConstructionResource`, `updateProjectProgress`
- `src/lib/projects/projectSync.ts` — `ProjectSystemChange`, `ProjectSyncResult`, `syncProjectsFromSites`
- `src/lib/pushNotifications.ts` — `sendPushToUser`, `sendPushToUsers`, `sendPushToThreadSubscribers`, `sendPushToProjectMembers`, `sendPushToSquadronMembers`
- `src/lib/rateLimit.ts` — `checkRateLimit`, `checkSyncRateLimit`
- `src/lib/raven/client.ts` — `RavenWriteResult`, `ravenWhoAmI`, `ravenCreateProject`, `ravenLinkCommander`, `buildIdFromResponse`
- `src/lib/raven/keyStore.ts` — `loadRavenKey`
- `src/lib/raven/keyVault.ts` — `encryptRavenKey`, `decryptRavenKey`, `maskRavenKey`
- `src/lib/ravenColonial.ts` — `ravenBase`, `RavenResource`, `RavenCargoTotals`, `RavenProject`, `RavenSystemV2`, `parseRavenProjectResources`, `calculateRavenProjectTotals`, `calculateRavenProjectProgress`, `RavenDepotSnapshot`, `enrichRavenSystemWithDepotSnapshots`, `fetchRavenSystemV2`, `deriveStatusFromProgress`, `RavenSystemEnricher`, `fetchRavenSystemProgress`, `fetchRavenSystem`, `fetchRavenColonialData`
- `src/lib/ravenDepotSnapshots.ts` — `enrichRavenSystemWithJournalSnapshots`
- `src/lib/readAllRows.ts` — `readAllRows`
- `src/lib/referenceSystem.ts` — `ReferencePoint`, `referenceSystemCoords`
- `src/lib/requestUser.ts` — `authFromRequest`
- `src/lib/routeEngine.ts` — `RoutePoint`, `greedyRoute`, `weightedAStarRoute`, `neutronRouteEstimate`
- `src/lib/routeHint.ts` — `RouteHintStatus`, `RouteHintNeed`, `RouteHintConstruction`, `RouteHintCoordinates`, `RouteHintDiscovery`, `RouteHint`, `RouteHintRow`, `shapeCoordinates`, `shapeDiscovery`, `shapeConstruction`, `buildRouteHint`
- `src/lib/serverMonitor.ts` — `getServerMonitorSnapshot`
- `src/lib/setupChunkUpload.ts` — `SetupInfo`, `uploadSetupInChunks`
- `src/lib/siteDonation.ts` — `SiteDonationData`, `DEFAULT_DONATION`, `donationFromContent`, `buildDonationPayload`
- `src/lib/siteFooter.ts` — `SiteFooterData`, `DEFAULT_FOOTER`, `footerFromContent`, `buildSiteContentPayload`, `SITE_CONTENT_FOOTER_FIELDS`
- `src/lib/siteProjects.ts` — `ProjectSourceKind`, `ProjectStatus`, `SiteProjectCard`, `CompactResourceRow`, `JournalSiteRow`, `StoredProjectRow`, `RavenProjectRow`, `STALE_HOURS`, `commodityMap`, `compactProjectResources`, `remainingFromResources`, `projectKey`, `ProjectRegistrationInput`, `NormalizedRegistration`, `normalizeProjectRegistration`, `progressFromResources`, `cardsFromStored`, `cardsFromRavenCache`, `cardsFromJournalSites`, `mergeProjectCards`, `markStale`, `projectNeed`, `projectNeedTotal`, `buildSystemCards`, `ProjectResourceRow`, `cardResourceRows`, `cardTotals`, `ravenProjectFromCard`, `mergeResourceRows`
- `src/lib/siteUrl.ts` — `DEFAULT_SITE_URL`, `DEFAULT_SUPABASE_URL`, `getSiteUrl`, `publicOrigin`
- `src/lib/spanshClient.ts` — `SpanshSearchOptions`, `SpanshBodiesSearchOptions`, `SpanshNearestOptions`, `spanshSearch`, `spanshNearest`, `SpanshSystemsNearOptions`, `SpanshSystemStub`, `spanshSystemsNear`, `spanshBodiesSearch`, `mapSpanshSubtypeToWorldType`, `isTerraformable`, `SpanshDumpBody`, `SpanshDumpResult`, `spanshSystemDump`
- `src/lib/squadronConstants.ts` — `ED_POWERS`, `ED_ALLEGIANCES`, `LANGUAGES`, `TIMEZONES`, `ACTIVITY_TYPES`, `SQUADRON_MEMBER_LIMIT`, `NAME_CHANGE_COOLDOWN_DAYS`
- `src/lib/squadronData.ts` — `SquadronPermission`, `normaliseSquadronMember`, `loadSquadronMembers`, `getSquadronMembership`, `loadSquadronProjects`, `loadProjectSummaries`, `loadSquadronSummaries`, `loadSquadronForUser`
- `src/lib/squadronForm.ts` — `SquadronInput`, `SquadronParseResult`, `normalizeTag`, `tagFromName`, `parseSquadronInput`, `DbLikeError`, `squadronWriteError`
- `src/lib/squadronGame.ts` — `SquadronReport`, `SquadronApplyResult`, `parseSquadronReport`, `squadronReportFromEvent`, `applyPilotSquadron`, `SquadronApplyError`, `PilotGameSquadron`, `pilotGameSquadronFromProfile`
- `src/lib/stationCommerce.ts` — `stationReportSchema`, `StationReport`, `CommerceSource`, `COMMERCE_SOURCE_RANK`, `INVENTORY_TTL_MS`, `stationKey`, `canonicalReport`, `saveStationReport`, `knownMarketSystems`, `stationLandingPad`, `edsmStationReport`, `edsmInventoryItems`, `validTime`, `spanshStationReports`, `spanshCommercePayload`
- `src/lib/stationSearch.ts` — `stationSearchSchema`, `StationSearchKind`, `StationSearchSort`, `StationSearchItem`, `StationMetadata`, `StationSearchResult`, `StationMatchedItem`, `StationSearchStation`, `StationSearchStationsResponse`, `STATION_PAGE_SIZE`, `STATION_ITEM_LIMIT`, `SERVICE_OPTIONS`, `searchKey`, `serviceAliases`, `serviceLabel`, `stationItemKey`, `stationItemMatchesKeys`, `groupStationRows`, `hasStationCoordinates`, `stationAtlasLink`, `atlasFocusFromParams`
- `src/lib/stationSearchCatalog.ts` — `stationSearchOptions`, `STATION_ITEMS_SOURCE`, `StationPick`, `resolveStationPick`, `marketPickByName`, `stationQueryAliases`, `stationItemDisplay`, `stationItemLabel`
- `src/lib/stationSearchOptions.ts` — `StationSearchOption`, `StationPickRef`, `STATION_PICK_PREFIXES`, `pickMatchesKind`, `optionWords`, `optionKey`, `filterStationOptions`, `exactStationOption`, `ruPlural`
- `src/lib/supabaseAdmin.ts` — `supabaseAdmin`, `createAdminClient`, `upsertProfile`
- `src/lib/supabaseClient.ts` — `supabase`, `createSupabaseClient`, `getAuthenticatedSupabase`, `getAccessToken`, `getCurrentUser`, `getAuthHeaders`, `authFetch`
- `src/lib/supabaseServer.ts` — `getSupabaseUrl`, `createClient`, `createRouteClient`, `createServiceClient`, `createUserClient`, `authFromRequest`
- `src/lib/supabaseServerUrl.ts` — `getServerSupabaseUrl`
- `src/lib/supabaseUrl.ts` — `SUPABASE_AUTH_COOKIE_NAME`, `getPublicSupabaseUrl`, `getPublicStorageBaseUrl`, `getPublicStorageUrl`, `supabaseCookieOptions`
- `src/lib/supportTickets.ts` — `SUPPORT_STAFF_ROLES`, `SupportProfile`, `SupportRequestContext`, `isSupportStaff`, `getSupportRequestContext`, `loadSupportProfiles`
- `src/lib/systemCoordinateTypes.ts` — `SystemCoordinates`, `CoordinateSource`, `coordinateNameKey`, `readSystemCoordinates`
- `src/lib/systemCoordinates.ts` — `resolveSystemCoordinates`
- `src/lib/systemIdentity.ts` — `cleanSystemName`, `systemKey`, `sameSystem`, `systemId64`, `SystemPoint`, `systemPageHref`, `AtlasSystemTab`, `atlasSystemHref`, `ATLAS_CARRIER_PARAM`, `ATLAS_CARRIER_SYSTEM_PARAM`, `carrierMarketId`, `AtlasCarrierTarget`, `carrierAtlasHref`, `carrierAtlasTargetFromParams`, `stationSearchHref`, `externalSystemLinks`
- `src/lib/systemObservations.ts` — `ObservationSource`, `SplitObservations`, `SystemObservationsResult`, `splitSystemObservations`, `applySystemObservations`, `observationEventsFromJournalText`
- `src/lib/systemOrrery.ts` — `BodyKind`, `OrreryRing`, `OrbitalElements`, `DEFAULT_ELEMENTS`, `OrreryBody`, `OrreryStructure`, `OrreryOrbitPath`, `OrreryCluster`, `OrreryLayout`, `StructurePlacement`, `SCENE_SPAN`, `normalizeBody`, `extractStarKey`, `estimateStarLuminosity`, `habitableZoneLs`, `bodyMarkerSize`, `LayoutOptions`, `buildOrreryLayout`, `ellipsePath`, `parseOrbitalElements`, `solveKepler`, `trueAnomaly`, `OrbitOrientation`, `orbitPoint`, `orbitalPath`, `orbitalPosition`, `orientationOf`, `starRadiusScale`, `starColorFromTemperature`, `unitsPerPixel`, `bodyDisplayRadiusUnits`, `placeStructures`, `onSphere`, `bodySphereRadiusUnits`, `SphereGeometry`, `SPHERE_MESH`, `SPHERE_HAZE_SCALE`, `SPHERE_SURFACE_LIFT`, `SPHERE_MATERIAL`, `sceneAspect`, `sphereGeometry`, `FocusView`, `CAMERA_DISTANCE`, `SceneCamera`, `sceneCamera`, `FOCUS_PAD`, `OVERVIEW_PAD`, `traceExtent`, `focusWindow`, `overviewWindow`, `computeFocusView`, `neighboursOf`, `OrrerySummary`, `summarizeLayout`, `toStructures`
- `src/lib/systemOverview.ts` — `SystemOverviewViewer`, `OverviewCatalog`, `OverviewPlan`, `OverviewSquadronProject`, `OverviewArchitectProject`, `OverviewStation`, `OverviewPowerplay`, `OverviewGoal`, `OverviewFreshness`, `SystemOverview`, `pickReferencePlan`, `shapeSystemOverview`, `loadSystemOverview`, `CompactSystemProgress`, `loadSystemsProgress`
- `src/lib/systemProgress.ts` — `systemNameKey`, `readableProgress`, `statusFromProgress`, `ProgressCacheRow`, `latestProgressBySystem`, `mergeProgressIntoMap`, `RavenProgressPersistenceResult`, `persistRavenSystemProgress`
- `src/lib/translate.ts` — `SUPPORTED_TRANSLATION_LANGS`, `TranslationLang`, `TranslationResult`, `translateTexts`, `translateToAllLangs`, `TABLE_SOURCE_LANG`, `translateAndSaveArticle`
- `src/lib/updateAgent.ts` — `UpdateAgentInfo`, `UpdateAgentStatus`, `PUBLIC_STATUS_CACHE_MS`, `configuredUpdateAgent`, `invalidateUpdateAgentCache`, `getUpdateAgentStatus`, `UpdateAction`, `callUpdateAgent`, `EnvKeyEntry`, `listEnvKeys`, `saveEnvKey`, `deleteEnvKey`, `applyEnvKeys`, `SMTP_KEYS`, `SmtpKeyName`, `SmtpKeyEntry`, `SmtpStatus`, `listSmtpKeys`, `saveSmtpKey`, `deleteSmtpKey`, `applySmtpSettings`, `StorageReport`, `StorageHealth`, `readStorageHealth`, `restartStorage`
- `src/lib/updateSystemCoordinates.ts` — `updateSystemCoordinates`
- `src/lib/uploaderStore.ts` — `MANIFEST_SCHEMA`, `MAX_FILES`, `MAX_FILE_BYTES`, `MAX_BUNDLE_BYTES`, `CHANNELS`, `Channel`, `isValidLauncherPlatform`, `isValidLauncherVersion`, `CANONICAL_SIGN_KEY_ID`, `CANONICAL_SIGN_SEED_B64`, `CANONICAL_SIGN_PUBLIC_B64`, `ManifestFile`, `BundleManifest`, `SetupInfo`, `LauncherInfo`, `storeRoot`, `SignKeyConfig`, `UploaderConfig`, `readConfig`, `normalizePublicKey`, `deriveEd25519Public`, `uploaderSourceDir`, `clientTrustedKeys`, `GeneratedSignKey`, `generateSignKey`, `upsertSignKey`, `storeSignKey`, `importSignKey`, `removeSignKey`, `setPublishToken`, `generatePublishToken`, `checkManifest`, `canonicalManifestBytes`, `trustedKeys`, `envKeyIds`, `verifyManifestSignature`, `isPublishAuthorized`, `normalizeChannel`, `versionTuple`, `compareVersions`, `readChannelVersion`, `readManifest`, `manifestForChannel`, `readBlob`, `readBlobGzip`, `readBundleArchive`, `readLauncher`, `readLauncherBinary`, `readSetup`, `setupBinaryFile`, `readSetupBinary`, `saveSetupBinary`, `removeSetup`, `listVersions`, `channelState`, `PublishInput`, `PublishResult`, `ensureCanonicalSigningKey`, `stampTrustedKeysSource`, `embedTrustedKeys`, `trustedPublicKeys`, `createZip`, `HelperReleaseProgress`, `HelperReleaseProgressHandler`, `ServerReleaseInput`, `createServerRelease`, `publishBundle`, `promoteVersion`, `deleteVersion`, `clearChannel`, `ResignChannelOutcome`, `ResignChannelsResult`, `resignChannelManifests`, `saveLauncherBinary`, `saveLauncher`, `StoreStatus`, `storeStatus`
- `src/lib/userDisplay.ts` — `AuthUser`, `ProfileRow`, `nicknameFrom`, `avatarFrom`
- `src/lib/vkAccount.ts` — `VkIdentityRow`, `findVkIdentity`, `findVkIdentityByUser`, `linkVkIdentity`, `unlinkVkIdentity`, `resolveVkLogin`, `sessionTokenHash`
- `src/lib/vkId.ts` — `VK_AUTHORIZE_URL`, `VK_TOKEN_URL`, `VK_USER_INFO_URL`, `VK_LOGOUT_URL`, `VK_FLOW_COOKIE`, `VK_FLOW_TTL`, `VK_SCOPES`, `VkFlow`, `VkUserInfo`, `vkConfig`, `vkEnabled`, `vkRedirectUri`, `pkceChallenge`, `createVkFlow`, `readVkFlow`, `vkAuthorizeUrl`, `VkAuthError`, `exchangeVkCode`, `fetchVkUserInfo`, `vkPlaceholderEmail`, `isVkPlaceholderEmail`, `vkDisplayName`, `canUnlinkVk`
- `src/lib/vkShared.ts` — `VK_PROVIDER`, `VK_LABEL`, `vkErrorMessage`
- `src/lib/wikiAuth.ts`
- `src/lib/yandexAccount.ts` — `YandexIdentityRow`, `findYandexIdentity`, `findYandexIdentityByUser`, `linkYandexIdentity`, `unlinkYandexIdentity`, `resolveYandexLogin`, `sessionTokenHash`
- `src/lib/yandexId.ts` — `YANDEX_AUTHORIZE_URL`, `YANDEX_TOKEN_URL`, `YANDEX_USER_INFO_URL`, `YANDEX_AVATAR_URL`, `YANDEX_FLOW_COOKIE`, `YANDEX_FLOW_TTL`, `YANDEX_SCOPES`, `YANDEX_CLIENT_ID_RE`, `YandexFlow`, `YandexUserInfo`, `yandexConfig`, `yandexEnabled`, `yandexRedirectUri`, `pkceChallenge`, `createYandexFlow`, `readYandexFlow`, `yandexAuthorizeUrl`, `YandexAuthError`, `exchangeYandexCode`, `fetchYandexUserInfo`, `yandexPlaceholderEmail`, `isYandexPlaceholderEmail`, `yandexDisplayName`, `canUnlinkYandex`
- `src/lib/yandexShared.ts` — `YANDEX_PROVIDER`, `YANDEX_LABEL`, `yandexErrorMessage`
- `src/lib/zodSchemas.ts` — `atlasSearchSchema`, `deliveryImportSchema`, `forumPostSchema`, `forumReportSchema`, `poiSchema`

## 5. Компоненты и hooks сайта

### `src/components`

- `src/components/Account/HelperLinkPanel.tsx`
- `src/components/Admin/AdminNavigation.tsx`
- `src/components/Admin/AdminShell.module.css`
- `src/components/Admin/ArchiveUploadControl.tsx`
- `src/components/Admin/AuthProvidersTab.tsx`
- `src/components/Admin/BackupTab.tsx`
- `src/components/Admin/Billing/BillingInfographics.tsx`
- `src/components/Admin/Billing/PaymentProvidersPanel.tsx`
- `src/components/Admin/Billing/PaymentsPanel.tsx`
- `src/components/Admin/Billing/ProductManager.tsx`
- `src/components/Admin/Billing/ProfilePicker.tsx`
- `src/components/Admin/Billing/StoreAnalytics.tsx`
- `src/components/Admin/Billing/SubscriptionManager.tsx`
- `src/components/Admin/Billing/TransactionLedger.tsx`
- `src/components/Admin/BillingDashboard.tsx`
- `src/components/Admin/CommunityGoalsAdminTab.tsx`
- `src/components/Admin/FactionsAdminTab.tsx`
- `src/components/Admin/GalaxyCatalogTab.tsx`
- `src/components/Admin/HelperUpdatesTab.tsx`
- `src/components/Admin/MailSettingsCard.tsx`
- `src/components/Admin/OutfittingAdmin.module.css`
- `src/components/Admin/OutfittingAdmin.tsx`
- `src/components/Admin/OutfittingDialog.tsx`
- `src/components/Admin/OutfittingEditor.tsx`
- `src/components/Admin/OutfittingShipEditor.tsx`
- `src/components/Admin/PowerplayAdminTab.tsx`
- `src/components/Admin/RavenSyncTab.tsx`
- `src/components/Admin/RoutePagination.tsx`
- `src/components/Admin/ServerMonitorTab.tsx`
- `src/components/Admin/ShipImagesAdmin.tsx`
- `src/components/Admin/SquadronsAdmin.tsx`
- `src/components/Admin/StorageHealthPanel.tsx`
- `src/components/Architect/ArchitectNav.tsx`
- `src/components/Architect/ArchitectWorkspace.tsx`
- `src/components/Architect/DataQualityPanel.tsx`
- `src/components/Architect/ExistingPanel.tsx`
- `src/components/Architect/GovernancePanel.tsx`
- `src/components/Architect/InstallationPicker.tsx`
- `src/components/Architect/PlanInsights.tsx`
- `src/components/Architect/PlanSummary.tsx`
- `src/components/Architect/ProgressPanel.tsx`
- `src/components/Architect/RavenCreatePanel.tsx`
- `src/components/Architect/SharePanel.tsx`
- `src/components/Architect/SiteEditor.tsx`
- `src/components/Architect/SiteTable.tsx`
- `src/components/Architect/SourcingPanel.tsx`
- `src/components/Architect/SyncPanel.tsx`
- `src/components/Architect/SystemProjectsPanel.tsx`
- `src/components/Architect/panelStyles.ts`
- `src/components/Architect/projects/ProjectCarriers.tsx`
- `src/components/Architect/projects/ProjectLeaders.tsx`
- `src/components/Architect/projects/ProjectMembers.tsx`
- `src/components/Architect/projects/ProjectOverview.tsx`
- `src/components/Architect/projects/ProjectSettings.tsx`
- `src/components/Architect/projects/ProjectSystems.tsx`
- `src/components/Architect/projects/ProjectView.tsx`
- `src/components/Architect/projects/ProjectsHub.tsx`
- `src/components/Architect/projects/projectUi.tsx`
- `src/components/Atlas/AtlasCandidateList.tsx`
- `src/components/Atlas/AtlasCarriersPanel.tsx`
- `src/components/Atlas/AtlasContext.tsx`
- `src/components/Atlas/AtlasDialog.tsx`
- `src/components/Atlas/AtlasFactionsPanel.tsx`
- `src/components/Atlas/AtlasFavorites.tsx`
- `src/components/Atlas/AtlasMarketSearch.tsx`
- `src/components/Atlas/AtlasNearbySearch.tsx`
- `src/components/Atlas/AtlasPowerplayPanel.tsx`
- `src/components/Atlas/AtlasRingRouteFinder.tsx`
- `src/components/Atlas/AtlasRouteFinder.tsx`
- `src/components/Atlas/AtlasSearchHistory.tsx`
- `src/components/Atlas/AtlasSearchPanel.tsx`
- `src/components/Atlas/AtlasShipRouteFinder.tsx`
- `src/components/Atlas/CollapsibleSection.tsx`
- `src/components/Atlas/RangeNumberField.tsx`
- `src/components/Atlas/RingGeometryControls.tsx`
- `src/components/Atlas/SystemSearchInput.tsx`
- `src/components/AuthMethods.tsx`
- `src/components/Avatar.tsx`
- `src/components/Billing/SubscriptionsPage.tsx`
- `src/components/Carriers/CarrierCard.tsx`
- `src/components/Carriers/CarrierCardPage.tsx`
- `src/components/Carriers/CarrierDirectoryPage.tsx`
- `src/components/Carriers/CarrierJumpBoard.tsx`
- `src/components/Carriers/CarrierJumpCalendar.tsx`
- `src/components/Carriers/CarrierJumpHistory.tsx`
- `src/components/Carriers/CarrierJumpsPage.tsx`
- `src/components/Carriers/CarrierPanel.tsx`
- `src/components/CmdrDossier.tsx`
- `src/components/Comments/CommentSection.tsx`
- `src/components/CommunityGoals/GoalCard.module.css`
- `src/components/CommunityGoals/GoalCard.tsx`
- `src/components/Cosmetics/AccountPremiumPanel.tsx`
- `src/components/Cosmetics/CmdrProfileCosmetics.tsx`
- `src/components/Cosmetics/CosmeticAvatar.tsx`
- `src/components/Cosmetics/CosmeticBadge.tsx`
- `src/components/Cosmetics/CosmeticCallsign.tsx`
- `src/components/Cosmetics/CosmeticTitle.tsx`
- `src/components/Cosmetics/HudSkinProvider.tsx`
- `src/components/Cosmetics/PilotIdentity.tsx`
- `src/components/Cosmetics/types.ts`
- `src/components/Cosmetics/useCosmetics.ts`
- `src/components/DirectChat.tsx`
- `src/components/EmailRequestForm.tsx`
- `src/components/Engineers/EngineerTree.tsx`
- `src/components/Engineers/EngineersHeader.tsx`
- `src/components/Footer.tsx`
- `src/components/Forum/ForumAdmin.tsx`
- `src/components/Forum/ForumBreadcrumbs.tsx`
- `src/components/Forum/ForumReactions.tsx`
- `src/components/Forum/ForumReplyBox.tsx`
- `src/components/Forum/ForumReportButton.tsx`
- `src/components/Forum/ForumSearch.tsx`
- `src/components/Forum/ForumSkeleton.tsx`
- `src/components/Forum/MarkdownToolbar.tsx`
- `src/components/Forum/RecentPosts.tsx`
- `src/components/FriendsPanel.tsx`
- `src/components/GalaxyMap/AllSystemsPoints.tsx`
- `src/components/GalaxyMap/AtlasMarkers.tsx`
- `src/components/GalaxyMap/CarrierGlyph.tsx`
- `src/components/GalaxyMap/CarrierLayerControls.tsx`
- `src/components/GalaxyMap/CarrierMarkers.tsx`
- `src/components/GalaxyMap/CarrierSystemCard.tsx`
- `src/components/GalaxyMap/FactionPoints.tsx`
- `src/components/GalaxyMap/FactionSystemCard.tsx`
- `src/components/GalaxyMap/GalacticRegions.tsx`
- `src/components/GalaxyMap/GalaxyBackground.tsx`
- `src/components/GalaxyMap/GalaxyMap.tsx`
- `src/components/GalaxyMap/GalaxyMapClient.tsx`
- `src/components/GalaxyMap/GalaxyPlane.tsx`
- `src/components/GalaxyMap/GalaxyRegionBoundaries.tsx`
- `src/components/GalaxyMap/GalaxyRegionMarkers.tsx`
- `src/components/GalaxyMap/GalaxyScene.tsx`
- `src/components/GalaxyMap/HubMarkers.tsx`
- `src/components/GalaxyMap/INTEGRATION.md`
- `src/components/GalaxyMap/LandmarkMarkers.tsx`
- `src/components/GalaxyMap/MarketResultMarkers.tsx`
- `src/components/GalaxyMap/NebulaCard.tsx`
- `src/components/GalaxyMap/NebulaField.tsx`
- `src/components/GalaxyMap/NoMarketMarkers.tsx`
- `src/components/GalaxyMap/PilotMarkers.tsx`
- `src/components/GalaxyMap/PowerplayGlyph.tsx`
- `src/components/GalaxyMap/PowerplayPoints.tsx`
- `src/components/GalaxyMap/PowerplaySystemCard.tsx`
- `src/components/GalaxyMap/RingZone.tsx`
- `src/components/GalaxyMap/RouteLine.tsx`
- `src/components/GalaxyMap/RouteMarkers.tsx`
- `src/components/GalaxyMap/SearchProgressLayer.tsx`
- `src/components/GalaxyMap/StarField.tsx`
- `src/components/GalaxyMap/index.ts`
- `src/components/GalaxyMap/useGalaxyData.ts`
- `src/components/Galnet/GalnetNewsBlock.tsx`
- `src/components/Icons.tsx`
- `src/components/LanguageSwitcher.tsx`
- `src/components/Leaderboard.tsx`
- `src/components/LeaderboardStats.tsx`
- `src/components/MaintenanceScreen.tsx`
- `src/components/MobileNav.tsx`
- `src/components/NotificationBell.tsx`
- `src/components/Outfitting/ArmourEngineering.tsx`
- `src/components/Outfitting/BulkheadPicker.tsx`
- `src/components/Outfitting/Charts.tsx`
- `src/components/Outfitting/ExchangePanel.tsx`
- `src/components/Outfitting/MercCoinPanel.tsx`
- `src/components/Outfitting/ModulePicker.tsx`
- `src/components/Outfitting/ModuleTooltip.tsx`
- `src/components/Outfitting/OutfittingHeader.tsx`
- `src/components/Outfitting/OutfittingWorkspace.tsx`
- `src/components/Outfitting/PowerDistributorPips.tsx`
- `src/components/Outfitting/ShipControl.tsx`
- `src/components/Outfitting/SpecialEffectCard.tsx`
- `src/components/Outfitting/StatsPanel.tsx`
- `src/components/Outfitting/styles.ts`
- `src/components/Projects/ProjectCard.tsx`
- `src/components/Projects/ProjectRoutePlanner.tsx`
- `src/components/Projects/ProjectSystemPanel.tsx`
- `src/components/ShipImage.tsx`
- `src/components/Sidebar.tsx`
- `src/components/SiteFooter.tsx`
- `src/components/SiteStatusBar.tsx`
- `src/components/SquadronChat.tsx`
- `src/components/SquadronVoiceChat.tsx`
- `src/components/Starfield.tsx`
- `src/components/StationSearch/StationItemPicker.tsx`
- `src/components/StationSearch/StationResultsList.tsx`
- `src/components/Support/SupportAdmin.tsx`
- `src/components/System/SystemOverviewSections.tsx`
- `src/components/SystemMap/SystemBodyRail.tsx`
- `src/components/SystemMap/SystemOrrery3D.tsx`
- `src/components/Translate.tsx`
- `src/components/UnreadBadge.tsx`
- `src/components/UserMenu.tsx`
- `src/components/UserShipPhotoUploader.tsx`
- `src/components/UtcClock.tsx`
- `src/components/Wiki/WikiArticleContent.tsx`
- `src/components/Wiki/WikiArticleMeta.tsx`
- `src/components/Wiki/WikiHome.tsx`
- `src/components/Wiki/WikiSearchBox.tsx`
- `src/components/Wiki/WikiSidebar.tsx`
- `src/components/ui/ErrorBoundary.tsx`
- `src/components/ui/Toaster.tsx`

### `src/hooks`

- `src/hooks/useAtlasData.ts`
- `src/hooks/useAtlasHistory.ts`
- `src/hooks/useAtlasRingPreview.ts`
- `src/hooks/useAtlasSearchProgress.ts`
- `src/hooks/useCarrierLayer.ts`
- `src/hooks/useFactionsLayer.ts`
- `src/hooks/useFriends.ts`
- `src/hooks/usePowerplayLayer.ts`
- `src/hooks/useRealtimeUserId.ts`
- `src/hooks/useSystemAutocomplete.ts`

### `src/types`

- `src/types/atlas.ts`
- `src/types/billing.ts`
- `src/types/capi.ts`
- `src/types/eddn.ts`
- `src/types/forum.ts`
- `src/types/friend.ts`
- `src/types/helperRelease.ts`
- `src/types/hub.ts`
- `src/types/inara.ts`
- `src/types/journal.ts`
- `src/types/monitor.ts`
- `src/types/pg-copy-streams.d.ts`
- `src/types/project.ts`
- `src/types/squadron.ts`
- `src/types/three-jsx.d.ts`
- `src/types/web-push.d.ts`
- `src/types/zeromq.d.ts`

## 6. Миграции PostgreSQL (в порядке имён)

- `supabase/migrations/000_base_schema.sql`
- `supabase/migrations/001_rls_policies.sql`
- `supabase/migrations/20250831160000_add_language_to_profiles.sql`
- `supabase/migrations/20250906_support_system.sql`
- `supabase/migrations/20250907_fix_support_notifications.sql`
- `supabase/migrations/20260830102924_rls_policies.sql`
- `supabase/migrations/20260830110258_rls_policies_v2.sql`
- `supabase/migrations/20260830152500_galnet_news.sql`
- `supabase/migrations/20260831000000_comments.sql`
- `supabase/migrations/20260831030000_comments_fix_fk.sql`
- `supabase/migrations/20260901000000_wiki.sql`
- `supabase/migrations/20260902120000_fix_forum_trigger_author_name.sql`
- `supabase/migrations/20260903000000_wiki_fill_empty_categories.sql`
- `supabase/migrations/20260903010000_wiki_update_colonization.sql`
- `supabase/migrations/20260903020000_wiki_lore_articles.sql`
- `supabase/migrations/20260903170000_fix_squadron_friends.sql`
- `supabase/migrations/20260904000000_capi_journal_base.sql`
- `supabase/migrations/20260904010000_eddn_market_data.sql`
- `supabase/migrations/20260904020000_squadron_live_tracking.sql`
- `supabase/migrations/20260904030000_fleet_carriers.sql`
- `supabase/migrations/20260904040000_cg_inara_integration.sql`
- `supabase/migrations/20260904100000_system_coords_cache.sql`
- `supabase/migrations/20260908010000_wiki_exobiology.sql`
- `supabase/migrations/20260908020000_wiki_exobiology_update.sql`
- `supabase/migrations/20260909010000_fix_email_login_profile.sql`
- `supabase/migrations/20260911000000_raven_depot_snapshot_lookup.sql`
- `supabase/migrations/20260911010000_delivery_import_idempotency.sql`
- `supabase/migrations/20260911020000_precise_raven_progress.sql`
- `supabase/migrations/20260911030000_squadron_read_models_and_profile_sync.sql`
- `supabase/migrations/20260911040000_delivery_import_placement_resolver.sql`
- `supabase/migrations/20260911050000_delivery_import_indexes.sql`
- `supabase/migrations/20260911060000_project_system_coordinates.sql`
- `supabase/migrations/20260912000000_atlas_ring_system_cache.sql`
- `supabase/migrations/20260915000000_galnet_translations.sql`
- `supabase/migrations/20260916000000_system_scans_and_pilot_dossier.sql`
- `supabase/migrations/20260917000000_deliveries_transport_scope.sql`
- `supabase/migrations/20260918000000_deliveries_cargo_scope.sql`
- `supabase/migrations/20260918010000_profile_privacy_settings.sql`
- `supabase/migrations/20260918020000_pilot_stats_capi_fields.sql`
- `supabase/migrations/20260919000000_delivery_import_timeout_hardening.sql`
- `supabase/migrations/20260920000000_site_content_translations.sql`
- `supabase/migrations/20260921000000_billing_and_premium_shop.sql`
- `supabase/migrations/20260921120000_galaxy_systems.sql`
- `supabase/migrations/20260922000000_billing_real_data_payments.sql`
- `supabase/migrations/20260922010000_tbank_provider.sql`
- `supabase/migrations/20260923000000_vk_identities.sql`
- `supabase/migrations/20260924000000_galaxy_systems_finish.sql`
- `supabase/migrations/20260924010000_reconcile_galnet_news_structure.sql`
- `supabase/migrations/20260925000000_galaxy_systems_scale.sql`
- `supabase/migrations/20260925010000_yandex_identities.sql`
- `supabase/migrations/20260926000000_site_content_footer_translations.sql`
- `supabase/migrations/20260927000000_app_flags_maintenance.sql`
- `supabase/migrations/20260928000000_colonisation_events_source_hash.sql`
- `supabase/migrations/20260929000000_system_plans.sql`
- `supabase/migrations/20260930000000_raven_sync_log_synced_at.sql`
- `supabase/migrations/20261001000000_body_signals.sql`
- `supabase/migrations/20261002000000_capi_profile_binding_and_fleet.sql`
- `supabase/migrations/20261002010000_system_scans_orbit.sql`
- `supabase/migrations/20261003000000_capi_binding_diagnostics.sql`
- `supabase/migrations/20261004000000_profile_avatars_fallback.sql`
- `supabase/migrations/20261004010000_saved_outfitting_builds.sql`
- `supabase/migrations/20261005000000_squadron_tag_optional.sql`
- `supabase/migrations/20261006000000_system_architects.sql`
- `supabase/migrations/20261007000000_squadron_branding.sql`
- `supabase/migrations/20261008000000_colonisation_events_slim_retention.sql`
- `supabase/migrations/20261009000000_galaxy_points_scale.sql`
- `supabase/migrations/20261009010000_colonisation_sites.sql`
- `supabase/migrations/20261010000000_pilot_stats_source.sql`
- `supabase/migrations/20261010010000_outfitting_catalog.sql`
- `supabase/migrations/20261010020000_raven_keys.sql`
- `supabase/migrations/20261011000000_atlas_search_caches.sql`
- `supabase/migrations/20261012000000_atlas_ring_cache_near.sql`
- `supabase/migrations/20261013000000_ring_key_systems_and_deviation.sql`
- `supabase/migrations/20261013010000_ring_tilt_and_center.sql`
- `supabase/migrations/20261013020000_ring_tilt_axis.sql`
- `supabase/migrations/20261013030000_market_construction_blueprints.sql`
- `supabase/migrations/20261014000000_station_commerce.sql`
- `supabase/migrations/20261014010000_station_search.sql`
- `supabase/migrations/20261015000000_profiles_rls_hardening.sql`
- `supabase/migrations/20261016000000_credentials_and_views_hardening.sql`
- `supabase/migrations/20261017000000_fleet_carriers.sql`
- `supabase/migrations/20261017120000_architect_projects.sql`
- `supabase/migrations/20261018000000_fleet_carrier_squadron_claims.sql`
- `supabase/migrations/20261018120000_powerplay_systems.sql`
- `supabase/migrations/20261018180000_powerplay_sync_progress.sql`
- `supabase/migrations/20261019120000_minor_factions.sql`
- `supabase/migrations/20261020120000_unified_system_data.sql`
- `supabase/migrations/20261021120000_powerplay_owner.sql`
- `supabase/migrations/20261021130000_eddn_listener.sql`
- `supabase/migrations/20261022120000_station_search_by_station.sql`
- `supabase/migrations/20261023120000_station_search_access_filters.sql`
- `supabase/migrations/20261024120000_profile_squadron_images.sql`
- `supabase/migrations/20261025090000_cg_inara_details.sql`
- `supabase/migrations/20261026080000_cg_identity_key.sql`
- `supabase/migrations/20261026090000_community_goal_commander_reports.sql`
- `supabase/migrations/20261027090000_community_goal_admin.sql`
- `supabase/migrations/20261028090000_community_goal_fallback_sources.sql`
- `supabase/migrations/20261029090000_capi_sync_jobs.sql`
- `supabase/migrations/20261030090000_community_goal_game_identity.sql`
- `supabase/migrations/20261031090000_community_goal_progress_freshness.sql`
- `supabase/migrations/20261101090000_community_goal_progress_history.sql`
- `supabase/migrations/20261102090000_frontier_public_community_goals.sql`
- `supabase/migrations/20261103090000_ship_route_planner.sql`
- `supabase/migrations/20261104090000_helper_device_linking.sql`
- `supabase/migrations/20261105090000_profiles_access_repair.sql`
- `supabase/migrations/20261106090000_construction_projects.sql`
- `supabase/migrations/20261107090000_atlas_carrier_watch.sql`
- `supabase/migrations/20261108120000_carrier_directory.sql`
- `supabase/migrations/20261110090000_carrier_directory_route.sql`
- `supabase/migrations/20261110190000_carrier_watch_jump.sql`
- `supabase/migrations/20261112120000_carrier_jump_schedule.sql`
- `supabase/migrations/20261113120000_carrier_jump_history.sql`
- `supabase/migrations/20261114100000_carrier_jump_notify.sql`
- `supabase/migrations/20261116090000_carrier_catalog.sql`
- `supabase/migrations/20261117090000_squadron_journal_sync.sql`
- `supabase/migrations/20261117100000_site_content_donation.sql`
- `supabase/migrations/20261118000000_billing_subscription_bonuses.sql`
- `supabase/migrations/20261118010000_squadron_transfer_fix.sql`
- `supabase/migrations/20261120000000_ship_images_bucket.sql`
- `supabase/migrations/20261120010000_user_ship_photos.sql`

## 7. Тестовые файлы

### Python / Helper

- `uploader/tests/test_bgs_sync.py`
- `uploader/tests/test_build_bundle.py`
- `uploader/tests/test_build_exe.py`
- `uploader/tests/test_bundle.py`
- `uploader/tests/test_bundle_updater.py`
- `uploader/tests/test_capi_link.py`
- `uploader/tests/test_capi_site_bridge.py`
- `uploader/tests/test_carrier.py`
- `uploader/tests/test_carrier_reconcile.py`
- `uploader/tests/test_carrier_sync.py`
- `uploader/tests/test_colonisation.py`
- `uploader/tests/test_colony_build_types.py`
- `uploader/tests/test_colony_tab.py`
- `uploader/tests/test_community_goals.py`
- `uploader/tests/test_companion_api.py`
- `uploader/tests/test_connection_status.py`
- `uploader/tests/test_crash_log.py`
- `uploader/tests/test_eddn.py`
- `uploader/tests/test_exobio_cache_and_scan.py`
- `uploader/tests/test_exobio_filters.py`
- `uploader/tests/test_exobio_overlay.py`
- `uploader/tests/test_exobio_tab.py`
- `uploader/tests/test_exobiology.py`
- `uploader/tests/test_external_scans_and_orrery.py`
- `uploader/tests/test_faction_site_sync.py`
- `uploader/tests/test_factions_data.py`
- `uploader/tests/test_factions_page.py`
- `uploader/tests/test_foot_map.py`
- `uploader/tests/test_foot_map_overlay.py`
- `uploader/tests/test_helper_auth_page.py`
- `uploader/tests/test_helper_colony_page.py`
- `uploader/tests/test_helper_equipment_page.py`
- `uploader/tests/test_helper_exobio_page.py`
- `uploader/tests/test_helper_log_page.py`
- `uploader/tests/test_helper_overlay_page.py`
- `uploader/tests/test_helper_pilot_page.py`
- `uploader/tests/test_helper_route_page.py`
- `uploader/tests/test_helper_shell.py`
- `uploader/tests/test_helper_travel_flow.py`
- `uploader/tests/test_helper_travel_page.py`
- `uploader/tests/test_helper_upload_page.py`
- `uploader/tests/test_helper_window_sizing.py`
- `uploader/tests/test_i18n.py`
- `uploader/tests/test_initial_upload_flow.py`
- `uploader/tests/test_installer.py`
- `uploader/tests/test_installer_window.py`
- `uploader/tests/test_journal_transport_scope.py`
- `uploader/tests/test_launcher.py`
- `uploader/tests/test_launcher_account.py`
- `uploader/tests/test_launcher_profile.py`
- `uploader/tests/test_launcher_ui.py`
- `uploader/tests/test_launcher_window.py`
- `uploader/tests/test_locale_config.py`
- `uploader/tests/test_map_export.py`
- `uploader/tests/test_map_tab.py`
- `uploader/tests/test_orrery_layout.py`
- `uploader/tests/test_overlay_content_options.py`
- `uploader/tests/test_overlay_default_layout.py`
- `uploader/tests/test_overlay_flicker.py`
- `uploader/tests/test_overlay_layout.py`
- `uploader/tests/test_overlay_management.py`
- `uploader/tests/test_overlay_screens.py`
- `uploader/tests/test_overlay_settings_migration.py`
- `uploader/tests/test_pilot_equipment.py`
- `uploader/tests/test_pilot_infographic.py`
- `uploader/tests/test_powerplay_data.py`
- `uploader/tests/test_powerplay_page.py`
- `uploader/tests/test_powerplay_sync.py`
- `uploader/tests/test_raven_deliveries.py`
- `uploader/tests/test_route_export.py`
- `uploader/tests/test_route_export_dialog.py`
- `uploader/tests/test_route_hint.py`
- `uploader/tests/test_route_overlay_hint.py`
- `uploader/tests/test_route_travel.py`
- `uploader/tests/test_selfhost_connection.py`
- `uploader/tests/test_ship_hud.py`
- `uploader/tests/test_ship_overlay.py`
- `uploader/tests/test_ship_tracker_status.py`
- `uploader/tests/test_site_projects.py`
- `uploader/tests/test_squadron_sync.py`
- `uploader/tests/test_station_commerce.py`
- `uploader/tests/test_system_map.py`
- `uploader/tests/test_system_view.py`
- `uploader/tests/test_theme_tokens.py`
- `uploader/tests/test_third_party_api.py`
- `uploader/tests/test_uninstall.py`
- `uploader/tests/test_uninstall_window.py`
- `uploader/tests/test_upload_performance.py`
- `uploader/tests/test_wheel_guard.py`
- `uploader/tests/test_window_chrome.py`
- `uploader/tests/test_window_lifecycle.py`
- `uploader/tests/test_window_resize.py`

### Node / сайт, SQL, инфраструктура

- `scripts/tests/admin-access.test.mjs`
- `scripts/tests/admin-email-actions.test.mjs`
- `scripts/tests/android-app.test.mjs`
- `scripts/tests/architect-body-sync.test.mjs`
- `scripts/tests/architect-data-quality.test.mjs`
- `scripts/tests/architect-economy.test.mjs`
- `scripts/tests/architect-existing.test.mjs`
- `scripts/tests/architect-governance-route.test.mjs`
- `scripts/tests/architect-insights.test.mjs`
- `scripts/tests/architect-plans-route.test.mjs`
- `scripts/tests/architect-progress.test.mjs`
- `scripts/tests/architect-projects-db.test.mjs`
- `scripts/tests/architect-projects-lib.test.mjs`
- `scripts/tests/architect-projects-routes.test.mjs`
- `scripts/tests/architect-projects-ui.test.mjs`
- `scripts/tests/architect-raven-create.test.mjs`
- `scripts/tests/architect-sourcing.test.mjs`
- `scripts/tests/architect-store.test.mjs`
- `scripts/tests/architect-system-bodies-route.test.mjs`
- `scripts/tests/architect-ui.test.mjs`
- `scripts/tests/atlas-carriers.test.mjs`
- `scripts/tests/atlas-market-ui.test.mjs`
- `scripts/tests/atlas-market.test.mjs`
- `scripts/tests/atlas-nearby-ui.test.mjs`
- `scripts/tests/atlas-nearby.test.mjs`
- `scripts/tests/atlas-ring-bridge.test.mjs`
- `scripts/tests/atlas-ring-constraints.test.mjs`
- `scripts/tests/atlas-ring-orientation.test.mjs`
- `scripts/tests/atlas-ring-params.test.mjs`
- `scripts/tests/atlas-ring-preview-dom.test.mjs`
- `scripts/tests/atlas-ring-preview.test.mjs`
- `scripts/tests/atlas-ring-save.test.mjs`
- `scripts/tests/atlas-search-map.test.mjs`
- `scripts/tests/atlas-search-progress.test.mjs`
- `scripts/tests/atlas-sector.test.mjs`
- `scripts/tests/atlas-tabs-i18n.test.mjs`
- `scripts/tests/atlas-ui-dom.test.mjs`
- `scripts/tests/atlas-ui.test.mjs`
- `scripts/tests/avatar-squadron-routes.test.mjs`
- `scripts/tests/avatar-url.test.mjs`
- `scripts/tests/billing-and-shop.test.mjs`
- `scripts/tests/build-cache-guard.test.mjs`
- `scripts/tests/bundle-cache.test.mjs`
- `scripts/tests/capi-binding.test.mjs`
- `scripts/tests/capi-callback-route.test.mjs`
- `scripts/tests/capi-client-legacy.test.mjs`
- `scripts/tests/capi-entitlement.test.mjs`
- `scripts/tests/capi-helper-route.test.mjs`
- `scripts/tests/capi-journal.test.mjs`
- `scripts/tests/capi-network-probe.test.mjs`
- `scripts/tests/capi-page.test.mjs`
- `scripts/tests/capi-pkce.test.mjs`
- `scripts/tests/capi-profile-binding.test.mjs`
- `scripts/tests/capi-profile-parse.test.mjs`
- `scripts/tests/capi-session.test.mjs`
- `scripts/tests/capi-token-route.test.mjs`
- `scripts/tests/carrier-card.test.mjs`
- `scripts/tests/carrier-catalog-ui.test.mjs`
- `scripts/tests/carrier-catalog.test.mjs`
- `scripts/tests/carrier-jump-calendar-ui.test.mjs`
- `scripts/tests/carrier-jump-history-ui.test.mjs`
- `scripts/tests/carrier-jump-history.test.mjs`
- `scripts/tests/carrier-jump-notify.test.mjs`
- `scripts/tests/carrier-jump-schedule.test.mjs`
- `scripts/tests/carrier-jumps-ui.test.mjs`
- `scripts/tests/carrier-jumps.test.mjs`
- `scripts/tests/carrier-map-lib.test.mjs`
- `scripts/tests/carrier-map-route.test.mjs`
- `scripts/tests/carrier-map-ui.test.mjs`
- `scripts/tests/carrier-registry.test.mjs`
- `scripts/tests/cmdr-squadron-route.test.mjs`
- `scripts/tests/cmdr-stats-route.test.mjs`
- `scripts/tests/colonisation-events.test.mjs`
- `scripts/tests/community-goal-admin-api.test.mjs`
- `scripts/tests/community-goal-admin.test.mjs`
- `scripts/tests/community-goal-commodity-links.test.mjs`
- `scripts/tests/community-goal-journal.test.mjs`
- `scripts/tests/community-goal-reports.test.mjs`
- `scripts/tests/community-goals.test.mjs`
- `scripts/tests/compose-switch.test.mjs`
- `scripts/tests/construction-projects-db.test.mjs`
- `scripts/tests/cookie-budget.test.mjs`
- `scripts/tests/cosmetics-refresh.test.mjs`
- `scripts/tests/credentials-and-gateway-hardening.test.mjs`
- `scripts/tests/credentials-rls-hardening.test.mjs`
- `scripts/tests/cron-auth.test.mjs`
- `scripts/tests/db-backup.test.mjs`
- `scripts/tests/delivery-import.test.mjs`
- `scripts/tests/deploy-any-server.test.mjs`
- `scripts/tests/deploy-diag.test.mjs`
- `scripts/tests/dossier-cargo.test.mjs`
- `scripts/tests/eddn-listener.test.mjs`
- `scripts/tests/email-auth.test.mjs`
- `scripts/tests/email-health.test.mjs`
- `scripts/tests/engineers-i18n.test.mjs`
- `scripts/tests/env-route.test.mjs`
- `scripts/tests/factions-lib.test.mjs`
- `scripts/tests/factions-sync.test.mjs`
- `scripts/tests/factions-ui.test.mjs`
- `scripts/tests/fleet-carriers-api.test.mjs`
- `scripts/tests/fleet-carriers-db.test.mjs`
- `scripts/tests/fleet-carriers-normalize.test.mjs`
- `scripts/tests/fleet-carriers-squadron-claims.test.mjs`
- `scripts/tests/friends-api.test.mjs`
- `scripts/tests/frontier-community-goals.test.mjs`
- `scripts/tests/galaxy-archive-store.test.mjs`
- `scripts/tests/galaxy-copy-writer.test.mjs`
- `scripts/tests/galaxy-db-connection.test.mjs`
- `scripts/tests/galaxy-download-segments.test.mjs`
- `scripts/tests/galaxy-dump-variants.test.mjs`
- `scripts/tests/galaxy-import.test.mjs`
- `scripts/tests/galaxy-nebulae.test.mjs`
- `scripts/tests/galaxy-points-pick.test.mjs`
- `scripts/tests/galaxy-points-publish.test.mjs`
- `scripts/tests/galaxy-points-scale.test.mjs`
- `scripts/tests/galaxy-ring-zone.test.mjs`
- `scripts/tests/galaxy-shards.test.mjs`
- `scripts/tests/galnet-parser.test.mjs`
- `scripts/tests/galnet-sync.test.mjs`
- `scripts/tests/helper-link.test.mjs`
- `scripts/tests/home-stats.test.mjs`
- `scripts/tests/i18n-locale-parity.test.mjs`
- `scripts/tests/i18n-placeholders.test.mjs`
- `scripts/tests/import-retry.test.mjs`
- `scripts/tests/journal-telemetry.test.mjs`
- `scripts/tests/large-route-ui.test.mjs`
- `scripts/tests/large-route.test.mjs`
- `scripts/tests/leaderboard-stats-route.test.mjs`
- `scripts/tests/leaderboard-ui.test.mjs`
- `scripts/tests/localized-content.test.mjs`
- `scripts/tests/logs-upload-route.test.mjs`
- `scripts/tests/map-layer-defaults.test.mjs`
- `scripts/tests/market-find-legacy.test.mjs`
- `scripts/tests/menu-i18n.test.mjs`
- `scripts/tests/migrations-sql.test.mjs`
- `scripts/tests/monitor-agent.test.mjs`
- `scripts/tests/monitor-bootstrap.test.mjs`
- `scripts/tests/oauth-selfhost.test.mjs`
- `scripts/tests/outfitting-analysis.test.mjs`
- `scripts/tests/outfitting-catalog.test.mjs`
- `scripts/tests/outfitting-data-cache.test.mjs`
- `scripts/tests/outfitting-i18n.test.mjs`
- `scripts/tests/outfitting-ui.test.mjs`
- `scripts/tests/outfitting.test.mjs`
- `scripts/tests/pg-reachability.test.mjs`
- `scripts/tests/pilot-stats-source.test.mjs`
- `scripts/tests/powerplay-admin.test.mjs`
- `scripts/tests/powerplay-lib.test.mjs`
- `scripts/tests/powerplay-owner.test.mjs`
- `scripts/tests/powerplay-sync.test.mjs`
- `scripts/tests/powerplay-ui.test.mjs`
- `scripts/tests/privacy.test.mjs`
- `scripts/tests/profiles-access-repair.test.mjs`
- `scripts/tests/profiles-rls-hardening.test.mjs`
- `scripts/tests/progress-sync.test.mjs`
- `scripts/tests/projects-route.test.mjs`
- `scripts/tests/raven-project-route.test.mjs`
- `scripts/tests/react-hook-order.test.mjs`
- `scripts/tests/realtime-lifecycle.test.mjs`
- `scripts/tests/rebuild-now.test.mjs`
- `scripts/tests/release-upload-limits.test.mjs`
- `scripts/tests/server-jobs-cli.test.mjs`
- `scripts/tests/server-jobs.test.mjs`
- `scripts/tests/ship-route.test.mjs`
- `scripts/tests/site-projects.test.mjs`
- `scripts/tests/spansh-systems.test.mjs`
- `scripts/tests/squadron-form.test.mjs`
- `scripts/tests/squadron-game.test.mjs`
- `scripts/tests/squadron-images-db.test.mjs`
- `scripts/tests/squadron-images.test.mjs`
- `scripts/tests/squadron-journal-db.test.mjs`
- `scripts/tests/station-commerce-api.test.mjs`
- `scripts/tests/station-commerce-db.test.mjs`
- `scripts/tests/station-search-ui.test.mjs`
- `scripts/tests/station-search.test.mjs`
- `scripts/tests/storage-check.test.mjs`
- `scripts/tests/storage-repair.test.mjs`
- `scripts/tests/subscription-bonus.test.mjs`
- `scripts/tests/supabase-gateway.test.mjs`
- `scripts/tests/supabase-net-watchdog.test.mjs`
- `scripts/tests/system-architect.test.mjs`
- `scripts/tests/system-coordinates-ui.test.mjs`
- `scripts/tests/system-coordinates.test.mjs`
- `scripts/tests/system-identity.test.mjs`
- `scripts/tests/system-map-3d-controls.test.mjs`
- `scripts/tests/system-map-hover.test.mjs`
- `scripts/tests/system-map-navigation.test.mjs`
- `scripts/tests/system-orrery-3d.test.mjs`
- `scripts/tests/system-orrery.test.mjs`
- `scripts/tests/system-overview-ui.test.mjs`
- `scripts/tests/system-progress-site.test.mjs`
- `scripts/tests/systems-route-hint.test.mjs`
- `scripts/tests/tbank-payments.test.mjs`
- `scripts/tests/unified-system-data.test.mjs`
- `scripts/tests/update-agent.test.mjs`
- `scripts/tests/update-migrations.test.mjs`
- `scripts/tests/update-script.test.mjs`
- `scripts/tests/uploader-build-kit.test.mjs`
- `scripts/tests/uploader-launcher-chunks.test.mjs`
- `scripts/tests/uploader-routes.test.mjs`
- `scripts/tests/uploader-server-release.test.mjs`
- `scripts/tests/uploader-setup.test.mjs`
- `scripts/tests/uploader-store.test.mjs`
- `scripts/tests/vk-auth.test.mjs`
- `scripts/tests/yandex-auth.test.mjs`

### Browser / Playwright

- `tests/browser/admin-outfitting.spec.ts`
- `tests/browser/atlas-ring.spec.ts`
- `tests/browser/mobile-shell.spec.ts`
- `tests/browser/site.spec.ts`
- `tests/browser/station-search.spec.ts`

## 8. Операционные скрипты, деплой, Android

- `android-app/QUICKSTART.md`
- `android-app/README.md`
- `android-app/app/build.gradle.kts`
- `android-app/app/proguard-rules.pro`
- `android-app/app/src/debug/AndroidManifest.xml`
- `android-app/app/src/debug/res/xml/network_security_config.xml`
- `android-app/app/src/main/AndroidManifest.xml`
- `android-app/app/src/main/java/com/edringcolony/monitor/EDApplication.kt`
- `android-app/app/src/main/java/com/edringcolony/monitor/MainActivity.kt`
- `android-app/app/src/main/java/com/edringcolony/monitor/data/local/TokenManager.kt`
- `android-app/app/src/main/java/com/edringcolony/monitor/data/model/AdminSummary.kt`
- `android-app/app/src/main/java/com/edringcolony/monitor/data/network/ApiService.kt`
- `android-app/app/src/main/java/com/edringcolony/monitor/data/network/AuthInterceptor.kt`
- `android-app/app/src/main/java/com/edringcolony/monitor/data/network/RetrofitClient.kt`
- `android-app/app/src/main/java/com/edringcolony/monitor/data/repository/MonitorRepository.kt`
- `android-app/app/src/main/java/com/edringcolony/monitor/ui/components/LoadingView.kt`
- `android-app/app/src/main/java/com/edringcolony/monitor/ui/components/StatCard.kt`
- `android-app/app/src/main/java/com/edringcolony/monitor/ui/components/StatusPill.kt`
- `android-app/app/src/main/java/com/edringcolony/monitor/ui/navigation/BottomNav.kt`
- `android-app/app/src/main/java/com/edringcolony/monitor/ui/navigation/NavGraph.kt`
- `android-app/app/src/main/java/com/edringcolony/monitor/ui/screens/BillingScreen.kt`
- `android-app/app/src/main/java/com/edringcolony/monitor/ui/screens/DashboardScreen.kt`
- `android-app/app/src/main/java/com/edringcolony/monitor/ui/screens/LoginScreen.kt`
- `android-app/app/src/main/java/com/edringcolony/monitor/ui/screens/MonitorScreen.kt`
- `android-app/app/src/main/java/com/edringcolony/monitor/ui/screens/SystemsScreen.kt`
- `android-app/app/src/main/java/com/edringcolony/monitor/ui/screens/WebViewScreen.kt`
- `android-app/app/src/main/java/com/edringcolony/monitor/ui/theme/Color.kt`
- `android-app/app/src/main/java/com/edringcolony/monitor/ui/theme/Theme.kt`
- `android-app/app/src/main/java/com/edringcolony/monitor/ui/theme/Type.kt`
- `android-app/app/src/main/res/drawable/ic_launcher_background.xml`
- `android-app/app/src/main/res/drawable/ic_launcher_foreground.xml`
- `android-app/app/src/main/res/mipmap-hdpi/ic_launcher.xml`
- `android-app/app/src/main/res/mipmap-hdpi/ic_launcher_round.xml`
- `android-app/app/src/main/res/mipmap-mdpi/ic_launcher.xml`
- `android-app/app/src/main/res/mipmap-mdpi/ic_launcher_round.xml`
- `android-app/app/src/main/res/mipmap-xhdpi/ic_launcher.xml`
- `android-app/app/src/main/res/mipmap-xhdpi/ic_launcher_round.xml`
- `android-app/app/src/main/res/mipmap-xxhdpi/ic_launcher.xml`
- `android-app/app/src/main/res/mipmap-xxhdpi/ic_launcher_round.xml`
- `android-app/app/src/main/res/mipmap-xxxhdpi/ic_launcher.xml`
- `android-app/app/src/main/res/mipmap-xxxhdpi/ic_launcher_round.xml`
- `android-app/app/src/main/res/values/colors.xml`
- `android-app/app/src/main/res/values/strings.xml`
- `android-app/app/src/main/res/values/themes.xml`
- `android-app/app/src/main/res/xml/backup_rules.xml`
- `android-app/app/src/main/res/xml/data_extraction_rules.xml`
- `android-app/build.gradle.kts`
- `android-app/docs-mockup.png`
- `android-app/gradle.properties`
- `android-app/gradle/wrapper/gradle-wrapper.properties`
- `android-app/settings.gradle.kts`
- `deploy/Dockerfile.jobs`
- `deploy/Dockerfile.monitor`
- `deploy/Dockerfile.update-agent`
- `deploy/apply-env.sh`
- `deploy/apply-smtp.sh`
- `deploy/compose-lib.sh`
- `deploy/compose.legacy-build.yml`
- `deploy/compose.supabase-net.yml`
- `deploy/crontab.example`
- `deploy/db-backup.sh`
- `deploy/db-recover.sh`
- `deploy/diag-after-update.sh`
- `deploy/diag-cookies.sh`
- `deploy/docker-disk-report.sh`
- `deploy/docker-next-cache-guard.sh`
- `deploy/ed-ring-colony-update.service`
- `deploy/ed-ring-colony.service`
- `deploy/fix-update-stuck.sh`
- `deploy/make-dist.sh`
- `deploy/migrate-galaxy-dump.sh`
- `deploy/migrate-uploader-store.sh`
- `deploy/monitoring-setup.sh`
- `deploy/nginx.conf`
- `deploy/prepare-standalone.sh`
- `deploy/rebuild-now.sh`
- `deploy/selfhost/check-release-upload-limit.sh`
- `deploy/selfhost/fix-storage-limit.sh`
- `deploy/selfhost/generate-keys.sh`
- `deploy/selfhost/install.sh`
- `deploy/selfhost/nginx-realtime-location.conf`
- `deploy/selfhost/nginx-selfhost.conf`
- `deploy/selfhost/realtime-check.py`
- `deploy/selfhost/smoke-test.sh`
- `deploy/selfhost/storage-check.py`
- `deploy/selfhost/supabase-auth.override.yml`
- `deploy/selfhost/upgrade.py`
- `deploy/start-monitoring.sh`
- `deploy/start-update-agent.sh`
- `deploy/storage-repair.sh`
- `deploy/update-agent-entrypoint.sh`
- `deploy/update-project.sh`
- `deploy/web-entrypoint.sh`
- `scripts/apply-galnet-migration.mjs`
- `scripts/build-nebula-catalog.mjs`
- `scripts/build-outfitting-data.mjs`
- `scripts/build-station-search-items.mjs`
- `scripts/check-db-reachability.mjs`
- `scripts/check-edsy-gaps.mjs`
- `scripts/check-nebula-shaders.mjs`
- `scripts/data/experimental-effects.json`
- `scripts/data/extra-blueprints.json`
- `scripts/data/factory-modules.json`
- `scripts/data/ship-update-20260428-lynx.json`
- `scripts/data/ship-update-20261020.json`
- `scripts/eddn-worker.ts`
- `scripts/eddn_listener.py`
- `scripts/extract-regions.mjs`
- `scripts/fetch-progress.mjs`
- `scripts/galnet-sync.mjs`
- `scripts/import-spansh-systems.mjs`
- `scripts/job-schedule.mjs`
- `scripts/lib/galnet-source.mjs`
- `scripts/lib/galnet-sync.mjs`
- `scripts/lib/progress-sync.mjs`
- `scripts/lib/translate.mjs`
- `scripts/lib/update-state.mjs`
- `scripts/monitor-agent.mjs`
- `scripts/preview-nebulae.mjs`
- `scripts/run-tests.mjs`
- `scripts/server-jobs.mjs`
- `scripts/update-agent.mjs`
- `scripts/upload-ship-images.mjs`
