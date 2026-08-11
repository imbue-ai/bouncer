package com.imbue.bouncer.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.BottomAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RichTooltip
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TooltipAnchorPosition
import androidx.compose.material3.TooltipBox
import androidx.compose.material3.TooltipDefaults
import androidx.compose.material3.rememberTooltipState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties
import com.imbue.bouncer.state.Platform
import com.imbue.bouncer.state.Platforms
import com.imbue.bouncer.ui.theme.BouncerPurple
import com.imbue.bouncer.ui.theme.OnBouncerPurple

private val BOUNCER_BUTTON = DpSize(64.dp, 40.dp)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NavBar(
    currentUrl: String,
    filteredCount: Int,
    onReload: () -> Unit,
    onSelectPlatform: (Platform) -> Unit,
    onBouncerClick: () -> Unit,
    showBouncerTooltip: Boolean = false,
    onBouncerTooltipDismissed: () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val tooltipState = rememberTooltipState(isPersistent = true)
    LaunchedEffect(showBouncerTooltip) {
        if (showBouncerTooltip) tooltipState.show() else tooltipState.dismiss()
    }
    LaunchedEffect(tooltipState.isVisible) {
        if (!tooltipState.isVisible && showBouncerTooltip) onBouncerTooltipDismissed()
    }
    BottomAppBar(
        modifier = modifier,
        windowInsets = WindowInsets(0, 0, 0, 0),
        containerColor = MaterialTheme.colorScheme.surface,
        tonalElevation = 0.dp,
        actions = {
            // A Box (not a Row) so the platform dropdown centers on the whole
            // bar — refresh pinned leading, Bouncer button pinned trailing —
            // exactly like the iOS NavBarView.
            Box(modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp)) {
                IconButton(
                    onClick = onReload,
                    modifier = Modifier.align(Alignment.CenterStart),
                ) {
                    Icon(Icons.Default.Refresh, contentDescription = "Reload")
                }

                PlatformSelector(
                    currentUrl = currentUrl,
                    onSelectPlatform = onSelectPlatform,
                    modifier = Modifier.align(Alignment.Center),
                )

                BouncerButton(
                    filteredCount = filteredCount,
                    tooltipState = tooltipState,
                    onClick = {
                        if (tooltipState.isVisible) onBouncerTooltipDismissed()
                        onBouncerClick()
                    },
                    modifier = Modifier.align(Alignment.CenterEnd),
                )
            }
        },
    )
}

/**
 * Centered platform dropdown, mirroring iOS's `.menu`-style Picker: the current
 * platform's name in the accent color followed by a chevron, with a checkmark
 * on the active row in the popup. No globe icon, no chip background.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PlatformSelector(
    currentUrl: String,
    onSelectPlatform: (Platform) -> Unit,
    modifier: Modifier = Modifier,
) {
    var expanded by remember { mutableStateOf(false) }
    val current = Platforms.fromUrl(currentUrl) ?: Platforms.all.first()
    val density = LocalDensity.current

    Box(modifier) {
        Surface(
            onClick = { expanded = true },
            shape = RoundedCornerShape(20.dp),
            // Transparent so there's no perpetual tinted "highlight" — just the
            // text + chevron, with a ripple only while pressed (like iOS).
            color = Color.Transparent,
            contentColor = MaterialTheme.colorScheme.primary,
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.heightIn(min = 40.dp).padding(start = 14.dp, end = 8.dp),
            ) {
                Text(
                    current.displayName,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                )
                Icon(
                    Icons.Default.ArrowDropDown,
                    contentDescription = "Switch platform",
                )
            }
        }

        if (expanded) {
            // Material's DropdownMenu hard-clamps ~48dp off the screen edge, so
            // it can't sit flush above a bottom-bar anchor. A custom Popup with
            // our own position provider drops it right onto the chip.
            val gapPx = with(density) { 6.dp.roundToPx() }
            val marginPx = with(density) { 8.dp.roundToPx() }
            Popup(
                onDismissRequest = { expanded = false },
                properties = PopupProperties(focusable = true),
                popupPositionProvider = object : PopupPositionProvider {
                    override fun calculatePosition(
                        anchorBounds: IntRect,
                        windowSize: IntSize,
                        layoutDirection: LayoutDirection,
                        popupContentSize: IntSize,
                    ): IntOffset {
                        val x = (anchorBounds.left + anchorBounds.width / 2 - popupContentSize.width / 2)
                            .coerceIn(marginPx, (windowSize.width - popupContentSize.width - marginPx).coerceAtLeast(marginPx))
                        val y = anchorBounds.top - popupContentSize.height - gapPx
                        return IntOffset(x, y)
                    }
                },
            ) {
                Surface(
                    shape = RoundedCornerShape(12.dp),
                    color = MaterialTheme.colorScheme.surfaceContainerHigh,
                    tonalElevation = 3.dp,
                    shadowElevation = 8.dp,
                ) {
                    Column(modifier = Modifier.width(IntrinsicSize.Max).padding(vertical = 4.dp)) {
                        Platforms.all.forEach { platform ->
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable {
                                        expanded = false
                                        onSelectPlatform(platform)
                                    }
                                    .padding(horizontal = 16.dp, vertical = 12.dp),
                            ) {
                                Text(
                                    platform.displayName,
                                    style = MaterialTheme.typography.bodyLarge,
                                    color = MaterialTheme.colorScheme.onSurface,
                                    modifier = Modifier.weight(1f),
                                )
                                if (platform.id == current.id) {
                                    Spacer(Modifier.width(16.dp))
                                    Icon(
                                        Icons.Default.Check,
                                        contentDescription = "Current",
                                        tint = MaterialTheme.colorScheme.primary,
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun BouncerButton(
    filteredCount: Int,
    tooltipState: androidx.compose.material3.TooltipState,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    BadgedBox(
        modifier = modifier,
        badge = {
            if (filteredCount > 0) {
                Badge(
                    containerColor = MaterialTheme.colorScheme.tertiary,
                    contentColor = MaterialTheme.colorScheme.onTertiary,
                ) {
                    Text(
                        filteredCount.toString(),
                        style = MaterialTheme.typography.labelLarge,
                        fontWeight = FontWeight.Bold,
                    )
                }
            }
        },
    ) {
        TooltipBox(
            positionProvider = TooltipDefaults.rememberTooltipPositionProvider(
                TooltipAnchorPosition.Above,
            ),
            tooltip = {
                RichTooltip(
                    title = { Text("Set up your filters", style = MaterialTheme.typography.titleMedium) },
                    text = { Text("Tap here to describe what you want to remove from your feed.") },
                    caretShape = TooltipDefaults.caretShape(DpSize(24.dp, 12.dp)),
                    colors = TooltipDefaults.richTooltipColors(
                        containerColor = MaterialTheme.colorScheme.surfaceContainerHighest,
                    ),
                )
            },
            state = tooltipState,
        ) {
            FilledIconButton(
                onClick = onClick,
                modifier = Modifier.size(BOUNCER_BUTTON),
                colors = IconButtonDefaults.filledIconButtonColors(
                    containerColor = BouncerPurple,
                    contentColor = OnBouncerPurple,
                ),
            ) {
                BouncerIcon(tint = LocalContentColor.current)
            }
        }
    }
}
