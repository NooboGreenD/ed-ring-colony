package com.edringcolony.monitor.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable

private val DarkColorScheme = darkColorScheme(
    primary = Orange,
    secondary = Cyan,
    tertiary = Green,
    background = Bg,
    surface = Panel,
    surfaceVariant = PanelHover,
    onBackground = Text,
    onSurface = Text,
    error = Red,
    outline = Line
)

@Composable
fun EDRingColonyTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit
) {
    MaterialTheme(
        colorScheme = DarkColorScheme,
        typography = Typography,
        content = content
    )
}
