package com.edringcolony.monitor.ui.screens

import android.annotation.SuppressLint
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.edringcolony.monitor.ui.theme.Bg
import com.edringcolony.monitor.ui.theme.Orange

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun WebViewScreen(
    url: String,
    modifier: Modifier = Modifier
) {
    var loading by remember { mutableStateOf(true) }

    Box(modifier = modifier.fillMaxSize().background(Bg)) {
        AndroidView(
            factory = { context ->
                WebView(context).apply {
                    webViewClient = object : WebViewClient() {
                        override fun onPageFinished(view: WebView?, url: String?) {
                            loading = false
                        }
                    }
                    settings.javaScriptEnabled = true
                    settings.domStorageEnabled = true
                    settings.allowFileAccess = false
                    loadUrl(url)
                }
            },
            modifier = Modifier.fillMaxSize()
        )

        if (loading) {
            Box(modifier = Modifier.fillMaxSize().background(Bg.copy(alpha = 0.8f)), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = Orange)
            }
        }
    }
}
