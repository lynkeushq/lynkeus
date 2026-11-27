package com.lynkeus

import android.content.Context
import android.content.pm.ApplicationInfo
import android.graphics.Matrix
import android.graphics.RectF
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.TextView
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.uimanager.RootView
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

  // Every window of this process, back to front: the activity's, and what opens over it (a Modal's dialog, an
  // AlertDialog, a popup). The list is the one Espresso reads; without it, the activity's window alone.
  private fun windowRoots(): List<View> {
    val activity = rootView()
    val all = try {
      val global = Class.forName("android.view.WindowManagerGlobal")
      val instance = global.getMethod("getInstance").invoke(null)
      val field = global.getDeclaredField("mViews")
      field.isAccessible = true
      (field.get(instance) as? List<*>)?.filterIsInstance<View>()
    } catch (e: Exception) {
      null
    }
    val roots = all?.filter { it.isShown && it.context.applicationContext == reactApplicationContext.applicationContext }
    return if (roots.isNullOrEmpty() || (activity != null && activity !in roots)) listOfNotNull(activity) else roots
  }

  private fun flags(root: View): Int = (root.layoutParams as? WindowManager.LayoutParams)?.flags ?: 0

  private fun origin(view: View): IntArray = IntArray(2).also { view.getLocationOnScreen(it) }

  /**
   * The window a finger at (x, y) of the activity's window lands in, front first, and the point in its coordinates.
   * A window that cannot be touched lets it through; a dialog that is modal to touch takes it even outside itself.
   */
  private fun windowAt(x: Float, y: Float): Triple<View, Float, Float>? {
    val activity = rootView() ?: return null
    val base = origin(activity)
    for (root in windowRoots().asReversed()) {
      val flags = flags(root)
      if (flags and WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE != 0) continue
      val at = origin(root)
      val lx = x + base[0] - at[0]
      val ly = y + base[1] - at[1]
      val inside = lx >= 0 && ly >= 0 && lx < root.width && ly < root.height
      val modal = root != activity && flags and (WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE) == 0
      if (inside || modal) return Triple(root, lx, ly)
    }
    return Triple(activity, x, y)
  }

  private fun focusedEditText(): EditText? =
    windowRoots().asReversed().firstNotNullOfOrNull { it.findFocus() as? EditText } ?: rootView()?.findFocus() as? EditText

  private fun px(points: Double): Float =
    (points * reactApplicationContext.resources.displayMetrics.density).toFloat()

  private fun dispatch(down: Long, action: Int, x: Float, y: Float, at: Long = SystemClock.uptimeMillis()) {
    val root = rootView() ?: return
    val event = MotionEvent.obtain(down, at, action, x, y, 0)
    event.source = InputDevice.SOURCE_TOUCHSCREEN
    root.dispatchTouchEvent(event)
    event.recycle()
  }

  // A gesture goes to the window it started in, in that window's coordinates, as Android's input dispatch sends it.
  private class Gesture(val root: View, val dx: Float, val dy: Float)

  private fun gestureAt(x: Float, y: Float): Gesture? {
    val (root, lx, ly) = windowAt(x, y) ?: return null
    return Gesture(root, lx - x, ly - y)
  }

  private fun dispatch(gesture: Gesture?, down: Long, action: Int, x: Float, y: Float, at: Long = SystemClock.uptimeMillis()) {
    if (gesture == null) return dispatch(down, action, x, y, at)
    val event = MotionEvent.obtain(down, at, action, x + gesture.dx, y + gesture.dy, 0)
    event.source = InputDevice.SOURCE_TOUCHSCREEN
    gesture.root.dispatchTouchEvent(event)
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
    val gesture = gestureAt(px(x), px(y))
    dispatch(gesture, down, MotionEvent.ACTION_DOWN, px(x), px(y))
    main.postDelayed({
      dispatch(gesture, down, MotionEvent.ACTION_UP, px(x), px(y))
      promise.resolve(true)
    }, if (holdMs > 0) holdMs.toLong() else 50)
  }

  override fun swipe(x1: Double, y1: Double, x2: Double, y2: Double, durationMs: Double, promise: Promise) =
    guarded(promise) {
      val duration = if (durationMs > 0) durationMs else 250.0
      val down = SystemClock.uptimeMillis()
      val gesture = gestureAt(px(x1), px(y1))
      dispatch(gesture, down, MotionEvent.ACTION_DOWN, px(x1), px(y1))
      val steps = maxOf(4, (duration / 16).toInt())
      for (i in 1..steps) {
        val t = i.toDouble() / steps
        val x = px(x1 + (x2 - x1) * t)
        val y = px(y1 + (y2 - y1) * t)
        // Each move carries the time it was meant for, not the time the main thread got to it: VelocityTracker
        // reads the release speed off these, and a late frame would change how far the fling goes.
        val at = down + (duration * t).toLong()
        main.postDelayed({
          dispatch(gesture, down, MotionEvent.ACTION_MOVE, x, y, at)
          if (i == steps) {
            dispatch(gesture, down, MotionEvent.ACTION_UP, x, y, at)
            promise.resolve(true)
          }
        }, (duration * t).toLong())
      }
    }

  // Editing through the IME follows the same TextWatchers as a hardware keyboard, including controlled React inputs.
  override fun typeText(text: String, promise: Promise) = withFocusedInput(promise) { input ->
    val connection = input.onCreateInputConnection(EditorInfo())
    if (connection != null) connection.commitText(text, 1)
    else input.text.insert(input.selectionEnd.coerceAtLeast(0), text)
  }

  override fun deleteBackward(count: Double, promise: Promise) = withFocusedInput(promise) { input ->
    // Replacing a controlled React field must clear both sides of a caret that may be mid-text. The IME wrapper
    // applies large deletions only before the caret on Android, leaving the suffix in the native field.
    input.text.clear()
    input.setSelection(0)
  }

  // The return key sends the field's own editor action, which React Native turns into onSubmitEditing.
  override fun submitEditing(promise: Promise) = withFocusedInput(promise) { input ->
    val action = input.imeOptions and EditorInfo.IME_MASK_ACTION
    input.onEditorAction(if (action == EditorInfo.IME_ACTION_UNSPECIFIED) EditorInfo.IME_ACTION_DONE else action)
  }

  override fun dismissKeyboard(promise: Promise) = guarded(promise) {
    rootView()?.let { root ->
      // Losing the focus does not take Android's keyboard down: hide it too, as React Native's own blur does.
      val keyboard = reactApplicationContext.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
      keyboard.hideSoftInputFromWindow(root.windowToken, 0)
      root.findFocus()?.clearFocus()
    }
    promise.resolve(true)
  }

  // Synchronous: asked on the JS thread, answered on the main one, by React Native's own search for the
  // target of a touch. It is the search a real touch goes through, so a view that lets touches pass (the
  // debugging overlay over every dev build, anything with pointerEvents none) covers nothing.
  override fun hitTest(xs: ReadableArray, ys: ReadableArray): String {
    if (!debuggable) return "[]"
    val points = List(minOf(xs.size(), ys.size())) { px(xs.getDouble(it)) to px(ys.getDouble(it)) }
    return onMain("[]") {
      val chains = JSONArray()
      for ((x, y) in points) {
        val (root, lx, ly) = windowAt(x, y) ?: Triple(null, x, y)
        chains.put(root?.let { hit(it, lx, ly) } ?: JSONArray())
      }
      chains.toString()
    }
  }

  // React Native's own search for a touch's target starts at its root view and takes any view as a target, so it
  // starts there: what the window holds outside React (the bars' backgrounds, a launcher's splash left invisible)
  // gets a touch only the way Android hands it one. Null when nothing at the point takes the touch; an empty chain
  // when a view outside React Native does.
  private fun hit(view: View, x: Float, y: Float): JSONArray? {
    if (view.visibility != View.VISIBLE || x < 0 || y < 0 || x >= view.width || y >= view.height) return null
    if (view is RootView && view is ViewGroup) {
      val chain = JSONArray()
      for (target in TouchTargetHelper.findTargetPathAndCoordinatesForTouch(x, y, view, FloatArray(2))) {
        if (target.getViewId() > 0) chain.put(target.getViewId())
      }
      return chain
    }
    if (view is ViewGroup) {
      for (i in view.childCount - 1 downTo 0) {
        val child = view.getChildAt(i) ?: continue
        val local = floatArrayOf(x + view.scrollX - child.left, y + view.scrollY - child.top)
        if (!child.matrix.isIdentity) {
          val inverse = Matrix()
          if (!child.matrix.invert(inverse)) continue
          inverse.mapPoints(local)
        }
        hit(child, local[0], local[1])?.let { return it }
      }
    }
    return if (view.isClickable || view.isLongClickable) JSONArray() else null
  }

  private fun hasReactRoot(view: View): Boolean =
    view is RootView || (view is ViewGroup && (0 until view.childCount).any { i -> view.getChildAt(i)?.let { hasReactRoot(it) } == true })

  private fun actsOnTouch(view: View, stop: View): Boolean {
    var at: View? = view
    while (at != null && at != stop) {
      if (at.isClickable) return true
      at = at.parent as? View
    }
    return false
  }

  // What windows of this process that React Native does not draw show over the app (an AlertDialog, a native SDK's
  // dialog): their words with frames, in the activity window's points. A dialog that is modal to touch covers it all.
  override fun systemViews(): String {
    if (!debuggable) return "null"
    return onMain("null") {
      val activity = rootView() ?: return@onMain "null"
      val base = origin(activity)
      val density = reactApplicationContext.resources.displayMetrics.density
      val items = JSONArray()
      var covers: RectF? = null
      for (root in windowRoots().asReversed()) {
        if (root == activity || hasReactRoot(root)) break
        if (flags(root) and WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE != 0) continue
        val at = origin(root)
        val modal = flags(root) and (WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE) == 0
        val area = if (modal) RectF(0f, 0f, activity.width.toFloat(), activity.height.toFloat())
          else RectF((at[0] - base[0]).toFloat(), (at[1] - base[1]).toFloat(), (at[0] - base[0] + root.width).toFloat(), (at[1] - base[1] + root.height).toFloat())
        covers = covers?.apply { union(area) } ?: area
        val texts = ArrayList<TextView>()
        fun gather(view: View) {
          if (view.visibility != View.VISIBLE) return
          if (view is TextView && !view.text.isNullOrEmpty()) texts.add(view)
          if (view is ViewGroup) for (i in 0 until view.childCount) view.getChildAt(i)?.let { gather(it) }
        }
        gather(root)
        for (text in texts) {
          val box = boundsInWindow(text)
          box.offset((at[0] - base[0]).toFloat(), (at[1] - base[1]).toFloat())
          items.put(JSONObject().apply {
            put("text", text.text.toString())
            put("kind", if (actsOnTouch(text, root)) "button" else "text")
            put("frame", JSONArray(listOf(box.left / density, box.top / density, box.width() / density, box.height() / density)))
          })
        }
      }
      val area = covers ?: return@onMain "null"
      JSONObject().apply {
        put("frame", JSONArray(listOf(area.left / density, area.top / density, area.width() / density, area.height() / density)))
        put("items", items)
      }.toString()
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
    if (view is ViewGroup) for (i in 0 until view.childCount) view.getChildAt(i)?.let { collect(it, wanted, found) }
  }

  // Where each tag's view stands: [x, y, width, height] in points from the
  // window's corner, null for a tag with no view. Read on the main thread, where the view hierarchy cannot change mid-walk.
  override fun frames(tags: ReadableArray): String {
    if (!debuggable) return "[]"
    return onMain("[]") {
      val wanted = HashSet<Int>()
      for (i in 0 until tags.size()) wanted.add(tags.getDouble(i).toInt())
      val found = HashMap<Int, View>()
      rootView()?.let { collect(it, wanted, found) }
      val density = reactApplicationContext.resources.displayMetrics.density.toDouble()
      val frames = JSONArray()
      for (i in 0 until tags.size()) {
        val view = found[tags.getDouble(i).toInt()]
        if (view == null) {
          frames.put(JSONObject.NULL)
        } else {
          val box = boundsInWindow(view)
          frames.put(JSONArray(listOf(box.left / density, box.top / density, box.width() / density, box.height() / density)))
        }
      }
      frames.toString()
    }
  }

  // The box a view covers in the window once every transform on the way up is
  // applied, as iOS's convertRect gives it. getLocationInWindow maps only the
  // view's own corner, which a rotated or flipped view moves to the other side.
  private fun boundsInWindow(view: View): RectF {
    val box = RectF(0f, 0f, view.width.toFloat(), view.height.toFloat())
    var current = view
    while (true) {
      if (!current.matrix.isIdentity) current.matrix.mapRect(box)
      val parent = current.parent as? View
      if (parent == null) {
        // The window's own offsets are getLocationInWindow's business; the top view has no transform.
        val location = IntArray(2)
        current.getLocationInWindow(location)
        box.offset(location[0].toFloat(), location[1].toFloat())
        return box
      }
      box.offset((current.left - parent.scrollX).toFloat(), (current.top - parent.scrollY).toFloat())
      current = parent
    }
  }

  // What each tag's field holds, null for a tag that is not a text field. Read on the main thread, like hitTest.
  override fun texts(tags: ReadableArray): String {
    if (!debuggable) return "[]"
    return onMain("[]") {
      val wanted = HashSet<Int>()
      for (i in 0 until tags.size()) wanted.add(tags.getDouble(i).toInt())
      val found = HashMap<Int, View>()
      rootView()?.let { collect(it, wanted, found) }
      val texts = JSONArray()
      for (i in 0 until tags.size()) {
        val view = found[tags.getDouble(i).toInt()]
        texts.put(if (view is EditText) view.text.toString() else JSONObject.NULL)
      }
      texts.toString()
    }
  }

  companion object {
    const val NAME = NativeLynkeusSpec.NAME
  }
}
