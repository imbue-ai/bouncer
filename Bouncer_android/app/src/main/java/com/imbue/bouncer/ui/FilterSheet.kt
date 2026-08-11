package com.imbue.bouncer.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowCircleUp
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
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp

@OptIn(ExperimentalLayoutApi::class, ExperimentalMaterial3Api::class)
@Composable
fun FilterSheet(
    sheetState: SheetState,
    phrases: List<String>,
    filteredCount: Int,
    aiDetectionOn: Boolean,
    aiDetectionPending: Boolean,
    filterReplies: Boolean,
    notificationsEnabled: Boolean,
    onAdd: (String) -> Unit,
    onRemove: (String) -> Unit,
    onViewFiltered: () -> Unit,
    onShareFilterPack: () -> Unit,
    onToggleAiDetection: () -> Unit,
    onFilterRepliesChange: (Boolean) -> Unit,
    onNotificationsEnabledChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    var showSettings by remember { mutableStateOf(false) }
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
                    val sheetTop = runCatching { sheetState.requireOffset() }
                        .getOrDefault(0f)
                        .toInt()
                        .coerceAtLeast(0)
                    val capped = (fullHeightPx - sheetTop - stickyHeightPx)
                        .coerceAtLeast(0)
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
                shareEnabled = phrases.isNotEmpty(),
                aiDetectionOn = aiDetectionOn,
                aiDetectionPending = aiDetectionPending,
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
                )
            } else {
                // Only let the list participate in scroll/nested-scroll when
                // the sheet has settled at Expanded. While partial or while
                // animating, the list passes drags straight through to the
                // sheet — no nested-scroll handoff fighting the drag, which
                // is what makes the sheet feel like it "loses grip" with a
                // populated list. `currentValue` only changes on settle, so
                // mid-drag it stays at the prior anchor and the list stays
                // inert until the drag actually ends at Expanded.
                PhraseList(
                    phrases = phrases,
                    onRemove = onRemove,
                    userScrollEnabled = sheetState.currentValue == SheetValue.Expanded,
                    modifier = Modifier.weight(1f),
                )
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
                AddPhraseRow(onAdd = onAdd)
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

@Composable
private fun SheetHeader(
    title: String,
    shareEnabled: Boolean,
    aiDetectionOn: Boolean,
    aiDetectionPending: Boolean,
    onToggleAiDetection: () -> Unit,
    onShare: () -> Unit,
    onToggle: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 20.dp, end = 8.dp, top = 4.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = title,
            style = MaterialTheme.typography.titleLarge,
            modifier = Modifier.weight(1f),
        )
        // AI-detection indicator, the native counterpart of the sparkle at
        // the top-right of the desktop filter box (.filter-ai-indicator in
        // content.css) and the iOS sheet's toolbar sparkle. It reports the
        // natural-language-derived state AND toggles it — but only through
        // the phrase mechanism itself; there is no override switch (see the
        // extension's background/ai-intent.ts).
        IconButton(
            onClick = onToggleAiDetection,
            enabled = !aiDetectionPending,
            modifier = Modifier.alpha(if (aiDetectionPending) 0.55f else 1f),
        ) {
            Icon(
                Icons.Default.AutoAwesome,
                contentDescription = if (aiDetectionOn) {
                    "Removing AI-generated content — your filter phrases ask for it. Tap to stop (removes those phrases)."
                } else {
                    "Tap to remove AI-generated content from your feed (adds the filter phrase \"AI slop\")."
                },
                tint = if (aiDetectionOn) {
                    MaterialTheme.colorScheme.primary
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant
                },
            )
        }
        IconButton(onClick = onShare, enabled = shareEnabled) {
            Icon(Icons.Default.Share, contentDescription = "Share filters")
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
private fun AddPhraseRow(onAdd: (String) -> Unit) {
    var text by remember { mutableStateOf("") }
    val trimmed = text.trim()
    val canSubmit = trimmed.isNotEmpty()

    fun submit() {
        if (!canSubmit) return
        onAdd(trimmed)
        text = ""
    }

    OutlinedTextField(
        value = text,
        onValueChange = { text = it },
        label = { Text("Add a topic to filter") },
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 4.dp),
        singleLine = true,
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
        keyboardActions = KeyboardActions(onSend = { submit() }),
    )
}
