package com.edringcolony.monitor.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

val Typography = Typography(
    // H1 hero — uppercase, letter-spacing 6px, 800
    displayLarge = TextStyle(
        fontFamily = FontFamily.Monospace,
        fontWeight = FontWeight.ExtraBold,
        fontSize = 28.sp,
        letterSpacing = (2).sp,
        color = Text
    ),
    // H2 — 18px, 700, uppercase, 2px spacing
    headlineMedium = TextStyle(
        fontFamily = FontFamily.Monospace,
        fontWeight = FontWeight.Bold,
        fontSize = 16.sp,
        letterSpacing = 2.sp,
        color = Text
    ),
    // H3 — 16px, 600, uppercase, orange
    titleLarge = TextStyle(
        fontFamily = FontFamily.Monospace,
        fontWeight = FontWeight.SemiBold,
        fontSize = 13.sp,
        letterSpacing = 2.sp,
        color = Orange
    ),
    // Body — 14px, Segoe UI equivalent
    bodyLarge = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.Normal,
        fontSize = 14.sp,
        lineHeight = 22.sp,
        color = Text
    ),
    // Label — 11px, 600, uppercase, muted, monospace
    labelSmall = TextStyle(
        fontFamily = FontFamily.Monospace,
        fontWeight = FontWeight.SemiBold,
        fontSize = 10.sp,
        letterSpacing = 2.sp,
        color = Muted
    ),
    // Button — 12-13px, uppercase, 2-3px spacing, monospace
    labelLarge = TextStyle(
        fontFamily = FontFamily.Monospace,
        fontWeight = FontWeight.Normal,
        fontSize = 12.sp,
        letterSpacing = 2.sp,
        color = Orange
    )
)
