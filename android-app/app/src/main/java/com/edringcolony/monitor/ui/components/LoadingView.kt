package com.edringcolony.monitor.ui.components

import androidx.compose.foundation.layout.*
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.edringcolony.monitor.ui.theme.Muted
import com.edringcolony.monitor.ui.theme.Orange

@Composable
fun LoadingView(
    message: String = "Загрузка телеметрии...",
    modifier: Modifier = Modifier
) {
    Box(
        modifier = modifier.fillMaxSize(),
        contentAlignment = Alignment.Center
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp)) {
            CircularProgressIndicator(color = Orange, strokeWidth = 2.dp, modifier = Modifier.size(36.dp))
            Text(
                text = message.uppercase(),
                fontFamily = FontFamily.Monospace,
                fontSize = 12.sp,
                letterSpacing = 2.sp,
                color = Muted
            )
        }
    }
}

@Composable
fun ErrorView(
    message: String,
    onRetry: (() -> Unit)? = null,
    modifier: Modifier = Modifier
) {
    Box(modifier = modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.padding(24.dp)) {
            Text(
                text = "ОШИБКА",
                fontFamily = FontFamily.Monospace,
                fontSize = 14.sp,
                letterSpacing = 2.sp,
                color = com.edringcolony.monitor.ui.theme.Red
            )
            Text(
                text = message,
                fontFamily = FontFamily.Default,
                fontSize = 14.sp,
                color = Muted
            )
            if (onRetry != null) {
                Spacer(Modifier.height(8.dp))
                androidx.compose.material3.Button(
                    onClick = onRetry,
                    colors = androidx.compose.material3.ButtonDefaults.buttonColors(
                        containerColor = com.edringcolony.monitor.ui.theme.Panel,
                        contentColor = Orange
                    ),
                    border = androidx.compose.foundation.BorderStroke(1.dp, Orange)
                ) {
                    Text("ПОВТОРИТЬ", fontFamily = FontFamily.Monospace, letterSpacing = 2.sp)
                }
            }
        }
    }
}
