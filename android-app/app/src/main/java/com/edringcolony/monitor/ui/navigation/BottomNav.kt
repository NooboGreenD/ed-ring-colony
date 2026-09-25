package com.edringcolony.monitor.ui.navigation

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.ui.graphics.vector.ImageVector

sealed class Screen(val route: String, val label: String, val icon: ImageVector, val hudIcon: String) {
    object Dashboard : Screen("dashboard", "Обзор", Icons.Default.Dashboard, "◧")
    object Monitor : Screen("monitor", "Монитор", Icons.Default.Memory, "◍")
    object Billing : Screen("billing", "Биллинг", Icons.Default.AccountBalanceWallet, "₿")
    object Systems : Screen("systems", "Системы", Icons.Default.Public, "⬡")
    object Content : Screen("content", "Контент", Icons.Default.Article, "☰")
    object Users : Screen("users", "Юзеры", Icons.Default.People, "👤")
    object Support : Screen("support", "Поддержка", Icons.Default.SupportAgent, "🎧")
    object Backup : Screen("backup", "Бэкапы", Icons.Default.Backup, "💾")
    object Auth : Screen("auth", "Auth", Icons.Default.Lock, "🔒")
}

val bottomNavItems = listOf(
    Screen.Dashboard,
    Screen.Monitor,
    Screen.Billing,
    Screen.Systems,
    Screen.Content,
    Screen.Users,
    Screen.Support,
    Screen.Backup,
    Screen.Auth
)

val allScreens = bottomNavItems
