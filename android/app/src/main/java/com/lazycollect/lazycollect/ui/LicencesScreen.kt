package com.lazycollect.lazycollect.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lazycollect.lazycollect.R

@Composable
fun LicencesScreen() {
    val assets = LocalContext.current.assets
    val text = remember { assets.open("THIRD-PARTY-NOTICES.txt").bufferedReader().use { it.readText() } }
    Column(Modifier.verticalScroll(rememberScrollState()).padding(24.dp)) {
        Text(stringResource(R.string.licences_title), style = MaterialTheme.typography.headlineSmall)
        Text(text, fontFamily = FontFamily.Monospace, fontSize = 11.sp, modifier = Modifier.padding(top = 12.dp))
    }
}
