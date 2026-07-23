package com.imbue.bouncer.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import com.imbue.bouncer.R

@Composable
fun BouncerIcon(
    modifier: Modifier = Modifier,
    tint: Color = Color.White,
) {
    Image(
        painter = painterResource(id = R.drawable.ic_bouncer),
        contentDescription = null,
        modifier = modifier.size(30.dp),
        colorFilter = ColorFilter.tint(tint),
    )
}
