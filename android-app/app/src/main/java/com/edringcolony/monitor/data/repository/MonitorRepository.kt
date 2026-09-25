package com.edringcolony.monitor.data.repository

import com.edringcolony.monitor.data.model.AdminSummaryResponse
import com.edringcolony.monitor.data.model.AuthResponse
import com.edringcolony.monitor.data.model.LoginRequest
import com.edringcolony.monitor.data.network.ApiService

class MonitorRepository(private val api: ApiService) {

    suspend fun login(email: String, password: String): Result<AuthResponse> {
        return try {
            val res = api.login(LoginRequest(email, password))
            if (res.success) Result.success(res)
            else Result.failure(Exception(res.error ?: "Login failed"))
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    suspend fun checkAuth(): Result<AuthResponse> {
        return try {
            val res = api.checkAuth()
            if (res.success) Result.success(res)
            else Result.failure(Exception(res.error ?: "Auth check failed"))
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    suspend fun getSummary(period: String = "30d"): Result<AdminSummaryResponse> {
        return try {
            val res = api.getAdminSummary(period)
            if (res.success) Result.success(res)
            else Result.failure(Exception(res.error ?: "Failed to load summary"))
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    suspend fun getStatus(): Result<Map<String, Any>> {
        return try {
            Result.success(api.getStatus())
        } catch (e: Exception) {
            Result.failure(e)
        }
    }
}
