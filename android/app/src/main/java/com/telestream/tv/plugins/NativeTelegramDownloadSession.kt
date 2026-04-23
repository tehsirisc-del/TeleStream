package com.telestream.tv.plugins

import dev.g000sha256.tdl.dto.File
import java.io.IOException

class NativeTelegramDownloadSession(
    val peerType: String,
    val peerId: Long,
    val messageId: Long,
    val fileId: Int,
    val fileName: String,
    val mimeType: String,
    initialSize: Long,
) {
    private val lock = Object()

    @Volatile
    private var totalSize: Long = initialSize

    @Volatile
    private var localPath: String = ""

    @Volatile
    private var availableFrom: Long = 0L

    @Volatile
    private var availableUntil: Long = 0L

    @Volatile
    private var completed = false

    @Volatile
    private var closed = false

    @Volatile
    private var failureMessage: String? = null

    fun update(file: File) {
        synchronized(lock) {
            if (file.size > 0) {
                totalSize = file.size
            } else if (file.expectedSize > 0 && totalSize <= 0) {
                totalSize = file.expectedSize
            }

            if (file.local.path.isNotEmpty()) {
                localPath = file.local.path
            }

            val nextAvailableFrom = if (file.local.isDownloadingCompleted) {
                0L
            } else {
                file.local.downloadOffset
            }

            val nextAvailableUntil = if (file.local.isDownloadingCompleted) {
                maxOf(totalSize, file.local.downloadedSize, file.local.downloadOffset + file.local.downloadedPrefixSize)
            } else {
                file.local.downloadOffset + file.local.downloadedPrefixSize
            }

            availableFrom = if (file.local.isDownloadingCompleted) {
                0L
            } else {
                nextAvailableFrom
            }
            completed = file.local.isDownloadingCompleted
            availableUntil = nextAvailableUntil
            lock.notifyAll()
        }
    }

    fun fail(message: String) {
        synchronized(lock) {
            failureMessage = message
            lock.notifyAll()
        }
    }

    fun close() {
        synchronized(lock) {
            closed = true
            lock.notifyAll()
        }
    }

    fun getTotalSize(): Long = totalSize

    fun getLocalPath(): String = localPath

    fun getAvailableFrom(): Long = availableFrom

    fun getAvailableUntil(): Long = availableUntil

    fun isCompleted(): Boolean = completed

    @Throws(IOException::class)
    fun awaitReadable(positionExclusive: Long, timeoutMs: Long): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs

        synchronized(lock) {
            while (true) {
                failureMessage?.let { throw IOException(it) }

                if (closed) {
                    return false
                }

                if (
                    localPath.isNotEmpty() &&
                    (
                        completed ||
                            (positionExclusive > availableFrom && positionExclusive <= availableUntil)
                        )
                ) {
                    return true
                }

                val remaining = deadline - System.currentTimeMillis()
                if (remaining <= 0) {
                    return false
                }

                try {
                    lock.wait(remaining)
                } catch (interrupted: InterruptedException) {
                    Thread.currentThread().interrupt()
                    throw IOException("Interrupted while waiting for native Telegram data", interrupted)
                }
            }
        }
    }
}
