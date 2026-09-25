package com.edringcolony.monitor.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.edringcolony.monitor.data.model.AdminSummaryResponse
import com.edringcolony.monitor.ui.components.*
import com.edringcolony.monitor.ui.theme.*

@Composable
fun SystemsScreen(summary: AdminSummaryResponse?) {
    LazyColumn(
        modifier = Modifier.fillMaxSize().background(Bg).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        item { SectionHeader(title = "Системы и маршрут") }

        item {
            HudCard {
                SectionHeader(title = "Хабы (${summary?.lists?.hubs?.size ?: summary?.overview?.hubs ?: 0})")
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    summary?.lists?.hubs?.forEach { h ->
                        Row(
                            modifier = Modifier.fillMaxWidth()
                                .clip(RoundedCornerShape(2.dp))
                                .background(CardBg)
                                .border(1.dp, Line, RoundedCornerShape(2.dp))
                                .padding(10.dp),
                            horizontalArrangement = Arrangement.SpaceBetween
                        ) {
                            Column(modifier = Modifier.weight(1f)) {
                                Text(h.name ?: "—", fontFamily = FontFamily.Default, fontSize = 13.sp, color = Text)
                                Text("${h.systemName} • #${h.segmentOrder}", fontFamily = FontFamily.Monospace, fontSize = 10.sp, color = Muted)
                            }
                            LevelBadge(status = h.status ?: "unknown")
                        }
                    } ?: Text("Нет данных", fontFamily = FontFamily.Monospace, fontSize = 12.sp, color = Muted)
                }
            }
        }

        item {
            HudCard {
                SectionHeader(title = "Маршрут (${summary?.overview?.routeSystems ?: 0})")
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    summary?.lists?.routeSystems?.forEach { r ->
                        Row(
                            modifier = Modifier.fillMaxWidth()
                                .clip(RoundedCornerShape(2.dp))
                                .background(CardBg)
                                .border(1.dp, Line, RoundedCornerShape(2.dp))
                                .padding(8.dp),
                            horizontalArrangement = Arrangement.SpaceBetween
                        ) {
                            Column(modifier = Modifier.weight(1f)) {
                                Text("${r.sortOrder}. ${r.systemName}", fontFamily = FontFamily.Default, fontSize = 12.sp, color = Text)
                                Spacer(Modifier.height(4.dp))
                                Box(modifier = Modifier.fillMaxWidth().height(3.dp).background(Line)) {
                                    Box(modifier = Modifier.fillMaxHeight().fillMaxWidth((r.progress ?: 0) / 100f).background(Orange))
                                }
                            }
                            Text("${r.progress ?: 0}%", fontFamily = FontFamily.Monospace, fontSize = 10.sp, color = Muted, modifier = Modifier.padding(start = 8.dp))
                        }
                    } ?: Text("Нет данных маршрута", fontFamily = FontFamily.Monospace, fontSize = 12.sp, color = Muted)
                }
            }
        }

        item {
            HudCard {
                SectionHeader(title = "Галактика")
                Text("TOTAL SYSTEMS: ${summary?.overview?.galaxySystems?.toString() ?: "—"}", fontFamily = FontFamily.Monospace, fontSize = 12.sp, color = Text)
                Spacer(Modifier.height(6.dp))
                Text(
                    "Каталог Spansh импортируется через Админка → Каталог систем. Полный дамп десятки ГБ, облако точек для карты.",
                    fontFamily = FontFamily.Default,
                    fontSize = 11.sp,
                    color = Muted
                )
            }
        }

        item { Spacer(Modifier.height(80.dp)) }
    }
}

@Composable
fun ContentScreen(summary: AdminSummaryResponse?) {
    LazyColumn(
        modifier = Modifier.fillMaxSize().background(Bg).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        item { SectionHeader(title = "Контент") }

        item {
            HudCard {
                SectionHeader(title = "Новости (${summary?.overview?.news ?: 0})")
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    summary?.lists?.recentNews?.forEach { n ->
                        Column(
                            modifier = Modifier.fillMaxWidth()
                                .clip(RoundedCornerShape(2.dp))
                                .background(CardBg)
                                .border(1.dp, Line, RoundedCornerShape(2.dp))
                                .padding(8.dp)
                        ) {
                            Text(n.title ?: "—", fontFamily = FontFamily.Default, fontSize = 12.sp, color = Text)
                            Text("${n.publishedAt?.take(19) ?: "—"} • ${n.translationStatus ?: "—"}", fontFamily = FontFamily.Monospace, fontSize = 10.sp, color = Muted)
                        }
                    } ?: Text("Нет новостей", fontFamily = FontFamily.Monospace, fontSize = 12.sp, color = Muted)
                }
            }
        }

        item {
            HudCard {
                SectionHeader(title = "Форум и комментарии")
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                    StatCard(label = "Темы", value = "${summary?.overview?.forumThreads ?: "—"}", modifier = Modifier.weight(1f))
                    StatCard(label = "Посты", value = "${summary?.overview?.forumPosts ?: "—"}", modifier = Modifier.weight(1f))
                }
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                    StatCard(label = "Комменты", value = "${summary?.overview?.comments ?: "—"}", modifier = Modifier.weight(1f))
                    StatCard(label = "Galnet", value = "${summary?.overview?.galnetPending ?: "—"}", accent = Cyan, modifier = Modifier.weight(1f))
                }
            }
        }

        item { Spacer(Modifier.height(80.dp)) }
    }
}

