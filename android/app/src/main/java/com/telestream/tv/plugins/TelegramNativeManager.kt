package com.telestream.tv.plugins

import android.content.Context
import android.os.Build
import android.util.Log
import dev.g000sha256.tdl.TdlClient
import dev.g000sha256.tdl.TdlResult
import dev.g000sha256.tdl.dto.AuthorizationState
import dev.g000sha256.tdl.dto.AuthorizationStateClosed
import dev.g000sha256.tdl.dto.AuthorizationStateClosing
import dev.g000sha256.tdl.dto.AuthorizationStateLoggingOut
import dev.g000sha256.tdl.dto.AuthorizationStateReady
import dev.g000sha256.tdl.dto.AuthorizationStateWaitCode
import dev.g000sha256.tdl.dto.AuthorizationStateWaitOtherDeviceConfirmation
import dev.g000sha256.tdl.dto.AuthorizationStateWaitPassword
import dev.g000sha256.tdl.dto.AuthorizationStateWaitPhoneNumber
import dev.g000sha256.tdl.dto.AuthorizationStateWaitTdlibParameters
import dev.g000sha256.tdl.dto.File
import dev.g000sha256.tdl.dto.MessageAnimation
import dev.g000sha256.tdl.dto.MessageContent
import dev.g000sha256.tdl.dto.MessageDocument
import dev.g000sha256.tdl.dto.MessageVideo
import dev.g000sha256.tdl.dto.MessageVideoNote
import dev.g000sha256.tdl.dto.PhoneNumberAuthenticationSettings
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import java.util.Locale
import java.io.File as JavaFile
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

object TelegramNativeManager {
    private const val TAG = "TelegramNative"
    private const val TDLIB_FILES_DIR_NAME = "tdlib-files"

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val authStateFlow = MutableStateFlow(AuthSnapshot(state = "idle"))
    private val listeners = CopyOnWriteArrayList<(AuthSnapshot) -> Unit>()
    private val downloadSessions = ConcurrentHashMap<Int, NativeTelegramDownloadSession>()

    @Volatile
    private var appContext: Context? = null

    @Volatile
    private var apiId: Int = 0

    @Volatile
    private var apiHash: String = ""

    @Volatile
    private var client: TdlClient? = null

    @Volatile
    private var observersStarted = false

    @Volatile
    private var tdlibParametersConfigured = false

    @Volatile
    private var tdlibParametersInFlight = false

    @JvmStatic
    fun ensureConfigured(context: Context, apiId: Int, apiHash: String) {
        Log.d(TAG, "ensureConfigured() apiId=" + apiId + " hasHash=" + apiHash.isNotBlank())
        this.appContext = context.applicationContext
        this.apiId = apiId
        this.apiHash = apiHash
        cleanupTdlibFilesAsync(context.applicationContext)

        if (client == null) {
            synchronized(this) {
                if (client == null) {
                    Log.d(TAG, "Creating TDLib client")
                    client = TdlClient.create()
                    tdlibParametersConfigured = false
                    tdlibParametersInFlight = false
                    startObservers()
                }
            }
        }
    }

    @JvmStatic
    fun addAuthListener(listener: (AuthSnapshot) -> Unit) {
        listeners.add(listener)
        listener(authStateFlow.value)
    }

    @JvmStatic
    fun removeAuthListener(listener: (AuthSnapshot) -> Unit) {
        listeners.remove(listener)
    }

    @JvmStatic
    fun getSnapshot(): AuthSnapshot = authStateFlow.value

    @JvmStatic
    fun isAuthorized(): Boolean = authStateFlow.value.state == "ready"

