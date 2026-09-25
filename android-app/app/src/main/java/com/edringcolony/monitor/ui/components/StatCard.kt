package com.edringcolony.monitor.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.edringcolony.monitor.ui.theme.*

@Composable
fun StatCard(
    label: String,
    value: String,
    accent: Color = Orange,
    modifier: Modifier = Modifier
) {
    Column(
        modifier = modifier
            .clip(RoundedCornerShape(2.dp))
            .background(CardBg)
            .border(1.dp, Line, RoundedCornerShape(2.dp))
            .padding(12.dp)
    ) {
        Text(
            text = label.uppercase(),
            fontFamily = FontFamily.Monospace,
            fontSize = 10.sp,
            letterSpacing = 2.sp,
            fontWeight = FontWeight.SemiBold,
            color = Muted
        )
        Spacer(Modifier.height(6.dp))
        Text(
            text = value,
            fontFamily = FontFamily.Monospace,
            fontSize = 20.sp,
            fontWeight = FontWeight.Bold,
            color = accent,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
    }
}

@Composable
fun SectionHeader(
    title: String,
    modifier: Modifier = Modifier,
    action: @Composable (() -> Unit)? = null
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(vertical = 8.dp),
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Text(
            text = title.uppercase(),
            fontFamily = FontFamily.Monospace,
            fontSize = 13.sp,
            letterSpacing = 2.sp,
            fontWeight = FontWeight.Bold,
            color = Orange
        )
        action?.invoke()
    }
}

@Composable
fun HudCard(
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(4.dp))
            .background(Panel)
            .border(1.dp, Line, RoundedCornerShape(4.dp))
            .padding(16.dp),
        content = content
    )
}

fun formatBytes(bytes: Long?): String {
    if (bytes == null || bytes < 0) return "—"
    val units = arrayOf("Б", "КБ", "МБ", "ГБ", "ТБ")
    if (bytes < 1024) return "$bytes ${units[0]}"
    val exp = (Math.log(bytes.toDouble()) / Math.log(1024.0)).toInt().coerceAtMost(units.size - 1)
    val value = bytes / Math.pow(1024.0, exp.toDouble())
    return if (value >= 100) "${value.toInt()} ${units[exp]}" else "${String.format("%.1f", value)} ${units[exp]}"
}

fun formatUptime(seconds: Long?): String {
    if (seconds == null) return "—"
    val h = seconds / 3600
    val m = (seconds % 3600) / 60
    return "${h}ч ${m}м"
}