@Composable
fun UsersScreen(summary: AdminSummaryResponse?) {
    LazyColumn(
        modifier = Modifier.fillMaxSize().background(Bg).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        item { SectionHeader(title = "Пользователи и доступ") }
        item {
            HudCard {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                    StatCard(label = "Всего", value = "${summary?.overview?.profiles ?: "—"}", modifier = Modifier.weight(1f))
                    StatCard(label = "API Tokens", value = "${summary?.overview?.apiTokens ?: "—"}", accent = Cyan, modifier = Modifier.weight(1f))
                }
                Spacer(Modifier.height(12.dp))
                Text(
                    "Управление ролями, аватарами и правами доступно в полной админке /admin → Управление. Здесь — только счётчики и быстрый доступ.",
                    fontFamily = FontFamily.Default,
                    fontSize = 12.sp,
                    color = Muted
                )
            }
        }
        item { Spacer(Modifier.height(80.dp)) }
    }
}

@Composable
fun SupportScreen(summary: AdminSummaryResponse?) {
    LazyColumn(
        modifier = Modifier.fillMaxSize().background(Bg).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        item { SectionHeader(title = "Техподдержка") }
        item {
            HudCard {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                    StatCard(label = "Открытых", value = "${summary?.overview?.ticketsOpen ?: 0}", accent = Red, modifier = Modifier.weight(1f))
                    StatCard(label = "Всего", value = "${summary?.overview?.ticketsTotal ?: 0}", modifier = Modifier.weight(1f))
                }
                Spacer(Modifier.height(12.dp))
                Text("Тикеты обрабатываются в Админка → Техподдержка. Мобильная панель показывает только сводку.", fontFamily = FontFamily.Default, fontSize = 12.sp, color = Muted)
            }
        }
        item { Spacer(Modifier.height(80.dp)) }
    }
}

@Composable
fun BackupScreen(summary: AdminSummaryResponse?) {
    LazyColumn(
        modifier = Modifier.fillMaxSize().background(Bg).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        item { SectionHeader(title = "Бэкапы и обновления") }
        item {
            val proj = summary?.monitor?.project
            HudCard {
                SectionHeader(title = "Обновление проекта")
                Text("CURRENT: ${proj?.currentSha?.take(7) ?: "—"} ${proj?.currentRef?.let { "($it)" } ?: ""}", fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = Orange)
                Text("UPSTREAM: ${proj?.upstreamSha?.take(7) ?: "—"} [${proj?.upstreamBranch ?: "main"}] (${proj?.aheadBy ?: 0} новых)", fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = Cyan)
                Text("Updater: ${if (proj?.updater?.connected == true) "подключен" else "недоступен"} ${if (proj?.updater?.active == true) "• ACTIVE" else ""}", fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = if (proj?.updater?.connected == true) Green else Red)
                if (!proj?.pendingMigrations.isNullOrEmpty()) {
                    Spacer(Modifier.height(6.dp))
                    Text("Миграции: ${proj.pendingMigrations.joinToString(", ")}", fontFamily = FontFamily.Monospace, fontSize = 10.sp, color = Red)
                } else {
                    Spacer(Modifier.height(6.dp))
                    Text("Миграций нет", fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = Green)
                }
            }
        }
        item {
            HudCard {
                SectionHeader(title = "Последние бэкапы")
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    summary?.lists?.backupLog?.forEach { b ->
                        Column(modifier = Modifier.fillMaxWidth().background(CardBg).padding(8.dp)) {
                            Text("${b["fetched_at"] ?: b["created_at"] ?: "—"} • ${b["status"] ?: "—"}", fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = Text)
                            Text("${b["error_msg"] ?: "${b["articles_count"] ?: ""} статей"}", fontFamily = FontFamily.Monospace, fontSize = 10.sp, color = Muted)
                        }
                    } ?: Text("Нет логов бэкапа", fontFamily = FontFamily.Monospace, fontSize = 12.sp, color = Muted)
                }
            }
        }
        item { Spacer(Modifier.height(80.dp)) }
    }
}

@Composable
fun AuthScreen(summary: AdminSummaryResponse?) {
    LazyColumn(
        modifier = Modifier.fillMaxSize().background(Bg).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        item { SectionHeader(title = "Авторизация") }
        item {
            HudCard {
                SectionHeader(title = "Провайдеры")
                Text("Настройка OAuth: Discord, VK ID, Yandex ID, Frontier CAPI", fontFamily = FontFamily.Default, fontSize = 12.sp, color = Muted)
                Spacer(Modifier.height(8.dp))
                Text("Флаги из app_flags:", fontFamily = FontFamily.Monospace, fontSize = 10.sp, color = Muted, letterSpacing = 1.sp)
                Spacer(Modifier.height(6.dp))
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    summary?.flags?.take(10)?.forEach { f ->
                        Row(modifier = Modifier.fillMaxWidth().background(CardBg).padding(6.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text("${f["key"] ?: f["id"] ?: "—"}", fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = Text, modifier = Modifier.weight(1f))
                            Text("${f["value"] ?: f["enabled"] ?: ""}", fontFamily = FontFamily.Monospace, fontSize = 10.sp, color = Muted)
                        }
                    } ?: Text("Нет флагов", fontFamily = FontFamily.Monospace, fontSize = 12.sp, color = Muted)
                }
            }
        }
        item { Spacer(Modifier.height(80.dp)) }
    }
}
