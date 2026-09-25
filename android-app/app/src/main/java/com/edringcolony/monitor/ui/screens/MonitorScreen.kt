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
fun MonitorScreen(summary: AdminSummaryResponse?) {
    if (summary?.monitor == null) {
        LoadingView()
        return
    }
    val monitor = summary.monitor

    LazyColumn(
        modifier = Modifier.fillMaxSize().background(Bg).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        item { SectionHeader(title = "Мониторинг сервера") }

        item {
            HudCard {
                SectionHeader(title = "Docker контейнеры")
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    monitor.docker?.containers?.forEach { c ->
                        Row(
                            modifier = Modifier.fillMaxWidth()
                                .clip(RoundedCornerShape(2.dp))
                                .background(CardBg)
                                .border(1.dp, Line, RoundedCornerShape(2.dp))
                                .border(3.dp, if (c.state == "running" && c.health != "unhealthy") Green else Red, RoundedCornerShape(2.dp))
                                .padding(10.dp),
                            horizontalArrangement = Arrangement.SpaceBetween
                        ) {
                            Column {
                                Text(c.service ?: "—", fontFamily = FontFamily.Monospace, fontSize = 12.sp, color = Text)
                                Text("${c.state} • ${c.health} • restart ${c.restartCount}", fontFamily = FontFamily.Monospace, fontSize = 10.sp, color = Muted)
                            }
                            StatusPill(level = if (c.state == "running" && c.health != "unhealthy") "healthy" else "critical")
                        }
                    } ?: Text("Нет данных", fontFamily = FontFamily.Monospace, fontSize = 12.sp, color = Muted)
                }
            }
        }

        item {
            HudCard {
                SectionHeader(title = "Фоновые задачи")
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    monitor.scheduler?.jobs?.forEach { j ->
                        Column(
                            modifier = Modifier.fillMaxWidth()
                                .clip(RoundedCornerShape(2.dp))
                                .background(CardBg)
                                .border(1.dp, Line, RoundedCornerShape(2.dp))
                                .padding(10.dp)
                        ) {
                            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                Text(j.name ?: "—", fontFamily = FontFamily.Monospace, fontSize = 12.sp, color = Text)
                                StatusPill(level = j.status ?: "unknown")
                            }
                            Text("LAST ${j.lastSuccessAt?.take(19) ?: "—"} • NEXT ${j.nextRunAt?.take(19) ?: "—"}", fontFamily = FontFamily.Monospace, fontSize = 10.sp, color = Muted)
                            if (!j.lastError.isNullOrBlank()) {
                                Spacer(Modifier.height(6.dp))
                                Text(j.lastError, fontFamily = FontFamily.Monospace, fontSize = 10.sp, color = Orange, modifier = Modifier.background(WarningBg).padding(6.dp))
                            }
                        }
                    }
                }
            }
        }

        item {
            HudCard {
                SectionHeader(title = "Контент и переводы")
                Text("TRANSLATE: ${if (monitor.content?.translateConfigured == true) "настроен" else "не настроен"}", fontFamily = FontFamily.Monospace, fontSize = 12.sp, color = if (monitor.content?.translateConfigured == true) Green else Red)
                Text("PENDING: ${monitor.content?.pendingTotal ?: "—"} статей", fontFamily = FontFamily.Monospace, fontSize = 12.sp, color = Text)
                monitor.content?.lastSync?.let {
                    Text("LAST SYNC: ${it.at?.take(19) ?: "—"} • ${it.status} • +${it.newCount ?: 0}", fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = Muted)
                }
                monitor.content?.queue?.forEach { q ->
                    Text("${q.table}: ${q.pending ?: "—"} в очереди", fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = Muted)
                }
            }
        }

        item {
            HudCard {
                SectionHeader(title = "Топ таблиц БД")
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    monitor.database?.size?.largest?.forEach { t ->
                        val max = monitor.database.size.largest.firstOrNull()?.totalBytes ?: 1L
                        val pct = if (max > 0) (t.totalBytes ?: 0L).toFloat() / max.toFloat() else 0f
                        Column {
                            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                Text("${t.name} (${t.kind})", fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = Text, modifier = Modifier.weight(1f))
                                Text(formatBytes(t.totalBytes), fontFamily = FontFamily.Monospace, fontSize = 10.sp, color = Muted)
                            }
                            Spacer(Modifier.height(4.dp))
                            Box(modifier = Modifier.fillMaxWidth().height(4.dp).background(Line)) {
                                Box(modifier = Modifier.fillMaxHeight().fillMaxWidth(pct).background(Cyan))
                            }
                        }
                    }
                }
            }
        }

        item { Spacer(Modifier.height(80.dp)) }
    }
}
