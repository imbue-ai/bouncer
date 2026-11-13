package com.imbue.bouncer.ui

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowCircleUp
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material3.BottomSheetDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SheetState
import androidx.compose.material3.SheetValue
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.PrimaryScrollableTabRow
import androidx.compose.material3.Tab
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import com.imbue.bouncer.push.PushSite
import kotlinx.coroutines.launch

@OptIn(ExperimentalLayoutApi::class, ExperimentalMaterial3Api::class)
@Composable
fun FilterSheet(
    sheetState: SheetState,
    phrases: List<String>,
    filteredCount: Int,
    aiDetectionOn: Boolean,
    aiDetectionPending: Boolean,
    aiBadgeDismissed: Boolean,
    filterReplies: Boolean,
    notificationsEnabled: Map<PushSite, Boolean>,
    debugModeEnabled: Boolean,
    onAdd: (String) -> Unit,
    onRemove: (String) -> Unit,
    offersSeeMore: Boolean,
    seeMoreTopics: List<String>,
    onAddSeeMoreTopic: (String) -> Unit,
    onRemoveSeeMoreTopic: (String) -> Unit,
    seeMoreSource: String,
    onSeeMoreSourceChange: (String) -> Unit,
    onViewFiltered: () -> Unit,
    onShareFilterPack: () -> Unit,
    onToggleAiDetection: () -> Unit,
    onFilterRepliesChange: (Boolean) -> Unit,
    onNotificationsEnabledChange: (PushSite, Boolean) -> Unit,
    onDebugModeChange: (Boolean) -> Unit,
    excludedAccounts: List<String>,
    onAddExcludedAccount: (String) -> Unit,
    onRemoveExcludedAccount: (String) -> Unit,
    onOpenExcludedAccount: ((String) -> Unit)?,
    modifier: Modifier = Modifier,
) {
    var showSettings by remember { mutableStateOf(false) }
    // Which list the sheet edits: a page each, swiped between or picked by
    // tab. See more only exists on X.
    val listPager = rememberPagerState(pageCount = { SheetList.entries.size })
    val scope = rememberCoroutineScope()
    val list = if (offersSeeMore) SheetList.entries[listPager.currentPage] else SheetList.FilterOut
    val isSeeMore = list == SheetList.SeeMore
    val focusManager = LocalFocusManager.current
    val imeVisible = WindowInsets.isImeVisible
    LaunchedEffect(imeVisible) {
        if (!imeVisible) focusManager.clearFocus()
    }

    // Measured height of the sticky block (input + view-filtered link). Drives
    // both where the block sits (offset) and where the list above it ends
    // (layout cap), so list items can't render behind the block.
    var stickyHeightPx by remember { mutableIntStateOf(0) }

    BoxWithConstraints(
        modifier = modifier
            .fillMaxWidth()
            .fillMaxHeight()
            // Tap-outside also clears focus. detectTapGestures only fires for
            // taps no child consumed, so buttons/the text field itself are
            // unaffected; empty regions of the sheet drop focus.
            .pointerInput(Unit) {
                detectTapGestures(onTap = { focusManager.clearFocus() })
            },
    ) {
        val fullHeightPx = constraints.maxHeight

        // Main column: header + list. Capped in layout to end at the sticky
        // block's top edge so items are hard-clipped above the block instead
        // of bleeding behind the (partially-transparent) text-button.
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .layout { measurable, innerConstraints ->
                    // Settings mode has no sticky block, so no cap: capping
                    // there squeezes the last toggle into whatever sliver
                    // remains at partial expansion (a bare clipped Switch)
                    // instead of letting rows sit below the fold.
                    val capped = if (showSettings) {
                        innerConstraints.maxHeight
                    } else {
                        val sheetTop = runCatching { sheetState.requireOffset() }
                            .getOrDefault(0f)
                            .toInt()
                            .coerceAtLeast(0)
                        (fullHeightPx - sheetTop - stickyHeightPx)
                            .coerceAtLeast(0)
                    }
                    val placeable = measurable.measure(
                        innerConstraints.copy(maxHeight = capped),
                    )
                    layout(placeable.width, placeable.height) {
                        placeable.place(0, 0)
                    }
                },
        ) {
            SheetHeader(
                title = if (showSettings) "Settings" else "Filter out",
                // On X the tabs take the title's place: they name the list.
                tabs = if (offersSeeMore && !showSettings) {
                    {
                        SheetListTabs(
                            selected = list,
                            onSelect = { scope.launch { listPager.animateScrollToPage(it.ordinal) } },
                            modifier = Modifier.weight(1f),
                        )
                    }
                } else {
                    null
                },
                // The sparkle and share act on the filter-out list.
                showFilterActions = !showSettings && !isSeeMore,
                shareEnabled = phrases.isNotEmpty(),
                aiDetectionOn = aiDetectionOn,
                aiDetectionPending = aiDetectionPending,
                aiBadgeDismissed = aiBadgeDismissed,
                onToggleAiDetection = onToggleAiDetection,
                onShare = onShareFilterPack,
                onToggle = { showSettings = !showSettings },
            )
            if (showSettings) {
                BouncerSettings(
                    filterReplies = filterReplies,
                    onFilterRepliesChange = onFilterRepliesChange,
                    notificationsEnabled = notificationsEnabled,
                    onNotificationsEnabledChange = onNotificationsEnabledChange,
                    debugModeEnabled = debugModeEnabled,
                    onDebugModeChange = onDebugModeChange,
                    excludedAccounts = excludedAccounts,
                    onAddExcludedAccount = onAddExcludedAccount,
                    onRemoveExcludedAccount = onRemoveExcludedAccount,
                    onOpenExcludedAccount = onOpenExcludedAccount,
                )
            } else {
                // Only let the lists participate in scroll/nested-scroll when
                // the sheet has settled at Expanded. While partial or while
                // animating, a list passes drags straight through to the
                // sheet — no nested-scroll handoff fighting the drag, which
                // is what makes the sheet feel like it "loses grip" with a
                // populated list. `currentValue` only changes on settle, so
                // mid-drag it stays at the prior anchor and the list stays
                // inert until the drag actually ends at Expanded.
                val listScrollEnabled = sheetState.currentValue == SheetValue.Expanded
                val filterOutList = @Composable { modifier: Modifier ->
                    PhraseList(
                        phrases = phrases,
                        onRemove = onRemove,
                        userScrollEnabled = listScrollEnabled,
                        modifier = modifier,
                    )
                }
                if (offersSeeMore) {
                    // Horizontal swipes page between the lists; vertical
                    // drags still go to the list or the sheet.
                    HorizontalPager(
                        state = listPager,
                        verticalAlignment = Alignment.Top,
                        modifier = Modifier.weight(1f),
                    ) { page ->
                        when (SheetList.entries[page]) {
                            SheetList.FilterOut -> filterOutList(Modifier.fillMaxSize())
                            SheetList.SeeMore -> PhraseList(
                                phrases = seeMoreTopics,
                                onRemove = onRemoveSeeMoreTopic,
                                userScrollEnabled = listScrollEnabled,
                                modifier = Modifier.fillMaxSize(),
                            )
                        }
                    }
                } else {
                    filterOutList(Modifier.weight(1f))
                }
            }
        }

        if (!showSettings) {
            // The sticky block tracks the sheet's *visible* bottom edge via
            // `requireOffset()`. M3's ModalBottomSheet lays content out at the
            // expanded height then translates the surface down for the partial
            // state, so the natural content-bottom sits below the partial
            // fold; offsetting from sheet state keeps the block flush with
            // screen-bottom in both states and animates smoothly between.
            // Opaque background so the cap above isn't required to be exact.
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .onSizeChanged { stickyHeightPx = it.height }
                    .offset {
                        val sheetTop = runCatching { sheetState.requireOffset() }
                            .getOrDefault(0f)
                            .toInt()
                            .coerceAtLeast(0)
                        val visibleBottom = fullHeightPx - sheetTop
                        IntOffset(0, (visibleBottom - stickyHeightPx).coerceAtLeast(0))
                    }
                    // Match the sheet's container color exactly so dark/light
                    // mode swaps stay in sync. `BottomSheetDefaults.ContainerColor`
                    // is what `ModalBottomSheet` defaults to when no explicit
                    // `containerColor` is passed (see BouncerApp.kt).
                    .background(BottomSheetDefaults.ContainerColor),
            ) {
                if (isSeeMore) {
                    val full = seeMoreTopics.size >= MAX_SEE_MORE_TOPICS
                    AddPhraseRow(
                        label = if (full) {
                            "That's $MAX_SEE_MORE_TOPICS topics, the most there can be"
                        } else {
                            "Add a topic to see more of"
                        },
                        enabled = !full,
                        onAdd = onAddSeeMoreTopic,
                    )
                    // In the View filtered button's spot, so the field
                    // doesn't move between the lists.
                    SeeMoreSourceMenu(
                        source = seeMoreSource,
                        onChange = onSeeMoreSourceChange,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(bottom = 8.dp),
                    )
                } else {
                    AddPhraseRow(label = "Add a topic to filter", onAdd = onAdd)
                    TextButton(
                        onClick = onViewFiltered,
                        enabled = filteredCount > 0,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(bottom = 8.dp),
                    ) {
                        Text("View filtered ($filteredCount)")
                    }
                }
            }
        }
    }
}