    @JvmStatic
    suspend fun requestQrBootstrap(timeoutMs: Long, forceRefresh: Boolean = false): AuthSnapshot? {
        Log.d(
            TAG,
            "requestQrBootstrap() current=" + authStateFlow.value + " forceRefresh=" + forceRefresh,
        )
        val activeClient = client ?: return null
        val bootstrapState = withTimeoutOrNull(timeoutMs) {
            authStateFlow
                .filter {
                    it.state == "ready" ||
                        it.state == "wait_phone_number" ||
                        it.state == "wait_qr" ||
                        it.state == "error"
                }
                .first()
        } ?: return null

        Log.d(TAG, "requestQrBootstrap() bootstrapState=" + bootstrapState)
        if (bootstrapState.state == "ready" || bootstrapState.state == "error") {
            return bootstrapState
        }
        if (!forceRefresh && bootstrapState.state == "wait_qr") {
            return bootstrapState
        }

        val previousQrLink = authStateFlow.value.qrLink ?: bootstrapState.qrLink

        when (val result = activeClient.requestQrCodeAuthentication(longArrayOf())) {
            is TdlResult.Failure -> {
                Log.e(TAG, "requestQrCodeAuthentication failed: " + result.message)
                emit(AuthSnapshot(state = "error", error = result.message))
                return authStateFlow.value
            }
            is TdlResult.Success -> Log.d(TAG, "requestQrCodeAuthentication success")
        }

        val refreshed = withTimeoutOrNull(timeoutMs) {
            authStateFlow
                .filter {
                    it.state == "ready" ||
                        it.state == "error" ||
                        (
                            it.state == "wait_qr" &&
                                !it.qrLink.isNullOrEmpty() &&
                                (previousQrLink.isNullOrEmpty() || it.qrLink != previousQrLink)
                            )
                }
                .first()
        }

        if (refreshed != null) {
            return refreshed
        }

        val current = authStateFlow.value
        return current.takeIf {
            it.state == "ready" ||
                it.state == "error" ||
                (it.state == "wait_qr" && !it.qrLink.isNullOrEmpty())
        }
    }

    @JvmStatic
    suspend fun waitForReady(timeoutMs: Long): AuthSnapshot? {
        Log.d(TAG, "waitForReady() current=" + authStateFlow.value)
        val current = authStateFlow.value
        if (current.state == "ready") {
            return current
        }

        return withTimeoutOrNull(timeoutMs) {
            authStateFlow
                .filter { it.state == "ready" || it.state == "error" }
                .first()
        }
    }

    @JvmStatic
    suspend fun refreshAuthState(): AuthSnapshot? {
        val activeClient = client ?: return authStateFlow.value
        return when (val result = activeClient.getAuthorizationState()) {
            is TdlResult.Failure -> {
                Log.e(TAG, "refreshAuthState() failed: " + result.message)
                emit(AuthSnapshot(state = "error", error = result.message))
                authStateFlow.value
            }
            is TdlResult.Success -> {
                Log.d(TAG, "refreshAuthState() -> " + result.result::class.java.simpleName)
                handleAuthorizationState(result.result)
                authStateFlow.value
            }
        }
    }

    @JvmStatic
    suspend fun logOut() {
        val activeClient = client ?: return
        when (val result = activeClient.logOut()) {
            is TdlResult.Failure -> emit(AuthSnapshot(state = "error", error = result.message))
            is TdlResult.Success -> {}
        }
    }

    @JvmStatic
    suspend fun openDownloadSession(
        peerType: String,
        peerId: Long,
        messageId: Long,
        messageLink: String? = null,
    ): NativeTelegramDownloadSession {
        val activeClient = client ?: error("TDLib is not initialized")
        if (!isAuthorized()) {
            error("Native Telegram session is not ready")
        }

        val resolvedMessage = resolveMessage(activeClient, peerType, peerId, messageId, messageLink)
        val chatId = resolvedMessage.chatId
        val message = resolvedMessage.message

        val media = extractMedia(message.content)
        val session = NativeTelegramDownloadSession(
            peerType = peerType,
            peerId = peerId,
            messageId = messageId,
            fileId = media.file.id,
            fileName = media.fileName,
            mimeType = media.mimeType,
            initialSize = if (media.file.size > 0) media.file.size else media.file.expectedSize,
        )

        downloadSessions[media.file.id] = session
        session.update(media.file)

        when (val result = activeClient.downloadFile(media.file.id, 32, 0, 0, false)) {
            is TdlResult.Failure -> {
                downloadSessions.remove(media.file.id)
                session.fail(result.message)
                throw IllegalStateException(result.message)
            }
            is TdlResult.Success -> session.update(result.result)
        }

        return session
    }

