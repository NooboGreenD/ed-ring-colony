package com.edringcolony.monitor

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.edringcolony.monitor.data.local.TokenManager
import com.edringcolony.monitor.data.model.AdminSummaryResponse
import com.edringcolony.monitor.data.network.RetrofitClient
import com.edringcolony.monitor.data.repository.MonitorRepository
import com.edringcolony.monitor.ui.components.ErrorView
import com.edringcolony.monitor.ui.components.LoadingView
import com.edringcolony.monitor.ui.navigation.AppNavHost
import com.edringcolony.monitor.ui.navigation.bottomNavItems
import com.edringcolony.monitor.ui.screens.LoginScreen
import com.edringcolony.monitor.ui.theme.*
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val tokenManager = TokenManager(this)

        setContent {
            EDRingColonyTheme {
                var isLoggedIn by remember { mutableStateOf(tokenManager.isLoggedIn()) }
                var summary by remember { mutableStateOf<AdminSummaryResponse?>(null) }
                var loading by remember { mutableStateOf(false) }
                var loginLoading by remember { mutableStateOf(false) }
                var error by remember { mutableStateOf<String?>(null) }
                var loginError by remember { mutableStateOf<String?>(null) }

                val scope = rememberCoroutineScope()

                var repository by remember {
                    mutableStateOf(
                        MonitorRepository(
                            RetrofitClient.create(tokenManager.getBaseUrl(), tokenManager)
                        )
                    )
                }

                fun refreshRepository() {
                    repository = MonitorRepository(
                        RetrofitClient.create(tokenManager.getBaseUrl(), tokenManager)
                    )
                }

                fun loadSummary(period: String = "30d") {
                    if (!tokenManager.isLoggedIn()) return
                    scope.launch {
                        loading = true
                        error = null
                        refreshRepository()
                        val result = repository.getSummary(period)
                        result.onSuccess {
                            summary = it
                            loading = false
                        }.onFailure {
                            error = it.message ?: "Ошибка загрузки"
                            loading = false
                            val msg = it.message ?: ""
                            if (msg.contains("401") || msg.contains("403") || msg.contains("Не авторизован") || msg.contains("Unauthorized")) {
                                tokenManager.clear()
                                isLoggedIn = false
                            }
                        }
                    }
                }

                LaunchedEffect(isLoggedIn) {
                    if (isLoggedIn) loadSummary()
                }

                // Auto-refresh every 20s like web panel
                LaunchedEffect(isLoggedIn) {
                    while (isLoggedIn) {
                        delay(20000)
                        if (isLoggedIn) loadSummary()
                    }
                }

                Surface(modifier = Modifier.fillMaxSize(), color = Bg) {
                    if (!isLoggedIn) {
                        LoginScreen(
                            onLogin = { email, password, baseUrl ->
                                scope.launch {
                                    loginLoading = true
                                    loginError = null
                                    tokenManager.setBaseUrl(baseUrl)
                                    refreshRepository()
                                    val repo = MonitorRepository(
                                        RetrofitClient.create(baseUrl, tokenManager)
                                    )
                                    val res = repo.login(email, password)
                                    res.onSuccess { auth ->
                                        if (auth.accessToken != null) {
                                            tokenManager.saveTokens(auth.accessToken, auth.refreshToken)
                                            auth.user?.let {
                                                tokenManager.saveUser(
                                                    it.email ?: email,
                                                    it.role ?: "admin",
                                                    it.cmdrName ?: "CMDR"
                                                )
                                            }
                                            repository = repo
                                            isLoggedIn = true
                                            loginLoading = false
                                        } else {
                                            loginError = "Не получен токен"
                                            loginLoading = false
                                        }
                                    }.onFailure {
                                        loginError = it.message ?: "Ошибка входа"
                                        loginLoading = false
                                    }
                                }
                            },
                            isLoading = loginLoading,
                            error = loginError,
                            defaultBaseUrl = tokenManager.getBaseUrl()
                        )
                    } else {
                        val navController = rememberNavController()
                        val navBackStackEntry by navController.currentBackStackEntryAsState()
                        val currentRoute = navBackStackEntry?.destination?.route

                        Scaffold(
                            topBar = {
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .height(56.dp)
                                        .background(TopBar)
                                        .border(1.dp, Line)
                                        .padding(horizontal = 16.dp),
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                                        Box(
                                            modifier = Modifier
                                                .size(28.dp)
                                                .clip(RoundedCornerShape(2.dp))
                                                .background(Orange),
                                            contentAlignment = Alignment.Center
                                        ) {
                                            Text("E", fontFamily = FontFamily.Monospace, fontSize = 14.sp, color = Bg)
                                        }
                                        Column {
                                            Text("ED RING COLONY", fontFamily = FontFamily.Monospace, fontSize = 12.sp, letterSpacing = 3.sp, color = Orange)
                                            Text("MOBILE ADMIN • ${tokenManager.getCmdr() ?: "CMDR"}", fontFamily = FontFamily.Monospace, fontSize = 9.sp, letterSpacing = 1.sp, color = Muted)
                                        }
                                    }
                                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                                        if (summary != null) {
                                            val overall = summary!!.health?.overall ?: "unknown"
                                            val color = when (overall) {
                                                "healthy" -> Green
                                                "warning" -> Orange
                                                "critical" -> Red
                                                else -> Muted
                                            }
                                            Box(
                                                modifier = Modifier
                                                    .clip(RoundedCornerShape(99.dp))
                                                    .background(color.copy(alpha = 0.12f))
                                                    .border(1.dp, color.copy(alpha = 0.4f), RoundedCornerShape(99.dp))
                                                    .padding(horizontal = 8.dp, vertical = 3.dp)
                                            ) {
                                                Text(overall.uppercase(), fontFamily = FontFamily.Monospace, fontSize = 9.sp, color = color)
                                            }
                                        }
                                        TextButton(
                                            onClick = {
                                                tokenManager.clear()
                                                isLoggedIn = false
                                                summary = null
                                            },
                                            colors = ButtonDefaults.textButtonColors(contentColor = Muted)
                                        ) {
                                            Text("ВЫЙТИ", fontFamily = FontFamily.Monospace, fontSize = 9.sp, letterSpacing = 1.sp)
                                        }
                                    }
                                }
                            },
                            bottomBar = {
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .height(64.dp)
                                        .background(TopBar)
                                        .border(1.dp, Line),
                                    horizontalArrangement = Arrangement.SpaceEvenly,
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    bottomNavItems.forEach { screen ->
                                        val selected = currentRoute == screen.route
                                        TextButton(
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
                                                containerColor = if (selected) Orange.copy(alpha = 0.12f) else androidx.compose.ui.graphics.Color.Transparent,
                                                contentColor = if (selected) Orange else Muted
                                            ),
                                            contentPadding = PaddingValues(2.dp)
                                        ) {
                                            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                                                Text(text = screen.hudIcon, fontSize = 16.sp, color = if (selected) Orange else Muted)
                                                Spacer(Modifier.height(2.dp))
                                                Text(
                                                    text = screen.label.take(4).uppercase(),
                                                    fontFamily = FontFamily.Monospace,
                                                    fontSize = 7.sp,
                                                    letterSpacing = 0.5.sp,
                                                    color = if (selected) Orange else Muted
                                                )
                                            }
                                        }
                                    }
                                }
                            },
                            containerColor = Bg
                        ) { paddingValues ->
                            Box(modifier = Modifier.padding(paddingValues)) {
                                when {
                                    loading && summary == null -> LoadingView()
                                    error != null && summary == null -> ErrorView(message = error!!, onRetry = { loadSummary() })
                                    else -> AppNavHost(
                                        navController = navController,
                                        summary = summary,
                                        onRefresh = { loadSummary() },
                                        modifier = Modifier.fillMaxSize()
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