@Composable
private fun SheetHeader(
    title: String,
    tabs: (@Composable RowScope.() -> Unit)?,
    showFilterActions: Boolean,
    shareEnabled: Boolean,
    aiDetectionOn: Boolean,
    aiDetectionPending: Boolean,
    aiBadgeDismissed: Boolean,
    onToggleAiDetection: () -> Unit,
    onShare: () -> Unit,
    onToggle: () -> Unit,
) {
    // Beside the tabs no phone has room for the badge's words (tabs ~200dp,
    // pill ~150dp, two icons 96dp), so there it's just the sparkle on the
    // badge's color.
    val roomForBadgeText = tabs == null
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = if (tabs != null) 4.dp else 20.dp, end = 8.dp, top = 4.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (tabs != null) {
            tabs()
        } else {
            Text(
                text = title,
                style = MaterialTheme.typography.titleLarge,
                modifier = Modifier.weight(1f),
            )
        }
        // AI-detection indicator, the native counterpart of the sparkle at
        // the top-right of the desktop filter box (.filter-ai-indicator in
        // content.css) and the iOS sheet's toolbar sparkle. It reports the
        // natural-language-derived state AND toggles it — but only through
        // the phrase mechanism itself; there is no override switch (see the
        // extension's background/ai-intent.ts).
        // Until detection first turns on, the sparkle wears a "REMOVE AI
        // SLOP?" pill — the desktop indicator's first-run badge (`with-badge`
        // in content.css) — that collapses down to the plain sparkle once
        // detection engages.
        if (showFilterActions) {
            val showBadge = !aiDetectionOn && !aiBadgeDismissed
            val showBadgeText = showBadge && roomForBadgeText
            Surface(
                onClick = onToggleAiDetection,
                enabled = !aiDetectionPending,
                shape = CircleShape,
                color = if (showBadge) MaterialTheme.colorScheme.primary else Color.Transparent,
                contentColor = when {
                    showBadge -> MaterialTheme.colorScheme.onPrimary
                    aiDetectionOn -> MaterialTheme.colorScheme.primary
                    else -> MaterialTheme.colorScheme.onSurfaceVariant
                },
                modifier = Modifier.alpha(if (aiDetectionPending) 0.55f else 1f),
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                    modifier = Modifier
                        .animateContentSize()
                        .padding(
                            horizontal = 12.dp,
                            vertical = if (showBadgeText) 8.dp else 12.dp,
                        ),
                ) {
                    Icon(
                        Icons.Default.AutoAwesome,
                        contentDescription = if (aiDetectionOn) {
                            "Removing AI-generated content — your filter phrases ask for it. Tap to stop (removes those phrases)."
                        } else {
                            "Tap to remove AI-generated content from your feed (adds the filter phrase \"AI slop\")."
                        },
                        modifier = Modifier.size(if (showBadgeText) 16.dp else 24.dp),
                    )
                    if (showBadgeText) {
                        Text(
                            "REMOVE AI SLOP?",
                            style = MaterialTheme.typography.labelSmall,
                            fontWeight = FontWeight.Bold,
                            maxLines = 1,
                        )
                    }
                }
            }
            IconButton(onClick = onShare, enabled = shareEnabled) {
                Icon(Icons.Default.Share, contentDescription = "Share filters")
            }
        }
        IconButton(onClick = onToggle) {
            Icon(Icons.Default.Tune, contentDescription = "Settings")
        }
    }
}

