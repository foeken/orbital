package com.dreetje.orbital.android

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.service.quicksettings.TileService

// Quick Add from the Quick Settings panel, the lock screen's included: the iPhone's Lock Screen Quick Add widget
// (ios/Widgets/Widgets.swift QuickAddWidget), where Android's lock screen takes no widget of an app's own. A tap opens
// Quick Add in the app (orbital:add), once the phone is unlocked.
class QuickAddTile : TileService() {
    override fun onClick() {
        if (isLocked) unlockAndRun(::open) else open()
    }

    // lint reads the Intent overload as unsafe from Android 14 on, where it is never called: only below it, which has no other
    @SuppressLint("StartActivityAndCollapseDeprecated")
    private fun open() {
        val add = FromOrbital.open(this, "orbital:add").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        // Android 14 takes only a pending intent here; before it, only the intent
        if (Build.VERSION.SDK_INT >= 34) startActivityAndCollapse(PendingIntent.getActivity(this, 0, add, PendingIntent.FLAG_IMMUTABLE))
        else @Suppress("DEPRECATION") startActivityAndCollapse(add)
    }
}
