package com.edringcolony.monitor.data.network

import com.edringcolony.monitor.data.model.AdminSummaryResponse
import com.edringcolony.monitor.data.model.AuthResponse
import com.edringcolony.monitor.data.model.LoginRequest
import retrofit2.http.*

interface ApiService {

    @POST("api/mobile/auth")
    suspend fun login(@Body request: LoginRequest): AuthResponse

    @GET("api/mobile/auth")
    suspend fun checkAuth(): AuthResponse

    @GET("api/mobile/admin-summary")
    suspend fun getAdminSummary(@Query("period") period: String = "30d"): AdminSummaryResponse

    // Fallbacks
    @GET("api/admin/monitor")
    suspend fun getMonitor(): Map<String, Any>

    @GET("api/status")
    suspend fun getStatus(): Map<String, Any>
}
