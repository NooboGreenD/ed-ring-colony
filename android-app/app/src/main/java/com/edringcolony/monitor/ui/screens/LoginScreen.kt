package com.edringcolony.monitor.ui.screens

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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.edringcolony.monitor.ui.theme.*

@Composable
fun LoginScreen(
    onLogin: (email: String, password: String, baseUrl: String) -> Unit,
    isLoading: Boolean,
    error: String?,
    defaultBaseUrl: String
) {
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var baseUrl by remember { mutableStateOf(defaultBaseUrl) }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Bg)
            .padding(20.dp),
        contentAlignment = Alignment.Center
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(4.dp))
                .background(Panel)
                .border(1.dp, Line, RoundedCornerShape(4.dp))
                .padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            // Brand
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Box(
                    modifier = Modifier
                        .size(32.dp)
                        .clip(RoundedCornerShape(2.dp))
                        .background(Orange),
                    contentAlignment = Alignment.Center
                ) {
                    Text("E", fontFamily = FontFamily.Monospace, fontWeight = FontWeight.ExtraBold, fontSize = 18.sp, color = Bg)
                }
                Column {
                    Text("ED RING COLONY", fontFamily = FontFamily.Monospace, fontSize = 13.sp, letterSpacing = 3.sp, color = Orange, fontWeight = FontWeight.Bold)
                    Text("MOBILE ADMIN • LOGIN", fontFamily = FontFamily.Monospace, fontSize = 9.sp, letterSpacing = 1.5.sp, color = Muted)
                }
            }

            Spacer(Modifier.height(8.dp))

            Text(
                "Доступ только для администраторов. Используйте email и пароль от сайта.",
                fontSize = 12.sp,
                color = Muted,
                lineHeight = 16.sp
            )

            OutlinedTextField(
                value = email,
                onValueChange = { email = it },
                label = { Text("EMAIL", fontFamily = FontFamily.Monospace, fontSize = 10.sp, letterSpacing = 2.sp) },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = Orange,
                    unfocusedBorderColor = Line,
                    focusedLabelColor = Orange,
                    unfocusedLabelColor = Muted,
                    focusedTextColor = Text,
                    unfocusedTextColor = Text
                )
            )

            OutlinedTextField(
                value = password,
                onValueChange = { password = it },
                label = { Text("PASSWORD", fontFamily = FontFamily.Monospace, fontSize = 10.sp, letterSpacing = 2.sp) },
                visualTransformation = PasswordVisualTransformation(),
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = Orange,
                    unfocusedBorderColor = Line,
                    focusedLabelColor = Orange,
                    unfocusedLabelColor = Muted,
                    focusedTextColor = Text,
                    unfocusedTextColor = Text
                )
            )

            OutlinedTextField(
                value = baseUrl,
                onValueChange = { baseUrl = it },
                label = { Text("API BASE URL", fontFamily = FontFamily.Monospace, fontSize = 10.sp, letterSpacing = 2.sp) },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = Cyan,
                    unfocusedBorderColor = Line,
                    focusedLabelColor = Cyan,
                    unfocusedLabelColor = Muted,
                    focusedTextColor = Text,
                    unfocusedTextColor = Text
                )
            )

            if (error != null) {
                Text(
                    text = error,
                    color = Red,
                    fontSize = 12.sp,
                    fontFamily = FontFamily.Monospace,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(2.dp))
                        .background(Red.copy(alpha = 0.1f))
                        .border(1.dp, Red.copy(alpha = 0.3f), RoundedCornerShape(2.dp))
                        .padding(10.dp)
                )
            }

            Button(
                onClick = { onLogin(email, password, baseUrl) },
                enabled = !isLoading && email.isNotBlank() && password.isNotBlank(),
                modifier = Modifier.fillMaxWidth(),
                colors = ButtonDefaults.buttonColors(
                    containerColor = Panel,
                    contentColor = Orange,
                    disabledContainerColor = Panel,
                    disabledContentColor = Muted
                ),
                border = androidx.compose.foundation.BorderStroke(1.dp, Orange),
                shape = RoundedCornerShape(2.dp)
            ) {
                if (isLoading) {
                    CircularProgressIndicator(modifier = Modifier.size(16.dp), color = Orange, strokeWidth = 2.dp)
                    Spacer(Modifier.width(8.dp))
                }
                Text(
                    if (isLoading) "ВХОД..." else "ВОЙТИ",
                    fontFamily = FontFamily.Monospace,
                    letterSpacing = 2.sp,
                    fontSize = 12.sp
                )
            }

            Text(
                "Стиль: Dark sci-fi military HUD • Flat, brutal, functional",
                fontFamily = FontFamily.Monospace,
                fontSize = 9.sp,
                color = Muted.copy(alpha = 0.6f),
                letterSpacing = 1.sp
            )
        }
    }
}
