package com.lynkeus

import android.content.pm.ApplicationInfo
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.uimanager.TouchTargetHelper
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject

/**
 * Touch and key synthesis dispatched to the activity's own window: no
 * instrumentation, no INJECT_EVENTS permission. Only debuggable builds get
 * it; a release build answers "unavailable" to everything.
 */
class LynkeusModule(reactContext: ReactApplicationContext) :
  NativeLynkeusSpec(reactContext) {

  private val main = Handler(Looper.getMainLooper())

  private val debuggable: Boolean
    get() = (reactApplicationContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0

  override fun isAvailable(): Boolean = debuggable

  private fun rootView(): View? = currentActivity?.window?.decorView

  private fun focusedEditText(): EditText? = rootView()?.findFocus() as? EditText

  private fun px(points: Double): Float =
    (points * reactApplicationContext.resources.displayMetrics.density).toFloat()

  private fun dispatch(down: Long, action: Int, x: Float, y: Float) {
    val root = rootView() ?: return
    val event = MotionEvent.obtain(down, SystemClock.uptimeMillis(), action, x, y, 0)
    event.source = InputDevice.SOURCE_TOUCHSCREEN
    root.dispatchTouchEvent(event)
    event.recycle()
  }

  private inline fun guarded(promise: Promise, crossinline block: () -> Unit) {
    if (!debuggable) {
      promise.reject("unavailable", "Lynkeus is only available in debuggable builds")
      return
    }
    main.post { block() }
  }

  private inline fun withFocusedInput(promise: Promise, crossinline block: (EditText) -> Unit) = guarded(promise) {
    val input = focusedEditText()
    if (input == null) {
      promise.reject("no_input", "No focused text input")
    } else {
      block(input)
      promise.resolve(true)
    }
  }

  override fun tap(x: Double, y: Double, holdMs: Double, promise: Promise) = guarded(promise) {
    if (rootView() == null) {
      promise.reject("no_window", "No activity window")
      return@guarded
    }
    val down = SystemClock.uptimeMillis()
    dispatch(down, MotionEvent.ACTION_DOWN, px(x), px(y))
    main.postDelayed({
      dispatch(down, MotionEvent.ACTION_UP, px(x), px(y))
      promise.resolve(true)
    }, if (holdMs > 0) holdMs.toLong() else 50)
  }

  override fun swipe(x1: Double, y1: Double, x2: Double, y2: Double, durationMs: Double, promise: Promise) =
    guarded(promise) {
      val duration = if (durationMs > 0) durationMs else 250.0
      val down = SystemClock.uptimeMillis()
      dispatch(down, MotionEvent.ACTION_DOWN, px(x1), px(y1))
      val steps = maxOf(4, (duration / 16).toInt())
      for (i in 1..steps) {
        val t = i.toDouble() / steps
        val x = px(x1 + (x2 - x1) * t)
        val y = px(y1 + (y2 - y1) * t)
        main.postDelayed({
          dispatch(down, MotionEvent.ACTION_MOVE, x, y)
          if (i == steps) {
            dispatch(down, MotionEvent.ACTION_UP, x, y)
            promise.resolve(true)
          }
        }, (duration * t).toLong())
      }
    }

  // Editing the buffer runs the TextWatchers, so React Native sees a change.
  override fun typeText(text: String, promise: Promise) = withFocusedInput(promise) { input ->
    input.text.insert(input.selectionEnd.coerceAtLeast(0), text)
  }

  override fun deleteBackward(count: Double, promise: Promise) = withFocusedInput(promise) { input ->
    val end = input.selectionEnd.coerceAtLeast(0)
    input.text.delete((end - count.toInt()).coerceAtLeast(0), end)
  }

  // The return key sends the field's own editor action, which React Native turns into onSubmitEditing.
  override fun submitEditing(promise: Promise) = withFocusedInput(promise) { input ->
    val action = input.imeOptions and EditorInfo.IME_MASK_ACTION
    input.onEditorAction(if (action == EditorInfo.IME_ACTION_UNSPECIFIED) EditorInfo.IME_ACTION_DONE else action)
  }

  override fun dismissKeyboard(promise: Promise) = guarded(promise) {
    rootView()?.findFocus()?.clearFocus()
    promise.resolve(true)
  }

  // Synchronous: asked on the JS thread, answered on the main one, by React Native's own search for the
  // target of a touch. It is the search a real touch goes through, so a view that lets touches pass (the
  // debugging overlay over every dev build, anything with pointerEvents none) covers nothing.
  override fun hitTest(xs: ReadableArray, ys: ReadableArray): String {
    if (!debuggable) return "[]"
    val points = List(minOf(xs.size(), ys.size())) { px(xs.getDouble(it)) to px(ys.getDouble(it)) }
    return onMain("[]") {
      val root = rootView() as? ViewGroup
      val chains = JSONArray()
      for ((x, y) in points) {
        val chain = JSONArray()
        if (root != null) {
          for (target in TouchTargetHelper.findTargetPathAndCoordinatesForTouch(x, y, root, FloatArray(2))) {
            if (target.getViewId() > 0) chain.put(target.getViewId())
          }
        }
        chains.put(chain)
      }
      chains.toString()
    }
  }

  private fun <T> onMain(otherwise: T, work: () -> T): T {
    if (Looper.myLooper() == Looper.getMainLooper()) return work()
    val task = FutureTask(work)
    main.post(task)
    return try {
      task.get(1, TimeUnit.SECONDS)
    } catch (e: Exception) {
      otherwise
    }
  }

  private fun collect(view: View, wanted: Set<Int>, found: MutableMap<Int, View>) {
    if (view.id in wanted) found[view.id] = view
    if (view is ViewGroup) for (i in 0 until view.childCount) collect(view.getChildAt(i), wanted, found)
  }

  // Where each tag's view stands: [x, y, width, height] in points from the
  // window's corner, null for a tag with no view. Read like hitTest, on
  // whichever thread asks.
  override fun frames(tags: ReadableArray): String {
    if (!debuggable) return "[]"
    val wanted = HashSet<Int>()
    for (i in 0 until tags.size()) wanted.add(tags.getDouble(i).toInt())
    val found = HashMap<Int, View>()
    rootView()?.let { collect(it, wanted, found) }
    val density = reactApplicationContext.resources.displayMetrics.density.toDouble()
    val frames = JSONArray()
    val location = IntArray(2)
    for (i in 0 until tags.size()) {
      val view = found[tags.getDouble(i).toInt()]
      if (view == null) {
        frames.put(JSONObject.NULL)
      } else {
        view.getLocationInWindow(location)
        frames.put(JSONArray(listOf(location[0] / density, location[1] / density, view.width / density, view.height / density)))
      }
    }
    return frames.toString()
  }

  companion object {
    const val NAME = NativeLynkeusSpec.NAME
  }
}
