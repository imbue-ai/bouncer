package com.imbue.bouncer.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.InputChip
import androidx.compose.material3.InputChipDefaults
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

// AI detection intentionally has no switch here — it is driven entirely by
// the user's natural-language filter phrases and the sheet header's sparkle
// indicator (see FilterSheet), mirroring the iOS app.
@Composable
fun BouncerSettings(
    filterReplies: Boolean,
    onFilterRepliesChange: (Boolean) -> Unit,
    notificationsEnabled: Boolean,
    onNotificationsEnabledChange: (Boolean) -> Unit,
    debugModeEnabled: Boolean,
    onDebugModeChange: (Boolean) -> Unit,
    excludedAccounts: List<String>,
    onAddExcludedAccount: (String) -> Unit,
    onRemoveExcludedAccount: (String) -> Unit,
    // Opens the account's profile. Null when the active platform has no
    // handle-derived profile URLs (LinkedIn stores display names) — chips
    // then do nothing on tap (× still removes).
    onOpenExcludedAccount: ((String) -> Unit)?,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier.fillMaxWidth().padding(bottom = 8.dp)) {
        // Headline toggle, same storage key the JS pipeline reads
        // (mirrors the iOS sheet's "Also filter replies in threads").
        ListItem(
            headlineContent = { Text("Also filter replies in threads") },
            trailingContent = {
                Switch(
                    checked = filterReplies,
                    onCheckedChange = onFilterRepliesChange,
                )
            },
            colors = ListItemDefaults.colors(containerColor = Color.Transparent),
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp)
        )

        // App-level display switch. On subscribes (if needed) and shows X
        // notifications; off just suppresses display — the subscription and OS
        // permission stay in place (see WebNotificationHandler / BouncerViewModel).
        ListItem(
            headlineContent = { Text("Push notifications") },
            trailingContent = {
                Switch(
                    checked = notificationsEnabled,
                    onCheckedChange = onNotificationsEnabledChange,
                )
            },
            colors = ListItemDefaults.colors(containerColor = Color.Transparent),
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp)
        )

        // Enables the press-and-hold reasoning popup on posts (why a post was
        // kept or hidden). This toggle is the sole switch for it — the build
        // type doesn't matter.
        ListItem(
            headlineContent = { Text("Debug mode") },
            trailingContent = {
                Switch(
                    checked = debugModeEnabled,
                    onCheckedChange = onDebugModeChange,
                )
            },
            colors = ListItemDefaults.colors(containerColor = Color.Transparent),
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp)
        )

        // Excluded accounts for the active platform: posts from these
        // accounts are never classified or hidden. The list also grows from
        // the filtered-posts modal's "Never filter @x" button; this section
        // is where entries are reviewed and removed. Backed by the
        // extension's `excludedAccounts_<siteId>` storage via the
        // __ff_loadExcludedAccounts / __ff_mutateExcludedAccount bridges.
        // Accounts render as M3 input chips (tap opens the profile, × removes)
        // with a trailing "Add account" chip that opens a dialog, so the
        // sheet carries no always-on text field. The divider sets it off
        // from the toggles above as its own section (Compose has no
        // Section container; M3 groups settings with dividers).
        HorizontalDivider(modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp))
        ListItem(
            headlineContent = { Text("Excluded accounts") },
            supportingContent = { Text("Posts from these accounts are never filtered.") },
            colors = ListItemDefaults.colors(containerColor = Color.Transparent),
            modifier = Modifier.padding(start = 8.dp, end = 8.dp, top = 4.dp),
        )
        var showAddDialog by remember { mutableStateOf(false) }
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 24.dp),
        ) {
            excludedAccounts.forEach { account ->
                InputChip(
                    selected = false,
                    // LinkedIn entries are display names with no profile URL,
                    // so the chip body does nothing there; × still removes.
                    onClick = { onOpenExcludedAccount?.invoke(account) },
                    label = {
                        Text(account, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    },
                    trailingIcon = {
                        Icon(
                            imageVector = Icons.Default.Close,
                            contentDescription = "Stop excluding $account",
                            modifier = Modifier
                                .size(InputChipDefaults.IconSize)
                                .clip(CircleShape)
                                .clickable { onRemoveExcludedAccount(account) },
                        )
                    },
                )
            }
            AssistChip(
                onClick = { showAddDialog = true },
                label = { Text("Add account") },
                leadingIcon = {
                    Icon(
                        imageVector = Icons.Default.Add,
                        contentDescription = null,
                        modifier = Modifier.size(AssistChipDefaults.IconSize),
                    )
                },
            )
        }
        if (showAddDialog) {
            AddExcludedAccountDialog(
                onAdd = {
                    onAddExcludedAccount(it)
                    showAddDialog = false
                },
                onDismiss = { showAddDialog = false },
            )
        }
    }
}

@Composable
private fun AddExcludedAccountDialog(
    onAdd: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    var text by remember { mutableStateOf("") }
    val focusRequester = remember { FocusRequester() }
    // Open with the keyboard up — the field is the dialog's only purpose.
    LaunchedEffect(Unit) { focusRequester.requestFocus() }
    fun submit() {
        val trimmed = text.trim()
        if (trimmed.isNotEmpty()) onAdd(trimmed)
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Exclude an account") },
        text = {
            OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                placeholder = { Text("@handle") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.None,
                    autoCorrectEnabled = false,
                    imeAction = ImeAction.Done,
                ),
                keyboardActions = KeyboardActions(onDone = { submit() }),
                modifier = Modifier
                    .fillMaxWidth()
                    .focusRequester(focusRequester),
            )
        },
        confirmButton = {
            TextButton(onClick = { submit() }, enabled = text.isNotBlank()) {
                Text("Add")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel") }
        },
    )
}
