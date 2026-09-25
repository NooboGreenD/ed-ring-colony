package com.edringcolony.monitor.data.network

import com.edringcolony.monitor.data.local.TokenManager
import okhttp3.Interceptor
import okhttp3.Response

class AuthInterceptor(private val tokenManager: TokenManager) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val original = chain.request()
        val token = tokenManager.getAccessToken()
        val builder = original.newBuilder()
        if (!token.isNullOrBlank()) {
            builder.header("Authorization", "Bearer $token")
        }
        builder.header("Accept", "application/json")
        builder.header("Content-Type", "application/json")
        return chain.proceed(builder.build())
    }
}
