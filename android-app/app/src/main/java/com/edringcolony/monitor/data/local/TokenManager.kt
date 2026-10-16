package com.edringcolony.monitor.data.local

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

class TokenManager(context: Context) {

    private val appContext = context.applicationContext

    private val prefs: SharedPreferences by lazy {
        createEncryptedPrefs(appContext)
    }

    private fun createEncryptedPrefs(ctx: Context): SharedPreferences {
        val masterKey = MasterKey.Builder(ctx)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        return try {
            EncryptedSharedPreferences.create(
                ctx,
                PREFS_FILE_NAME,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            )
        } catch (_: Exception) {
            // При повреждении ключей Keystore сбрасываем зашифрованное хранилище
            // и пересоздаём его без отката на незашифрованный SharedPreferences.
            ctx.deleteSharedPreferences(PREFS_FILE_NAME)
            ctx.deleteSharedPreferences("fallback_prefs")
            EncryptedSharedPreferences.create(
                ctx,
                PREFS_FILE_NAME,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            )
        }
    }

    companion object {
        private const val PREFS_FILE_NAME = "secure_prefs"
        private const val KEY_ACCESS_TOKEN = "access_token"
        private const val KEY_REFRESH_TOKEN = "refresh_token"
        private const val KEY_USER_EMAIL = "user_email"
        private const val KEY_CMDR_NAME = "cmdr_name"
        private const val KEY_USER_ROLE = "user_role"
        private const val KEY_BASE_URL = "base_url"
        const val DEFAULT_BASE_URL = "https://edringcolony.ru"
    }

    fun saveSession(
        accessToken: String,
        refreshToken: String?,
        email: String?,
        cmdrName: String?,
        role: String?
    ) {
        prefs.edit()
            .putString(KEY_ACCESS_TOKEN, accessToken)
            .putString(KEY_REFRESH_TOKEN, refreshToken)
            .putString(KEY_USER_EMAIL, email)
            .putString(KEY_CMDR_NAME, cmdrName)
            .putString(KEY_USER_ROLE, role)
            .apply()
    }

    fun getAccessToken(): String? = prefs.getString(KEY_ACCESS_TOKEN, null)
    fun getRefreshToken(): String? = prefs.getString(KEY_REFRESH_TOKEN, null)
    fun getEmail(): String? = prefs.getString(KEY_USER_EMAIL, null)
    fun getCmdrName(): String? = prefs.getString(KEY_CMDR_NAME, null)
    fun getRole(): String? = prefs.getString(KEY_USER_ROLE, null)

    fun getBaseUrl(): String =
        prefs.getString(KEY_BASE_URL, DEFAULT_BASE_URL) ?: DEFAULT_BASE_URL

    fun setBaseUrl(url: String) {
        val cleaned = url.trim().trimEnd('/')
        prefs.edit().putString(KEY_BASE_URL, cleaned.ifEmpty { DEFAULT_BASE_URL }).apply()
    }

    fun isLoggedIn(): Boolean = !getAccessToken().isNullOrBlank()

    fun clearSession() {
        val savedUrl = getBaseUrl()
        prefs.edit().clear().putString(KEY_BASE_URL, savedUrl).apply()
    }
}
