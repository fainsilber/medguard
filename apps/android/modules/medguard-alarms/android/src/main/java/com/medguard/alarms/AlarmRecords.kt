package com.medguard.alarms

import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

/** Mirrors `ScheduleDoseAlarmInput` in `src/MedGuardAlarms.types.ts`. */
class ScheduleDoseAlarmRecord : Record {
    @Field
    var occurrenceKey: String = ""

    @Field
    var triggerAtMs: Long = 0L

    @Field
    var channelId: String = MedGuardChannels.DOSE_STANDARD

    @Field
    var title: String = ""

    @Field
    var body: String = ""

    @Field
    var chimeDurationSeconds: Int = 45

    @Field
    var escalation: Boolean = false
}
