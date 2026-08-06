package com.medguard.alarms

import org.json.JSONObject

/**
 * Everything a fired alarm needs to post its own notification and chime, with no JS process
 * required to be running. This is what makes the alarm work with the app force-stopped and the
 * phone locked — the whole point of the native client (docs/android-client-plan.md, "What the
 * native client buys").
 */
data class AlarmPayload(
    val occurrenceKey: String,
    val channelId: String,
    val title: String,
    val body: String,
    val chimeDurationSeconds: Int,
    val escalation: Boolean,
    val triggerAtMs: Long,
) {
    fun toJson(): JSONObject =
        JSONObject()
            .put("occurrenceKey", occurrenceKey)
            .put("channelId", channelId)
            .put("title", title)
            .put("body", body)
            .put("chimeDurationSeconds", chimeDurationSeconds)
            .put("escalation", escalation)
            .put("triggerAtMs", triggerAtMs)

    companion object {
        fun fromJson(json: JSONObject): AlarmPayload =
            AlarmPayload(
                occurrenceKey = json.getString("occurrenceKey"),
                channelId = json.getString("channelId"),
                title = json.getString("title"),
                body = json.getString("body"),
                chimeDurationSeconds = json.getInt("chimeDurationSeconds"),
                escalation = json.getBoolean("escalation"),
                triggerAtMs = json.getLong("triggerAtMs"),
            )
    }
}
