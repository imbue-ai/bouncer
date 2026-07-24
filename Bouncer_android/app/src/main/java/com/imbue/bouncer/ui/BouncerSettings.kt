package com.imbue.bouncer.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.imbue.bouncer.inference.LocalInferenceService.ModelStatus

/** Everything the "Filtering model" section needs to render. */
data class ModelSectionState(
    /** Extension storage value: "" or "imbue" = cloud; "iosLocal:<id>" = on-device. */
    val selectedModel: String,
    /** The on-device model's storage key ("iosLocal:<id>"). */
    val onDeviceKey: String,
    val displayName: String,
    val approxSize: String,
    val requiredRamDisplay: String,
    val isDeviceSupported: Boolean,
    val status: ModelStatus,
    /** e.g. "950 MB / 2.2 GB" while downloading. */
    val downloadDetail: String,
) {
    val onDeviceSelected: Boolean get() = selectedModel == onDeviceKey
    val onDeviceAvailable: Boolean get() = status is ModelStatus.Downloaded || status is ModelStatus.Ready
}

data class ModelSectionActions(
    val onSelectCloud: () -> Unit,
    val onSelectOnDevice: () -> Unit,
    val onDownload: () -> Unit,
    val onPause: () -> Unit,
    val onResume: () -> Unit,
    val onCancel: () -> Unit,
    val onDelete: () -> Unit,
)

@Composable
fun BouncerSettings(
    aiTextFilterEnabled: Boolean,
    aiTextDetectionThreshold: Double,
    modelSection: ModelSectionState,
    modelActions: ModelSectionActions,
    onAiTextFilterEnabledChange: (Boolean) -> Unit,
    onAiTextDetectionThresholdChange: (Double) -> Unit,
    modifier: Modifier = Modifier,
) {
    var draft by remember(aiTextDetectionThreshold) {
        mutableFloatStateOf(aiTextDetectionThreshold.toFloat())
    }
    val titleAlpha = if (aiTextFilterEnabled) 1f else 0.5f

    Column(modifier = modifier.fillMaxWidth().padding(bottom = 8.dp)) {
        ModelSection(modelSection, modelActions)

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

@Composable
private fun ModelSection(state: ModelSectionState, actions: ModelSectionActions) {
    Text(
        "Filtering model",
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp),
    )

    ModelRow(
        title = "Cloud",
        subtitle = "Fast and free.",
        selected = !state.onDeviceSelected,
        enabled = true,
        onClick = actions.onSelectCloud,
    )

    if (!state.isDeviceSupported) {
        ModelRow(
            title = "On-Device (${state.displayName})",
            subtitle = "Not available on this phone — requires ${state.requiredRamDisplay}+ RAM.",
            selected = false,
            enabled = false,
            onClick = {},
        )
    } else {
        ModelRow(
            title = "On-Device (${state.displayName})",
            subtitle = if (state.onDeviceAvailable) {
                "Nothing leaves your phone."
            } else {
                "Nothing leaves your phone. Download the model to enable."
            },
            selected = state.onDeviceSelected,
            enabled = state.onDeviceAvailable,
            onClick = actions.onSelectOnDevice,
        )
        ModelStatusRow(state, actions)
    }

    Spacer(Modifier.height(8.dp))
}

@Composable
private fun ModelRow(
    title: String,
    subtitle: String,
    selected: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    val alpha = if (enabled) 1f else 0.5f
    ListItem(
        headlineContent = {
            Text(title, color = MaterialTheme.colorScheme.onSurface.copy(alpha = alpha))
        },
        supportingContent = {
            Text(
                subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = alpha),
            )
        },
        trailingContent = {
            if (selected) {
                Icon(
                    Icons.Default.Check,
                    contentDescription = "Selected",
                    tint = MaterialTheme.colorScheme.primary,
                )
            }
        },
        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
        modifier = Modifier
            .padding(horizontal = 8.dp)
            .clickable(enabled = enabled, onClick = onClick),
    )
}

@Composable
private fun ModelStatusRow(state: ModelSectionState, actions: ModelSectionActions) {
    when (val status = state.status) {
        is ModelStatus.NotDownloaded -> Row(modifier = Modifier.padding(horizontal = 20.dp)) {
            TextButton(onClick = actions.onDownload) { Text("Download (${state.approxSize})") }
        }

        is ModelStatus.Downloading, is ModelStatus.Paused -> {
            val progress = when (status) {
                is ModelStatus.Downloading -> status.progress
                is ModelStatus.Paused -> status.progress
                else -> 0.0
            }
            val paused = status is ModelStatus.Paused
            Column(modifier = Modifier.padding(horizontal = 20.dp)) {
                LinearProgressIndicator(
                    progress = { progress.toFloat() },
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text(
                        buildString {
                            append(if (paused) "Paused at " else "")
                            append("${(progress * 100).toInt()}%")
                            if (state.downloadDetail.isNotEmpty()) append(" · ${state.downloadDetail}")
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Row {
                        if (paused) {
                            TextButton(onClick = actions.onResume) { Text("Resume") }
                        } else {
                            TextButton(onClick = actions.onPause) { Text("Pause") }
                        }
                        TextButton(onClick = actions.onCancel) { Text("Cancel") }
                    }
                }
            }
        }

        is ModelStatus.Downloaded, is ModelStatus.Ready, is ModelStatus.Loading -> {
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    if (status is ModelStatus.Loading) "Loading model…" else "Downloaded · ${state.approxSize}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                TextButton(onClick = actions.onDelete) { Text("Delete") }
            }
        }

        is ModelStatus.Error -> Column(modifier = Modifier.padding(horizontal = 20.dp)) {
            Text(
                status.message,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
            Row {
                TextButton(onClick = actions.onDownload) { Text("Retry") }
                TextButton(onClick = actions.onCancel) { Text("Cancel") }
            }
        }
    }
}