    @JvmStatic
    suspend fun closeDownloadSession(session: NativeTelegramDownloadSession?) {
        if (session == null) {
            return
        }

        val localPath = session.getLocalPath()
        session.close()
        downloadSessions.remove(session.fileId)

        val activeClient = client
        if (activeClient != null) {
            when (activeClient.cancelDownloadFile(session.fileId, false)) {
                is TdlResult.Failure -> {}
                is TdlResult.Success -> {}
            }
        }
        deleteLocalFile(localPath)
    }

    @JvmStatic
    suspend fun prioritizeDownload(fileId: Int, offset: Long) {
        val activeClient = client ?: return
        when (val result = activeClient.downloadFile(fileId, 32, offset, 0, false)) {
            is TdlResult.Failure -> Log.w(TAG, "prioritizeDownload($fileId, $offset) failed: ${result.message}")
            is TdlResult.Success -> downloadSessions[fileId]?.update(result.result)
        }
    }

    @JvmStatic
    fun openDownloadSessionBlocking(
        peerType: String,
        peerId: Long,
        messageId: Long,
        messageLink: String? = null,
    ): NativeTelegramDownloadSession = runBlocking(Dispatchers.IO) {
        openDownloadSession(peerType, peerId, messageId, messageLink)
    }

    @JvmStatic
    fun closeDownloadSessionBlocking(session: NativeTelegramDownloadSession?) {
        runBlocking(Dispatchers.IO) {
            closeDownloadSession(session)
        }
    }

    @JvmStatic
    fun prioritizeDownloadBlocking(fileId: Int, offset: Long) {
        runBlocking(Dispatchers.IO) {
            prioritizeDownload(fileId, offset)
        }
    }

    @JvmStatic
    fun prioritizeDownloadAsync(fileId: Int, offset: Long) {
        scope.launch {
            prioritizeDownload(fileId, offset)
        }
    }

    private fun startObservers() {
        if (observersStarted) {
            return
        }

        val activeClient = client ?: return
        observersStarted = true
        Log.d(TAG, "startObservers()")

        scope.launch {
            activeClient.authorizationStateUpdates.collect { update ->
                Log.d(TAG, "authorizationStateUpdates -> " + update.authorizationState::class.java.simpleName)
                handleAuthorizationState(update.authorizationState)
            }
        }

        scope.launch {
            activeClient.fileUpdates.collect { update ->
                downloadSessions[update.file.id]?.update(update.file)
            }
        }

        scope.launch {
            when (val result = activeClient.getAuthorizationState()) {
                is TdlResult.Failure -> {
                    Log.e(TAG, "getAuthorizationState failed: " + result.message)
                    emit(AuthSnapshot(state = "error", error = result.message))
                }
                is TdlResult.Success -> {
                    Log.d(TAG, "Initial authorization state -> " + result.result::class.java.simpleName)
                    handleAuthorizationState(result.result)
                }
            }
        }
    }

