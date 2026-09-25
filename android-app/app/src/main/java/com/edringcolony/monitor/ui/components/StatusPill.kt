package com.edringcolony.monitor.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.edringcolony.monitor.ui.theme.*

@Composable
fun StatusPill(
    level: String,
    label: String? = null,
    modifier: Modifier = Modifier
) {
    val (color, bg) = when (level.lowercase()) {
        "healthy", "online", "done", "current" -> Green to Color(0xFF1A2E22)
        "warning", "building", "different", "outdated" -> Color(0xFFF2B544) to Color(0xFF2E2512)
        "critical", "stopped", "unhealthy", "missing", "failed" -> Red to Color(0xFF2E1A1A)
        else -> Muted to Color(0xFF25282B)
    }

    val text = label ?: when (level.lowercase()) {
        "healthy" -> "OK"
        "warning" -> "WARN"
        "critical" -> "CRIT"
        "current" -> "CURRENT"
        "different" -> "OUTDATED"
        else -> level.uppercase()
    }

    Row(
        modifier = modifier
            .clip(RoundedCornerShape(99.dp))
            .background(bg)
            .border(1.dp, color.copy(alpha = 0.4f), RoundedCornerShape(99.dp))
            .padding(horizontal = 8.dp, vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        Box(
            modifier = Modifier
                .size(6.dp)
                .clip(RoundedCornerShape(3.dp))
                .background(color)
        )
        Text(
            text = text,
            fontFamily = FontFamily.Monospace,
            fontWeight = FontWeight.Bold,
            fontSize = 10.sp,
            letterSpacing = (0.8).sp,
            color = color
        )
    }
}

@Composable
fun LevelBadge(
    status: String,
    modifier: Modifier = Modifier
) {
    val (color, label) = when (status.lowercase()) {
        "planned" -> Muted to "PLANNED"
        "building" -> Orange to "BUILDING"
        "done" -> Green to "DONE"
        "healthy" -> Green to "HEALTHY"
        "warning" -> Color(0xFFF2B544) to "WARNING"
        "critical" -> Red to "CRITICAL"
        else -> Muted to status.uppercase()
    }
    StatusPill(level = status, label = label, modifier = modifier)
}
