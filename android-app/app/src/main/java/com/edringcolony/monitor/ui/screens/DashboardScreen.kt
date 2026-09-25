package com.edringcolony.monitor.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.edringcolony.monitor.data.model.AdminSummaryResponse
import com.edringcolony.monitor.ui.components.*
import com.edringcolony.monitor.ui.theme.*

@Composable
fun DashboardScreen(
    summary: AdminSummaryResponse?,
    onRefresh: () -> Unit
) {
    if (summary == null) {
        LoadingView()
        return
    }

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .background(Bg)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        item {
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("ОБЗОР СИСТЕМЫ", fontFamily = FontFamily.Monospace, fontSize = 16.sp, letterSpacing = 2.sp, color = Text)
                Text(summary.checkedAt?.take(19) ?: "", fontFamily = FontFamily.Monospace, fontSize = 10.sp, color = Muted)
            }
        }

        item {
            HudCard {
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    StatusPill(level = summary.health?.app ?: "unknown", label = "APP: ${summary.health?.app ?: "—"}")
                    StatusPill(level = summary.health?.database ?: "unknown", label = "DB: ${summary.health?.database ?: "—"}")
                    StatusPill(level = summary.health?.disk ?: "unknown", label = "DISK: ${summary.health?.disk ?: "—"}")
                    StatusPill(level = summary.health?.overall ?: "unknown", label = summary.health?.overall ?: "—")
                }
                Spacer(Modifier.height(12.dp))
                // Stats grid 2x3
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                        StatCard(label = "Командиры", value = "${summary.overview?.profiles ?: "—"}", modifier = Modifier.weight(1f))
                        StatCard(label = "Хабы", value = "${summary.overview?.hubs ?: "—"}", modifier = Modifier.weight(1f))
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                        StatCard(label = "Маршрут", value = "${summary.overview?.routeSystems ?: "—"}", accent = Cyan, modifier = Modifier.weight(1f))
                        StatCard(label = "Новости", value = "${summary.overview?.news ?: "—"}", accent = Cyan, modifier = Modifier.weight(1f))
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                        StatCard(label = "Тикеты OPEN", value = "${summary.overview?.ticketsOpen ?: "—"}", accent = if ((summary.overview?.ticketsOpen ?: 0) > 0) Red else Muted, modifier = Modifier.weight(1f))
                        StatCard(label = "Галактика", value = summary.overview?.galaxySystems?.let { "${it/1_000_000}M" } ?: "—", accent = Green, modifier = Modifier.weight(1f))
                    }
                }
            }
        }

        item {
            val app = summary.monitor?.application
            HudCard {
                SectionHeader(title = "Приложение")
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text("UPTIME", fontFamily = FontFamily.Monospace, fontSize = 10.sp, color = Muted, letterSpacing = 1.sp)
                        Text(formatUptime(app?.uptimeSeconds), fontFamily = FontFamily.Monospace, fontSize = 13.sp, color = Text)
                    }
                    Column(modifier = Modifier.weight(1f)) {
                        Text("NODE", fontFamily = FontFamily.Monospace, fontSize = 10.sp, color = Muted, letterSpacing = 1.sp)
                        Text(app?.nodeVersion ?: "—", fontFamily = FontFamily.Monospace, fontSize = 13.sp, color = Text)
                    }
                }
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text("RSS", fontFamily = FontFamily.Monospace, fontSize = 10.sp, color = Muted, letterSpacing = 1.sp)
                        Text(formatBytes(app?.memory?.rssBytes), fontFamily = FontFamily.Monospace, fontSize = 13.sp, color = Text)
                    }
                    Column(modifier = Modifier.weight(1f)) {
                        Text("HEAP", fontFamily = FontFamily.Monospace, fontSize = 10.sp, color = Muted, letterSpacing = 1.sp)
                        Text(formatBytes(app?.memory?.heapUsedBytes), fontFamily = FontFamily.Monospace, fontSize = 13.sp, color = Text)
                    }
                }
            }
        }

        item {
            val db = summary.monitor?.database
            HudCard {
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    SectionHeader(title = "База данных", modifier = Modifier.weight(1f))
                    StatusPill(level = db?.status ?: "unknown")
                }
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text("SIZE", fontFamily = FontFamily.Monospace, fontSize = 10.sp, color = Muted)
                        Text(formatBytes(db?.size?.databaseBytes), fontFamily = FontFamily.Monospace, fontSize = 13.sp, color = Text)
                    }
                    Column(modifier = Modifier.weight(1f)) {
                        Text("LATENCY", fontFamily = FontFamily.Monospace, fontSize = 10.sp, color = Muted)
                        Text(db?.latencyMs?.let { "${it} ms" } ?: "—", fontFamily = FontFamily.Monospace, fontSize = 13.sp, color = Text)
                    }
                }
                val largest = db?.size?.largest?.firstOrNull()
                if (largest != null) {
                    Spacer(Modifier.height(8.dp))
                    Text("LARGEST: ${largest.name} — ${formatBytes(largest.totalBytes)}", fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = Muted)
                }
            }
        }

        item {
            val disk = summary.monitor?.disk
            HudCard {
                SectionHeader(title = "Диск")
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text("USED", fontFamily = FontFamily.Monospace, fontSize = 10.sp, color = Muted)
                        Text(disk?.usedPercent?.let { "$it%" } ?: "—", fontFamily = FontFamily.Monospace, fontSize = 13.sp, color = Text)
                    }
                    Column(modifier = Modifier.weight(1f)) {
                        Text("FREE", fontFamily = FontFamily.Monospace, fontSize = 10.sp, color = Muted)
                        Text(formatBytes(disk?.availableBytes), fontFamily = FontFamily.Monospace, fontSize = 13.sp, color = Text)
                    }
                }
                if (disk?.usedPercent != null) {
                    Spacer(Modifier.height(10.dp))
                    androidx.compose.foundation.layout.Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(6.dp)
                            .background(Line)
                    ) {
                        Box(
                            modifier = Modifier
                                .fillMaxHeight()
                                .fillMaxWidth((disk.usedPercent / 100.0).toFloat().coerceIn(0f, 1f))
                                .background(if (disk.usedPercent > 90) Red else Orange)
                        )
                    }
                }
            }
        }

        item {
            val proj = summary.monitor?.project
            HudCard {
                SectionHeader(title = "Версия проекта")
                Text("CURRENT: ${proj?.currentSha?.take(7) ?: "—"} ${proj?.currentRef?.let { "($it)" } ?: ""}", fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = Orange)
                Text("UPSTREAM: ${proj?.upstreamSha?.take(7) ?: "—"} [${proj?.upstreamBranch ?: "main"}]", fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = Cyan)
                Text("AHEAD: ${proj?.aheadBy ?: "—"} коммитов • MIGRATIONS: ${proj?.pendingMigrations?.size ?: 0}", fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = Text)
                if (!proj?.pendingMigrations.isNullOrEmpty()) {
                    Spacer(Modifier.height(6.dp))
                    Text(proj.pendingMigrations.joinToString(", "), fontFamily = FontFamily.Monospace, fontSize = 10.sp, color = Red, modifier = Modifier.background(Red.copy(alpha = 0.08f)).padding(6.dp))
                }
            }
        }

        item { Spacer(Modifier.height(80.dp)) }
    }
}
