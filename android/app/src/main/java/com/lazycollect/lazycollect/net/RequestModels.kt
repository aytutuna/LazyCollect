package com.lazycollect.lazycollect.net

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive

@Serializable
data class RequestRow(
    val id: String,
    @SerialName("client_id") val clientId: String,
    @SerialName("client_name") val clientName: String,
    val title: String,
    val deadline: Long,
    val status: String,
    val empty: Int = 0,
    val submitted: Int = 0,
    val approved: Int = 0,
    val rejected: Int = 0,
    val unavailable: Int = 0,
    val waived: Int = 0,
    val unanswered: Int = 0,
    val expiring: Int = 0,
    @SerialName("expiring_on") val expiringOn: String? = null,
) {
    val total get() = empty + submitted + approved + rejected + unavailable + waived
    val received get() = submitted + approved + waived
    val open get() = status == "draft" || status == "open"
}

@Serializable
data class RequestCounts(
    val all: Int = 0,
    @SerialName("to_review") val toReview: Int = 0,
    val waiting: Int = 0,
    val expiring: Int = 0,
    val overdue: Int = 0,
    @SerialName("due_soon") val dueSoon: Int = 0,
    val done: Int = 0,
)

@Serializable
data class ClientRef(val id: String, val name: String)

/** [counts] come with the first page only; [next] is the offset of the page after this one. */
@Serializable
data class RequestPage(val rows: List<RequestRow>, val next: Int? = null, val counts: RequestCounts? = null, val client: ClientRef? = null)

@Serializable
data class RequestFile(
    val id: String,
    val name: String,
    val size: Long,
    val mime: String,
    @SerialName("uploaded_at") val uploadedAt: Long,
    @SerialName("sent_back_at") val sentBackAt: Long? = null,
)

@Serializable
data class RequestItem(
    val id: String,
    val label: String,
    val help: String? = null,
    val required: Boolean = false,
    val status: String,
    val kind: String = "file",
    @SerialName("reject_note") val rejectNote: String? = null,
    @SerialName("reject_reasons") val rejectReasons: List<String> = emptyList(),
    @SerialName("unavailable_note") val unavailableNote: String? = null,
    val answer: JsonElement? = null,
    @SerialName("answer_at") val answerAt: Long? = null,
    val hidden: Boolean = false,
    @SerialName("person_pos") val personPos: Int? = null,
    @SerialName("expiry_rule") val expiryRule: String? = null,
    @SerialName("valid_months") val validMonths: Int? = null,
    @SerialName("expires_on") val expiresOn: String? = null,
    @SerialName("issued_on") val issuedOn: String? = null,
    @SerialName("valid_to") val validTo: String? = null,
    @SerialName("expiry_flag") val expiryFlag: String? = null,
    val files: List<RequestFile> = emptyList(),
) {
    val received get() = status == "submitted" || status == "approved" || status == "waived"

    val answerText: String
        get() = when (val a = answer) {
            is JsonPrimitive -> if (a.isString) a.content else ""
            is JsonArray -> a.joinToString(", ") { it.jsonPrimitive.content }
            else -> ""
        }
}

@Serializable
data class RequestDetail(
    val id: String,
    @SerialName("client_id") val clientId: String,
    val title: String,
    val note: String? = null,
    val deadline: Long,
    val status: String,
    @SerialName("sent_at") val sentAt: Long? = null,
    @SerialName("first_opened_at") val firstOpenedAt: Long? = null,
    @SerialName("reminders_on") val remindersOn: Boolean = false,
    @SerialName("next_reminder_at") val nextReminderAt: Long? = null,
    val people: List<Person> = emptyList(),
    val items: List<RequestItem> = emptyList(),
) {
    /** Open and complete requests take reviews and replies; a draft has no link yet and a closed one is final. */
    val reviewable get() = status == "open" || status == "complete"
    val editable get() = status == "draft" || status == "open" || status == "complete"

    /** An item an answer has hidden is not part of the count. */
    val shown get() = items.filter { !it.hidden }
}

@Serializable
data class NoteThread(val notes: List<Note> = emptyList(), val unanswered: Int = 0)

/** What the server says about the email that tells the client of a reply: sent, recent, no_email, unsubscribed and so on. */
@Serializable
data class NoteReply(val note: Note, val emailed: Boolean = false, val email: String = "")

@Serializable
data class LinkInfo(val url: String? = null, @SerialName("expires_at") val expiresAt: Long? = null)

@Serializable
data class LinkBody(@SerialName("send_email") val sendEmail: Boolean)

@Serializable
data class LinkMade(val url: String, val emailed: Boolean = false, @SerialName("email_failed") val emailFailed: Boolean = false)

/** [files] are the ones the reviewer looked at and [answeredAt] the answer's time, so the server can refuse a decision on something that changed. */
@Serializable
data class ReviewBody(
    val decision: String,
    val files: List<String>,
    @SerialName("answered_at") val answeredAt: Long? = null,
    val reasons: List<String>? = null,
    val note: String? = null,
)

@Serializable
data class UnavailableDecision(val decision: String, val note: String? = null)