    private suspend fun handleAuthorizationState(state: AuthorizationState) {
        Log.d(TAG, "handleAuthorizationState(" + state::class.java.simpleName + ")")
        when (state) {
            is AuthorizationStateWaitTdlibParameters -> {
                emit(AuthSnapshot(state = "wait_tdlib_parameters"))
                configureTdlib()
            }
            is AuthorizationStateWaitPhoneNumber -> emit(AuthSnapshot(state = "wait_phone_number"))
            is AuthorizationStateWaitOtherDeviceConfirmation -> emit(
                AuthSnapshot(
                    state = "wait_qr",
                    qrLink = state.link,
                ),
            )
            is AuthorizationStateWaitCode -> emit(AuthSnapshot(state = "wait_code"))
            is AuthorizationStateWaitPassword -> emit(AuthSnapshot(state = "wait_password"))
            is AuthorizationStateReady -> {
                val userId = fetchCurrentUserId()
                emit(AuthSnapshot(state = "ready", userId = userId))
            }
            is AuthorizationStateLoggingOut -> emit(AuthSnapshot(state = "logging_out"))
            is AuthorizationStateClosing -> emit(AuthSnapshot(state = "closing"))
            is AuthorizationStateClosed -> emit(AuthSnapshot(state = "closed"))
            else -> emit(AuthSnapshot(state = state::class.java.simpleName))
        }
    }

    private suspend fun configureTdlib() {
        val context = appContext ?: return
        val activeClient = client ?: return
        if (apiId <= 0 || apiHash.isBlank()) {
            emit(AuthSnapshot(state = "error", error = "Telegram API credentials are missing"))
            return
        }

        synchronized(this) {
            if (tdlibParametersConfigured || tdlibParametersInFlight) {
                Log.d(
                    TAG,
                    "configureTdlib() skipped configured=$tdlibParametersConfigured inFlight=$tdlibParametersInFlight",
                )
                return
            }
            tdlibParametersInFlight = true
        }

        val databaseDir = context.getDir("tdlib-db", Context.MODE_PRIVATE).absolutePath
        val filesDir = context.getDir("tdlib-files", Context.MODE_PRIVATE).absolutePath
        val locale = Locale.getDefault().toLanguageTag().ifBlank { "en" }

        when (
            val result = activeClient.setTdlibParameters(
                useTestDc = false,
                databaseDirectory = databaseDir,
                filesDirectory = filesDir,
                databaseEncryptionKey = ByteArray(0),
                useFileDatabase = true,
                useChatInfoDatabase = true,
                useMessageDatabase = true,
                useSecretChats = false,
                apiId = apiId,
                apiHash = apiHash,
                systemLanguageCode = locale,
                deviceModel = Build.MODEL ?: "Android TV",
                systemVersion = "Android ${Build.VERSION.RELEASE ?: "unknown"}",
                applicationVersion = "TeleStream Native",
            )
        ) {
            is TdlResult.Failure -> {
                Log.e(TAG, "setTdlibParameters failed: " + result.message)
                synchronized(this) {
                    tdlibParametersInFlight = false
                    if (!result.message.contains("Unexpected setTdlibParameters")) {
                        tdlibParametersConfigured = false
                    }
                }
                if (!result.message.contains("Unexpected setTdlibParameters")) {
                    emit(AuthSnapshot(state = "error", error = result.message))
                }
            }
            is TdlResult.Success -> {
                synchronized(this) {
                    tdlibParametersConfigured = true
                    tdlibParametersInFlight = false
                }
                Log.d(TAG, "setTdlibParameters success")
            }
        }
    }

    private suspend fun fetchCurrentUserId(): String? {
        val activeClient = client ?: return null
        return when (val me = activeClient.getMe()) {
            is TdlResult.Failure -> null
            is TdlResult.Success -> me.result.id.toString()
        }
    }

    private suspend fun resolveChatId(activeClient: TdlClient, peerType: String, peerId: Long): Long {
        return when (peerType) {
            "user" -> when (val result = activeClient.createPrivateChat(peerId, false)) {
                is TdlResult.Failure -> error(result.message)
                is TdlResult.Success -> result.result.id
            }
            "chat" -> when (val result = activeClient.createBasicGroupChat(peerId, false)) {
                is TdlResult.Failure -> error(result.message)
                is TdlResult.Success -> result.result.id
            }
            else -> when (val result = activeClient.createSupergroupChat(peerId, false)) {
                is TdlResult.Failure -> error(result.message)
                is TdlResult.Success -> result.result.id
            }
        }
    }

