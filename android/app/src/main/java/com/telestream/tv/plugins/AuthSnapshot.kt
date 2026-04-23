package com.telestream.tv.plugins

data class AuthSnapshot(
    val state: String,
    val qrLink: String? = null,
    val userId: String? = null,
    val error: String? = null,
)
