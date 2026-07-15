package com.imbue.bouncer.ui

import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Public
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
import androidx.compose.material3.Text
import androidx.compose.material3.TextFieldDefaults
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
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import com.imbue.bouncer.ui.theme.BouncerPurple
import com.imbue.bouncer.ui.theme.OnBouncerPurple

private val FIELD_HEIGHT = 40.dp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NavBar(
    currentUrl: String,
    filteredCount: Int,
    onReload: () -> Unit,
    onNavigate: (String) -> Unit,
    onBouncerClick: () -> Unit,
    showBouncerTooltip: Boolean = false,
    onBouncerTooltipDismissed: () -> Unit = {},
    onUrlFieldFocusChanged: (Boolean) -> Unit = {},
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
            Box(modifier = Modifier.weight(1f).padding(horizontal = 4.dp)) {
                UrlField(
                    currentUrl = currentUrl,
                    onNavigate = onNavigate,
                    onFocusedChange = onUrlFieldFocusChanged,
                )
            }
            IconButton(onClick = onReload) {
                Icon(Icons.Default.Refresh, contentDescription = "Reload")
            }
            BadgedBox(
                modifier = Modifier.padding(end = 12.dp),
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
                            title = {
                                Text(
                                    "Set up your filters",
                                    style = MaterialTheme.typography.titleMedium,
                                )
                            },
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
                        onClick = {
                            if (tooltipState.isVisible) onBouncerTooltipDismissed()
                            onBouncerClick()
                        },
                        modifier = Modifier.size(width = 64.dp, height = FIELD_HEIGHT),
                        colors = IconButtonDefaults.filledIconButtonColors(
                            containerColor = BouncerPurple,
                            contentColor = OnBouncerPurple,
                        ),
                    ) {
                        BouncerIcon(tint = LocalContentColor.current)
                    }
                }
            }
        },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun UrlField(
    currentUrl: String,
    onNavigate: (String) -> Unit,
    onFocusedChange: (Boolean) -> Unit,
) {
    val focusManager = LocalFocusManager.current
    var isFocused by remember { mutableStateOf(false) }
    var value by remember { mutableStateOf(TextFieldValue(prettyHost(currentUrl))) }
    val interactionSource = remember { MutableInteractionSource() }
    val colors = TextFieldDefaults.colors(
        focusedContainerColor = MaterialTheme.colorScheme.surfaceVariant,
        unfocusedContainerColor = MaterialTheme.colorScheme.surfaceVariant,
        focusedIndicatorColor = Color.Transparent,
        unfocusedIndicatorColor = Color.Transparent,
        disabledIndicatorColor = Color.Transparent,
    )

    // When the page navigates underneath us, refresh the collapsed host display
    // — but don't clobber what the user is typing.
    LaunchedEffect(currentUrl, isFocused) {
        if (!isFocused) value = TextFieldValue(prettyHost(currentUrl))
    }

    // Chrome behavior: tap shows the full URL with everything selected so
    // typing replaces it. The frame wait is load-bearing — TextField processes
    // the tap's caret placement after onFocusChanged fires, so a same-frame
    // selection update gets overwritten by the tap caret.
    LaunchedEffect(isFocused) {
        if (isFocused && currentUrl.isNotEmpty()) {
            withFrameNanos { }
            value = TextFieldValue(
                text = currentUrl,
                selection = TextRange(0, currentUrl.length),
            )
        }
    }

    // BasicTextField + DecorationBox so we can shrink the vertical content
    // padding to 0 and force the field to match the icon button's 40dp height.
    // Material 3's TextField composable enforces a 56dp internal min and gives
    // no public hook to override contentPadding.
    BasicTextField(
        value = value,
        onValueChange = { value = it },
        modifier = Modifier
            .fillMaxWidth()
            .height(FIELD_HEIGHT)
            .onFocusChanged { focusState ->
                isFocused = focusState.isFocused
                onFocusedChange(focusState.isFocused)
            },
        singleLine = true,
        textStyle = MaterialTheme.typography.bodyMedium.copy(color = LocalContentColor.current),
        cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
        interactionSource = interactionSource,
        keyboardOptions = KeyboardOptions(
            keyboardType = KeyboardType.Uri,
            imeAction = ImeAction.Go,
            autoCorrectEnabled = false,
            capitalization = KeyboardCapitalization.None,
        ),
        keyboardActions = KeyboardActions(onGo = {
            onNavigate(value.text)
            focusManager.clearFocus()
        }),
    ) { innerTextField ->
        TextFieldDefaults.DecorationBox(
            value = value.text,
            innerTextField = innerTextField,
            enabled = true,
            singleLine = true,
            visualTransformation = VisualTransformation.None,
            interactionSource = interactionSource,
            shape = CircleShape,
            colors = colors,
            contentPadding = PaddingValues(horizontal = 4.dp, vertical = 0.dp),
            leadingIcon = { Icon(Icons.Default.Public, contentDescription = null) },
            trailingIcon = {
                if (isFocused && value.text.isNotEmpty()) {
                    IconButton(onClick = {
                        value = TextFieldValue("")
                    }) {
                        Icon(Icons.Default.Close, contentDescription = "Clear")
                    }
                }
            },
        )
    }
}

private fun prettyHost(url: String): String {
    if (url.isEmpty()) return "x.com"
    return try {
        android.net.Uri.parse(url).host ?: url
    } catch (_: Throwable) {
        url
    }
}