@Composable
private fun PhraseList(
    phrases: List<String>,
    onRemove: (String) -> Unit,
    userScrollEnabled: Boolean,
    modifier: Modifier = Modifier,
) {
    if (phrases.isEmpty()) {
        Box(
            modifier = modifier
                .fillMaxWidth()
                .padding(horizontal = 24.dp, vertical = 32.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                "No topics added yet.",
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
        }
        return
    }
    // Newest first, matching iOS (`viewModel.phrases.reversed()`).
    val ordered = remember(phrases) { phrases.asReversed() }
    LazyColumn(
        modifier = modifier.fillMaxWidth(),
        userScrollEnabled = userScrollEnabled,
    ) {
        items(ordered, key = { it }) { phrase ->
            PhraseRow(phrase = phrase, onRemove = { onRemove(phrase) })
        }
    }
}

@Composable
private fun PhraseRow(phrase: String, onRemove: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 24.dp, end = 12.dp, top = 4.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = phrase,
            style = MaterialTheme.typography.bodyLarge,
            modifier = Modifier.weight(1f),
        )
        IconButton(onClick = onRemove) {
            Icon(
                imageVector = Icons.Default.Cancel,
                contentDescription = "Remove $phrase",
                tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AddPhraseRow(label: String, onAdd: (String) -> Unit, enabled: Boolean = true) {
    var text by remember { mutableStateOf("") }
    val trimmed = text.trim()
    val canSubmit = enabled && trimmed.isNotEmpty()

    fun submit() {
        if (!canSubmit) return
        onAdd(trimmed)
        text = ""
    }

    OutlinedTextField(
        value = text,
        onValueChange = { text = it },
        label = { Text(label) },
        enabled = enabled,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 4.dp),
        singleLine = true,
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
        keyboardActions = KeyboardActions(onSend = { submit() }),
    )
}

// The two lists the sheet edits. See more mixes posts about its topics into
// the X timeline (content/bluesky-see-more.ts in the extension).
enum class SheetList { FilterOut, SeeMore }

private const val MAX_SEE_MORE_TOPICS = 10 // MAX_SEE_MORE_TOPICS in shared/bluesky.ts

// Android's idiom for switching between two views of one surface: tabs,
// whose indicator slides between them (iOS uses a segmented control). Sized
// to their labels, so they share the header row with its buttons.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SheetListTabs(selected: SheetList, onSelect: (SheetList) -> Unit, modifier: Modifier = Modifier) {
    val options = listOf(SheetList.FilterOut to "Filter out", SheetList.SeeMore to "See more")
    // Clipped: a tab row given less room than it needs draws past it,
    // over whatever sits beside it.
    PrimaryScrollableTabRow(
        selectedTabIndex = options.indexOfFirst { it.first == selected },
        modifier = modifier.clipToBounds(),
        // Blend into the sheet rather than drawing a bar of its own.
        containerColor = BottomSheetDefaults.ContainerColor,
        edgePadding = 0.dp,
        divider = {},
    ) {
        options.forEach { (value, label) ->
            Tab(
                selected = selected == value,
                onClick = { onSelect(value) },
                text = { Text(label, style = MaterialTheme.typography.titleSmall) },
                unselectedContentColor = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

// Where See more's posts come from, by the extension's seeMoreSource_twitter
// values. Both comes first: it's the default.
private val SEE_MORE_SOURCES = listOf(
    "both" to "X and Bluesky",
    "x" to "X only",
    "bluesky" to "Bluesky only",
)

// "From X and Bluesky ▾": a text button that opens a menu of the sources,
// the counterpart of the iOS sheet's pull-down menu.
@Composable
private fun SeeMoreSourceMenu(source: String, onChange: (String) -> Unit, modifier: Modifier = Modifier) {
    var expanded by remember { mutableStateOf(false) }
    val label = SEE_MORE_SOURCES.firstOrNull { it.first == source }?.second ?: SEE_MORE_SOURCES[0].second
    Box(modifier = modifier, contentAlignment = Alignment.Center) {
        Box {
            TextButton(onClick = { expanded = true }) {
                Text("From $label")
                Icon(
                    Icons.Default.ArrowDropDown,
                    contentDescription = null,
                    modifier = Modifier.size(20.dp),
                )
            }
            if (expanded) {
                MenuAbove(
                    options = SEE_MORE_SOURCES,
                    selected = source,
                    onSelect = { if (it != source) onChange(it) },
                    onDismiss = { expanded = false },
                )
            }
        }
    }
}
