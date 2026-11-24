package com.lazycollect.lazycollect.net

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

val ApiJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = true
}

const val PLATFORM = "android"

@Serializable
data class Challenge(val challenge: String, val required: Boolean)

@Serializable
data class Attestation(val challenge: String, val token: String)

@Serializable
data class StartRequest(val email: String, val attestation: Attestation? = null, val platform: String = PLATFORM)

@Serializable
data class VerifyRequest(val email: String, val code: String, val platform: String = PLATFORM)

/** A session token, or the step still owed (passkey or enrol) with the pending token that goes with it. */
@Serializable
data class Verified(val token: String? = null, val step: String? = null, val pending: String? = null)

@Serializable
data class PendingInfo(val step: String? = null, val role: String? = null, val email: String? = null)

@Serializable
data class PasskeyOptions(val kind: String, val options: JsonObject)

@Serializable
data class PasskeyProof(val response: JsonObject, val name: String)

@Serializable
data class Token(val token: String)

@Serializable
data class User(val id: String, val email: String, val name: String? = null, val role: String) {
    val owner get() = role == "owner"
}

@Serializable
data class FirmState(
    val id: String,
    val name: String? = null,
    val tz: String,
    @SerialName("plan_status") val planStatus: String,
    @SerialName("trial_ends_at") val trialEndsAt: Long? = null,
    @SerialName("current_period_end") val currentPeriodEnd: Long? = null,
    @SerialName("past_due_since") val pastDueSince: Long? = null,
    @SerialName("cancel_at_period_end") val cancelAtPeriodEnd: Boolean = false,
    val subscribed: Boolean = false,
    @SerialName("closed_at") val closedAt: Long? = null,
    val held: Boolean = false,
    val usable: Boolean = true,
)

@Serializable
data class Me(val user: User, val firm: FirmState)

@Serializable
data class Firm(
    val name: String? = null,
    @SerialName("legal_name") val legalName: String? = null,
    val address: String? = null,
    val phone: String? = null,
    val province: String? = null,
    val tz: String,
)

@Serializable
data class FirmUpdate(
    val name: String,
    @SerialName("legal_name") val legalName: String,
    val address: String,
    val phone: String,
    val province: String,
    val tz: String,
)

@Serializable
data class Device(
    val id: String? = null,
    val label: String? = null,
    @SerialName("created_at") val createdAt: Long,
    @SerialName("last_seen_at") val lastSeenAt: Long,
    val current: Boolean = false,
)

@Serializable
internal data class ErrorBody(val error: String? = null)
