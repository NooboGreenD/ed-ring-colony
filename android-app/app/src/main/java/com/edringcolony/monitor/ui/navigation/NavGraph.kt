package com.edringcolony.monitor.ui.navigation

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import com.edringcolony.monitor.data.model.AdminSummaryResponse
import com.edringcolony.monitor.ui.screens.*
import com.edringcolony.monitor.ui.theme.*

@Composable
fun BottomNavigationBar(
    navController: NavHostController,
    modifier: Modifier = Modifier
) {
    val navBackStackEntry by navController.currentBackStackEntryAsState()
    val currentRoute = navBackStackEntry?.destination?.route

    NavigationBar(
        modifier = modifier
            .background(TopBar)
            .border(1.dp, Line, RoundedCornerShape(0.dp)),
        containerColor = TopBar,
        contentColor = Muted,
        tonalElevation = 0.dp
    ) {
        // Scrollable row for 9 items — custom implementation
        // Using NavigationBar with 9 items might be cramped, so we use scrollable Row
    }
}

@Composable
fun HudBottomBar(
    navController: NavHostController,
    modifier: Modifier = Modifier
) {
    val navBackStackEntry by navController.currentBackStackEntryAsState()
    val currentRoute = navBackStackEntry?.destination?.route

    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(64.dp)
            .background(TopBar)
            .border(1.dp, Line)
            .padding(horizontal = 4.dp),
        horizontalArrangement = Arrangement.SpaceAround,
        verticalAlignment = Alignment.CenterVertically
    ) {
        bottomNavItems.forEach { screen ->
            val selected = currentRoute == screen.route
            Column(
                modifier = Modifier
                    .clip(RoundedCornerShape(2.dp))
                    .background(if (selected) Orange.copy(alpha = 0.12f) else Color.Transparent)
                    .border(
                        1.dp,
                        if (selected) Orange.copy(alpha = 0.5f) else Color.Transparent,
                        RoundedCornerShape(2.dp)
                    )
                    .padding(horizontal = 8.dp, vertical = 6.dp)
                    .weight(1f),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center
            ) {
                // HUD icon text
                Text(
                    text = screen.hudIcon,
                    fontSize = 18.sp,
                    color = if (selected) Orange else Muted
                )
                Text(
                    text = screen.label.uppercase(),
                    fontFamily = FontFamily.Monospace,
                    fontSize = 8.sp,
                    letterSpacing = 1.sp,
                    fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
                    color = if (selected) Orange else Muted
                )
            }
        }
    }
}

// Proper clickable version
@Composable
fun HudBottomBarClickable(
    navController: NavHostController,
    modifier: Modifier = Modifier
) {
    val navBackStackEntry by navController.currentBackStackEntryAsState()
    val currentRoute = navBackStackEntry?.destination?.route

    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(64.dp)
            .background(TopBar)
            .border(1.dp, Line),
        horizontalArrangement = Arrangement.SpaceEvenly,
        verticalAlignment = Alignment.CenterVertically
    ) {
        bottomNavItems.forEach { screen ->
            val selected = currentRoute == screen.route
            androidx.compose.foundation.clickable {
                // placeholder
            }
            androidx.compose.material3.TextButton(
                onClick = {
                    navController.navigate(screen.route) {
                        popUpTo(navController.graph.startDestinationId) { saveState = true }
                        launchSingleTop = true
                        restoreState = true
                    }
                },
                modifier = Modifier
                    .weight(1f)
                    .fillMaxHeight(),
                colors = ButtonDefaults.textButtonColors(
                    containerColor = if (selected) Orange.copy(alpha = 0.12f) else Color.Transparent,
                    contentColor = if (selected) Orange else Muted
                ),
                contentPadding = PaddingValues(2.dp)
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(text = screen.hudIcon, fontSize = 16.sp)
                    Text(
                        text = screen.label.take(4).uppercase(),
                        fontFamily = FontFamily.Monospace,
                        fontSize = 7.sp,
                        letterSpacing = 0.5.sp
                    )
                }
            }
        }
    }
}

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
