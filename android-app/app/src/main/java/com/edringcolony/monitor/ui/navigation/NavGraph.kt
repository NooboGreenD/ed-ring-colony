package com.edringcolony.monitor.ui.navigation

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import com.edringcolony.monitor.data.model.AdminSummaryResponse
import com.edringcolony.monitor.ui.screens.*

// Нижняя панель вкладок — в MainActivity (bottomBar у Scaffold), список вкладок — bottomNavItems.
@Composable
fun AppNavHost(
    navController: NavHostController,
    summary: AdminSummaryResponse?,
    onRefresh: () -> Unit,
    modifier: Modifier = Modifier
) {
    NavHost(
        navController = navController,
        startDestination = Screen.Dashboard.route,
        modifier = modifier
    ) {
        composable(Screen.Dashboard.route) { DashboardScreen(summary, onRefresh) }
        composable(Screen.Monitor.route) { MonitorScreen(summary) }
        composable(Screen.Billing.route) { BillingScreen(summary) }
        composable(Screen.Systems.route) { SystemsScreen(summary) }
        composable(Screen.Content.route) { ContentScreen(summary) }
        composable(Screen.Users.route) { UsersScreen(summary) }
        composable(Screen.Support.route) { SupportScreen(summary) }
        composable(Screen.Backup.route) { BackupScreen(summary) }
        composable(Screen.Auth.route) { AuthScreen(summary) }
    }
}
