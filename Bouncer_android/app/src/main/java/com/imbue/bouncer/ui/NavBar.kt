package com.imbue.bouncer.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import com.imbue.bouncer.state.Platform
import com.imbue.bouncer.state.Platforms
import com.imbue.bouncer.ui.theme.BouncerPurple
import com.imbue.bouncer.ui.theme.OnBouncerPurple

private val BOUNCER_BUTTON = DpSize(64.dp, 40.dp)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NavBar(
    activePlatformId: String,
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
                    activePlatformId = activePlatformId,
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
    activePlatformId: String,
    onSelectPlatform: (Platform) -> Unit,
    modifier: Modifier = Modifier,
) {
    var expanded by remember { mutableStateOf(false) }
    // The displayed tab's platform is the truth here — deriving the label from
    // currentUrl mislabeled it whenever the URL mapped to no platform (Google
    // auth → the Twitter fallback) or hadn't caught up to a switch yet.
    val current = Platforms.byId(activePlatformId) ?: Platforms.all.first()

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
            MenuAbove(
                options = Platforms.all.map { it to it.displayName },
                selected = current,
                onSelect = onSelectPlatform,
                onDismiss = { expanded = false },
            )
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
