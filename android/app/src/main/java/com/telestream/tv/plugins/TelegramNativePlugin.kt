package com.telestream.tv.plugins

import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

@CapacitorPlugin(name = "TelegramNative")
class TelegramNativePlugin : Plugin() {
    companion object {
        private const val TAG = "TelegramNative"
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    private val authListener: (AuthSnapshot) -> Unit = { snapshot ->
        notifyListeners("auth_state", snapshot.toJs())
    }

    override fun load() {
        Log.d(TAG, "Plugin loaded")
        TelegramNativeManager.addAuthListener(authListener)
    }

    override fun handleOnDestroy() {
        TelegramNativeManager.removeAuthListener(authListener)
        super.handleOnDestroy()
    }

    @PluginMethod
    fun configure(call: PluginCall) {
        val apiId = call.getInt("apiId") ?: 0
        val apiHash = call.getString("apiHash") ?: ""
        Log.d(TAG, "configure() apiId=" + apiId + " hasHash=" + apiHash.isNotBlank())
        if (apiId <= 0 || apiHash.isBlank()) {
            call.reject("apiId/apiHash are required")
            return
        }

        TelegramNativeManager.ensureConfigured(context.applicationContext, apiId, apiHash)
        Log.d(TAG, "configure() snapshot=" + TelegramNativeManager.getSnapshot())
        call.resolve(TelegramNativeManager.getSnapshot().toJs())
    }

    @PluginMethod
    fun getAuthState(call: PluginCall) {
        Log.d(TAG, "getAuthState() snapshot=" + TelegramNativeManager.getSnapshot())
        call.resolve(TelegramNativeManager.getSnapshot().toJs())
    }

    @PluginMethod
    fun requestQrBootstrap(call: PluginCall) {
        val timeoutMs = call.getInt("timeoutMs")?.toLong() ?: 12_000L
        val forceRefresh = call.getBoolean("forceRefresh") ?: false
        Log.d(TAG, "requestQrBootstrap() timeoutMs=" + timeoutMs + " forceRefresh=" + forceRefresh)
        scope.launch {
            val snapshot = TelegramNativeManager.requestQrBootstrap(timeoutMs, forceRefresh)
            Log.d(TAG, "requestQrBootstrap() result=" + snapshot)
            if (snapshot == null) {
                call.reject("Timed out waiting for native QR bootstrap")
            } else {
                call.resolve(snapshot.toJs())
            }
        }
    }

    @PluginMethod
    fun waitForReady(call: PluginCall) {
        val timeoutMs = call.getInt("timeoutMs")?.toLong() ?: 20_000L
        Log.d(TAG, "waitForReady() timeoutMs=" + timeoutMs)
        scope.launch {
            val snapshot = TelegramNativeManager.waitForReady(timeoutMs)
            Log.d(TAG, "waitForReady() result=" + snapshot)
            if (snapshot == null) {
                call.reject("Timed out waiting for native Telegram readiness")
            } else {
                call.resolve(snapshot.toJs())
            }
        }
    }

    @PluginMethod
    fun refreshAuthState(call: PluginCall) {
        Log.d(TAG, "refreshAuthState()")
        scope.launch {
            val snapshot = TelegramNativeManager.refreshAuthState()
            Log.d(TAG, "refreshAuthState() result=" + snapshot)
            if (snapshot == null) {
                call.reject("Native Telegram is not configured")
            } else {
                call.resolve(snapshot.toJs())
            }
        }
    }

    @PluginMethod
    fun logout(call: PluginCall) {
        Log.d(TAG, "logout()")
        scope.launch {
            TelegramNativeManager.logOut()
            call.resolve()
        }
    }

    @PluginMethod
    fun debugLog(call: PluginCall) {
        val level = call.getString("level") ?: "d"
        val message = call.getString("message") ?: ""
        when (level.lowercase()) {
            "e" -> Log.e(TAG, "JS: $message")
            "w" -> Log.w(TAG, "JS: $message")
            else -> Log.d(TAG, "JS: $message")
        }
        call.resolve()
    }

    private fun AuthSnapshot.toJs(): JSObject {
        return JSObject().apply {
            put("state", state)
            put("qrLink", qrLink)
            put("userId", userId)
            put("error", error)
        }
    }
}
