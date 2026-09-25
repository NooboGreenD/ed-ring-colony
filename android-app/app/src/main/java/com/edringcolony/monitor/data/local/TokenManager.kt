package com.edringcolony.monitor.data.local

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

class TokenManager(context: Context) {

    companion object {
        private const val PREFS_NAME = "secure_prefs"
        private const val KEY_TOKEN = "access_token"
        private const val KEY_REFRESH = "refresh_token"
        private const val KEY_BASE_URL = "base_url"
        private const val KEY_EMAIL = "email"
        private const val KEY_ROLE = "role"
        private const val KEY_CMDR = "cmdr_name"
    }

    private val masterKey = MasterKey.Builder(context)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build()

    private val prefs: SharedPreferences = try {
        EncryptedSharedPreferences.create(
            context,
            PREFS_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    } catch (e: Exception) {
        // Fallback for devices without encryption support (emulator)
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    }

    fun saveTokens(access: String, refresh: String?) {
        prefs.edit()
            .putString(KEY_TOKEN, access)
            .putString(KEY_REFRESH, refresh ?: "")
            .apply()
    }

    fun saveUser(email: String, role: String, cmdr: String) {
        prefs.edit()
            .putString(KEY_EMAIL, email)
            .putString(KEY_ROLE, role)
            .putString(KEY_CMDR, cmdr)
            .apply()
    }

    fun getAccessToken(): String? = prefs.getString(KEY_TOKEN, null)?.takeIf { it.isNotBlank() }
    fun getRefreshToken(): String? = prefs.getString(KEY_REFRESH, null)?.takeIf { it.isNotBlank() }
    fun getEmail(): String? = prefs.getString(KEY_EMAIL, null)
    fun getRole(): String? = prefs.getString(KEY_ROLE, null)
    fun getCmdr(): String? = prefs.getString(KEY_CMDR, null)

    fun getBaseUrl(): String {
        return prefs.getString(KEY_BASE_URL, null)
            ?: "https://edringcolony.ru" // default, override in gradle.properties
    }

    fun setBaseUrl(url: String) {
        prefs.edit().putString(KEY_BASE_URL, url.trim().trimEnd('/')).apply()
    }

    fun isLoggedIn(): Boolean = !getAccessToken().isNullOrBlank()

    fun clear() {
        prefs.edit().clear().apply()
    }
}
