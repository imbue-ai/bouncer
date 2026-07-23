package com.imbue.bouncer.ui

import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import kotlinx.coroutines.delay

@Composable
fun TypewriterText(
    phrases: List<String>,
    modifier: Modifier = Modifier,
    style: TextStyle = LocalTextStyle.current,
    cursorColor: Color = style.color,
    typeDelayMs: Long = 60,
    eraseDelayMs: Long = 35,
    holdMs: Long = 1800,
    betweenMs: Long = 300,
) {
    var index by remember { mutableIntStateOf(0) }
    var visible by remember { mutableStateOf("") }
    var cursorOn by remember { mutableStateOf(true) }

    LaunchedEffect(Unit) {
        while (true) {
            delay(500)
            cursorOn = !cursorOn
        }
    }

    LaunchedEffect(phrases) {
        if (phrases.isEmpty()) return@LaunchedEffect
        while (true) {
            val target = phrases[index % phrases.size]
            for (i in 1..target.length) {
                visible = target.substring(0, i)
                delay(typeDelayMs)
            }
            delay(holdMs)
            for (i in target.length - 1 downTo 0) {
                visible = target.substring(0, i)
                delay(eraseDelayMs)
            }
            delay(betweenMs)
            index++
        }
    }

    val annotated = buildAnnotatedString {
        append(visible)
        withStyle(
            SpanStyle(
                color = if (cursorOn) cursorColor else Color.Transparent,
                fontWeight = FontWeight.Normal,
            ),
        ) {
            append("|")
        }
    }

    Text(text = annotated, style = style, modifier = modifier)
}
