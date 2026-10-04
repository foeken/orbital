package com.dreetje.orbital.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.AnimationSpec
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.SeekableTransitionState
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.rememberTransition
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.foundation.gestures.AnchoredDraggableDefaults
import androidx.compose.foundation.gestures.AnchoredDraggableState
import androidx.compose.foundation.gestures.DraggableAnchors
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.anchoredDraggable
import androidx.compose.foundation.gestures.animateTo
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.zIndex
import kotlin.math.roundToInt
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.runtime.toMutableStateList
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import com.dreetje.orbital.Dictation
import com.dreetje.orbital.Engine
import com.dreetje.orbital.json
import com.dreetje.orbital.maybe
import kotlin.io.encoding.Base64
import kotlin.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// The iPhone's ios/Orbital/Shell.swift: the side menu, the page, and the composer under it

// The app's frame, after the Codex and ChatGPT apps: a side menu behind the page (the Timeline, your saved searches and
// settings), the page with the menu button and its title, and a composer at the bottom that starts a chat with Tana.
// Wide windows (a tablet, an unfolded phone) keep the menu beside the page.
@Composable
fun Shell(engine: Engine, start: Start = Start()) {
    val c = Theme.colors
    val still = engine.platform.reduceMotion
    // what is open survives a rotation: the menu's page, the nodes zoomed into from it, and the sheets
    var page by rememberSaveable(stateSaver = listSaver<Menu, String>({ if (it is Menu.Search) listOf(it.id, it.title) else emptyList() }, { if (it.size == 2) Menu.Search(it[0], it[1]) else Menu.Timeline })) { mutableStateOf<Menu>(Menu.Timeline) }
    val path = rememberSaveable(saver = listSaver({ it.toList() }, { it.toMutableStateList() })) { mutableStateListOf<String>().apply { start.zoom?.let(::add) } } // the nodes zoomed into from the page
    val notes = remember { mutableStateMapOf<String, String>() } // chat id -> what its first message's send had to say
    val asked = remember { mutableStateMapOf<String, Instant>() } // chat id -> when Ask Tana sent its first message
    var searches by remember { mutableStateOf(listOf<Menu.Search>()) }
    var icons by remember { mutableStateOf(mapOf<String, ImageBitmap>()) } // saved search id -> the icon it was given in Orbital
    var secret by remember { mutableStateOf(setOf<String>()) } // the saved searches marked sensitive
    var settings by rememberSaveable { mutableStateOf(start.settings) }
    var adding by rememberSaveable { mutableStateOf(start.add) }
    var composer by remember { mutableStateOf(0.dp) } // how tall the floating composer is
    val focus = LocalFocusManager.current
    val density = LocalDensity.current
    val scope = rememberCoroutineScope()
    val pages = rememberSaveableStateHolder() // each page keeps its scroll while another is on top
    // The menu behind the page: the page follows the finger and settles open or shut with the iPhone's menu move, by
    // where it was let go and how fast it was going (Shell.swift predictedEndTranslation past a third of the menu)
    val drawer = remember { AnchoredDraggableState(false) }
    val move: AnimationSpec<Float> = if (still) snap() else snappy(0.3f)
    fun show(open: Boolean) { if (open) focus.clearFocus(); scope.launch { drawer.animateTo(open, move) } }
    // a back gesture under way (Back.kt): the edge it came from, 1 the left and -1 the right, 0 while there is none; and
    // where the open menu was when it began
    var edge by remember { mutableFloatStateOf(0f) }
    var drawerAtStart by remember { mutableStateOf<Float?>(null) }
    var forward by remember { mutableStateOf(true) } // which way the next page change moves
    // The page on top as a transition a back gesture can hold partway, as the iPhone's NavigationStack swipe: the page
    // it goes back to is drawn once, by the transition, so it is the same page when the gesture lets go, scrolled where
    // it was left
    val nav = remember { SeekableTransitionState(path.lastOrNull()) }

    // your saved searches for the menu, with the icons they were given in Orbital; the last list stays when a read fails
    suspend fun loadSearches() {
        if (engine.phase != Engine.Phase.Ready) return
        val found = maybe { engine.searches() } ?: return
        searches = ordered(found.map { Menu.Search(it.id, it.words) }, engine)
        secret = found.filter { it.sensitive == true }.map { it.id }.toSet()
        icons = found.mapNotNull { row -> row.glyph?.let { g -> runCatching { Base64.decode(g) }.getOrNull()?.let(engine.platform::decode)?.let { row.id to it } } }.toMap()
    }
    fun push(id: String) { forward = true; path.add(id) }
    fun pop() { forward = false; path.removeAt(path.lastIndex) }
    LaunchedEffect(engine.phase) { loadSearches() }
    // a page pushed, popped or picked moves there; one a gesture already moved to is there
    LaunchedEffect(path.lastOrNull()) {
        val top = path.lastOrNull()
        if (nav.currentState != top || nav.targetState != top) { if (still) nav.snapTo(top) else nav.animateTo(top) }
    }
    // however it opens (the button, a swipe), the composer's keyboard goes and the saved searches are read again, so one
    // pinned or given an icon on the Mac since shows up
    LaunchedEffect(drawer.targetValue) { if (drawer.targetValue) { focus.clearFocus(); loadSearches() } }
    LaunchedEffect(Unit) { if (start.menuDemo) { delay(2000); show(true); delay(2000); show(false) } }
    // shared words open Quick Add on their own, over nothing else (Shell.swift: adding and settings shut); a shared image
    // is read at once, behind the turning +, with nothing opened over the page
    LaunchedEffect(engine.shared) {
        val s = engine.shared ?: return@LaunchedEffect
        val image = s.image
        if (image != null) { engine.shared = null; engine.addImage { image } } else { adding = false; settings = false }
    }
    // an image's node, made: opened, as the desktop opens it
    LaunchedEffect(engine.made) { engine.made?.let { engine.made = null; push(it); show(false) } }

    BoxWithConstraints(Modifier.fillMaxSize().background(c.page)) {
        val wide = maxWidth >= 840.dp
        // the iPhone's 300 on a phone, growing with a wide window so page and menu both keep room (Shell.swift menuWidth)
        val width = (maxWidth * 0.4f).coerceIn(300.dp, 360.dp)
        val widthPx = with(density) { width.toPx() }
        LaunchedEffect(widthPx) { drawer.updateAnchors(DraggableAnchors { false at 0f; true at widthPx }) } // set again only when the width changes
        val x = drawer.offset.takeUnless { it.isNaN() }?.coerceIn(0f, widthPx) ?: 0f
        val menuShown = !wide && x > 0.5f

        PlatformBack(menuShown || path.isNotEmpty(), onProgress = { p, fromRight ->
            if (menuShown || drawerAtStart != null) {
                val now = drawer.offset.takeUnless { it.isNaN() } ?: 0f // where it is now, a second event in a frame included
                val from = drawerAtStart ?: now.also { drawerAtStart = it }
                drawer.dispatchRawDelta(predictiveDrawerOffset(from, p) - now)
            } else if (!still && path.isNotEmpty()) {
                if (edge == 0f) edge = if (fromRight) -1f else 1f
                val under = path.getOrNull(path.lastIndex - 1)
                scope.launch { nav.seekTo(p.coerceIn(0f, 1f), under) }
            }
        }, onCancel = {
            if (drawerAtStart != null) { drawerAtStart = null; show(true) }
            else if (edge != 0f) scope.launch {
                // taken back: the page settles home, the seek run back to its start (as Navigation's NavHost does)
                val top = path.lastOrNull()
                if (nav.fraction == 0f) { nav.snapTo(top); edge = 0f }
                else animate(nav.fraction, 0f, animationSpec = tween((nav.fraction * 300).toInt())) { v, _ ->
                    launch { if (v > 0f) nav.seekTo(v) else { nav.snapTo(top); edge = 0f } }
                }
            }
        }) {
            when {
                drawerAtStart != null || menuShown -> { drawerAtStart = null; show(false) }
                edge != 0f -> {
                    // let go to go back: the page carries on off the edge it was pulled to, the one under it already
                    // there; once, however many Backs come while it moves
                    val depth = path.size
                    scope.launch {
                        nav.animateTo(path.getOrNull(depth - 2), smooth(0.3f))
                        if (path.size == depth) { forward = false; path.removeAt(path.lastIndex) }
                        edge = 0f
                    }
                }
                path.isNotEmpty() -> pop()
            }
        }

        val zoom: (String?) -> Unit = { id -> if (id != null) { push(id); show(false) } }
        val sideMenu = @Composable { modifier: Modifier ->
            SideMenu(page, searches, icons, if (engine.reveal) emptySet() else secret, still, modifier,
                pick = { page = it; forward = false; path.clear(); show(false) },
                move = { i, by -> val to = i + by; if (to in searches.indices) { searches = searches.toMutableList().apply { add(to, removeAt(i)) }; saveOrder(searches, engine) } },
                settings = { settings = true })
        }
        // One page: the menu's (its bar, the page, and the composer floating over its foot, as the iPhone's
        // .safeAreaInset: the page scrolls on under it and fades out behind it), or a node zoomed into
        val pageOf = @Composable { top: String? ->
            // a node zoomed into and the menu's page are kept apart: a saved search can be both
            pages.SaveableStateProvider(top?.let { "node:$it" } ?: "page:" + page.key) {
                if (top == null) Column(Modifier.fillMaxSize().background(c.page).imePadding().navigationBarsPadding()) {
                    PageBar(page.title, onMenu = if (wide) null else ({ show(true) }), onAdd = { adding = true }, busy = engine.adding > 0)
                    Box(Modifier.weight(1f).fillMaxWidth()) {
                        CompositionLocalProvider(LocalBottomInset provides composer) {
                            when (val p = page) {
                                Menu.Timeline -> TimelineScreen(engine, Modifier.fillMaxSize())
                                is Menu.Search -> NodeScreen(engine, p.id, titled = false)
                            }
                        }
                        Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(composer + 16.dp)
                            .background(Brush.verticalGradient(0f to c.page.copy(alpha = 0f), 0.45f to c.page.copy(alpha = 0.9f), 1f to c.page)))
                        // a new chat, opened as it starts, its warning shown there
                        Box(Modifier.align(Alignment.BottomCenter).onSizeChanged { composer = with(density) { it.height.toDp() } }) {
                            Composer(engine) { text -> val sent = engine.ask(text); sent.warning?.let { notes[sent.id] = it }; asked[sent.id] = engine.now(); push(sent.id); null }
                        }
                    }
                } else NodeScreen(engine, top, Modifier.background(c.page).imePadding().navigationBarsPadding(), note = notes[top], asked = asked[top], onBack = { pop() })
            }
        }
        val content = @Composable { modifier: Modifier ->
            CompositionLocalProvider(LocalZoom provides zoom) {
                rememberTransition(nav, "page").AnimatedContent(modifier, transitionSpec = {
                    // a page pushed slides in over the one it came from, which drifts a quarter of the way off, as a
                    // NavigationStack push; back is the same in reverse, toward the edge a gesture pulls it to, the page
                    // under it a little dimmed until it is all there. Under a finger the moves are linear, so the page
                    // stays under it.
                    val gesture = edge != 0f
                    val slide: FiniteAnimationSpec<IntOffset> = if (gesture) tween(300, easing = LinearEasing) else smooth(0.35f)
                    val side = if (edge < 0f) -1 else 1
                    when {
                        still -> EnterTransition.None togetherWith ExitTransition.None
                        forward && !gesture -> slideInHorizontally(slide) { it } togetherWith slideOutHorizontally(slide) { -it / 4 }
                        else -> ((slideInHorizontally(slide) { -side * it / 4 } + fadeIn(if (gesture) tween(300, easing = LinearEasing) else smooth(0.35f), 0.88f))
                            togetherWith slideOutHorizontally(slide) { side * it }).apply { targetContentZIndex = -1f }
                    }
                }) { top -> pageOf(top) }
            }
        }

        if (wide) Row(Modifier.fillMaxSize()) {
            sideMenu(Modifier.width(width).fillMaxHeight())
            VerticalDivider(color = c.separator)
            content(Modifier.weight(1f).fillMaxHeight())
        } else {
            // A sideways swipe anywhere, the menu included, as the ChatGPT app's; only a swipe more sideways than up or
            // down moves it, so lists still scroll
            val open = x / widthPx
            val shape = RoundedCornerShape(28.dp * open)
            Box(Modifier.fillMaxSize().anchoredDraggable(drawer, Orientation.Horizontal, enabled = path.isEmpty(),
                flingBehavior = AnchoredDraggableDefaults.flingBehavior(drawer, positionalThreshold = { it / 3f }, animationSpec = move))) {
                sideMenu(Modifier.width(width).fillMaxHeight().then(if (menuShown) Modifier else Modifier.clearAndSetSemantics {}))
                // pushed aside, the page is a card with a hairline edge, as the ChatGPT app's is; a tap closes it
                Box(Modifier.fillMaxSize().offset { IntOffset(x.roundToInt(), 0) }
                    .shadow(if (menuShown && !c.dark) 24.dp * open else 0.dp, shape, ambientColor = Color.Black.copy(0.12f), spotColor = Color.Black.copy(0.12f))
                    .clip(shape).background(c.page)
                    .then(if (menuShown) Modifier.border(1.dp, c.separator, shape).clearAndSetSemantics {} else Modifier)) {
                    content(Modifier.fillMaxSize())
                    if (menuShown) Box(Modifier.fillMaxSize().background(if (c.dark) Color.White.copy(0.08f * open) else Color.Transparent)
                        .clickable(remember { MutableInteractionSource() }, null) { show(false) })
                }
            }
        }
    }

    if (settings) SettingsSheet(engine) { settings = false }
    if (adding) QuickAdd(engine, search = if (path.isEmpty()) (page as? Menu.Search)?.id else null) { adding = false } // on a saved search: a row of it
    engine.shared?.takeIf { it.image == null }?.let { s -> QuickAdd(engine, shared = s) { engine.shared = null } }
    engine.assigning?.let { a -> AssignSheet(engine, a) { engine.assigning = null } }
    ShareAskDialog(engine)
}