    private suspend fun resolveMessage(
        activeClient: TdlClient,
        peerType: String,
        peerId: Long,
        messageId: Long,
        messageLink: String?,
    ): ResolvedNativeMessage {
        if (!messageLink.isNullOrBlank()) {
            when (val result = activeClient.getMessageLinkInfo(messageLink)) {
                is TdlResult.Failure -> Log.w(TAG, "getMessageLinkInfo failed for $messageLink: ${result.message}")
                is TdlResult.Success -> {
                    val linkedMessage = result.result.message
                    if (linkedMessage != null) {
                        return ResolvedNativeMessage(
                            chatId = result.result.chatId,
                            message = linkedMessage,
                        )
                    }
                }
            }
        }

        val chatId = resolveChatId(activeClient, peerType, peerId)
        val message = when (val result = activeClient.getMessage(chatId, messageId)) {
            is TdlResult.Failure -> error(result.message)
            is TdlResult.Success -> result.result
        }
        return ResolvedNativeMessage(chatId = chatId, message = message)
    }

    private fun extractMedia(content: MessageContent): NativeMediaInfo {
        return when (content) {
            is MessageVideo -> NativeMediaInfo(
                file = content.video.video,
                fileName = content.video.fileName.ifBlank { "video.mp4" },
                mimeType = content.video.mimeType.ifBlank { "video/mp4" },
            )
            is MessageDocument -> NativeMediaInfo(
                file = content.document.document,
                fileName = content.document.fileName.ifBlank { "video.bin" },
                mimeType = content.document.mimeType.ifBlank { "application/octet-stream" },
            )
            is MessageAnimation -> NativeMediaInfo(
                file = content.animation.animation,
                fileName = content.animation.fileName.ifBlank { "animation.mp4" },
                mimeType = content.animation.mimeType.ifBlank { "video/mp4" },
            )
            is MessageVideoNote -> NativeMediaInfo(
                file = content.videoNote.video,
                fileName = "video-note.mp4",
                mimeType = "video/mp4",
            )
            else -> error("Unsupported Telegram media content: ${content::class.java.simpleName}")
        }
    }

    private fun emit(snapshot: AuthSnapshot) {
        Log.d(TAG, "emit(" + snapshot + ")")
        authStateFlow.update { snapshot }
        listeners.forEach { listener -> listener(snapshot) }
    }

    private fun cleanupTdlibFilesAsync(context: Context) {
        scope.launch {
            try {
                pruneDirectory(context.getDir(TDLIB_FILES_DIR_NAME, Context.MODE_PRIVATE))
            } catch (e: Exception) {
                Log.w(TAG, "cleanupTdlibFilesAsync failed", e)
            }
        }
    }

    private fun pruneDirectory(root: JavaFile?) {
        if (root == null || !root.exists()) {
            return
        }
        root.listFiles()?.forEach { child ->
            if (child.isDirectory) {
                pruneDirectory(child)
                child.listFiles()?.takeIf { it.isEmpty() }?.let {
                    child.delete()
                }
            } else {
                child.delete()
            }
        }
    }

    private fun deleteLocalFile(path: String?) {
        if (path.isNullOrBlank()) {
            return
        }
        try {
            val file = JavaFile(path)
            if (file.exists() && !file.delete()) {
                Log.w(TAG, "Failed to delete local TDLib file: $path")
            }
            file.parentFile?.let { parent ->
                if (parent.isDirectory && parent.listFiles().isNullOrEmpty()) {
                    parent.delete()
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "deleteLocalFile failed for $path", e)
        }
    }

    private data class NativeMediaInfo(
        val file: File,
        val fileName: String,
        val mimeType: String,
    )

    private data class ResolvedNativeMessage(
        val chatId: Long,
        val message: dev.g000sha256.tdl.dto.Message,
    )
}
