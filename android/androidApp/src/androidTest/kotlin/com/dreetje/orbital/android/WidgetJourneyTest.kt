package com.dreetje.orbital.android

import android.content.Context
import android.content.Intent
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import kotlinx.coroutines.runBlocking
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.regex.Pattern

// The widgets end to end, on the device's own home screen (UI Automator: the launcher is another app): the app opened
// on the iPhone's invented sample keeps what the widgets show, the launcher is asked to pin one, and it is used as a
// finger would. The cover screen's Timeline is offered on the home screen by the debug build (src/debug).
@RunWith(AndroidJUnit4::class)
class WidgetJourneyTest {
    private val device get() = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
    private val context get() = ApplicationProvider.getApplicationContext<Context>()

    // what the screen showed at a step, for whoever reads the run (adb pull /sdcard/Android/data/com.dreetje.orbital/files/widgets)
    private fun shot(name: String) { device.waitForIdle(); device.takeScreenshot(File(context.getExternalFilesDir("widgets"), "$name.png")) }

    // the app read on the sample, in a task of its own (a widget's tap may have left one), then the widget asked of the
    // launcher, which asks first; Home shows it
    private fun pinned(receiver: Class<out GlanceAppWidgetReceiver>) {
        awake(device)
        context.startActivity(Intent(context, MainActivity::class.java).putExtra("sample", true).putExtra("demoMode", false).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
        check(device.wait(Until.hasObject(By.text("Today's Tasks")), 15_000))
        Thread.sleep(2000) // the widgets' Timeline is kept half a second after the read settles
        check(runBlocking { GlanceAppWidgetManager(context).requestPinGlanceAppWidget(receiver) }) { "the launcher pins widgets" }
        device.wait(Until.findObject(By.text(Pattern.compile("(?i)add( to home screen| automatically)?"))), 10_000).click()
        device.pressHome()
    }

    @Test fun aMeetingOnTheTodayWidgetOpensInTheApp() {
        pinned(AheadWidgetReceiver::class.java)
        device.wait(Until.findObject(By.text("Design review")), 20_000).also { shot("today") }.click()
        check(device.wait(Until.hasObject(By.text("Offsite planning")), 15_000)) { "the meeting opens in the app, its documents on its page" }
        shot("meeting-in-the-app")
    }

    @Test fun theActivityWidgetScrollsToWhatHappenedEarlier() {
        pinned(ActivityWidgetReceiver::class.java)
        val rail = device.wait(Until.findObject(By.clazz("android.widget.ListView").hasDescendant(By.text("Rotate the staging API keys"))), 20_000)
        check(rail.scrollUntil(Direction.DOWN, Until.findObject(By.text("Retro, sprint 42"))) != null) { "further down the rail" }
        shot("timeline-scrolled")
    }

    @Test fun todaysTasksPlusOpensQuickAdd() {
        pinned(TodayWidgetReceiver::class.java)
        check(device.wait(Until.hasObject(By.text("Draft the Q4 hiring plan")), 20_000))
        shot("todays-tasks")
        device.findObject(By.desc("Quick Add Task")).click()
        check(device.wait(Until.hasObject(By.text("Quick Add")), 15_000)) { "Quick Add opens in the app" }
    }

    // a task's box opens the app, which ticks it at once; the widget, drawn again from what the app kept, shows it done
    @Test fun aTasksBoxOnTheWidgetTicksItInTheApp() {
        pinned(TodayWidgetReceiver::class.java)
        device.wait(Until.findObject(By.desc("Mark as done, Draft the Q4 hiring plan")), 20_000).also { shot("todays-tasks-box") }.click()
        check(device.wait(Until.hasObject(By.text("Today's Tasks")), 15_000)) { "the app opens on its Timeline" }
        Thread.sleep(2000) // kept half a second after the tick settles
        device.pressHome()
        check(device.wait(Until.hasObject(By.desc("Mark as not done, Draft the Q4 hiring plan")), 15_000)) { "the widget shows it ticked" }
        shot("todays-tasks-ticked")
    }
}