// The menu's pages: the Timeline, and each saved search (its id and title) under it
sealed interface Menu {
    val title: String
    val key: String
    data object Timeline : Menu { override val title = "Timeline"; override val key = "timeline" }
    data class Search(val id: String, override val title: String) : Menu { override val key get() = id }
}

// The order you moved the searches into, kept on this phone; one you never moved keeps its place after them, in the
// engine's order (your desktop pins first, then the newest)
// ponytail: on this phone only; the desktop's sidebar order is its own pin tree, written when wanted (sdk/pins placePin)
private fun ordered(list: List<Menu.Search>, engine: Engine): List<Menu.Search> {
    val saved = engine.platform.store.get("searchOrder")?.let { runCatching { json.decodeFromString<List<String>>(it) }.getOrNull() } ?: emptyList()
    val rank = saved.withIndex().associate { (i, id) -> id to i }
    return list.withIndex().sortedBy { (i, s) -> rank[s.id] ?: (saved.size + i) }.map { it.value }
}

private fun saveOrder(list: List<Menu.Search>, engine: Engine) = engine.platform.store.set("searchOrder", json.encodeToString(list.map { it.id }))

// busy: what Quick Add handed over is still being made (Engine.adding), and a thin ring turns around the +, which stays
// the button it was, so another task can be added meanwhile (Shell.swift AddGlyph)
@Composable
fun PageBar(title: String, onBack: (() -> Unit)? = null, onMenu: (() -> Unit)? = null, onAdd: (() -> Unit)? = null, busy: Boolean = false) {
    val c = Theme.colors
    CenterAlignedTopAppBar(
        title = { Text(title, style = Type.headline, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        navigationIcon = {
            when {
                onBack != null -> IconButton(onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
                onMenu != null -> IconButton(onMenu) { Icon(Icons.Filled.Menu, "Menu") }
            }
        },
        actions = {
            if (onAdd != null) IconButton(onAdd, Modifier.semantics { if (busy) stateDescription = "Adding" }) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(Icons.Filled.Add, "Quick Add Task")
                    if (busy) CircularProgressIndicator(Modifier.size(32.dp), color = c.secondary, strokeWidth = 1.5.dp)
                }
            }
        },
        colors = TopAppBarDefaults.topAppBarColors(containerColor = c.page, scrolledContainerColor = c.page, titleContentColor = c.text, navigationIconContentColor = c.text, actionIconContentColor = c.text),
    )
}

// The side menu: the app's name, its pages, your saved searches under them, and settings at the foot
@Composable
private fun SideMenu(
    page: Menu,
    searches: List<Menu.Search>,
    icons: Map<String, ImageBitmap>,
    hidden: Set<String>, // sensitive and not shown by a shake
    still: Boolean,
    modifier: Modifier,
    pick: (Menu) -> Unit,
    move: (Int, Int) -> Unit,
    settings: () -> Unit,
) {
    val c = Theme.colors
    val haptic = LocalHapticFeedback.current
    val list by rememberUpdatedState(searches)
    val moveBy by rememberUpdatedState(move)
    var lifted by remember { mutableStateOf<String?>(null) } // the search picked up, and how far it is from its place
    var liftedBy by remember { mutableFloatStateOf(0f) }
    Box(modifier.background(c.page).statusBarsPadding().navigationBarsPadding()) {
        Column(Modifier.fillMaxSize().padding(horizontal = 12.dp).padding(top = 8.dp)) {
            Text("Orbital", Modifier.heightIn(min = 46.dp).padding(start = 14.dp, top = 8.dp, bottom = 12.dp), style = Type.title2, color = c.text)
            MenuItem(Menu.Timeline, page == Menu.Timeline, null, false, pick)
            if (searches.isNotEmpty()) {
                HorizontalDivider(Modifier.padding(horizontal = 14.dp, vertical = 12.dp), color = c.separator)
                // Your saved searches, as the ChatGPT app lists chats under its pages. A long press picks one up and it
                // follows the finger, the others making way, as the iPhone's List reorders (Shell.swift onMove); TalkBack
                // moves one with Move up and Move down. They scroll under the settings button, fading out behind it.
                LazyColumn(Modifier.weight(1f).fillMaxWidth(), contentPadding = PaddingValues(bottom = 90.dp)) {
                    itemsIndexed(searches, key = { _, s -> s.id }) { i, s ->
                        val up = lifted == s.id
                        val lift by animateFloatAsState(if (up) 1f else 0f, if (still) snap() else snappy(0.3f))
                        var height by remember { mutableIntStateOf(1) }
                        Box(Modifier
                            .then(if (up) Modifier else Modifier.animateItem(fadeInSpec = null, fadeOutSpec = null, placementSpec = if (still) snap() else snappy(0.3f)))
                            .zIndex(if (up) 1f else 0f)
                            .onSizeChanged { height = it.height }
                            .graphicsLayer {
                                translationY = if (up) liftedBy else 0f
                                scaleX = 1f + 0.03f * lift; scaleY = scaleX
                                shadowElevation = 12.dp.toPx() * lift; shape = RoundedCornerShape(14.dp)
                            }
                            .background(c.page.copy(alpha = lift), RoundedCornerShape(14.dp))
                            .pointerInput(s.id) {
                                detectDragGesturesAfterLongPress(
                                    onDragStart = { lifted = s.id; liftedBy = 0f; haptic.performHapticFeedback(HapticFeedbackType.LongPress) },
                                    onDragEnd = { lifted = null; liftedBy = 0f },
                                    onDragCancel = { lifted = null; liftedBy = 0f },
                                ) { change, by ->
                                    change.consume()
                                    liftedBy += by.y
                                    // past half the next row, it takes that row's place
                                    val from = list.indexOfFirst { it.id == s.id }
                                    val step = if (liftedBy > height / 2f) 1 else if (liftedBy < -height / 2f) -1 else 0
                                    if (step != 0 && from + step in list.indices) {
                                        moveBy(from, step); liftedBy -= step * height
                                        haptic.performHapticFeedback(HapticFeedbackType.SegmentTick)
                                    }
                                }
                            }
                            .semantics { customActions = listOf(CustomAccessibilityAction("Move up") { moveBy(i, -1); true }, CustomAccessibilityAction("Move down") { moveBy(i, 1); true }) }) {
                            MenuItem(s, page == s, icons[s.id], s.id in hidden, pick)
                        }
                    }
                }
            }
        }
        if (searches.isNotEmpty()) Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(90.dp)
            .background(Brush.verticalGradient(0f to c.page.copy(alpha = 0f), 0.7f to c.page.copy(alpha = 0.95f), 1f to c.page)))
        RoundButton("Settings", 48.dp, c.card, Modifier.align(Alignment.BottomEnd).padding(12.dp).shadow(if (c.dark) 0.dp else 4.dp, CircleShape), border = c.separator, onClick = settings) {
            Icon(Icons.Outlined.Settings, null, Modifier.size(24.dp), c.text)
        }
    }
}

