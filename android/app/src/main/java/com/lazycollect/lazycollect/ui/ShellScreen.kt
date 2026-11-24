package com.lazycollect.lazycollect.ui

import androidx.annotation.DrawableRes
import androidx.annotation.StringRes
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.lazycollect.lazycollect.R
import com.lazycollect.lazycollect.net.Me
import com.lazycollect.lazycollect.shell.DevicesState

class ShellActions(
    val loadDevices: () -> Unit = {},
    val endDevice: (String) -> Unit = {},
    val endOthers: () -> Unit = {},
    val signOut: () -> Unit = {},
)

private const val LICENCES = "settings/licences"

private enum class Tab(val route: String, @StringRes val label: Int, @DrawableRes val icon: Int) {
    Requests("requests", R.string.nav_requests, R.drawable.ic_tab_requests),
    Clients("clients", R.string.nav_clients, R.drawable.ic_tab_clients),
    Templates("templates", R.string.nav_templates, R.drawable.ic_tab_templates),
    Settings("settings", R.string.nav_settings, R.drawable.ic_tab_settings),
}

const val GRACE_MS = 7 * 86_400_000L

/** The text of the plan banner and the date it names, or null when the plan is fine. */
fun planBanner(me: Me, blocked: Boolean): Pair<Int, Long?>? {
    val ended = blocked || !me.firm.usable
    val owner = me.user.owner
    if (me.firm.planStatus != "past_due") return if (ended) (if (owner) R.string.plan_ended else R.string.plan_ended_member) to null else null
    if (ended) return (if (owner) R.string.plan_past_due_ended else R.string.plan_past_due_ended_member) to null
    return (if (owner) R.string.plan_past_due else R.string.plan_past_due_member) to ((me.firm.pastDueSince ?: 0) + GRACE_MS)
}

@Composable
fun ShellScreen(me: Me, planEnded: Boolean, devices: DevicesState, actions: ShellActions, start: String = Tab.Requests.route, now: Long = System.currentTimeMillis()) {
    val nav = rememberNavController()
    val current by nav.currentBackStackEntryAsState()
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surface) {
        Scaffold(
            containerColor = MaterialTheme.colorScheme.surface,
            bottomBar = {
                NavigationBar {
                    Tab.entries.forEach { tab ->
                        NavigationBarItem(
                            selected = current?.destination?.route?.startsWith(tab.route) == true || (current == null && start == tab.route),
                            onClick = {
                                nav.navigate(tab.route) {
                                    popUpTo(nav.graph.findStartDestination().id) { saveState = true }
                                    launchSingleTop = true
                                    restoreState = true
                                }
                            },
                            icon = { Icon(painterResource(tab.icon), contentDescription = null) },
                            label = { Text(stringResource(tab.label)) },
                        )
                    }
                }
            },
        ) { padding ->
            Column(Modifier.padding(padding)) {
                planBanner(me, planEnded)?.let { (text, date) ->
                    Text(
                        if (date == null) stringResource(text) else stringResource(text, formatDate(date, me.firm.tz)),
                        color = MaterialTheme.colorScheme.onSecondaryContainer,
                        modifier = Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.secondaryContainer).padding(16.dp),
                    )
                }
                NavHost(nav, startDestination = start, modifier = Modifier.weight(1f)) {
                    composable(Tab.Requests.route) { Placeholder(me.firm.name, R.string.nav_requests) }
                    composable(Tab.Clients.route) { Placeholder(me.firm.name, R.string.nav_clients) }
                    composable(Tab.Templates.route) { Placeholder(me.firm.name, R.string.nav_templates) }
                    composable(Tab.Settings.route) { SettingsScreen(me, devices, actions, now) { nav.navigate(LICENCES) } }
                    composable(LICENCES) { LicencesScreen() }
                }
            }
        }
    }
}

@Composable
private fun Placeholder(firm: String?, @StringRes title: Int) {
    Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        Column {
            Text(stringResource(title), style = MaterialTheme.typography.headlineSmall)
            if (firm != null) Text(firm, color = MaterialTheme.colorScheme.primary)
            Text(stringResource(R.string.coming_soon), color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
