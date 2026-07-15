package com.imbue.bouncer.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

@Composable
fun BouncerSettings(
    aiTextFilterEnabled: Boolean,
    aiTextDetectionThreshold: Double,
    onAiTextFilterEnabledChange: (Boolean) -> Unit,
    onAiTextDetectionThresholdChange: (Double) -> Unit,
    modifier: Modifier = Modifier,
) {
    var draft by remember(aiTextDetectionThreshold) {
        mutableFloatStateOf(aiTextDetectionThreshold.toFloat())
    }
    val titleAlpha = if (aiTextFilterEnabled) 1f else 0.5f

    Column(modifier = modifier.fillMaxWidth().padding(bottom = 8.dp)) {
        ListItem(
            headlineContent = { Text("Remove posts with AI text") },
            trailingContent = {
                Switch(
                    checked = aiTextFilterEnabled,
                    onCheckedChange = onAiTextFilterEnabledChange,
                )
            },
            colors = ListItemDefaults.colors(containerColor = Color.Transparent),
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp)
        )

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(
                "Confidence threshold",
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = titleAlpha),
            )
            AssistChip(
                onClick = {},
                enabled = aiTextFilterEnabled,
                label = { Text("${(draft * 100).toInt()}%") },
                colors = AssistChipDefaults.assistChipColors(
                    containerColor = MaterialTheme.colorScheme.surfaceVariant,
                ),
            )
        }
        Slider(
            value = draft,
            onValueChange = { draft = it },
            onValueChangeFinished = { onAiTextDetectionThresholdChange(draft.toDouble()) },
            valueRange = 0f..1f,
            enabled = aiTextFilterEnabled,
            modifier = Modifier.padding(horizontal = 20.dp),
        )
        Spacer(Modifier.height(4.dp))
        Text(
            "Posts at or above this confidence are hidden. Lower values catch more, higher values catch only obvious cases.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 20.dp),
        )
    }
}