@Composable
private fun MenuItem(item: Menu, selected: Boolean, icon: ImageBitmap?, hidden: Boolean, pick: (Menu) -> Unit) {
    val c = Theme.colors
    Row(
        Modifier.fillMaxWidth().padding(vertical = 2.dp).clip(RoundedCornerShape(14.dp)).background(if (selected) c.fill else Color.Transparent)
            .clickable { pick(item) }.semantics { this.selected = selected }
            .padding(horizontal = 14.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        // a saved search by the icon you gave it in Orbital (Set icon), else the search glyph
        if (icon != null) Image(icon, null, Modifier.size(22.dp), colorFilter = ColorFilter.tint(c.text))
        else Glyph(if (item is Menu.Search) "searchMenu" else "timelineMenu", Modifier.size(22.dp), c.text)
        Sensitive(hidden) { Words(item.title, style = Type.body.copy(fontWeight = FontWeight.Medium), maxLines = 1) }
    }
}

// The composer, as the Codex app has it: what you type goes to Tana, as a new chat from the page (Shell) or a follow-up
// in a chat (NodeScreen). A capsule at rest, a card while you type in it, the words on top and send in its corner.
// The words go the moment it is sent, and come back with the reason if Tana refuses them; a message sent that Tana did
// not answer stays sent, with the warning send hands back shown over the box.
@Composable
fun Composer(engine: Engine, prompt: String = "Ask Tana", note: String? = null, send: suspend (String) -> String?) {
    val c = Theme.colors
    val still = engine.platform.reduceMotion
    var text by rememberSaveable { mutableStateOf("") }
    var failure by remember { mutableStateOf(note) }
    var sending by remember { mutableStateOf(false) }
    var focused by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val focus = LocalFocusManager.current
    val dictation = remember { Dictation(engine.platform, engine.scope) }
    DisposableEffect(Unit) { onDispose { dictation.cancel() } } // the page left while listening: nothing kept
    val empty = text.isBlank()
    val busy = dictation.recording || dictation.transcribing // listening, or writing down what was said
    val open = focused || !empty || busy
    val side by animateDpAsState(if (open) 14.dp else 36.dp, if (still) snap() else snappy())
    val shape = RoundedCornerShape(23.dp)
    fun append(said: String) { text = if (text.isEmpty()) said else "$text $said" } // dictated words land after what is typed

    // Send while listening or writing down too: listening stops and the words are waited for first
    suspend fun submit() {
        if (busy) {
            sending = true
            val heard = dictation.settle(::append)
            sending = false
            if (!heard) return
        }
        val words = text.trim()
        if (words.isEmpty()) return
        text = ""; focus.clearFocus(); sending = true
        try {
            failure = send(words)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            text = if (text.isEmpty()) words else words + "\n\n" + text // the unsent words come back, ahead of anything typed since
            failure = e.message
        }
        sending = false
    }

    Column(Modifier.fillMaxWidth().padding(horizontal = side).padding(top = 4.dp, bottom = if (focused) 10.dp else 6.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        val line = failure ?: dictation.problem
        if (line != null) Text(line, Modifier.padding(bottom = 6.dp), style = Type.footnote, color = c.secondary, textAlign = TextAlign.Center)
        Box(Modifier.fillMaxWidth().shadow(if (c.dark) 0.dp else 8.dp, shape, ambientColor = Color.Black.copy(0.08f), spotColor = Color.Black.copy(0.12f))
            .clip(shape).background(c.card).border(1.dp, c.separator, shape).animateContentSize(if (still) snap() else snappy())) {
            BasicTextField(
                text, { text = it },
                Modifier.fillMaxWidth().heightIn(min = 46.dp).onFocusChanged { focused = it.isFocused }
                    .padding(start = 18.dp, end = if (open) 18.dp else 52.dp, top = if (open) 15.dp else 12.dp, bottom = if (open) 58.dp else 12.dp)
                    .semantics { contentDescription = prompt },
                textStyle = Type.body.copy(color = c.text), cursorBrush = SolidColor(c.accent), maxLines = 6,
                decorationBox = { inner -> Box { if (text.isEmpty()) Text(prompt, style = Type.body, color = c.secondary); inner() } },
            )
            // the card's bottom row: dictating, only while you are in the card (or it still listens), then send
            Row(Modifier.align(Alignment.BottomEnd).then(if (dictation.recording) Modifier.fillMaxWidth() else Modifier).padding(if (open) 10.dp else 6.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                if (focused || busy) Dictate(dictation, engine) { append(it) }
                Send(enabled = (!empty || busy) && !sending, label = prompt) { scope.launch { submit() } }
            }
        }
    }
}

// the Codex app's send: a grey circle while there is nothing to send, blue once there is
@Composable
fun Send(enabled: Boolean, label: String, onClick: () -> Unit) {
    val c = Theme.colors
    RoundButton(label, 34.dp, if (enabled) c.accent else c.fill, enabled = enabled, onClick = onClick) {
        Icon(Icons.Filled.ArrowUpward, null, Modifier.size(20.dp), if (enabled) Color.White else c.tertiary)
    }
}
