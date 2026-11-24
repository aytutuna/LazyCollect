package com.lazycollect.lazycollect.net

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive

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

@Serializable
data class Exchange(val token: String, @SerialName("expires_at") val expiresAt: Long)

@Serializable
data class ExchangeRequest(val token: String, val attestation: Attestation? = null, val platform: String = PLATFORM)

@Serializable
data class FileRow(
    val id: String,
    val name: String,
    val size: Long,
    @SerialName("uploaded_at") val uploadedAt: Long,
    @SerialName("sent_back_at") val sentBackAt: Long? = null,
)

@Serializable
data class ClientItem(
    val id: String,
    val label: String,
    val help: String? = null,
    val required: Boolean = false,
    val status: String,
    @SerialName("reject_note") val rejectNote: String? = null,
    @SerialName("reject_reasons") val rejectReasons: List<String> = emptyList(),
    @SerialName("unavailable_note") val unavailableNote: String? = null,
    val kind: String = "file",
    val example: String? = null,
    val options: List<String>? = null,
    // a string, or an array of strings for a multi-choice question
    val answer: JsonElement? = null,
    @SerialName("person_pos") val personPos: Int? = null,
    @SerialName("expiry_rule") val expiryRule: String? = null,
    @SerialName("valid_months") val validMonths: Int? = null,
    @SerialName("expires_on") val expiresOn: String? = null,
    @SerialName("issued_on") val issuedOn: String? = null,
    val files: List<FileRow> = emptyList(),
) {
    val received get() = status == "submitted" || status == "approved" || status == "waived"
    val approved get() = status == "approved"

    val answerText: String get() = (answer as? JsonPrimitive)?.takeIf { it.isString }?.content.orEmpty()
    val answerList: List<String> get() = (answer as? JsonArray)?.map { it.jsonPrimitive.content }.orEmpty()
}

@Serializable
data class Note(val id: String, val author: String, val body: String, @SerialName("created_at") val createdAt: Long)

@Serializable
data class Person(val position: Int, val role: String, val name: String)

@Serializable
data class Contact(val name: String? = null, val email: String? = null, val phone: String? = null, val address: String? = null)

@Serializable
data class ClientView(
    @SerialName("firm_name") val firmName: String,
    val tz: String = "America/Toronto",
    val title: String,
    val note: String? = null,
    val deadline: Long,
    val status: String,
    @SerialName("expires_at") val expiresAt: Long,
    val contact: Contact? = null,
    val notes: List<Note> = emptyList(),
    val people: List<Person> = emptyList(),
    val items: List<ClientItem> = emptyList(),
)

@Serializable
data class Uploaded(val id: String, val name: String, val size: Long)

@Serializable
data class ItemsReply(val items: List<ClientItem>)

@Serializable
data class NoteBody(val body: String)

@Serializable
data class UnavailableBody(val note: String)
