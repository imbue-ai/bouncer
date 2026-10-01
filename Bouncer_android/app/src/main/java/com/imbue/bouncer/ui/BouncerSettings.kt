package com.imbue.bouncer.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
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
    // handle-derived profile URLs (LinkedIn stores display names) — rows
    // then render as plain, non-clickable text.
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
        // the filtered-posts modal's "Keep posts by @x" button; this section
        // is where entries are reviewed and removed. Backed by the
        // extension's `excludedAccounts_<siteId>` storage via the
        // __ff_loadExcludedAccounts / __ff_mutateExcludedAccount bridges.
        Text(
            text = "Excluded accounts",
            style = MaterialTheme.typography.titleSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(start = 24.dp, top = 16.dp, bottom = 4.dp),
        )
        excludedAccounts.forEach { account ->
            ListItem(
                headlineContent = {
                    Text(
                        text = account,
                        // Link-colored when tappable, mirroring the iOS
                        // sheet's tinted Link rows.
                        color = if (onOpenExcludedAccount != null) {
                            MaterialTheme.colorScheme.primary
                        } else {
                            Color.Unspecified
                        },
                    )
                },
                trailingContent = {
                    IconButton(onClick = { onRemoveExcludedAccount(account) }) {
                        Icon(
                            imageVector = Icons.Default.Close,
                            contentDescription = "Stop excluding $account",
                        )
                    }
                },
                colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                modifier = Modifier
                    .padding(horizontal = 8.dp)
                    .then(
                        if (onOpenExcludedAccount != null) {
                            Modifier.clickable { onOpenExcludedAccount(account) }
                        } else {
                            Modifier
                        }
                    ),
            )
        }
        var newAccount by remember { mutableStateOf("") }
        fun submitAccount() {
            val trimmed = newAccount.trim()
            if (trimmed.isEmpty()) return
            onAddExcludedAccount(trimmed)
            newAccount = ""
        }
        OutlinedTextField(
            value = newAccount,
            onValueChange = { newAccount = it },
            label = { Text("Add an account to exclude") },
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 4.dp),
            singleLine = true,
            keyboardOptions = KeyboardOptions(
                capitalization = KeyboardCapitalization.None,
                imeAction = ImeAction.Done,
            ),
            keyboardActions = KeyboardActions(onDone = { submitAccount() }),
        )
    }
}
