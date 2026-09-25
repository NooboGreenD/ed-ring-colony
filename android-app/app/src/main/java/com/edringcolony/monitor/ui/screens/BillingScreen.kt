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
fun BillingScreen(summary: AdminSummaryResponse?) {
    val billing = summary?.billing
    if (billing == null) {
        LoadingView(message = "Загрузка биллинга...")
        return
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize().background(Bg).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        item { SectionHeader(title = "Биллинг и статистика") }

        item {
            HudCard {
                SectionHeader(title = "Выручка и метрики")
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                    StatCard(label = "Total Revenue", value = "${billing.revenue?.total?.toInt() ?: 0} ₽", accent = Green, modifier = Modifier.weight(1f))
                    StatCard(label = "Transactions", value = "${billing.transactions?.total ?: 0}", modifier = Modifier.weight(1f))
                }
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                    StatCard(label = "Avg Check", value = "${billing.revenue?.avgCheck?.toInt() ?: 0} ₽", modifier = Modifier.weight(1f))
                    StatCard(label = "ARPU", value = "${billing.revenue?.arpu?.toInt() ?: 0} ₽", accent = Cyan, modifier = Modifier.weight(1f))
                }
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                    StatCard(label = "Active Subs", value = "${billing.subscriptions?.active ?: 0}", accent = Green, modifier = Modifier.weight(1f))
                    StatCard(label = "Churn", value = "${billing.subscriptions?.churnRate ?: 0.0}%", accent = Red, modifier = Modifier.weight(1f))
                }
            }
        }

        item {
            HudCard {
                SectionHeader(title = "Телеметрия проекта")
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                    StatCard(label = "Пилоты", value = "${billing.telemetry?.totalRegisteredPilots ?: "—"}", modifier = Modifier.weight(1f))
                    StatCard(label = "Системы", value = "${billing.telemetry?.totalSystemsClaimed ?: "—"}", modifier = Modifier.weight(1f))
                }
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                    StatCard(label = "Постройки", value = "${billing.telemetry?.totalFacilitiesBuilt ?: "—"}", accent = Green, modifier = Modifier.weight(1f))
                    StatCard(label = "Тоннаж", value = billing.telemetry?.totalTonnageHauled?.let { "${(it/1000).toInt()}k" } ?: "—", modifier = Modifier.weight(1f))
                }
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                    StatCard(label = "Тикеты OPEN", value = "${billing.telemetry?.supportTicketsOpen ?: 0}", accent = Red, modifier = Modifier.weight(1f))
                    StatCard(label = "API Tokens", value = "${billing.telemetry?.apiTokensActive ?: "—"}", accent = Cyan, modifier = Modifier.weight(1f))
                }
            }
        }

        item {
            HudCard {
                SectionHeader(title = "Топ товары")
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    billing.topProducts?.take(5)?.forEach { p ->
                        Row(modifier = Modifier.fillMaxWidth().background(CardBg).padding(8.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text(p.name ?: p.id ?: "—", fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = Text, modifier = Modifier.weight(1f))
                            Text("${p.sales ?: p.count ?: 0} продаж", fontFamily = FontFamily.Monospace, fontSize = 10.sp, color = Muted)
                        }
                    } ?: Text("Нет данных", fontFamily = FontFamily.Monospace, fontSize = 12.sp, color = Muted)
                }
            }
        }

        item { Spacer(Modifier.height(80.dp)) }
    }
}
