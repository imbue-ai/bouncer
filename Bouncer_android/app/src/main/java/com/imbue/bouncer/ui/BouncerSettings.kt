package com.imbue.bouncer.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
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
    }
}
