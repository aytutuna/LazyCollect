package com.lazycollect.lazycollect.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// Tones of the icon's amber, #E8930C; the light primary is darker so white text on it stays readable.
private val Light = lightColorScheme(
    primary = Color(0xFF8C5600),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFFFDDB5),
    onPrimaryContainer = Color(0xFF2C1700),
    secondary = Color(0xFF6F5B40),
    secondaryContainer = Color(0xFFFBDEBC),
    onSecondaryContainer = Color(0xFF271905),
    surface = Color(0xFFFFF8F2),
    onSurface = Color(0xFF1F1B16),
    surfaceVariant = Color(0xFFF1E0CF),
    onSurfaceVariant = Color(0xFF4F4539),
    surfaceContainer = Color(0xFFF8EBDF),
    outline = Color(0xFF817567),
)

private val Dark = darkColorScheme(
    primary = Color(0xFFFFB95C),
    onPrimary = Color(0xFF472A00),
    primaryContainer = Color(0xFF673D00),
    onPrimaryContainer = Color(0xFFFFDDB5),
    secondary = Color(0xFFDDC2A1),
    secondaryContainer = Color(0xFF574329),
    onSecondaryContainer = Color(0xFFFBDEBC),
    surface = Color(0xFF1F1B16),
    onSurface = Color(0xFFEAE1D9),
    surfaceVariant = Color(0xFF4F4539),
    onSurfaceVariant = Color(0xFFD3C4B4),
    surfaceContainer = Color(0xFF2C2620),
    outline = Color(0xFF9C8F80),
)

@Composable
fun LazyCollectTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (dark) Dark else Light, content = content)
}
